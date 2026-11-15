// The real kill: a `foreman ship` process that gets SIGTERM while a step waits says so on its last
// line, exits 1 and, when nothing could be live, leaves no ship lock behind.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { makeShipCommand } from './ship.mjs';
import { fakeSh } from '../../../../test/ship-fakes.mjs';
import { fakePack } from '../../../../test/fake-pack.mjs';
import { noteOnStory } from '../../engine/story-notes.mjs';

vi.mock('../../engine/story-notes.mjs', async (importOriginal) => ({ ...(await importOriginal()), noteOnStory: vi.fn() }));

const here = (rel) => pathToFileURL(new URL(rel, import.meta.url).pathname).href;
const SHIP = here('./ship.mjs');
const FAKE_SH = here('../../../../test/ship-fakes.mjs');
const FAKE_PACK = here('../../../../test/fake-pack.mjs');

// The script a child process runs: the real command and runner, a fake shell and a pack whose one
// step waits a minute.
const SCRIPT = `
import { makeShipCommand } from ${JSON.stringify(SHIP)};
import { fakeSh } from ${JSON.stringify(FAKE_SH)};
import { fakePack } from ${JSON.stringify(FAKE_PACK)};

const dir = process.argv[2];
const pointOfNoReturn = process.argv[3] === 'point-of-no-return';
const wait = {
  name: 'acme-wait',
  needs: [],
  ...(pointOfNoReturn ? { pointOfNoReturn: true } : {}),
  run: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 60_000)),
};
const sh = fakeSh([
  ['git rev-parse --abbrev-ref HEAD', 'story/app-1\\n'],
  ['git status --porcelain', ''],
  ['git rev-list --count', '1\\n'],
]);
const command = makeShipCommand({ sh, packs: { acme: fakePack({ steps: { 'acme-wait': wait } }) } });
const code = await command.run(['--story', 'APP-1'], { cwd: dir, root: dir, env: process.env, stdout: process.stdout, stderr: process.stderr });
process.exit(code);
`;

let dir;
let home;
let child;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-ship-kill-'));
  home = mkdtempSync(join(tmpdir(), 'foreman-ship-kill-home-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'acme', ship: { steps: ['acme-wait'] } }));
  writeFileSync(join(dir, 'run-ship.mjs'), SCRIPT);
  mkdirSync(join(dir, '.foreman'), { recursive: true });
});

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const lockFile = () => join(dir, '.foreman', 'locks', 'ship.json');
const lockStage = () => {
  try {
    return JSON.parse(readFileSync(lockFile(), 'utf8')).stage;
  } catch {
    return null;
  }
};

// Starts the script, waits until the step holds the lock, sends SIGTERM to that child only, and
// gives what it left.
async function killed(variant) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(FOREMAN_|FACTORY_|GIT_)/.test(k)));
  Object.assign(env, { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', HOME: home });
  child = spawn(process.execPath, [join(dir, 'run-ship.mjs'), dir, variant], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const ended = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20_000;
  while (lockStage() !== 'acme-wait' && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  expect(lockStage(), stderr).toBe('acme-wait');
  child.kill('SIGTERM');
  const { code, signal } = await ended;
  const lines = stdout.trim().split('\n');
  return { code, signal, stderr, last: JSON.parse(lines[lines.length - 1]) };
}

describe('foreman ship killed by SIGTERM', () => {
  it('before anything is live, says it was interrupted, exits 1 and leaves no ship lock', async () => {
    const r = await killed('plain');
    expect(r.signal).toBeNull();
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ ok: false, code: 1, stage: 'interrupted', step: 'acme-wait', signal: 'SIGTERM', lockReleased: true, story: 'APP-1' });
    expect(existsSync(lockFile())).toBe(false);
  });

  it('at a point of no return, says so and keeps the lock as the record of where it stopped', async () => {
    const r = await killed('point-of-no-return');
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ ok: false, code: 1, stage: 'interrupted', step: 'acme-wait', lockReleased: false });
    expect(lockStage()).toBe('acme-wait');
  });
});

describe('the signal handlers of foreman ship', () => {
  // A command whose runner only hands back what the command gave it.
  async function wired({ answer = { code: 1, result: { stage: 'interrupted', step: 'ci', signal: 'SIGTERM', lockReleased: true } }, during = null } = {}) {
    const signals = new EventEmitter();
    const exits = [];
    const writes = [];
    let given = null;
    let offCalled = 0;
    const command = makeShipCommand({
      sh: fakeSh([]),
      packs: { acme: fakePack({ steps: { 'acme-wait': { name: 'acme-wait', needs: [], run: async () => ({ ok: true }) } } }) },
      signals,
      exit: (code) => exits.push(code),
      runShip: async ({ ctx, interrupts }) => {
        given = { ctx, stopped: () => answer, interrupts };
        const off = interrupts(() => answer);
        given.off = () => {
          offCalled += 1;
          off();
        };
        // A signal while the release runs, and the release returns before the process exits.
        if (during) return during(answer);
        return { code: 0, result: { stage: 'shipped' } };
      },
    });
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'acme', ship: { steps: ['acme-wait'] } }));
    const stdout = { write: (text, cb) => (writes.push(text), cb) };
    const run = () => command.run(['--story', 'APP-1'], { cwd: dir, root: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout, stderr: { write: () => {} } });
    return { signals, exits, writes, run, given: () => given, offCalled: () => offCalled, stdout };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('listens for SIGTERM, SIGINT and SIGHUP once the runner asks, and for nothing after it switches them off', async () => {
    const w = await wired();
    await w.run();
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) expect(w.signals.listenerCount(name)).toBe(1);
    w.given().off();
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) expect(w.signals.listenerCount(name)).toBe(0);
  });

  it('prints the interrupted JSON line, exits with its code once the line is written, and only once', async () => {
    const w = await wired();
    await w.run();
    w.signals.emit('SIGTERM');
    w.signals.emit('SIGINT');
    const printed = w.writes.filter((t) => t.includes('"interrupted"'));
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0])).toMatchObject({ ok: false, code: 1, stage: 'interrupted', step: 'ci', lockReleased: true });
    expect(printed[0].endsWith('\n')).toBe(true);
    expect(w.exits).toEqual([]);
  });

  it('exits when the write finishes', async () => {
    const w = await wired();
    await w.run();
    const cbs = [];
    w.stdout.write = (text, cb) => (cbs.push(cb), true);
    w.signals.emit('SIGHUP');
    expect(w.exits).toEqual([]);
    cbs[0]();
    cbs[0]();
    expect(w.exits).toEqual([1]);
  });

  it('exits after a second anyway when the write never finishes', async () => {
    const w = await wired();
    await w.run();
    w.stdout.write = () => true;
    w.signals.emit('SIGTERM');
    expect(w.exits).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(w.exits).toEqual([1]);
  });

  it('a release that returns after the signal prints nothing more and writes nothing on the story', async () => {
    const answer = { code: 1, result: { stage: 'interrupted', step: 'merge', signal: 'SIGTERM', lockReleased: false } };
    let w;
    w = await wired({
      answer,
      during: async () => {
        w.signals.emit('SIGTERM');
        return answer;
      },
    });
    noteOnStory.mockClear();
    const code = await w.run();
    expect(code).toBe(1);
    const lines = w.writes.filter((t) => t.trim().startsWith('{'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ ok: false, code: 1, stage: 'interrupted', lockReleased: false });
    expect(noteOnStory).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(w.exits).toEqual([1]);
  });

  it('prints the progress lines the runner reports, before the JSON', async () => {
    const w = await wired();
    await w.run();
    w.given().ctx.progress('still releasing APP-1: ci (1 min)');
    expect(w.writes).toContain('still releasing APP-1: ci (1 min)\n');
  });
});
