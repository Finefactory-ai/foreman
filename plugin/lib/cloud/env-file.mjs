// The keys in a cloud run. They arrive as environment variables (container variables, or
// repository secrets in Actions) and are written to files, where the parts of Foreman that need
// them already look; then they are taken out of the environment the supervisor gets, so the
// Claude sessions never carry them. Foreman's own keys (engine/foreman-keys.mjs) go to config
// `foremanEnvFile` (.env.foreman), which is never linked into a slot; the project's keys go to
// its envFile, which is linked into every slot for its builds and tests.
//
//   keyNames(config)                   the adapters' declared variables plus cloud.envVars,
//                                      without the Claude sign-ins and GH_TOKEN, which the
//                                      sessions need in their environment
//   writeEnvFile({ root, config, env, file, names }) -> { file, written, missing, refused }
//                                      names only; `file` (relative to root) defaults to the
//                                      envFile and `names` to keyNames(config)
//   serialize(name, value)             one `NAME=value` line that Node's parseEnv reads back
//                                      exactly, or null when no quoting can (engine/env-text.mjs)
//   withoutKeys(env, names)            a copy of env without those names
//   placeKeys({ root, config, env, sh }) -> { env, warnings }
//                                      what a cloud run does: the project's keys to the envFile
//                                      when git ignores it, Foreman's keys to .env.foreman (mode
//                                      600) when git ignores that, after adding it to the
//                                      clone's .git/info/exclude when git does not; never to a
//                                      file git would commit, nor to one git already tracks
//                                      (foreman-keys.mjs isTracked), which only gets a warning.
//                                      It returns the environment without any of the names.
//
// Lines already in a file for other names are kept; a named variable's old line is replaced.
// The write is the key store's (secrets/env-store.mjs): a temp file and a rename, mode 600.
// An empty variable counts as missing: Actions sets an unset secret to "".

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { requirements } from '../engine/doctor-checks.mjs';
import { serialize } from '../engine/env-text.mjs';
import { writeKeys } from '../secrets/env-store.mjs';
import { addIgnoreLine, foremanEnvName, isForemanKey, isIgnored, isTracked, projectEnvName } from '../engine/foreman-keys.mjs';

export { serialize };

const RUNNER = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);

export function keyNames(config) {
  return [...new Set([...requirements(config).env, ...(config.cloud?.envVars ?? [])])].filter((n) => !RUNNER.has(n));
}

export function writeEnvFile({ root, config, env = process.env, file: rel = config.envFile ?? '.env.local', names = keyNames(config) }) {
  const file = join(root, rel);
  const missing = [];
  const values = {};
  for (const name of names) {
    const value = env[name];
    if (typeof value !== 'string' || value === '') missing.push(name);
    else values[name] = value;
  }
  if (!Object.keys(values).length) return { file, written: [], missing, refused: [] };
  const { written, refused } = writeKeys(file, values);
  return { file, written, missing, refused };
}

export function withoutKeys(env, names) {
  const out = { ...env };
  for (const name of names) delete out[name];
  return out;
}

const isDir = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

export function placeKeys({ root, config, env, sh }) {
  const names = keyNames(config);
  const projectNames = names.filter((n) => !isForemanKey(n));
  const ownNames = names.filter(isForemanKey);
  const envFile = projectEnvName(config);
  const ownFile = foremanEnvName(config);
  const warnings = [];
  const missing = new Set();
  const write = (file, list) => {
    const keys = writeEnvFile({ root, config, env, file, names: list });
    for (const name of keys.missing) missing.add(name);
    if (keys.refused.length) warnings.push(`not written to ${file}, because no quoting keeps them intact: ${keys.refused.join(', ')}`);
  };

  const tracked = (file) => isTracked({ root, file, sh }) === 'tracked';

  if (projectNames.length) {
    if (isIgnored({ root, file: envFile, sh }) === 'ignored') {
      if (tracked(envFile)) warnings.push(`${envFile} is tracked by git, so the project's keys were not written to it; remove it from the index first`);
      else write(envFile, projectNames);
    } else if (projectNames.some((n) => env[n])) warnings.push(`${envFile} is not ignored by git, so the project's keys were not written to it; add it to .gitignore`);
  }

  if (ownNames.length) {
    // The clone's own exclude file, so the project's .gitignore is never changed.
    let state = isIgnored({ root, file: ownFile, sh });
    if (state === 'not-ignored' && isDir(join(root, '.git'))) {
      addIgnoreLine(root, ownFile, undefined, join('.git', 'info', 'exclude'));
      state = isIgnored({ root, file: ownFile, sh });
    }
    if (state === 'ignored') {
      if (tracked(ownFile)) warnings.push(`${ownFile} is tracked by git, so Foreman's keys were not written to it; remove it from the index first`);
      else write(ownFile, ownNames);
    } else if (ownNames.some((n) => env[n])) warnings.push(`${ownFile} is not ignored by git, so Foreman's keys were not written to it; add it to .gitignore`);
  }

  const unset = names.filter((n) => missing.has(n));
  if (unset.length) warnings.unshift(`not set: ${unset.join(', ')} (the project's keys, from cloud.envVars and the adapters)`);
  return { env: withoutKeys(env, names), warnings };
}
