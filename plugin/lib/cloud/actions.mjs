// The GitHub Actions helpers that `foreman cloud actions init`, the Set up tab's Cloud runner
// step (lib/setup/cloud.mjs) and the doctor's cloud checks (lib/engine/doctor-cloud.mjs) share.
//
//   WORKFLOW, RUNNER_FILE              '.github/workflows/foreman.yml'; '.env.runner', the env
//                                      file the Set up tab writes for a container runner
//   writeWorkflow({ root, config, force }) -> { file, written, exists } | { file, written: false,
//                                      exists: true, link: true }
//                                      writes actionsWorkflow's text; an existing file is left as
//                                      it is unless force. When .github, .github/workflows or the
//                                      file is a link (dangling too), it writes and creates
//                                      nothing, even with force, and answers link: true
//   repoOf({ root, config, sh })       owner/name of the config's remote (origin) when it is on
//                                      github.com, by https or ssh, else null
//   GH_TIMEOUT_MS                      30 s, the timeout passed to `gh secret list` and
//                                      `gh secret set` (opts.timeout), so a hung gh cannot hold
//                                      the caller
//   listSecrets({ repo, sh, cwd }) -> { ok: true, names } | { ok: false, detail }
//                                      the repository's Actions secrets, by name
//   setSecret({ repo, name, value, sh, cwd }) -> { ok, detail }
//                                      `gh secret set <name>`, the value on stdin only: never in
//                                      the arguments or the environment
//   missingSecrets(config, names)      what the workflow reads that `names` lacks:
//                                      FOREMAN_GH_TOKEN, both sign-ins when neither is there, and
//                                      each project key (workflowSecrets)
//
// sh(cmd, args, opts) -> { status, stdout, stderr }. A detail is gh's last line with every
// secret blanked (lib/secrets/redact.mjs), never a value.

import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lastLine, redact } from '../secrets/redact.mjs';
import { actionsWorkflow, workflowSecrets } from './workflow-template.mjs';

export const WORKFLOW = '.github/workflows/foreman.yml';
export const RUNNER_FILE = '.env.runner';
export const GH_TIMEOUT_MS = 30_000;

const GITHUB = [
  /^https:\/\/(?:[^@/\s]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
  /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
];

// Whether the path is a link, dangling or not; false when nothing is there.
const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

export function writeWorkflow({ root, config, force = false }) {
  const file = join(root, WORKFLOW);
  if ([join(root, '.github'), join(root, '.github', 'workflows'), file].some(isLink)) return { file, written: false, exists: true, link: true };
  const exists = existsSync(file);
  if (exists && !force) return { file, written: false, exists };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, actionsWorkflow({ config }));
  return { file, written: true, exists };
}

export function repoOf({ root, config, sh }) {
  const r = sh('git', ['remote', 'get-url', config?.remote ?? 'origin'], { cwd: root });
  if (r?.status !== 0) return null;
  const url = String(r.stdout ?? '').trim();
  for (const re of GITHUB) {
    const m = url.match(re);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return null;
}

export function listSecrets({ repo, sh, cwd }) {
  const r = sh('gh', ['secret', 'list', '--repo', repo, '--app', 'actions', '--json', 'name'], { cwd, timeout: GH_TIMEOUT_MS });
  if (r?.status !== 0) return { ok: false, detail: lastLine(r, {}) || `gh exited ${r?.status}` };
  try {
    const list = JSON.parse(String(r.stdout ?? ''));
    if (!Array.isArray(list)) throw new Error('not a list');
    return { ok: true, names: list.map((s) => s?.name).filter((n) => typeof n === 'string') };
  } catch {
    return { ok: false, detail: 'gh secret list answered something unreadable' };
  }
}

export function setSecret({ repo, name, value, sh, cwd }) {
  // Node feeds `input` only to a piped stdin.
  const r = sh('gh', ['secret', 'set', name, '--repo', repo, '--app', 'actions'], { cwd, input: value, stdio: ['pipe', 'pipe', 'pipe'], timeout: GH_TIMEOUT_MS });
  if (r?.status === 0) return { ok: true, detail: '' };
  // Blanked before it is cut, so no part of the value is left.
  const said = String(r?.stderr || r?.stdout || '').trim().split('\n').pop() ?? '';
  return { ok: false, detail: redact(said, { values: [value] }).slice(0, 200) || `gh exited ${r?.status}` };
}

export function missingSecrets(config, names) {
  const have = new Set(names ?? []);
  const { token, signIn, keys } = workflowSecrets(config);
  const missing = [];
  if (!have.has(token)) missing.push(token);
  if (!signIn.some((n) => have.has(n))) missing.push(...signIn);
  for (const key of keys) if (!have.has(key)) missing.push(key);
  return missing;
}
