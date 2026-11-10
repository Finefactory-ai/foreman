// The supervisor reads each state file once, however long it runs, and keeps its event log small.
// A real foreground supervisor on a state folder with 200 decisions, 500 stories (notes and
// overlays) and 2 claims, all older than the racy window of read-cache.mjs. A preload wraps the
// supervisor's file opens and folder listings and logs each one, so the test counts them. Nothing
// is buildable, so the run sits on standby, and the same count over its quiet ticks shows the
// snapshot is not rebuilt while nothing changes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, makeRepos } from '../../../test/state-repos.mjs';
import { fastTick, TEST_TICK_MS } from '../../../test/fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from '../../../test/supervisors.mjs';
import { ownerClaim } from './locks.mjs';
import { RACY_MS } from './read-cache.mjs';
import { EVENTS_ROTATE_BYTES } from './state.mjs';

const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

// Preloaded with --import. In the supervisor only, it logs each file opened for reading
// (readFileSync, openSync for reading) and each folder listed, as { t, op, path }. A call made
// inside another counted call counts once. syncBuiltinESMExports() carries the wrapped functions
// into the named imports of the modules.
const RECORDER = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const out = process.env.READ_LOG;
if (out && String(process.argv[1] ?? '').endsWith('engine/supervisor.mjs')) {
  const { appendFileSync } = fs;
  let depth = 0;
  const wrap = (name, op, counts) => {
    const original = fs[name];
    fs[name] = function (p, ...rest) {
      depth++;
      try {
        if (depth === 1 && counts(rest) && (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p))) {
          appendFileSync(out, JSON.stringify({ t: Date.now(), op, path: String(p) }) + '\\n');
        }
        return original.call(this, p, ...rest);
      } finally {
        depth--;
      }
    };
  };
  wrap('readFileSync', 'read', () => true);
  wrap('readdirSync', 'list', () => true);
  wrap('openSync', 'read', ([flags]) => flags === undefined || flags === 'r' || flags === 'rs');
  syncBuiltinESMExports();
}
`;

// The notes are not final (todo) and each overlay says done, so the effective status is done (the
// run sits on standby) and list() has to read every overlay.
const note = (id) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\ndepends_on: []\n---\n\nDo ${id}.\n\n## Progress notes\n`;

let repos;
let clone;
let bin;
let readLog;
let child;

beforeEach(() => {
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false } });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  readLog = join(repos.base, 'reads.log');
  writeFileSync(readLog, '');
  child = null;
});
afterEach(() => {
  if (child && child.exitCode === null) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  repos.cleanup();
});
// After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
useSupervisors();

const stateDir = () => join(clone, '.foreman');

// The fixture: 500 stories (notes, committed and pushed, and overlays), 200 decisions, 2 owner
// claims (on the two stories that are open: the owner-claim sweep clears one on a done story), and an event log past the rotation limit. Every file and then every folder is dated an
// hour back, so the cache trusts it from the first read.
function fixture() {
  const pad = (n, w) => String(n).padStart(w, '0');
  const files = [];
  const put = (file, text) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    files.push(file);
  };
  for (let n = 1; n <= 500; n++) {
    put(join(clone, 'stories', `ACME-${n}.md`), note(`ACME-${n}`));
    put(join(stateDir(), 'stories', `ACME-${n}.json`), JSON.stringify({ id: `ACME-${n}`, status: n <= 2 ? 'in-progress' : 'done', fields: {}, notes: [] }));
  }
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add 500 stories');
  git(clone, 'push', '-q', 'origin', 'main');
  for (let n = 1; n <= 200; n++) {
    const id = `d-20261101${pad(n, 6)}-${pad(n.toString(16), 4)}`;
    put(join(stateDir(), 'decisions', `${id}.json`), JSON.stringify({ id, story: `ACME-${n}`, kind: 'decision', title: `ACME-${n} could not pass review`, options: ['Retry', "I'll take it", 'Drop'], urgent: false, body: '', createdAt: `2026-11-01T00:00:${pad(n % 60, 2)}.000Z`, answer: null, appliedAt: null }));
  }
  ownerClaim(stateDir(), 'ACME-1');
  ownerClaim(stateDir(), 'ACME-2');
  files.push(join(stateDir(), 'claims', 'ACME-1.json'), join(stateDir(), 'claims', 'ACME-2.json'));
  const lines = [];
  let size = 0;
  for (let i = 0; size <= EVENTS_ROTATE_BYTES; i++) {
    const line = `${JSON.stringify({ at: `2026-11-01T00:00:00.${pad(i % 1000, 3)}Z`, text: `old event ${i}`, kind: 'info', slot: null })}\n`;
    lines.push(line);
    size += line.length;
  }
  put(join(stateDir(), 'events.jsonl'), lines.join(''));
  const hourAgo = new Date(Date.now() - 3_600_000);
  for (const file of files) utimesSync(file, hourAgo, hourAgo);
  for (const folder of [join(clone, 'stories'), join(stateDir(), 'decisions'), join(stateDir(), 'claims'), join(stateDir(), 'stories')]) utimesSync(folder, hourAgo, hourAgo);
}

const runEnv = (extra) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, ...extra };
};

const loop = () => {
  try {
    return JSON.parse(readFileSync(join(stateDir(), 'state.json'), 'utf8')).loop ?? null;
  } catch {
    return null;
  }
};
const reads = () =>
  readFileSync(readLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => ({ ...r, path: r.path.replaceAll('\\', '/') }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what, test, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`the run exited (${child.exitCode}) while waiting for ${what}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}; loop ${JSON.stringify(loop())}`);
}

// How often each path was opened (op read) or listed (op list), among the paths `match` takes.
const countBy = (entries, op, match) => {
  const counts = new Map();
  for (const e of entries) if (e.op === op && match(e.path)) counts.set(e.path, (counts.get(e.path) ?? 0) + 1);
  return counts;
};
const most = (counts) => Math.max(0, ...counts.values());

describe('the supervisor on a big state folder', () => {
  it('opens each decision, story, overlay, claim and state.json once, rotates the log, and does not rebuild the snapshot while nothing changes', async () => {
    fixture();
    const recorder = join(repos.base, 'record-reads.mjs');
    writeFileSync(recorder, RECORDER);
    const env = runEnv({ NODE_OPTIONS: `--import=${pathToFileURL(recorder).href}`, READ_LOG: readLog });

    child = startForeman(['run', '--foreground'], { cwd: clone, env, stdio: ['ignore', 'ignore', 'ignore'] });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    await waitFor('standby', () => loop()?.state === 'standby', 60_000);
    await sleep(RACY_MS + 4 * TEST_TICK_MS);
    const t0 = Date.now();
    await sleep(6 * TEST_TICK_MS);
    const t1 = Date.now();
    expect(child.exitCode).toBeNull();
    expect(runForeman(['stop'], { cwd: clone, env, encoding: 'utf8', timeout: 30_000 }).status).toBe(0);
    expect(await exited).toBe(0);

    const all = reads();
    const decisions = countBy(all, 'read', (p) => /\/\.foreman\/decisions\/d-\d{14}-[0-9a-f]{4}\.json$/.test(p));
    const notes = countBy(all, 'read', (p) => /\/stories\/ACME-\d+\.md$/.test(p) && !p.includes('/.foreman/'));
    const overlays = countBy(all, 'read', (p) => /\/\.foreman\/stories\/ACME-\d+\.json$/.test(p));
    const claims = countBy(all, 'read', (p) => /\/\.foreman\/claims\/[^/]+\.json$/.test(p));
    const states = countBy(all, 'read', (p) => /\/\.foreman\/state\.json$/.test(p));
    const folders = countBy(all, 'list', (p) => /\/\.foreman\/(decisions|claims)$/.test(p) || (/\/stories$/.test(p) && !p.includes('/.foreman/')));

    // The supervisor did read them, and read each at most once over the whole run.
    expect([decisions.size, notes.size]).toEqual([200, 500]);
    expect(claims.size).toBe(2);
    expect(most(decisions)).toBe(1);
    expect(most(notes)).toBe(1);
    expect(overlays.size).toBe(500);
    expect(most(overlays)).toBe(1);
    expect(most(claims)).toBe(1);
    expect(most(states)).toBeLessThanOrEqual(1);
    expect(folders.size).toBe(3);
    expect(most(folders)).toBe(1);

    // While nothing changed, the snapshot was not rebuilt: its events.jsonl is read at most once
    // between t0 and t1 (a change of minute may rebuild it once).
    const quiet = all.filter((e) => e.op === 'read' && e.t >= t0 && e.t < t1 && /\/\.foreman\/events\.jsonl$/.test(e.path));
    expect(quiet.length).toBeLessThanOrEqual(1);

    // The 5 MB log moved to a dated file, and the page still shows the 40 newest events.
    const rotated = readdirSync(stateDir()).filter((f) => /^events-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jsonl$/.test(f));
    expect(rotated).toHaveLength(1);
    expect(readFileSync(join(stateDir(), rotated[0]), 'utf8')).toContain('old event 0');
    const live = join(stateDir(), 'events.jsonl');
    expect(!existsSync(live) || statSync(live).size < EVENTS_ROTATE_BYTES).toBe(true);
    expect(!existsSync(live) || readFileSync(live, 'utf8')).not.toContain('old event');
    const shown = JSON.parse(readFileSync(join(stateDir(), 'status.json'), 'utf8')).events;
    expect(shown).toHaveLength(40);
    expect(shown.map((e) => e.at)).toEqual([...shown.map((e) => e.at)].sort().reverse());
    expect(shown.some((e) => e.text.startsWith('Factory standby'))).toBe(true);
  }, 120_000);
});
