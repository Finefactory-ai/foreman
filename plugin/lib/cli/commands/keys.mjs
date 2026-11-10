// `foreman keys`: Foreman's keys without editing env files. Values are pasted, never typed on
// the command line, and never printed.
//
//   foreman keys list                 every key Foreman knows and the ones the project's adapters
//                                     ask for: not set, set outside Foreman (in the
//                                     environment, which Foreman cannot change), or set in a file,
//                                     masked (secrets/env-store.mjs)
//   foreman keys set NAME             reads the value from the terminal without showing it (or
//                                     from stdin to its end when it is not a terminal), checks its
//                                     shape (setup/keys.mjs) and writes it to its file; adds the
//                                     file to .gitignore first when git does not ignore it
//   foreman keys remove NAME
//   foreman keys test NAME            asks the key's service whether it takes the key
//   foreman keys migrate              moves Foreman's own keys (lib/engine/foreman-keys.mjs: the
//                                     Jira app keys, Resend and the notify settings, the
//                                     dashboard token, the Gearset token, the Anthropic key and
//                                     the Claude token) out of the project's env file (config
//                                     `envFile`, .env.local), which is linked into every slot
//                                     worktree where the agents can read it, into config
//                                     `foremanEnvFile` (.env.foreman), which git ignores and no
//                                     slot ever gets. Both files are written atomically; the env
//                                     file keeps its other lines, its comments and its mode, and
//                                     .env.foreman is mode 600.
//
// Every subcommand takes --project <path>. The project is the one in the current folder (the
// main checkout of the git repo around it), or --project, resolved against the current folder.
// FOREMAN_PROJECT_DIR is never read to find the project. Inside a Foreman story session
// (FOREMAN_RUN=1) every subcommand refuses, before it reads any file, when that project is the
// one the run builds (FOREMAN_PROJECT_DIR, a folder inside it or a worktree of it:
// lib/engine/run-guard.mjs refuseAnchorWrite); on a scratch repo it works. Migrate prints names
// only, never a value:
//
//   moved A, B to .env.foreman
//   removed C from .env.local: .env.foreman already has it
//   left D in .env.local: its value cannot be written safely
//   added .env.foreman to .gitignore
//   nothing to move: .env.local has none of Foreman's keys
//
// Exits 0 on success; 1 with one line against the run's project in a story session, on a config error, when a key is
// set in the environment, a NAME is not a key name or looks like a key's value (never echoed), a value has the wrong shape, a test fails, or a file cannot be read or
// written or git will not ignore it; 130 when the paste is cancelled; 64 with the usage for
// anything else, and for a value given on the command line.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadResolved } from '../../settings/load.mjs';
import { projectRoot } from '../../engine/paths.mjs';
import { foremanEnvName, migrateKeys, projectEnvName } from '../../engine/foreman-keys.mjs';
import { refuseAnchorWrite } from '../../engine/run-guard.mjs';
import { requirements } from '../../engine/doctor-checks.mjs';
import { changeable, checkName, fileFor, ignoreKeyFile, keyState, removeKey, secretValue, setKey } from '../../secrets/env-store.mjs';
import { checkShape, KEYS, keyInfo, testKey } from '../../setup/keys.mjs';

const EXIT_USAGE = 64;
const EXIT_INTERRUPTED = 130;
const USAGE = 'usage: foreman keys list | set <NAME> | remove <NAME> | test <NAME> | migrate [--project <path>]\n';
const ON_COMMAND_LINE = 'foreman keys set takes no value on the command line, where it would stay in your shell history; run `foreman keys set NAME` and paste the value\n';
const SUBS = new Set(['list', 'set', 'remove', 'test', 'migrate']);
// How many names each subcommand takes.
const ARITY = { list: 0, set: 1, remove: 1, test: 1, migrate: 0 };

const realSh = (env) => (cmd, args = [], opts = {}) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const withoutForeman = (env) => Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !name.startsWith('FOREMAN_')));
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

// { sub, name, project }, or { error: 'usage' | 'value' }.
function parse(args) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({ args, options: { project: { type: 'string' } }, allowPositionals: true, strict: true }));
  } catch {
    return { error: 'usage' };
  }
  const [sub, ...rest] = positionals;
  if (!SUBS.has(sub)) return { error: 'usage' };
  if (sub === 'set' && rest.length === 2) return { error: 'value' };
  if (rest.length !== ARITY[sub]) return { error: 'usage' };
  return { sub, name: rest[0], project: values.project };
}

const interrupted = () => Object.assign(new Error('cancelled'), { code: 'interrupted' });

// Off a terminal: stdin to its end, without one trailing newline.
export function readAll(stdin) {
  return new Promise((resolve, reject) => {
    let text = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      text += chunk;
    });
    stdin.on('end', () => resolve(text.replace(/\r?\n$/, '')));
    stdin.on('error', reject);
    stdin.resume();
  });
}

// On a terminal: raw mode, so nothing echoes. Enter ends the value; Ctrl-C cancels.
export async function readSecretFromTerminal(prompt, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) return readAll(stdin);
  stderr.write(prompt);
  try {
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    return await new Promise((resolve, reject) => {
      let text = '';
      const done = (fn, value) => {
        stdin.off('data', onData);
        stderr.write('\n');
        fn(value);
      };
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(resolve, text);
          if (ch === '\u0003') return done(reject, interrupted());
          if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
          else text += ch;
        }
        return undefined;
      };
      stdin.on('data', onData);
      stdin.resume();
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

function list(names, store, config) {
  const width = Math.max(...names.map((n) => n.length));
  return keyState(names, store).map(({ name, set, masked, source }) => {
    const file = fileFor(name, config);
    let state = 'not set';
    if (source === 'environment') state = 'set outside Foreman';
    else if (set) state = masked === 'set' ? `set (${file})` : `${masked} (${file})`;
    return `${name.padEnd(width)}  ${state}\n`;
  }).join('');
}

async function setOne(name, store, { readSecret, stdout, stderr }) {
  try {
    changeable(name, store.env);
  } catch (err) {
    stderr.write(`${firstLine(err)}\n`);
    return 1;
  }
  let value;
  try {
    value = await readSecret(`Paste ${keyInfo(name).label} (it will not show), then press Enter: `);
  } catch (err) {
    if (err?.code === 'interrupted') return EXIT_INTERRUPTED;
    stderr.write(`${firstLine(err)}\n`);
    return 1;
  }
  const wrong = checkShape(name, value);
  if (wrong) {
    stderr.write(`${wrong}\n`);
    return 1;
  }
  const lines = [];
  try {
    let r;
    try {
      r = await setKey(name, value, store);
    } catch (err) {
      if (err?.code !== 'not-ignored') throw err;
      if (ignoreKeyFile(name, store) === 'added') lines.push(`added ${err.fix.file} to .gitignore`);
      r = await setKey(name, value, store);
    }
    lines.push(`set ${name} in ${r.file}`);
  } catch (err) {
    if (lines.length) stdout.write(`${lines.join('\n')}\n`);
    stderr.write(`${firstLine(err)}\n`);
    return 1;
  }
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function removeOne(name, store, { stdout, stderr }) {
  try {
    const r = await removeKey(name, store);
    stdout.write(r.removed ? `removed ${name} from ${r.file}\n` : `${name} is not in ${r.file}\n`);
    return 0;
  } catch (err) {
    stderr.write(`${firstLine(err)}\n`);
    return 1;
  }
}

async function testOne(name, store, deps, { stdout, stderr }) {
  try {
    checkName(name);
  } catch (err) {
    stderr.write(`${firstLine(err)}\n`);
    return 1;
  }
  const value = secretValue(name, store);
  if (value === null) {
    stderr.write(`${name} is not set\n`);
    return 1;
  }
  if (keyInfo(name).test === 'subscription') stderr.write('This asks Claude a short question, which uses a few tokens.\n');
  const r = await testKey(name, value, { fetch: deps.fetch, sh: store.sh, env: deps.env, base: deps.base, timeoutMs: deps.timeoutMs });
  stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${name} — ${r.detail}\n`);
  return r.ok ? 0 : 1;
}

function migrate(root, config, sh, { stdout, stderr }) {
  let r;
  try {
    r = migrateKeys({ root, config, sh });
  } catch (err) {
    stderr.write(`${firstLine(err)}\n`);
    return 1;
  }
  const own = foremanEnvName(config);
  const local = projectEnvName(config);
  const lines = [];
  if (r.moved.length) lines.push(`moved ${r.moved.join(', ')} to ${own}`);
  if (r.alreadyThere.length) lines.push(`removed ${r.alreadyThere.join(', ')} from ${local}: ${own} already has it`);
  if (r.refused.length) lines.push(`left ${r.refused.join(', ')} in ${local}: its value cannot be written safely`);
  if (r.ignore === 'added') lines.push(`added ${own} to .gitignore`);
  if (!r.moved.length && !r.alreadyThere.length && !r.refused.length) lines.push(`nothing to move: ${local} has none of Foreman's keys`);
  stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export function makeKeysCommand({ sh = null, readSecret = null, stdin = process.stdin, fetch = globalThis.fetch, base = {}, timeoutMs = 10_000 } = {}) {
  return {
    name: 'keys',
    summary: "Foreman's keys: list, set, remove and test them without editing env files (keys migrate moves old ones)",

    // ctx.root is not used: it may come from FOREMAN_PROJECT_DIR.
    async run(args, { cwd, env, stdout, stderr }) {
      const opts = parse(args);
      if (opts.error) {
        stderr.write(opts.error === 'value' ? ON_COMMAND_LINE : USAGE);
        return EXIT_USAGE;
      }
      const root = opts.project !== undefined ? path.resolve(cwd, opts.project) : projectRoot({ cwd, env: {} });
      const refusal = refuseAnchorWrite(env, root, `foreman keys ${opts.sub}`);
      if (refusal) {
        stderr.write(`${refusal}\n`);
        return 1;
      }

      const { config, errors } = loadResolved(root, { env: withoutForeman(env) });
      if (!config || errors.length) {
        stderr.write(`${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ') || 'the config could not be loaded'}\n`);
        return 1;
      }
      const shellEnv = env === process.env ? process.env : { ...process.env, ...env };
      const run = sh ?? realSh(shellEnv);
      const io = { stdout, stderr };
      if (opts.sub === 'migrate') return migrate(root, config, run, io);

      // The full environment: a key set in the shell is one Foreman cannot change.
      const store = { root, config, env, sh: run };
      if (opts.sub === 'list') {
        const known = KEYS.map((k) => k.name);
        const project = requirements(config).env.filter((n) => !known.includes(n));
        stdout.write(list([...known, ...project], store, config));
        return 0;
      }
      if (opts.sub === 'set') {
        const read = readSecret ?? ((prompt) => readSecretFromTerminal(prompt, { stdin, stderr }));
        return setOne(opts.name, store, { readSecret: read, ...io });
      }
      if (opts.sub === 'remove') return removeOne(opts.name, store, io);
      return testOne(opts.name, store, { fetch, base, timeoutMs, env: shellEnv }, io);
    },
  };
}

export default makeKeysCommand();
