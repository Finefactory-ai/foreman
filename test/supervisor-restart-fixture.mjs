// The fixture for `foreman run` end to end when the plugin's own code changes under it
// (supervisor-restart*.test.mjs): a copy of the plugin in a git repo of its own, which a fake
// session (or the test) commits to, a fake `claude` and `gh` on the PATH, and the short test tick.
// Some cases switch on a slow fixture adapter in the plugin copy (SLOW_PREPARE, HELD_PUBLISH,
// HELD_START, HELD_LOAD), or a slot environment that gives the sessions a CLAUDE_CONFIG_DIR of
// their own (SESSION_CONFIG).

import { afterEach } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from './state-repos.mjs';
import { fastTick } from './fast-tick.mjs';
import { slow } from './wait-scale.mjs';
import { endChild, runForeman, startForeman, useSupervisors } from './supervisors.mjs';

// The tests get `slow` from here, so a wait or time limit they write is stretched the same way as the fixture's.
export { slow };

const PLUGIN = fileURLToPath(new URL('../plugin/', import.meta.url));

// The session id of ACME-1 in the folder mode.
export const FOLDER_SESSION = '9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';

// Every session writes its pid to <FAKE_PIDS>/<ID>, marks its story blocked in the state overlay
// and says so. ACME-1's also commits a change to the plugin the supervisor runs from. What the
// sessions do next depends on FAKE_MODE:
//   go        ACME-1 and ACME-2 wait (up to 60 s) for the FAKE_GO file before they answer
//   ending    ACME-1 commits the plugin change, answers, then lingers for 3 s before it exits:
//             its result is in its log while it still runs, so the restart must wait for its exit
//   handover  ACME-1 answers, at a cost of $0.25, and exits as soon as state.json's restart lists
//             the sessions
//   linger    ACME-1 waits for the restart event, answers, and then never exits
//   halt      ACME-1 halts the release line, waits for the restart event, and answers
//   stop      ACME-1 commits only once the FAKE_COMMIT file exists, then waits for FAKE_GO;
//             ACME-2 never answers, and on SIGTERM writes the FAKE_TERM file and exits
//             once the FAKE_GO2 file exists
//   files     like go, and ACME-1 first claims src/a.mjs with `foreman lock files`
//   plain     every session answers at once
//   skip      ACME-1 is not marked blocked and commits nothing at first: it asks, as the page
//             would, to skip it (slot w1), and on that SIGTERM commits the change, asks for 2
//             workers and exits with no result. Committing only then keeps the old process from
//             picking before the restart, which waits for a session being stopped.
//   reject    like plain, and ACME-1's change also makes the new code's `config check` refuse
//             the config (it exits 1 if the line it changes has moved)
//   folder    ACME-1 first prints an init event for FOLDER_SESSION and writes its builder's
//             transcript under its own CLAUDE_CONFIG_DIR, then waits until the new process has
//             kept it across the restart, answers and exits
//   plugin    like go, and ACME-1 first prints an init event whose Foreman plugin is at
//             FAKE_PLUGIN_PATH (not the run's code), so the old process warns once, and waits
//             for that warning before it commits the change that restarts the run
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const state = process.env.FOREMAN_STATE_DIR;
const mode = process.env.FAKE_MODE;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
mkdirSync(process.env.FAKE_PIDS, { recursive: true });
writeFileSync(join(process.env.FAKE_PIDS, id), String(process.pid));
const stories = join(state, 'stories');
mkdirSync(stories, { recursive: true });
if (!(mode === 'skip' && id === 'ACME-1')) writeFileSync(join(stories, id + '.json'), JSON.stringify({ id, status: 'blocked', blockedBy: 'Fake session', fields: {}, notes: [] }));
const control = (change) => {
  const file = join(state, 'control.json');
  let c = {};
  try {
    c = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  writeFileSync(file, JSON.stringify({ ...c, ...change(c) }));
};
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitFor = (ok, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; Atomics.wait(pause, 0, 0, 200)) {
    try {
      if (ok()) return;
    } catch {}
  }
};
const restarted = () => readFileSync(join(state, 'events.jsonl'), 'utf8').split('\\n').some((l) => l.includes('"Restarted on new code'));
const commitPlugin = () => {
  const plug = process.env.FAKE_PLUG;
  writeFileSync(join(plug, 'lib', 'touched.txt'), 'new code\\n');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: plug });
  if (mode === 'reject') {
    const nl = String.fromCharCode(92) + 'n';
    const check = join(plug, 'lib', 'cli', 'commands', 'config.mjs');
    const anchor = "stdout.write('ok" + nl + "');";
    const text = readFileSync(check, 'utf8');
    if (!text.includes(anchor)) process.exit(1);
    writeFileSync(check, text.replace(anchor, "stdout.write('version: refused by the new code" + nl + "'); return 1;"));
    git('add', 'lib/cli/commands/config.mjs');
  }
  git('add', 'lib/touched.txt');
  git('commit', '-qm', 'Touch the plugin');
};
if (mode === 'skip' && id === 'ACME-1') {
  process.on('SIGTERM', () => {
    commitPlugin();
    control(() => ({ workers: 2, workersAt: new Date().toISOString() }));
    process.exit(0);
  });
  control((c) => ({ slots: { ...(c.slots ?? {}), w1: { action: 'skip', at: new Date().toISOString() } } }));
  setTimeout(() => process.exit(0), ${slow(60_000)});
  return;
}
if (mode === 'folder' && id === 'ACME-1') {
  const S = '${FOLDER_SESSION}';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: S, model: 'claude-opus-5-5', cwd: process.cwd() }));
  const wf = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-acme', S, 'subagents', 'workflows', 'wf_1');
  mkdirSync(wf, { recursive: true });
  const usage = { input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 6000, cache_creation_input_tokens: 800 };
  writeFileSync(join(wf, 'agent-a2.jsonl'), JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage } }) + '\\n');
  writeFileSync(join(wf, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'foreman:developer', description: 'build:' + id, workflowPhase: 'Build' }));
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-tmp-acme', S + '.jsonl'), '{}\\n');
}
if (mode === 'plugin' && id === 'ACME-1') {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake', model: 'claude-opus-5-5', plugins: [{ name: 'foreman', path: process.env.FAKE_PLUGIN_PATH, source: 'foreman@foreman', version: '0.0.1' }] }));
  waitFor(() => readFileSync(join(state, 'events.jsonl'), 'utf8').includes('its session loaded'), ${slow(60_000)});
}
if (id === 'ACME-1') {
  if (mode === 'files') {
    const plan = join(state, 'plan-ACME-1.json');
    writeFileSync(plan, JSON.stringify({ ready: true, resources: [], files: ['src/a.mjs'] }));
    const r = spawnSync(process.execPath, [join(process.env.FAKE_PLUG, 'bin', 'foreman'), 'lock', 'files', id, '--plan', plan], { encoding: 'utf8' }); // supervisor-guard: not a supervisor
    if (r.status !== 0) process.exit(1);
  }
  if (mode === 'stop') waitFor(() => existsSync(process.env.FAKE_COMMIT), ${slow(60_000)});
  commitPlugin();
  if (mode === 'halt') writeFileSync(join(state, 'HALT'), 'A release failed.');
  if (mode === 'handover') waitFor(() => (JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).restart?.sessions ?? []).length > 0, ${slow(60_000)});
  if (mode === 'linger' || mode === 'halt') waitFor(restarted, ${slow(60_000)});
  if (mode === 'folder') waitFor(() => readFileSync(join(state, 'events.jsonl'), 'utf8').includes('"Kept 1 running across the restart: ACME-1 (w1).'), ${slow(60_000)});
}
if (mode === 'stop' && id === 'ACME-2') {
  process.on('SIGTERM', () => {
    writeFileSync(process.env.FAKE_TERM, '');
    setInterval(() => existsSync(process.env.FAKE_GO2) && process.exit(0), 100);
  });
  setTimeout(() => process.exit(0), ${slow(60_000)});
} else {
  if (((mode === 'go' || mode === 'files' || mode === 'plugin') && id !== 'ACME-3') || (mode === 'stop' && id === 'ACME-1')) waitFor(() => existsSync(process.env.FAKE_GO), ${slow(60_000)});
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Could not get further.\\nFACTORY_RESULT: blocked ' + id, total_cost_usd: mode === 'handover' ? 0.25 : 0, session_id: 'fake' }));
  if (mode === 'linger') setInterval(() => {}, 1000);
  if (mode === 'ending' && id === 'ACME-1') waitFor(() => false, ${slow(3000)});
}
`;

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

export const STORY = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

// Fixture changes to the plugin copy, made before its first commit. Each is off unless the run's
// environment names its file, and fails loudly when the code it hooks into has moved.
const hook = (text, anchor, replacement) => {
  if (!text.includes(anchor)) throw new Error(`fixture anchor not found: ${anchor.split('\n')[0]}`);
  return text.replace(anchor, replacement);
};
// Slot w2's environment answers later: once the ACME_PREPARE_GATE file exists.
export const SLOW_PREPARE = {
  'lib/adapters/env/none.mjs': (text) =>
    `import { existsSync as acmeExists } from 'node:fs';\n${hook(
      text,
      "    prepare() {\n      return 'up';\n    },",
      `    prepare(n) {
      const gate = process.env.ACME_PREPARE_GATE;
      if (!gate || n !== 2) return 'up';
      return new Promise((resolve) => {
        const end = Date.now() + ${slow(60_000)};
        const timer = setInterval(() => {
          if (acmeExists(gate) || Date.now() > end) {
            clearInterval(timer);
            resolve('up');
          }
        }, 100);
      });
    },`,
    )}`,
};
// Every slot's environment sets CLAUDE_CONFIG_DIR to the ACME_SESSION_CONFIG folder, as a slot
// environment may, so the sessions write their files somewhere other than the supervisor's.
export const SESSION_CONFIG = {
  'lib/adapters/env/none.mjs': (text) =>
    hook(text, '      const env = { FOREMAN_SLOT: `w${n}` };\n', '      const env = { FOREMAN_SLOT: `w${n}` };\n      if (process.env.ACME_SESSION_CONFIG) env.CLAUDE_CONFIG_DIR = process.env.ACME_SESSION_CONFIG;\n'),
};
// The process that is restarting holds its last publish until the session whose pid is in the
// ACME_HOLD_FOR file has ended, and then a little longer, so that session ends inside the
// window between the handover and the exit. ACME_HELD is written when that happened.
export const HELD_PUBLISH = {
  'lib/adapters/console/files.mjs': (text) =>
    `import { existsSync as acmeExists, readFileSync as acmeRead, writeFileSync as acmeWrite } from 'node:fs';\n${hook(
      text,
      '    async publish(snapshot) {\n',
      `    async publish(snapshot) {
      const holdFor = process.env.ACME_HOLD_FOR;
      let restart = null;
      try {
        restart = JSON.parse(acmeRead(join(dir, 'state.json'), 'utf8')).restart;
      } catch {}
      if (holdFor && restart?.pid === process.pid) {
        const pid = Number(acmeRead(holdFor, 'utf8'));
        const up = () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err) {
            return err.code === 'EPERM';
          }
        };
        for (const end = Date.now() + ${slow(30_000)}; up() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
        if (!up()) {
          await new Promise((r) => setTimeout(r, 1000));
          acmeWrite(process.env.ACME_HELD, '');
        }
      }
`,
    )}`,
};

// The process started on the new code holds its start-up at its console (the first opened after
// the restart event, since the old process exits right after it), which it opens after it has
// adopted the sessions, until the ACME_START_GATE file exists. It writes ACME_START_HELD when it
// begins to wait: the gap between the adoption and the console, the dashboard and Jira.
export const HELD_START = {
  'lib/adapters/console/files.mjs': (text) =>
    `import { existsSync as acmeExists, readFileSync as acmeRead, writeFileSync as acmeWrite } from 'node:fs';\n${hook(
      text,
      '  const now = ctx.now ?? (() => new Date());\n',
      `  const now = ctx.now ?? (() => new Date());
  let acmeRestarted = false;
  try {
    acmeRestarted = acmeRead(join(dir, 'events.jsonl'), 'utf8').includes('"Restarted on new code');
  } catch {}
  if (process.env.ACME_START_GATE && acmeRestarted && !acmeExists(process.env.ACME_START_GATE)) {
    acmeWrite(process.env.ACME_START_HELD, '');
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (const end = Date.now() + ${slow(60_000)}; !acmeExists(process.env.ACME_START_GATE) && Date.now() < end; ) Atomics.wait(pause, 0, 0, 100);
  }
`,
    )}`,
};

// The process started on the new code holds as it loads, when it opens its slot environment
// (before main(), so before it writes its pid or adopts the sessions), until the ACME_START_GATE
// file exists. It writes ACME_START_HELD when it begins to wait: the gap between the old
// process's exit and the adoption.
export const HELD_LOAD = {
  'lib/adapters/env/none.mjs': (text) =>
    `import { existsSync as acmeExists, readFileSync as acmeRead, writeFileSync as acmeWrite } from 'node:fs';\nimport { join as acmeJoin } from 'node:path';\n${hook(
      text,
      'export function create(options = {}, ctx = {}) {\n',
      `export function create(options = {}, ctx = {}) {
  const acmeGate = process.env.ACME_START_GATE;
  if (ctx.stateDir && String(process.argv[1] ?? '').endsWith('supervisor.mjs') && acmeGate && !acmeExists(acmeGate)) {
    let acmeRestarted = false;
    try {
      acmeRestarted = acmeRead(acmeJoin(ctx.stateDir, 'events.jsonl'), 'utf8').includes('"Restarted on new code');
    } catch {}
    if (acmeRestarted) {
      acmeWrite(process.env.ACME_START_HELD, '');
      const pause = new Int32Array(new SharedArrayBuffer(4));
      for (const end = Date.now() + ${slow(60_000)}; !acmeExists(acmeGate) && Date.now() < end; ) Atomics.wait(pause, 0, 0, 100);
    }
  }
`,
    )}`,
};

export let repos = null;
export let clone;
export let state;
export let plug;
let bin;
let log;
export let pids;
export let go;
export let fixtureEnv;

// The project (Acme) with `ids` as its stories, `extra` on top of the config, and the plugin
// copy with `fixtures` (file → change) made to it.
export function setup(extra, ids, fixtures = {}) {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, ...extra });
  clone = repos.clone('acme');
  state = join(clone, '.foreman');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  for (const id of ids) writeFileSync(join(clone, 'stories', `${id}.md`), STORY(id));
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add the stories');
  git(clone, 'push', '-q', 'origin', 'main');
  plug = join(repos.base, 'plug');
  cpSync(PLUGIN, plug, { recursive: true, filter: (src) => !src.endsWith('.test.mjs') });
  for (const [file, change] of Object.entries(fixtures)) writeFileSync(join(plug, file), change(readFileSync(join(plug, file), 'utf8')));
  git(repos.base, 'init', '-q', '-b', 'main', plug);
  git(plug, 'add', '-A');
  git(plug, 'commit', '-qm', 'The plugin');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
  pids = join(repos.base, 'pids');
  go = join(repos.base, 'go');
  fixtureEnv = { FAKE_COMMIT: join(repos.base, 'commit'), FAKE_TERM: join(repos.base, 'term'), FAKE_GO2: join(repos.base, 'go2'), ACME_PREPARE_GATE: join(repos.base, 'prepared'), ACME_HOLD_FOR: join(pids, 'ACME-1'), ACME_HELD: join(repos.base, 'held'), ACME_START_GATE: join(repos.base, 'start'), ACME_START_HELD: join(repos.base, 'start-held'), ACME_SESSION_CONFIG: join(repos.base, 'session-config'), FAKE_PLUGIN_PATH: join(repos.base, 'cache', 'foreman', '0.0.1') };
}

export const pidOf = (id) => (existsSync(join(pids, id)) ? Number(readFileSync(join(pids, id), 'utf8')) : null);
export const isUp = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Registers the hooks that end what a test left running and remove its repos; the supervisors
// first (vitest runs afterEach hooks last first).
export function withRestartRepos() {
  afterEach(() => {
    if (!repos) return;
    // A fake session the run did not end must not outlive the test.
    for (const id of existsSync(pids) ? readdirSync(pids) : []) {
      const pid = pidOf(id);
      // Never 0 or less: kill(-0) would signal the test's own process group.
      if (!Number.isInteger(pid) || pid <= 1) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    repos.cleanup();
    repos = null;
  });
  useSupervisors();
}

export const runEnv = (mode) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', FAKE_CLAUDE_LOG: log, FAKE_PLUG: plug, FAKE_PIDS: pids, FAKE_GO: go, FAKE_MODE: mode, ...fixtureEnv };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return env;
};

export const read = (name, fallback) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8') : fallback);
export const events = () => read('events.jsonl', '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
export const texts = () => events().map((e) => e.text);
export const stateJson = () => {
  try {
    return JSON.parse(read('state.json', '{}'));
  } catch {
    return {};
  }
};
export const slotState = (slot) => {
  try {
    return JSON.parse(read(join('slots', `${slot}.json`), '{}')).state ?? 'idle';
  } catch {
    return null;
  }
};
export const started = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
export const runRecords = () => {
  const dir = join(state, 'runs');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};
export const until = async (ok, ms) => {
  for (const end = Date.now() + slow(ms); Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (ok()) return true;
  return ok();
};
export const restartEvents = () => texts().map((t) => t.match(/^Restarted on new code \(([0-9a-f]+) -> ([0-9a-f]+)\)\.$/)).filter(Boolean);

// Starts `foreman run --foreground [args]`; stop() writes STOP and resolves with the exit code
// (a run that does not end in 20 s is killed). `env` is added to the run's environment and `node`
// is the Node that runs `foreman` (this process's by default).
export function startRun(mode, args = [], { env = {}, node } = {}) {
  const child = startForeman(['run', '--foreground', ...args], { cwd: clone, env: { ...runEnv(mode), ...env }, stdio: 'ignore', bin: join(plug, 'bin', 'foreman'), stateDir: state, ...(node ? { node } : {}) });
  const exited = child.exited;
  return {
    exited,
    async stop() {
      writeFileSync(join(state, 'STOP'), '');
      const timer = setTimeout(() => endChild(child), slow(20_000));
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

// Runs `foreman <args>` from the plugin copy, in the run's environment for `mode`.
export const foremanCli = (mode, ...args) => runForeman(args, { cwd: clone, env: runEnv(mode), encoding: 'utf8', bin: join(plug, 'bin', 'foreman'), stateDir: state });
