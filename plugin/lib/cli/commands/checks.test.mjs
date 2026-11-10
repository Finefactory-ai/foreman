import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import checks from './checks.mjs';
import { main } from '../main.mjs';
import { checkTotals, readCheckRuns } from '../../engine/check-runs.mjs';
import { claimPath, releaseClaim, takeClaim } from '../../engine/check-claims.mjs';
import { sessionEnvPath } from '../../engine/session-env.mjs';
import { readResult } from '../../engine/check-jobs.mjs';
import { CHECK_RUNNING_DIR, CHECK_SLOTS_DIR, enterRun, setRun, stopRun } from '../../engine/check-slots.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-checks-'));
});

const CHECKS = [
  { run: 'npm test', when: 'always' },
  { run: 'npm run lint:sql', when: 'db/**/*.sql' },
  { run: 'npm run test:ui', when: 'src/ui/**' },
];

function write(list = CHECKS, extra = {}) {
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, checks: list, ...extra }));
}

// A fake git: `committed` answers the diff against the base, `untracked` ls-files, `dirty`
// the uncommitted diff. `baseFails` makes the base diff fail.
function fakeGit({ committed = [], untracked = [], dirty = [], baseFails = false } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    const out = (list) => ({ status: 0, stdout: list.map((f) => `${f}\n`).join('') });
    if (args[0] === 'diff' && args.some((a) => a.includes('...'))) return baseFails ? { status: 128, stdout: '' } : out(committed);
    if (args[0] === 'ls-files') return out(untracked);
    if (args[0] === 'diff') return out(dirty);
    return { status: 1, stdout: '' };
  };
  return { git, calls };
}

function fakeExec(failing = []) {
  const ran = [];
  const exec = async (cmd, { cwd }) => {
    ran.push({ cmd, cwd });
    return failing.includes(cmd) ? 1 : 0;
  };
  return { exec, ran };
}

async function run(args, { git, exec, cwd = path.join(dir, 'worktree') } = {}) {
  let out = '';
  let err = '';
  const code = await checks.run(args, {
    root: dir,
    cwd,
    env: {},
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    git,
    exec,
  });
  return { code, out, err };
}

describe('foreman checks', () => {
  it('without --changed runs only the always checks, in the current folder', async () => {
    write();
    const { exec, ran } = fakeExec();
    const { code, out } = await run([], { git: fakeGit({ committed: ['db/1.sql'] }).git, exec });
    expect(code).toBe(0);
    expect(ran).toEqual([{ cmd: 'npm test', cwd: path.join(dir, 'worktree') }]);
    expect(out).toContain('PASS npm test\n');
  });

  it('--all runs every check, also a glob check that --changed would skip', async () => {
    write();
    const changed = fakeExec();
    await run(['--changed'], { git: fakeGit({ committed: ['README.md'] }).git, exec: changed.exec });
    expect(changed.ran.map((r) => r.cmd)).toEqual(['npm test']);
    const { exec, ran } = fakeExec();
    const { code, out } = await run(['--all'], { git: fakeGit({ committed: ['README.md'] }).git, exec });
    expect(code).toBe(0);
    expect(ran.map((r) => r.cmd)).toEqual(['npm test', 'npm run lint:sql', 'npm run test:ui']);
    expect(out).toContain('PASS npm run test:ui\n');
  });

  it('--all with --changed exits 64 and runs nothing', async () => {
    write();
    const { exec, ran } = fakeExec();
    const res = await run(['--all', '--changed'], { git: fakeGit().git, exec });
    expect(res.code).toBe(64);
    expect(res.err).toContain('--all cannot be combined with --changed');
    expect(res.err).toContain('usage: foreman checks [--changed] [--reuse]');
    expect(ran).toEqual([]);
  });

  it('--changed adds the checks whose glob matches a changed, untracked or uncommitted file', async () => {
    write();
    const { exec, ran } = fakeExec();
    const { git, calls } = fakeGit({ committed: ['db/migrations/001.sql'], untracked: ['src/ui/Button.js'] });
    const { code, out } = await run(['--changed'], { git, exec });
    expect(code).toBe(0);
    expect(ran.map((r) => r.cmd)).toEqual(['npm test', 'npm run lint:sql', 'npm run test:ui']);
    expect(out).toContain('PASS npm run lint:sql\n');
    expect(calls).toContain('diff --name-only origin/main...HEAD');
    expect(calls).toContain('ls-files --others --exclude-standard');
  });

  it('--changed sees uncommitted changes', async () => {
    write();
    const { exec, ran } = fakeExec();
    await run(['--changed'], { git: fakeGit({ dirty: ['src/ui/x.js'] }).git, exec });
    expect(ran.map((r) => r.cmd)).toEqual(['npm test', 'npm run test:ui']);
  });

  it('diffs against the configured remote and base branch', async () => {
    write(CHECKS, { remote: 'upstream', baseBranch: 'trunk' });
    const { git, calls } = fakeGit();
    await run(['--changed'], { git, exec: fakeExec().exec });
    expect(calls).toContain('diff --name-only upstream/trunk...HEAD');
  });

  it('--changed with no matching file runs only the always checks', async () => {
    write();
    const { exec, ran } = fakeExec();
    await run(['--changed'], { git: fakeGit({ committed: ['README.md'] }).git, exec });
    expect(ran.map((r) => r.cmd)).toEqual(['npm test']);
  });

  it('runs every check when the base cannot be diffed, and says so', async () => {
    write();
    const { exec, ran } = fakeExec();
    const { err } = await run(['--changed'], { git: fakeGit({ baseFails: true }).git, exec });
    expect(ran.map((r) => r.cmd)).toEqual(['npm test', 'npm run lint:sql', 'npm run test:ui']);
    expect(err).toContain('origin/main');
  });

  it('a failing check prints FAIL, the rest still run, and the exit is 1', async () => {
    write([
      { run: 'npm test', when: 'always' },
      { run: 'npm run lint', when: 'always' },
    ]);
    const { exec, ran } = fakeExec(['npm test']);
    const { code, out } = await run([], { git: fakeGit().git, exec });
    expect(code).toBe(1);
    expect(ran).toHaveLength(2);
    expect(out).toContain('FAIL npm test');
    expect(out).toContain('PASS npm run lint');
  });

  it('exits 0 with a note when there are no checks', async () => {
    write([]);
    const { exec, ran } = fakeExec();
    const { code, out } = await run(['--changed'], { git: fakeGit().git, exec });
    expect(code).toBe(0);
    expect(ran).toEqual([]);
    expect(out).toMatch(/no checks/i);
  });

  it('exits 1 on a bad config and 64 on an unknown flag', async () => {
    expect((await run([], { git: fakeGit().git, exec: fakeExec().exec })).code).toBe(1);
    write();
    expect((await run(['--nope'], { git: fakeGit().git, exec: fakeExec().exec })).code).toBe(64);
  });

  it('really runs the commands with sh, streaming their output', async () => {
    write([
      { run: 'echo hello-from-check', when: 'always' },
      { run: 'exit 3', when: 'always' },
    ]);
    let out = '';
    const code = await main(['checks'], {
      cwd: dir,
      env: { ...process.env, FOREMAN_PROJECT_DIR: dir },
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    expect(code).toBe(1);
    expect(out).toContain('hello-from-check');
    expect(out).toContain('PASS echo hello-from-check');
    expect(out).toContain('FAIL exit 3');
  });
});

// --- Recording and --reuse -------------------------------------------------------------

const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// A real repo at <dir>/repo with one committed file; the config stays in <dir>, the root.
function realRepo() {
  const r = path.join(dir, 'repo');
  fs.mkdirSync(r);
  gitIn(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'a\n');
  gitIn(r, 'add', '-A');
  gitIn(r, 'commit', '-q', '-m', 'one');
  return r;
}

// A fake exec that counts calls and answers { code, output }.
function countingExec({ failing = [], output = 'all good\n' } = {}) {
  const ran = [];
  const exec = async (cmd) => {
    ran.push(cmd);
    return { code: failing.includes(cmd) ? 1 : 0, output: `${cmd} said\n${output}` };
  };
  return { exec, ran };
}

const stateOf = () => path.join(dir, 'state');
const recordFile = () => path.join(stateOf(), 'check-runs.jsonl');
const records = () => (fs.existsSync(recordFile()) ? fs.readFileSync(recordFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// A clock that moves 250 ms per call.
function stepClock(start = '2026-10-26T10:00:00.000Z') {
  let t = Date.parse(start);
  return () => {
    const d = new Date(t);
    t += 250;
    return d;
  };
}

// The environment the supervisor would have given a slot's session, and its file in the temp
// state folder (the file is what `foreman checks` runs the checks in).
const sessionEnv = (extra = {}) => ({
  PATH: process.env.PATH,
  ACME_SESSION_VAR: 'yes',
  FOREMAN_RUN: '1',
  FOREMAN_SLOT: 'w1',
  FOREMAN_STORY: 'ACME-1',
  FOREMAN_STATE_DIR: stateOf(),
  ...extra,
});
function seedSession(env) {
  const file = sessionEnvPath(env.FOREMAN_STATE_DIR, env.FOREMAN_SLOT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(env));
}

// session (default): `env` is added to a session env whose file is seeded, and `shell` to the
// caller's copy only. session: false: a plain shell outside a story session.
async function runReal(args, { cwd, exec, git = fakeGit().git, env = {}, shell = {}, session = true, hashTree, now, claimAlive: alive, pause, ctx = {} } = {}) {
  let out = '';
  let err = '';
  let callerEnv = { FOREMAN_STATE_DIR: stateOf(), ...env };
  if (session) {
    const inSession = sessionEnv(env);
    seedSession(inSession);
    callerEnv = { ...inSession, ...shell };
  }
  const code = await checks.run(args, {
    root: dir,
    cwd,
    env: callerEnv,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    git,
    exec,
    ...(hashTree ? { hashTree } : {}),
    ...(now ? { now } : {}),
    ...(alive ? { claimAlive: alive } : {}),
    ...(pause ? { pause } : {}),
    ...ctx,
  });
  return { code, out, err };
}

describe('foreman checks: recording and --reuse', () => {
  it('a second --reuse on the unchanged tree prints the record without running; an edit or a new file runs again', async () => {
    write();
    const r = realRepo();
    const { exec, ran } = countingExec();
    const first = await runReal(['--reuse'], { cwd: r, exec });
    expect(first.code).toBe(0);
    expect(ran).toEqual(['npm test']);
    expect(first.out).toContain('PASS npm test\n');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ run: 'npm test', exit: 0, full: true });
    expect(records()[0].tree).toBe(gitIn(r, 'rev-parse', 'HEAD^{tree}').trim());

    const second = await runReal(['--reuse'], { cwd: r, exec });
    expect(second.code).toBe(0);
    expect(ran).toHaveLength(1);
    expect(second.out).toContain('$ npm test\n');
    expect(second.out).toContain('reused:');
    expect(second.out).toContain(`(${records()[0].tree.slice(0, 12)})`);
    expect(second.out).toContain('npm test said\nall good');
    expect(second.out).toContain('PASS npm test (reused)\n');
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ run: 'npm test', reused: true, from: records()[0].at, tree: records()[0].tree });

    fs.writeFileSync(path.join(r, 'a.txt'), 'edited\n');
    await runReal(['--reuse'], { cwd: r, exec });
    expect(ran).toHaveLength(2);

    await runReal(['--reuse'], { cwd: r, exec });
    expect(ran).toHaveLength(2);

    fs.writeFileSync(path.join(r, 'new.txt'), 'n\n');
    await runReal(['--reuse'], { cwd: r, exec });
    expect(ran).toHaveLength(3);
  });

  it('reuses a recorded failure as FAIL, exit 1, without running', async () => {
    write();
    const r = realRepo();
    const first = countingExec({ failing: ['npm test'] });
    expect((await runReal([], { cwd: r, exec: first.exec })).code).toBe(1);
    const { exec, ran } = countingExec();
    const again = await runReal(['--reuse'], { cwd: r, exec });
    expect(again.code).toBe(1);
    expect(ran).toEqual([]);
    expect(again.out).toContain('FAIL npm test (exit 1, reused)\n');
  });

  it('without --reuse always runs, and records story, slot, full, exit, ms and the tail', async () => {
    write();
    const r = realRepo();
    const { exec, ran } = countingExec();
    const env = { FOREMAN_STORY: 'S-7', FOREMAN_SLOT: 'w3' };
    await runReal([], { cwd: r, exec, env });
    const git = fakeGit({ committed: ['db/1.sql'] }).git;
    const second = await runReal(['--changed'], { cwd: r, exec, env, git, now: stepClock() });
    expect(second.code).toBe(0);
    expect(ran).toEqual(['npm test', 'npm test', 'npm run lint:sql']);
    expect(second.out).not.toContain('reused');
    const [, full, glob] = records();
    expect(full).toMatchObject({ story: 'S-7', slot: 'w3', run: 'npm test', full: true, exit: 0, ms: 250, tail: 'npm test said\nall good' });
    expect(full.at).toMatch(/^2026-10-26T10:00:00\.\d{3}Z$/);
    expect(full).not.toHaveProperty('reused');
    expect(glob).toMatchObject({ story: 'S-7', slot: 'w3', run: 'npm run lint:sql', full: false, exit: 0, ms: 250 });
  });

  it('records story and slot as null outside a story session', async () => {
    write();
    const r = realRepo();
    await runReal([], { cwd: r, exec: countingExec().exec, session: false });
    expect(records()[0]).toMatchObject({ story: null, slot: null });
  });

  it('accepts an exec that answers a plain exit code, recording an empty tail', async () => {
    write();
    const r = realRepo();
    await runReal([], { cwd: r, exec: fakeExec().exec });
    expect(records()[0]).toMatchObject({ exit: 0, tail: '' });
  });

  it('blanks secrets out of the recorded tail', async () => {
    write();
    const r = realRepo();
    const secret = 'acme-token-value-12345';
    const exec = async () => ({ code: 0, output: `using ${secret}\nok\n` });
    await runReal([], { cwd: r, exec, env: { ACME_TOKEN: secret } });
    expect(records()[0].tail).not.toContain(secret);
    expect(records()[0].tail).toContain('ok');
  });

  it('--changed --reuse reuses each check that has a record and runs the rest', async () => {
    write();
    const r = realRepo();
    const { exec, ran } = countingExec();
    await runReal([], { cwd: r, exec });
    const git = fakeGit({ committed: ['db/1.sql'] }).git;
    const again = await runReal(['--changed', '--reuse'], { cwd: r, exec, git });
    expect(again.code).toBe(0);
    expect(ran).toEqual(['npm test', 'npm run lint:sql']);
    expect(again.out).toContain('PASS npm test (reused)\n');
    expect(again.out).toContain('PASS npm run lint:sql\n');
  });

  it('runs and warns, recording nothing, when the tree cannot be hashed', async () => {
    write();
    const { exec, ran } = countingExec();
    const res = await runReal(['--reuse'], { cwd: dir, exec, hashTree: () => null });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test']);
    expect(res.err).toContain('cannot hash this tree; running npm test');
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('records nothing when the tree changed during the run', async () => {
    write();
    const hashes = ['a'.repeat(40), 'b'.repeat(40)];
    let calls = 0;
    const hashTree = () => hashes[Math.min(calls++, 1)];
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: dir, exec, hashTree });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test']);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('carries the tree after a run on to the next check', async () => {
    write([
      { run: 'npm test', when: 'always' },
      { run: 'npm run lint', when: 'always' },
    ]);
    // The first check changes the tree (a → b); the second runs on b and leaves it b.
    const hashes = ['a'.repeat(40), 'b'.repeat(40), 'b'.repeat(40)];
    let calls = 0;
    const hashTree = () => hashes[Math.min(calls++, 2)];
    await runReal([], { cwd: dir, exec: countingExec().exec, hashTree });
    expect(records().map((e) => [e.run, e.tree[0]])).toEqual([['npm run lint', 'b']]);
  });

  it('keeps the exit code of the checks when the record cannot be written, with a warning', async () => {
    write();
    fs.writeFileSync(path.join(dir, 'blocker'), 'a file');
    const env = { FOREMAN_STATE_DIR: path.join(dir, 'blocker', 'state') };
    const pass = await runReal([], { cwd: dir, exec: countingExec().exec, env, session: false, hashTree: () => 'a'.repeat(40) });
    expect(pass.code).toBe(0);
    expect(pass.err).toMatch(/could not record/);
    const fail = await runReal([], { cwd: dir, exec: countingExec({ failing: ['npm test'] }).exec, env, session: false, hashTree: () => 'a'.repeat(40) });
    expect(fail.code).toBe(1);
    expect(fail.err).toMatch(/could not record/);
  });

  it('keeps the exit code and warns when the record file is a link, leaving its target alone', async () => {
    write();
    fs.mkdirSync(stateOf(), { recursive: true });
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'keep\n');
    fs.symlinkSync(target, path.join(stateOf(), 'check-runs.jsonl'));
    const pass = await runReal([], { cwd: dir, exec: countingExec().exec, session: false, hashTree: () => 'a'.repeat(40) });
    expect(pass.code).toBe(0);
    expect(pass.err).toMatch(/could not record the check run in .*not a regular file/);
    const fail = await runReal([], { cwd: dir, exec: countingExec({ failing: ['npm test'] }).exec, session: false, hashTree: () => 'a'.repeat(40) });
    expect(fail.code).toBe(1);
    expect(fail.err).toMatch(/could not record the check run in .*not a regular file/);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep\n');
  });

  it('keeps 64 for an unknown flag next to --reuse', async () => {
    write();
    const res = await runReal(['--reuse', '--nope'], { cwd: dir, exec: countingExec().exec });
    expect(res.code).toBe(64);
    expect(res.err).toContain('usage: foreman checks [--changed] [--reuse]');
  });

  it('shares one record file through the state folder across worktrees at the same commit', async () => {
    write([{ run: `echo x >> "${path.join(dir, 'count')}"; echo ran-the-check`, when: 'always' }]);
    const r = realRepo();
    gitIn(r, 'worktree', 'add', '-q', path.join(dir, 'wa'));
    gitIn(r, 'worktree', 'add', '-q', path.join(dir, 'wb'));
    const go = async (cwd, argv, slot) => {
      const env = sessionEnv({ FOREMAN_SLOT: slot });
      seedSession(env);
      let out = '';
      const code = await checks.run(argv, { root: dir, cwd, env, stdout: { write: (x) => { out += x; } }, stderr: { write: () => {} }, git: fakeGit().git });
      return { code, out };
    };
    const a = await go(path.join(dir, 'wa'), [], 'w1');
    expect(a.code).toBe(0);
    expect(a.out).toContain('ran-the-check');
    const b = await go(path.join(dir, 'wb'), ['--reuse'], 'w2');
    expect(b.code).toBe(0);
    expect(b.out).toContain('reused:');
    expect(b.out).toMatch(/PASS .* \(reused\)\n/);
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf8')).toBe('x\n');
  });
});

// --- The session environment and the run in progress ---------------------------------------

const treeOf = (r) => gitIn(r, 'rev-parse', 'HEAD^{tree}').trim();
const claimsDir = () => path.join(stateOf(), 'check-claims');
const claimFiles = () => (fs.existsSync(claimsDir()) ? fs.readdirSync(claimsDir()) : []);
const entry = (extra) => ({ at: '2026-10-31T09:05:00.000Z', story: 'ACME-2', slot: 'w2', run: 'npm test', full: true, exit: 0, ms: 1000, tail: 'other slot said\nfine', env: 'session', ...extra });
const putRecord = (e) => {
  fs.mkdirSync(stateOf(), { recursive: true });
  fs.appendFileSync(recordFile(), `${JSON.stringify(e)}\n`);
};

describe('foreman checks: the environment a check runs in', () => {
  const SHELL = 'echo "shell=${ACME_SHELL_ONLY:-unset} session=${ACME_SESSION_VAR:-unset}"';

  it('runs the check in the session env, so a variable set only on the calling shell is not visible', async () => {
    write([{ run: SHELL, when: 'always' }]);
    const r = realRepo();
    const res = await runReal([], { cwd: r, shell: { ACME_SHELL_ONLY: '1' } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('shell=unset session=yes');
    expect(res.err).toBe('');
    expect(records()[0]).toMatchObject({ env: 'session', exit: 0, story: 'ACME-1', slot: 'w1' });
    expect(records()[0].tail).toBe('shell=unset session=yes');
  });

  it('passes the session env to the exec, not the caller env', async () => {
    write();
    const r = realRepo();
    const seen = [];
    const exec = async (cmd, { env }) => {
      seen.push(env);
      return 0;
    };
    await runReal([], { cwd: r, exec, shell: { ACME_SHELL_ONLY: '1', NODE_OPTIONS: '--require /tmp/x.js' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(sessionEnv());
  });

  it('in a session whose file is missing, warns, uses the caller env, records env caller and never reuses that', async () => {
    write();
    const r = realRepo();
    const seen = [];
    const exec = async (cmd, { env }) => {
      seen.push(env.ACME_SHELL_ONLY ?? 'unset');
      return 0;
    };
    const env = sessionEnv({ ACME_SHELL_ONLY: 'visible' });
    const go = (args) => {
      let out = '';
      let err = '';
      return checks
        .run(args, { root: dir, cwd: r, env, stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, git: fakeGit().git, exec })
        .then((code) => ({ code, out, err }));
    };
    const first = await go([]);
    expect(first.code).toBe(0);
    expect(first.err).toContain("could not use this session's environment (cannot read ");
    expect(first.err).toContain('); running with this shell\'s, and this run will not be reused\n');
    expect(seen).toEqual(['visible']);
    expect(records()[0]).toMatchObject({ env: 'caller', exit: 0 });
    const again = await go(['--reuse']);
    expect(seen).toEqual(['visible', 'visible']);
    expect(again.out).not.toContain('reused');
  });

  it('does not trust an env file for a slot the supervisor never makes: a w9 run is a caller-env run and is never reused', async () => {
    write(); // slots: 1
    const r = realRepo();
    const seen = [];
    const exec = async (cmd, { env }) => {
      seen.push(env.ACME_SHELL_ONLY ?? 'unset');
      return 0;
    };
    const env = sessionEnv({ FOREMAN_SLOT: 'w9', ACME_SHELL_ONLY: 'visible' });
    seedSession(env);
    const go = (args) => {
      let err = '';
      let out = '';
      return checks
        .run(args, { root: dir, cwd: r, env, stdout: { write: (x) => { out += x; } }, stderr: { write: (x) => { err += x; } }, git: fakeGit().git, exec })
        .then((code) => ({ code, out, err }));
    };
    const first = await go(['--changed']);
    expect(first.err).toContain("could not use this session's environment (w9 is not one of this project's slots)");
    expect(seen).toEqual(['visible']);
    expect(records()[0]).toMatchObject({ env: 'caller', slot: 'w9', exit: 0 });
    const again = await go(['--changed', '--reuse']);
    expect(again.out).not.toContain('reused');
    expect(seen).toEqual(['visible', 'visible']);
  });

  it('says why when the file belongs to another session', async () => {
    write();
    const r = realRepo();
    seedSession(sessionEnv({ FOREMAN_STORY: 'ACME-9' }));
    let err = '';
    await checks.run([], { root: dir, cwd: r, env: sessionEnv(), stdout: { write: () => {} }, stderr: { write: (x) => { err += x; } }, git: fakeGit().git, exec: countingExec().exec });
    expect(err).toContain('belongs to another session: for ACME-9 in w1');
    expect(records()[0].env).toBe('caller');
  });

  it('outside a session says nothing and records env caller', async () => {
    write();
    const r = realRepo();
    const res = await runReal([], { cwd: r, exec: countingExec().exec, session: false });
    expect(res.err).toBe('');
    expect(records()[0]).toMatchObject({ env: 'caller' });
    expect(claimFiles()).toEqual([]);
  });

  it('never reuses a record made in the caller env, or one with no env', async () => {
    write();
    const r = realRepo();
    putRecord({ ...entry({ env: 'caller' }), tree: treeOf(r) });
    putRecord({ ...entry({ at: '2026-10-31T09:06:00.000Z' }), env: undefined, tree: treeOf(r) });
    const { exec, ran } = countingExec();
    const res = await runReal(['--reuse'], { cwd: r, exec });
    expect(ran).toEqual(['npm test']);
    expect(res.out).not.toContain('reused');
  });
});

describe('foreman checks: a run in progress in another slot', () => {
  const claimIt = (r, extra = {}) => takeClaim(stateOf(), { run: 'npm test', tree: treeOf(r), slot: 'w2', story: 'ACME-2', at: '2026-10-31T09:00:00.000Z', pid: 4242, script: '/p/main.mjs', ...extra });

  it('waits on a live claim until the record lands, prints it as a reuse, and runs nothing', async () => {
    write();
    const r = realRepo();
    const { claim } = claimIt(r);
    const { exec, ran } = countingExec();
    let pauses = 0;
    const pause = async () => {
      pauses++;
      if (pauses === 2) {
        putRecord({ ...entry(), tree: treeOf(r) });
        releaseClaim(stateOf(), claim);
      }
    };
    const res = await runReal([], { cwd: r, exec, claimAlive: () => true, pause });
    expect(res.code).toBe(0);
    expect(ran).toEqual([]);
    expect(pauses).toBe(2);
    const tree12 = treeOf(r).slice(0, 12);
    expect(res.out.match(/waiting:/g)).toHaveLength(1);
    expect(res.out).toContain(`waiting: w2 for ACME-2 is running this check on this tree (${tree12}) since 2026-10-31T09:00:00.000Z; its result is used when it ends\n`);
    expect(res.out).toContain('reused: Foreman\'s run of this tree');
    expect(res.out).toContain('other slot said\nfine\n');
    expect(res.out).toContain('PASS npm test (reused)\n');
    const lines = records();
    expect(lines.at(-1)).toMatchObject({ run: 'npm test', full: true, tree: treeOf(r), reused: true, waited: true, from: '2026-10-31T09:05:00.000Z', story: 'ACME-1', slot: 'w1' });
    expect(claimFiles()).toEqual([]);
  });

  it('stops waiting on a live holder that never ends after 30 minutes, and runs the check itself', async () => {
    write();
    const r = realRepo();
    claimIt(r);
    let t = Date.parse('2026-11-01T10:00:00.000Z');
    const pause = async () => {
      t += 10 * 60_000;
    };
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, claimAlive: () => true, pause, ctx: { now: () => new Date(t) } });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test']);
    expect(res.out.match(/^waiting:/gm)).toHaveLength(1);
    expect(res.out.match(/^stopped waiting:/gm)).toHaveLength(1);
    expect(res.out).toContain(`stopped waiting: w2 for ACME-2 has held this check on this tree (${treeOf(r).slice(0, 12)}) for 30 min; running it here without a claim\n`);
    expect(res.out).toContain('PASS npm test\n');
    expect(records().filter((e) => !e.reused)).toHaveLength(1);
    expect(claimFiles()).toHaveLength(1);
  });

  it('keeps waiting before the limit', async () => {
    write();
    const r = realRepo();
    const { claim } = claimIt(r);
    let t = Date.parse('2026-11-01T10:00:00.000Z');
    let pauses = 0;
    const pause = async () => {
      t += 10 * 60_000;
      if (++pauses === 2) releaseClaim(stateOf(), claim);
    };
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, claimAlive: () => true, pause, ctx: { now: () => new Date(t) } });
    expect(ran).toEqual(['npm test']);
    expect(res.out).not.toContain('stopped waiting:');
    expect(claimFiles()).toEqual([]);
  });

  it('measures the wait from its own start, not from a claim dated far ahead', async () => {
    write();
    const r = realRepo();
    claimIt(r, { at: '2099-01-01T00:00:00.000Z' });
    let t = Date.parse('2026-11-01T10:00:00.000Z');
    let pauses = 0;
    const pause = async () => {
      pauses++;
      t += 10 * 60_000;
    };
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, claimAlive: () => true, pause, ctx: { now: () => new Date(t) } });
    expect(ran).toEqual(['npm test']);
    expect(pauses).toBe(3);
    expect(res.out).toContain('stopped waiting: w2 for ACME-2 has held this check on this tree');
  });

  it('writes its own start time into the claim it takes', async () => {
    write();
    const r = realRepo();
    const during = [];
    const exec = async () => {
      during.push(JSON.parse(fs.readFileSync(claimPath(stateOf(), { run: 'npm test', tree: treeOf(r) }), 'utf8')));
      return { code: 0, output: 'ok\n' };
    };
    await runReal([], { cwd: r, exec, ctx: { startOf: () => 'Sun Nov 1 10:00:00 2026', runAlive: () => true, cores: 16 } });
    expect(during).toHaveLength(1);
    expect(during[0].started).toBe('Sun Nov 1 10:00:00 2026');
    expect(during[0].pid).toBe(process.pid);
  });

  it('counts a waited failure as exit 1', async () => {
    write();
    const r = realRepo();
    const { claim } = claimIt(r);
    const pause = async () => {
      putRecord({ ...entry({ exit: 2, tail: 'boom' }), tree: treeOf(r) });
      releaseClaim(stateOf(), claim);
    };
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, claimAlive: () => true, pause });
    expect(res.code).toBe(1);
    expect(ran).toEqual([]);
    expect(res.out).toContain('boom\n');
    expect(res.out).toContain('FAIL npm test (exit 2, reused)\n');
  });

  it('runs the check itself when the run it waited on ends with no record', async () => {
    write();
    const r = realRepo();
    const { claim } = claimIt(r);
    let pauses = 0;
    const pause = async () => {
      if (++pauses === 2) releaseClaim(stateOf(), claim);
    };
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, claimAlive: () => true, pause });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test']);
    expect(res.out).toContain('waiting:');
    expect(res.out).toContain('PASS npm test\n');
    expect(res.out).not.toContain('(reused)');
    expect(records().filter((e) => !e.reused)).toHaveLength(1);
    expect(claimFiles()).toEqual([]);
  });

  it('does not take a record older than the claim without --reuse', async () => {
    write();
    const r = realRepo();
    putRecord({ ...entry({ at: '2026-10-31T08:00:00.000Z', tail: 'old' }), tree: treeOf(r) });
    const { claim } = claimIt(r);
    const pause = async () => releaseClaim(stateOf(), claim);
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, claimAlive: () => true, pause });
    expect(ran).toEqual(['npm test']);
    expect(res.out).not.toContain('old');
  });

  it('uses a record from before the claim with --reuse, without waiting at all', async () => {
    write();
    const r = realRepo();
    putRecord({ ...entry({ at: '2026-10-31T08:00:00.000Z', tail: 'old' }), tree: treeOf(r) });
    claimIt(r);
    const { exec, ran } = countingExec();
    const res = await runReal(['--reuse'], { cwd: r, exec, claimAlive: () => true, pause: async () => { throw new Error('no wait'); } });
    expect(ran).toEqual([]);
    expect(res.out).toContain('old');
    expect(res.out).not.toContain('waiting:');
  });

  it('with --reuse and only a claim, waits like without it', async () => {
    write();
    const r = realRepo();
    const { claim } = claimIt(r);
    const pause = async () => {
      putRecord({ ...entry(), tree: treeOf(r) });
      releaseClaim(stateOf(), claim);
    };
    const { exec, ran } = countingExec();
    const res = await runReal(['--reuse'], { cwd: r, exec, claimAlive: () => true, pause });
    expect(ran).toEqual([]);
    expect(res.out).toContain('waiting:');
    expect(records().at(-1)).toMatchObject({ reused: true, waited: true });
  });

  it('runs at once past a stale claim, replacing it, and removes its own after', async () => {
    write();
    const r = realRepo();
    const { claim: stale } = claimIt(r, { pid: 999999 });
    const during = [];
    const exec = async () => {
      during.push(JSON.parse(fs.readFileSync(claimPath(stateOf(), { run: 'npm test', tree: treeOf(r) }), 'utf8')));
      return { code: 0, output: 'ok\n' };
    };
    const pause = async () => {
      throw new Error('a stale claim is not waited on');
    };
    const res = await runReal([], { cwd: r, exec, claimAlive: () => false, pause });
    expect(res.code).toBe(0);
    expect(res.out).not.toContain('waiting:');
    expect(during).toHaveLength(1);
    expect(during[0].token).not.toBe(stale.token);
    expect(during[0]).toMatchObject({ slot: 'w1', story: 'ACME-1', run: 'npm test', tree: treeOf(r) });
    expect(claimFiles()).toEqual([]);
    expect(records().filter((e) => !e.reused)).toHaveLength(1);
  });

  it('runs unclaimed, after three stale claims in a row', async () => {
    write();
    const r = realRepo();
    claimIt(r);
    const { exec, ran } = countingExec();
    let looked = 0;
    const alive = () => {
      looked++;
      // Each look at the holder finds it dead, but a new claim has replaced it by the time it is dropped.
      fs.rmSync(claimPath(stateOf(), { run: 'npm test', tree: treeOf(r) }));
      claimIt(r, { slot: 'w3' });
      return false;
    };
    const res = await runReal([], { cwd: r, exec, claimAlive: alive, pause: async () => {} });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test']);
    expect(looked).toBe(4);
  });

  it('warns and runs unclaimed when the claim cannot be made', async () => {
    write();
    const r = realRepo();
    fs.mkdirSync(stateOf(), { recursive: true });
    fs.writeFileSync(claimsDir(), 'a file where the folder goes');
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test']);
    expect(res.err).toContain('could not mark this run as in progress: ');
  });

  it('takes no claim in the caller env', async () => {
    write();
    const r = realRepo();
    const seen = [];
    const exec = async () => {
      seen.push(claimFiles());
      return 0;
    };
    await runReal([], { cwd: r, exec, session: false });
    expect(seen).toEqual([[]]);
  });

  it('takes a claim for the run and removes it when the run throws', async () => {
    write();
    const r = realRepo();
    const seen = [];
    const exec = async () => {
      seen.push(claimFiles().length);
      throw new Error('exec blew up');
    };
    await expect(runReal([], { cwd: r, exec })).rejects.toThrow('exec blew up');
    expect(seen).toEqual([1]);
    expect(claimFiles()).toEqual([]);
  });

  it('uses the real claimAlive by default: a claim of a dead process is run past', async () => {
    write();
    const r = realRepo();
    claimIt(r, { pid: 2 ** 22 + 12345 });
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec });
    expect(ran).toEqual(['npm test']);
    expect(res.out).not.toContain('waiting:');
  });

  it('two runs at once in one process execute the check once, the second printing the first result', async () => {
    write(CHECKS, { slots: 2 });
    const r = realRepo();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const ran = [];
    const exec = async (cmd) => {
      ran.push(cmd);
      entered();
      await gate;
      return { code: 2, output: 'the one run said\nfailing\n' };
    };
    const outs = ['', ''];
    const one = (i, extra) => {
      const env = sessionEnv({ FOREMAN_SLOT: `w${i + 1}` });
      seedSession(env);
      return checks.run([], { root: dir, cwd: r, env, stdout: { write: (x) => { outs[i] += x; } }, stderr: { write: () => {} }, git: fakeGit().git, exec, claimAlive: () => true, pause: () => new Promise((resolve) => setTimeout(resolve, 5)), ...extra });
    };
    const runner = one(0);
    await started;
    const waiter = one(1);
    for (let i = 0; i < 2000 && !outs[1].includes('waiting:'); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(outs[1]).toContain('waiting: w1 for ACME-1 is running this check');
    release();
    const [a, b] = await Promise.all([runner, waiter]);
    expect(ran).toEqual(['npm test']);
    expect(a).toBe(1);
    expect(b).toBe(a);
    expect(outs[1]).toContain('the one run said\nfailing\n');
    expect(outs[1]).toContain('FAIL npm test (exit 2, reused)\n');
    expect(outs[0]).toContain('FAIL npm test (exit 2)\n');
    const lines = records();
    expect(lines.filter((e) => !e.reused)).toHaveLength(1);
    expect(lines.filter((e) => e.waited === true)).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(claimFiles()).toEqual([]);
  });
});

describe('foreman checks: one real run per tree through a story', () => {
  it('the tester runs, then two reviewers and the commit reuse it: one real line and three reuse lines', async () => {
    write();
    const r = realRepo();
    const { exec, ran } = countingExec();
    const tester = await runReal(['--changed'], { cwd: r, exec });
    expect(tester.code).toBe(0);
    for (let i = 0; i < 3; i++) {
      const res = await runReal(['--changed', '--reuse'], { cwd: r, exec });
      expect(res.code).toBe(0);
      expect(res.out).toContain('PASS npm test (reused)\n');
    }
    expect(ran).toEqual(['npm test']);
    const lines = records().filter((e) => e.full === true && e.tree === treeOf(r));
    expect(lines.filter((e) => !e.reused)).toHaveLength(1);
    expect(lines.filter((e) => e.reused === true)).toHaveLength(3);
    expect(checkTotals(readCheckRuns(stateOf()))).toEqual([{ story: 'ACME-1', fullRuns: 1, minutes: expect.any(Number), quickRuns: 0, quickMinutes: 0, reused: 3, waited: 0, denied: 0, rounds: null }]);
  });

  it('an edit after the tester makes the commit run the checks again', async () => {
    write();
    const r = realRepo();
    const { exec, ran } = countingExec();
    await runReal(['--changed'], { cwd: r, exec });
    await runReal(['--changed', '--reuse'], { cwd: r, exec });
    fs.writeFileSync(path.join(r, 'a.txt'), 'fixed in a review round\n');
    const commit = await runReal(['--changed', '--reuse'], { cwd: r, exec });
    expect(commit.code).toBe(0);
    expect(commit.out).not.toContain('reused');
    expect(ran).toEqual(['npm test', 'npm test']);
    expect(records().filter((e) => !e.reused && e.full === true)).toHaveLength(2);
  });
});

// --- --wait, with hand-written job files -------------------------------------------------

const jobsAt = () => path.join(stateOf(), 'check-jobs');
function seedJob(id, { result, out = '', err = '', startedAt = '2026-10-31T10:00:00.000Z' } = {}) {
  fs.mkdirSync(jobsAt(), { recursive: true });
  const put = (name, text) => fs.writeFileSync(path.join(jobsAt(), `${id}${name}`), text);
  put('.json', JSON.stringify({ id, pid: 4242, slot: null, story: null, cwd: dir, args: [], startedAt }));
  put('.out', out);
  put('.err', err);
  if (result) put('.result.json', JSON.stringify(result));
}

async function waitFor(args, { alive = () => true, pause = async () => {}, now } = {}) {
  let out = '';
  let err = '';
  const pauses = [];
  const code = await checks.run(args, {
    root: dir,
    cwd: dir,
    env: { FOREMAN_STATE_DIR: stateOf() },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    alive,
    pause: async (ms) => { pauses.push(ms); await pause(ms); },
    now: now ?? stepClock('2026-10-31T10:00:30.000Z'),
  });
  return { code, out, err, pauses };
}

// A clock that moves one second per call.
function secondClock(start = '2026-10-31T10:00:30.000Z') {
  let t = Date.parse(start);
  return () => {
    const v = t;
    t += 1000;
    return v;
  };
}

const QUICK_CONFIG = [{ run: 'npm test', when: 'always', quick: 'npm test -- --changed' }];
const claimItFor = (r) => takeClaim(stateOf(), { run: 'npm test', tree: treeOf(r), slot: 'w2', story: 'ACME-2', at: '2026-10-31T09:00:00.000Z', pid: 4242, script: '/p/main.mjs' });

describe('foreman checks --quick', () => {
  const QUICK = [{ run: 'npm test', when: 'always', quick: 'npm test -- --changed' }];

  it('runs the quick command only, prints it, and records it as a quick run of the check', async () => {
    write(QUICK);
    const r = realRepo();
    const { exec, ran } = countingExec();
    const res = await runReal(['--quick'], { cwd: r, exec, now: stepClock() });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test -- --changed']);
    expect(res.out).toContain('$ npm test -- --changed\n');
    expect(res.out).toContain('PASS npm test -- --changed (quick)\n');
    expect(res.out).not.toContain('$ npm test\n');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ run: 'npm test', quick: true, cmd: 'npm test -- --changed', full: true, tree: treeOf(r), exit: 0, ms: 250, env: 'session', story: 'ACME-1', slot: 'w1' });
    expect(Object.keys(records()[0])).toEqual(['at', 'story', 'slot', 'run', 'quick', 'cmd', 'full', 'tree', 'exit', 'ms', 'tail', 'env']);
  });

  it('a failing quick run prints FAIL with the quick note and exits 1', async () => {
    write(QUICK);
    const r = realRepo();
    const { exec } = countingExec({ failing: ['npm test -- --changed'] });
    const res = await runReal(['--quick'], { cwd: r, exec });
    expect(res.code).toBe(1);
    expect(res.out).toContain('FAIL npm test -- --changed (exit 1, quick)\n');
    expect(records()[0]).toMatchObject({ quick: true, exit: 1 });
  });

  it('a check with no quick command runs its own, recorded as a plain run', async () => {
    write();
    const r = realRepo();
    const { exec, ran } = countingExec();
    const res = await runReal(['--quick'], { cwd: r, exec });
    expect(ran).toEqual(['npm test']);
    expect(res.out).toContain('PASS npm test\n');
    expect(res.out).not.toContain('(quick)');
    expect(records()[0]).not.toHaveProperty('quick');
    expect(records()[0]).not.toHaveProperty('cmd');
    expect(records()[0]).toMatchObject({ run: 'npm test', full: true, exit: 0 });
    // Such a run is a full run: a later --reuse prints it.
    const again = await runReal(['--reuse'], { cwd: r, exec });
    expect(again.out).toContain('PASS npm test (reused)\n');
    expect(ran).toEqual(['npm test']);
  });

  it('is never reused: after a quick run on an unchanged tree --reuse runs the full command', async () => {
    write(QUICK);
    const r = realRepo();
    const { exec, ran } = countingExec();
    await runReal(['--quick'], { cwd: r, exec });
    const again = await runReal(['--reuse'], { cwd: r, exec });
    expect(ran).toEqual(['npm test -- --changed', 'npm test']);
    expect(again.out).not.toContain('reused');
    expect(records().map((e) => [e.quick === true, e.reused === true])).toEqual([[true, false], [false, false]]);
    // The full run is what the next --reuse prints.
    const third = await runReal(['--reuse'], { cwd: r, exec });
    expect(third.out).toContain('PASS npm test (reused)\n');
    expect(ran).toHaveLength(2);
  });

  it('takes no claim and does not wait for a run in progress', async () => {
    write(QUICK);
    const r = realRepo();
    claimItFor(r);
    const { exec, ran } = countingExec();
    let pauses = 0;
    const res = await runReal(['--quick'], { cwd: r, exec, claimAlive: () => true, pause: async () => { pauses++; } });
    expect(res.code).toBe(0);
    expect(res.out).not.toContain('waiting');
    expect(pauses).toBe(0);
    expect(ran).toEqual(['npm test -- --changed']);
    expect(claimFiles()).toHaveLength(1);
  });

  it('runs the quick command, not a reuse, even when a full record of the tree exists', async () => {
    write(QUICK);
    const r = realRepo();
    putRecord({ ...entry(), tree: treeOf(r) });
    const { exec, ran } = countingExec();
    const res = await runReal(['--quick'], { cwd: r, exec });
    expect(ran).toEqual(['npm test -- --changed']);
    expect(res.out).not.toContain('reused');
  });

  it.each([
    [['--quick', '--reuse'], '--quick cannot be combined with --reuse: a quick run is never reused'],
    [['--recorded', '--reuse'], '--recorded'],
    [['--recorded', '--quick'], '--recorded'],
    [['--recorded', '--start'], '--recorded'],
    [['--recorded', '--wait', 'a1'], '--wait'],
    [['--wait', 'a1', '--quick'], '--wait cannot be combined with'],
  ])('%j exits 64 with a reason, runs nothing and records nothing', async (args, reason) => {
    write(QUICK);
    const r = realRepo();
    const { exec, ran } = countingExec();
    const res = await runReal(args, { cwd: r, exec });
    expect(res.code).toBe(64);
    expect(res.err).toContain(reason);
    expect(res.err).toContain('usage: foreman checks');
    expect(ran).toEqual([]);
    expect(records()).toEqual([]);
  });

  it('--changed --quick runs the quick of a glob check whose file changed, or its run when it has none', async () => {
    write([
      { run: 'npm test', when: 'always', quick: 'npm test -- --changed' },
      { run: 'npm run lint:sql', when: 'db/**/*.sql', quick: 'npm run lint:sql -- --fast' },
      { run: 'npm run test:ui', when: 'src/ui/**' },
      { run: 'npm run other', when: 'other/**', quick: 'x' },
    ]);
    const r = realRepo();
    const { exec, ran } = countingExec();
    const git = fakeGit({ committed: ['db/1.sql', 'src/ui/a.js'] }).git;
    const res = await runReal(['--changed', '--quick'], { cwd: r, exec, git });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test -- --changed', 'npm run lint:sql -- --fast', 'npm run test:ui']);
    expect(res.out).toContain('PASS npm run lint:sql -- --fast (quick)\n');
    expect(res.out).toContain('PASS npm run test:ui\n');
    expect(records().map((e) => [e.run, e.quick === true, e.full])).toEqual([['npm test', true, true], ['npm run lint:sql', true, false], ['npm run test:ui', false, false]]);
  });

  it('records nothing when the tree changed during the quick run, like a full run', async () => {
    write(QUICK);
    const hashes = ['a'.repeat(40), 'b'.repeat(40)];
    let calls = 0;
    const res = await runReal(['--quick'], { cwd: dir, exec: countingExec().exec, hashTree: () => hashes[Math.min(calls++, 1)] });
    expect(res.code).toBe(0);
    expect(fs.existsSync(recordFile())).toBe(false);
  });
});

describe('foreman checks --recorded', () => {
  const lineCount = () => (fs.existsSync(recordFile()) ? fs.readFileSync(recordFile(), 'utf8').split('\n').filter(Boolean).length : 0);

  it('prints the record of this tree and runs nothing, writes nothing', async () => {
    write();
    const r = realRepo();
    putRecord({ ...entry(), tree: treeOf(r) });
    const before = lineCount();
    const { exec, ran } = countingExec();
    const res = await runReal(['--recorded'], { cwd: r, exec });
    expect(res.code).toBe(0);
    expect(ran).toEqual([]);
    expect(res.out).toContain('$ npm test\n');
    expect(res.out).toContain(`recorded: Foreman's run of this tree (${treeOf(r).slice(0, 12)}) at 2026-10-31T09:05:00.000Z for ACME-2, took <1 min; last lines:\n`);
    expect(res.out).toContain('other slot said\nfine\n');
    expect(res.out).toContain('PASS npm test (recorded)\n');
    expect(res.out).not.toContain('reused');
    expect(lineCount()).toBe(before);
    expect(claimFiles()).toEqual([]);
  });

  it('a recorded failure gives exit 1', async () => {
    write();
    const r = realRepo();
    putRecord({ ...entry({ exit: 2, tail: 'boom' }), tree: treeOf(r) });
    const res = await runReal(['--recorded'], { cwd: r, exec: countingExec().exec });
    expect(res.code).toBe(1);
    expect(res.out).toContain('boom\n');
    expect(res.out).toContain('FAIL npm test (exit 2, recorded)\n');
  });

  it('says there is no record, exits 0, and runs nothing', async () => {
    write();
    const r = realRepo();
    const { exec, ran } = countingExec();
    const res = await runReal(['--recorded'], { cwd: r, exec });
    expect(res.code).toBe(0);
    expect(res.out).toContain(`no record of npm test on this tree (${treeOf(r).slice(0, 12)}); not run\n`);
    expect(ran).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('a record of another tree, a caller-env record and a quick-only record count as no record', async () => {
    write(QUICK_CONFIG);
    const r = realRepo();
    putRecord({ ...entry(), tree: 'c'.repeat(40) });
    putRecord({ ...entry({ env: 'caller' }), tree: treeOf(r) });
    putRecord({ ...entry({ quick: true, cmd: 'npm test -- --changed' }), tree: treeOf(r) });
    const res = await runReal(['--recorded'], { cwd: r, exec: countingExec().exec });
    expect(res.out).toContain('no record of npm test on this tree');
    expect(res.out).not.toContain('PASS');
  });

  it('with a quick line newer than the full line prints the full line', async () => {
    write(QUICK_CONFIG);
    const r = realRepo();
    putRecord({ ...entry({ tail: 'the full one' }), tree: treeOf(r) });
    putRecord({ ...entry({ at: '2026-10-31T09:09:00.000Z', quick: true, cmd: 'q', tail: 'the quick one' }), tree: treeOf(r) });
    const res = await runReal(['--recorded'], { cwd: r, exec: countingExec().exec });
    expect(res.out).toContain('the full one');
    expect(res.out).not.toContain('the quick one');
  });

  it('says so on stderr, exits 0 and runs nothing when the tree cannot be hashed', async () => {
    write();
    const { exec, ran } = countingExec();
    const res = await runReal(['--recorded'], { cwd: dir, exec, hashTree: () => null });
    expect(res.code).toBe(0);
    expect(res.err).toContain('cannot hash this tree; not run\n');
    expect(ran).toEqual([]);
    expect(fs.existsSync(recordFile())).toBe(false);
  });

  it('follows --changed and --all in choosing the checks', async () => {
    write();
    const r = realRepo();
    putRecord({ ...entry(), tree: treeOf(r) });
    const git = fakeGit({ committed: ['db/1.sql'] }).git;
    const changed = await runReal(['--recorded', '--changed'], { cwd: r, exec: countingExec().exec, git });
    expect(changed.out).toContain('PASS npm test (recorded)');
    expect(changed.out).toContain(`no record of npm run lint:sql on this tree (${treeOf(r).slice(0, 12)}); not run`);
    expect(changed.out).not.toContain('test:ui');
    const all = await runReal(['--recorded', '--all'], { cwd: r, exec: countingExec().exec, git });
    expect(all.out).toContain('no record of npm run test:ui on this tree');
  });

  it('does not need the session env: outside a session it still reads the record', async () => {
    write();
    const r = realRepo();
    putRecord({ ...entry(), tree: treeOf(r) });
    const res = await runReal(['--recorded'], { cwd: r, exec: countingExec().exec, session: false });
    expect(res.out).toContain('PASS npm test (recorded)');
    expect(res.err).toBe('');
  });
});

describe('foreman checks --wait', () => {
  it('exits 75 saying still running, with the time so far, when the time is used up', async () => {
    write();
    seedJob('w1-abc-123456');
    const res = await waitFor(['--wait', 'w1-abc-123456', '--for', '2'], { now: secondClock() });
    expect(res.code).toBe(75);
    expect(res.out).toContain('still running: w1-abc-123456, ');
    expect(res.out).toMatch(/, \d+ s so far; wait again with: foreman checks --wait w1-abc-123456\n$/);
    expect(res.pauses.length).toBeGreaterThan(0);
    expect(Math.max(...res.pauses)).toBeLessThanOrEqual(1000);
  });

  it('counts minutes once past a minute', async () => {
    write();
    seedJob('a1', { startedAt: '2026-10-31T09:50:30.000Z' });
    const res = await waitFor(['--wait', 'a1', '--for', '1'], { now: secondClock() });
    expect(res.code).toBe(75);
    expect(res.out).toContain('still running: a1, 10 min so far');
  });

  it('prints the saved output byte for byte and exits with the run exit code', async () => {
    write();
    seedJob('a1', { result: { exit: 3, endedAt: 'x' }, out: '$ npm test\nFAIL npm test (exit 3)\n', err: 'to-err\n' });
    const res = await waitFor(['--wait', 'a1']);
    expect(res.code).toBe(3);
    expect(res.out).toBe('$ npm test\nFAIL npm test (exit 3)\n');
    expect(res.err).toBe('to-err\n');
    expect(res.pauses).toEqual([]);
  });

  it('finds a result that landed as the process ended', async () => {
    write();
    seedJob('a1', { out: 'o\n' });
    const alive = () => {
      fs.writeFileSync(path.join(jobsAt(), 'a1.result.json'), JSON.stringify({ exit: 0, endedAt: 'x' }));
      return false;
    };
    const res = await waitFor(['--wait', 'a1'], { alive });
    expect(res.code).toBe(0);
    expect(res.out).toBe('o\n');
  });

  it('fails on the first poll when the process is gone and left no result', async () => {
    write();
    seedJob('a1');
    const res = await waitFor(['--wait', 'a1'], { alive: () => false });
    expect(res.code).toBe(1);
    expect(res.out + res.err).toContain('FAIL the check run a1 ended without a result: its process (pid 4242) is gone; start the checks again');
    expect(res.pauses).toEqual([]);
  });

  it('says there is no such run for an unknown id', async () => {
    write();
    const res = await waitFor(['--wait', 'nope']);
    expect(res.code).toBe(1);
    expect(res.out + res.err).toContain('no check run nope here');
  });

  it('exits 1 on a bad config', async () => {
    expect((await waitFor(['--wait', 'a1'])).code).toBe(1);
  });

  it('says what --wait cannot be combined with', async () => {
    write();
    expect((await waitFor(['--wait', 'a', '--all'])).err).toContain('--wait cannot be combined with --start, --changed, --reuse, --all, --quick or --recorded\n');
  });

  it.each([
    [['--wait', '../x']],
    [['--wait', 'a/b']],
    [['--wait', 'a', '--start']],
    [['--wait', 'a', '--changed']],
    [['--wait', 'a', '--reuse']],
    [['--wait', 'a', '--all']],
    [['--wait', 'a', '--quick']],
    [['--wait', 'a', '--recorded']],
    [['--for', '5']],
    [['--wait', 'a', '--for', '0']],
    [['--wait', 'a', '--for', 'abc']],
    [['--wait', 'a', '--for', '1.5']],
    [['--wait']],
  ])('exits 64 for %j', async (args) => {
    write();
    const res = await waitFor(args);
    expect(res.code).toBe(64);
    expect(res.err).toContain('usage: foreman checks');
  });
});


// --- One full run per worktree, and a cap across slots -----------------------------------------

const runningAt = () => path.join(stateOf(), CHECK_RUNNING_DIR);
const seatsAt = () => path.join(stateOf(), CHECK_SLOTS_DIR);
const filesIn = (d) => (fs.existsSync(d) && fs.statSync(d).isDirectory() ? fs.readdirSync(d).filter((f) => !f.endsWith('.tmp')) : []);
const putSeat = (n, extra = {}) => {
  fs.mkdirSync(seatsAt(), { recursive: true });
  fs.writeFileSync(path.join(seatsAt(), `${n}.json`), JSON.stringify({ token: `holder${n}`, pid: 4242, script: '/p/main.mjs', slot: 'w2', story: 'ACME-2', at: '2026-10-31T09:00:00.000Z', ...extra }));
};
const tick = (start = '2026-11-01T10:00:00.000Z') => {
  const clock = { t: Date.parse(start) };
  clock.now = () => new Date(clock.t);
  return clock;
};

describe('foreman checks: a newer run in a worktree stops an older run on a changed tree', () => {
  const olderRun = (r, extra = {}) => {
    seedJob('w1-old-1');
    fs.mkdirSync(stateOf(), { recursive: true });
    return enterRun(stateOf(), { pid: 4242, script: '/p/main.mjs', job: 'w1-old-1', slot: 'w1', story: 'ACME-1', tree: 'aaa', at: '2026-11-01T09:00:00.000Z', state: 'running', since: '2026-11-01T09:00:00.000Z', ...extra }).entry;
  };

  it('stops it, hands its waiters the newer job, says so and leaves nothing of either behind', async () => {
    write();
    const r = realRepo();
    const old = olderRun(r);
    const stopped = [];
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, ctx: { job: 'w1-new-1', runAlive: () => true, stopTree: (pid) => stopped.push(pid), cores: 16, now: tick().now } });
    expect(res.code).toBe(0);
    expect(stopped).toEqual([4242]);
    expect(readResult(stateOf(), 'w1-old-1')).toMatchObject({ exit: 1, supersededBy: 'w1-new-1' });
    expect(res.out).toContain('superseded: stopped the older run w1-old-1 in this worktree, on tree aaa; this tree (' + treeOf(r).slice(0, 12) + ') has changed since\n');
    expect(filesIn(runningAt())).toEqual([]);
    expect(fs.existsSync(path.join(runningAt(), `${old.token}.json`))).toBe(false);
    expect(ran).toEqual(['npm test']);
  });

  it.each([
    ['an older entry on the same tree', (r) => ({ tree: treeOf(r) })],
    ['an older entry in another slot', () => ({ slot: 'w2' })],
    ['a newer entry', () => ({ at: '2026-11-01T11:00:00.000Z' })],
  ])('does not stop %s', async (_name, extra) => {
    write();
    const r = realRepo();
    olderRun(r, extra(r));
    const stopped = [];
    const res = await runReal([], { cwd: r, exec: countingExec().exec, ctx: { job: 'w1-new-1', runAlive: () => true, stopTree: (pid) => stopped.push(pid), cores: 16, now: tick().now } });
    expect(res.code).toBe(0);
    expect(stopped).toEqual([]);
    expect(res.out).not.toContain('superseded:');
    expect(readResult(stateOf(), 'w1-old-1')).toBeNull();
  });

  it('does nothing outside a story session: no register, no stop', async () => {
    write();
    const r = realRepo();
    olderRun(r);
    const stopped = [];
    const res = await runReal([], { cwd: r, exec: countingExec().exec, session: false, ctx: { runAlive: () => true, stopTree: (pid) => stopped.push(pid) } });
    expect(res.code).toBe(0);
    expect(stopped).toEqual([]);
    expect(filesIn(runningAt())).toHaveLength(1);
  });

  it('a --quick run supersedes too, but takes no seat', async () => {
    write(QUICK_CONFIG);
    const r = realRepo();
    olderRun(r);
    putSeat(0);
    const stopped = [];
    const res = await runReal(['--quick'], { cwd: r, exec: countingExec().exec, ctx: { job: 'w1-new-1', runAlive: () => true, stopTree: (pid) => stopped.push(pid), cores: 8, now: tick().now, pause: async () => { throw new Error('queued'); } } });
    expect(res.code).toBe(0);
    expect(stopped).toEqual([4242]);
  });

  it('warns and runs without the slots when the register cannot be made', async () => {
    write();
    const r = realRepo();
    fs.mkdirSync(stateOf(), { recursive: true });
    fs.writeFileSync(runningAt(), 'not a folder');
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, ctx: { runAlive: () => true, cores: 16 } });
    expect(res.code).toBe(0);
    expect(res.err).toContain('could not mark this run for the check slots: ');
    expect(res.err).toContain('; running without them\n');
    expect(ran).toEqual(['npm test']);
    expect(records().filter((e) => !e.reused)).toHaveLength(1);
  });
});

describe('foreman checks: the cap on full runs across slots', () => {
  const capCtx = (clock, extra = {}) => ({ runAlive: () => true, cores: 16, now: clock.now, ...extra });

  it('queues over the cap, beats the slot while it waits, and runs only after the seat is free', async () => {
    write(CHECKS, { checkRuns: { maxParallel: 1 } });
    const r = realRepo();
    putSeat(0);
    const clock = tick();
    const beats = [];
    const states = [];
    let pauses = 0;
    const pause = async () => {
      pauses++;
      clock.t += 20_000;
      if (pauses === 1) states.push(...filesIn(runningAt()).map((f) => JSON.parse(fs.readFileSync(path.join(runningAt(), f), 'utf8')).state));
      if (pauses === 3) fs.rmSync(path.join(seatsAt(), '0.json'));
    };
    const ranAfter = [];
    const exec = async (cmd) => {
      ranAfter.push(pauses);
      return { code: 0, output: 'ok\n' };
    };
    const res = await runReal([], { cwd: r, exec, pause, ctx: capCtx(clock, { beat: async (d, slot, at) => { beats.push([d, slot, at.getTime() - Date.parse('2026-11-01T10:00:00.000Z')]); } }) });
    expect(res.code).toBe(0);
    expect(res.out.match(/waiting for a free check slot:/g)).toHaveLength(1);
    expect(res.out).toContain('waiting for a free check slot: 1 of 1 in use (w2 for ACME-2); this run starts when it gets one\n');
    expect(res.out).toMatch(/got a free check slot after 1 min\n/);
    expect(states).toEqual(['queued']);
    expect(ranAfter).toEqual([3]);
    expect(beats).toEqual([[stateOf(), 'w1', expect.any(Number)], [stateOf(), 'w1', expect.any(Number)]]);
    expect(beats[0][2]).toBe(0);
    expect(beats[1][2]).toBe(40_000);
    expect(filesIn(seatsAt())).toEqual([]);
    expect(filesIn(runningAt())).toEqual([]);
    expect(records().filter((e) => !e.reused)).toHaveLength(1);
  });

  it('keeps going when the beat throws', async () => {
    write(CHECKS, { checkRuns: { maxParallel: 1 } });
    const r = realRepo();
    putSeat(0);
    const clock = tick();
    let pauses = 0;
    const pause = async () => {
      if (++pauses === 2) fs.rmSync(path.join(seatsAt(), '0.json'));
    };
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, pause, ctx: capCtx(clock, { beat: async () => { throw new Error('disk full'); } }) });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test']);
  });

  it('with no checkRuns the limit is one per 8 cores, at least 1', async () => {
    write();
    const r = realRepo();
    putSeat(0);
    let pauses = 0;
    const pause = async () => {
      if (++pauses === 1) fs.rmSync(path.join(seatsAt(), '0.json'));
    };
    const few = await runReal([], { cwd: r, exec: countingExec().exec, pause, ctx: capCtx(tick(), { cores: 4, beat: async () => {} }) });
    expect(few.out).toContain('waiting for a free check slot: 1 of 1 in use');
    putSeat(0);
    const many = await runReal([], { cwd: r, exec: countingExec().exec, pause: async () => { throw new Error('must not wait'); }, ctx: capCtx(tick(), { cores: 18 }) });
    expect(many.out).not.toContain('waiting for a free check slot');
    expect(many.code).toBe(0);
  });

  it('a --quick run and a run outside a session never queue', async () => {
    write(QUICK_CONFIG, { checkRuns: { maxParallel: 1 } });
    const r = realRepo();
    putSeat(0);
    const beats = [];
    const ctx = capCtx(tick(), { beat: async () => { beats.push(1); } });
    const pause = async () => { throw new Error('must not wait'); };
    const quick = await runReal(['--quick'], { cwd: r, exec: countingExec().exec, pause, ctx });
    expect(quick.code).toBe(0);
    expect(quick.out).not.toContain('waiting for a free check slot');
    const outside = await runReal([], { cwd: r, exec: countingExec().exec, pause, session: false, ctx });
    expect(outside.code).toBe(0);
    expect(outside.out).not.toContain('waiting for a free check slot');
    expect(beats).toEqual([]);
  });

  it('a run that waits on another slot\'s run of the same tree takes no seat and never queues', async () => {
    write(CHECKS, { checkRuns: { maxParallel: 1 } });
    const r = realRepo();
    putSeat(0);
    const { claim } = takeClaim(stateOf(), { run: 'npm test', tree: treeOf(r), slot: 'w2', story: 'ACME-2', at: '2026-10-31T09:00:00.000Z', pid: 4242, script: '/p/main.mjs' });
    const pause = async () => {
      putRecord({ ...entry(), tree: treeOf(r) });
      releaseClaim(stateOf(), claim);
    };
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, pause, claimAlive: () => true, ctx: capCtx(tick()) });
    expect(res.code).toBe(0);
    expect(ran).toEqual([]);
    expect(res.out).toContain('waiting: w2 for ACME-2');
    expect(res.out).not.toContain('waiting for a free check slot');
    expect(filesIn(seatsAt())).toEqual(['0.json']);
    expect(JSON.parse(fs.readFileSync(path.join(seatsAt(), '0.json'), 'utf8')).token).toBe('holder0');
  });

  it('warns and runs, recording, when the seats cannot be made', async () => {
    write(CHECKS, { checkRuns: { maxParallel: 1 } });
    const r = realRepo();
    fs.mkdirSync(stateOf(), { recursive: true });
    fs.writeFileSync(seatsAt(), 'not a folder');
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, ctx: capCtx(tick()) });
    expect(res.code).toBe(0);
    expect(res.err).toContain('could not take a check slot: ');
    expect(res.err).toContain('; running without one\n');
    expect(ran).toEqual(['npm test']);
    expect(records().filter((e) => !e.reused)).toHaveLength(1);
  });

  it('releases the seat, the claim and the register entry when the check throws', async () => {
    write(CHECKS, { checkRuns: { maxParallel: 1 } });
    const r = realRepo();
    const exec = async () => {
      expect(filesIn(seatsAt())).toHaveLength(1);
      expect(filesIn(runningAt())).toHaveLength(1);
      throw new Error('exec blew up');
    };
    await expect(runReal([], { cwd: r, exec, ctx: capCtx(tick()) })).rejects.toThrow('exec blew up');
    expect(filesIn(seatsAt())).toEqual([]);
    expect(claimFiles()).toEqual([]);
    expect(filesIn(runningAt())).toEqual([]);
  });

  it('holds one seat per full check and a register entry in state running while it runs', async () => {
    write([{ run: 'npm test', when: 'always' }, { run: 'npm run lint', when: 'always' }], { checkRuns: { maxParallel: 1 } });
    const r = realRepo();
    const seen = [];
    const exec = async (cmd) => {
      seen.push([cmd, filesIn(seatsAt()), filesIn(runningAt()).map((f) => JSON.parse(fs.readFileSync(path.join(runningAt(), f), 'utf8')).state)]);
      return { code: 0, output: '' };
    };
    await runReal([], { cwd: r, exec, ctx: capCtx(tick()) });
    expect(seen.map(([cmd, seats, states]) => [cmd, seats.length, states])).toEqual([['npm test', 1, ['running']], ['npm run lint', 1, ['running']]]);
    expect(filesIn(seatsAt())).toEqual([]);
  });
});

describe('foreman checks --wait: a run that a newer run stopped', () => {
  it('follows the newer run and prints its output and exit code', async () => {
    write();
    seedJob('X', { result: { exit: 1, endedAt: 'x', supersededBy: 'Y' }, out: 'stale\n' });
    seedJob('Y', { result: { exit: 0, endedAt: 'y' }, out: 'hello\n' });
    const res = await waitFor(['--wait', 'X']);
    expect(res.code).toBe(0);
    expect(res.out).toBe('superseded: X was stopped for a newer run in its worktree (Y); following Y\nhello\n');
  });

  it('says superseded when there is nothing to follow', async () => {
    write();
    seedJob('X', { result: { exit: 1, endedAt: 'x', supersededBy: null } });
    const res = await waitFor(['--wait', 'X']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('FAIL X was superseded by a newer run in its worktree on a changed tree; its result would be stale, so start the checks again\n');
  });

  it('fails on a cycle instead of following it for ever', async () => {
    write();
    seedJob('X', { result: { exit: 1, endedAt: 'x', supersededBy: 'Y' } });
    seedJob('Y', { result: { exit: 1, endedAt: 'x', supersededBy: 'X' } });
    const res = await waitFor(['--wait', 'X']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('FAIL Y was superseded');
  });

  it('fails when the newer id is not a job id', async () => {
    write();
    seedJob('X', { result: { exit: 1, endedAt: 'x', supersededBy: '../etc' } });
    const res = await waitFor(['--wait', 'X']);
    expect(res.code).toBe(1);
    expect(res.err).toContain('FAIL X was superseded');
  });

  it('still follows when the newer run has not written its job file yet', async () => {
    write();
    seedJob('X', { result: { exit: 1, endedAt: 'x', supersededBy: 'Y' } });
    let polls = 0;
    const res = await waitFor(['--wait', 'X'], {
      alive: () => { throw new Error('a job that is not there has no process to check'); },
      pause: async () => {
        polls++;
        seedJob('Y', { result: { exit: 0, endedAt: 'y' }, out: 'late\n' });
      },
    });
    expect(polls).toBe(1);
    expect(res.code).toBe(0);
    expect(res.out).toContain('following Y\n');
    expect(res.out).toContain('late\n');
  });

  it('says still running, waiting for a free check slot, when time is up on a queued run', async () => {
    write();
    seedJob('X');
    fs.mkdirSync(stateOf(), { recursive: true });
    const { entry: e } = enterRun(stateOf(), { pid: 4242, script: '/p/main.mjs', job: 'X', slot: 'w1', story: 'ACME-1', tree: 'aaa', at: '2026-11-01T09:00:00.000Z', state: 'started', since: '2026-11-01T09:00:00.000Z' });
    setRun(stateOf(), e, { state: 'queued' });
    const res = await waitFor(['--wait', 'X', '--for', '2'], { now: secondClock() });
    expect(res.code).toBe(75);
    expect(res.out).toMatch(/^still running: X, \d+ s so far, waiting for a free check slot; wait again with: foreman checks --wait X\n$/);
  });
});

describe('foreman checks: a machine that cannot read processes', () => {
  const WARNING = 'warning: cannot read processes here (ps is missing or failing), so the check slots cannot verify any run: older runs in this worktree are not stopped and the cap on parallel full runs does not hold\n';
  const TWO = [{ run: 'npm test', when: 'always' }, { run: 'npm run lint', when: 'always' }];

  it('warns once, at registration, and goes on', async () => {
    write(TWO);
    const r = realRepo();
    const { exec, ran } = countingExec();
    const res = await runReal([], { cwd: r, exec, ctx: { startOf: () => null, runAlive: () => true, cores: 16 } });
    expect(res.code).toBe(0);
    expect(ran).toEqual(['npm test', 'npm run lint']);
    expect(res.err.split(WARNING)).toHaveLength(2);
    expect(res.err).toContain(WARNING);
  });

  it('is quiet when the start time can be read', async () => {
    write(TWO);
    const r = realRepo();
    const res = await runReal([], { cwd: r, exec: countingExec().exec, ctx: { startOf: () => 'Sun Nov 1 10:00:00 2026', runAlive: () => true, cores: 16 } });
    expect(res.code).toBe(0);
    expect(res.err).not.toContain('cannot read processes');
  });

  it('is quiet outside a story session', async () => {
    write(TWO);
    const r = realRepo();
    const res = await runReal([], { cwd: r, exec: countingExec().exec, session: false, ctx: { startOf: () => null, runAlive: () => true } });
    expect(res.code).toBe(0);
    expect(res.err).not.toContain('cannot read processes');
  });
});

describe('foreman checks: a foreground run that a newer run stops says so', () => {
  const LINE = "superseded: stopped for a newer run in this worktree on a changed tree; this run's result would be stale\n";
  const TWO = [{ run: 'npm test', when: 'always' }, { run: 'npm run lint', when: 'always' }];
  // The register entry of this very run, as another process would read it, with a pid that is not ours.
  const myEntry = () => {
    const [f] = filesIn(runningAt()).filter((n) => n.endsWith('.json'));
    return { ...JSON.parse(fs.readFileSync(path.join(runningAt(), f), 'utf8')), pid: 4242 };
  };
  const stopMe = () => stopRun(stateOf(), myEntry(), { supersededBy: null, alive: () => true, stopTree: () => {}, groupKill: () => {} });
  const term = () => {
    const t = { handler: null, removed: false, exits: [], ctx: null };
    t.ctx = { onTerm: (fn) => { t.handler = fn; return () => { t.removed = true; }; }, exit: (c) => t.exits.push(c), runAlive: () => true, cores: 16 };
    return t;
  };

  it('prints the line once, leaves the register and exits 143 when SIGTERM comes after a stop note', async () => {
    write();
    const r = realRepo();
    const t = term();
    const exec = async () => {
      stopMe();
      t.handler();
      t.handler();
      return { code: 143, output: '' };
    };
    const res = await runReal([], { cwd: r, exec, ctx: t.ctx });
    expect(res.out.split(LINE)).toHaveLength(2);
    expect(t.exits).toEqual([143]);
    expect(t.removed).toBe(true);
    expect(filesIn(runningAt())).toEqual([]);
    expect(filesIn(seatsAt())).toEqual([]);
    expect(res.out).not.toContain('FAIL npm test');
    expect(records().filter((e) => !e.reused)).toEqual([]);
  });

  it('says it once and runs nothing more when the child ended before the signal came', async () => {
    write(TWO);
    const r = realRepo();
    const t = term();
    const ran = [];
    const exec = async (cmd) => {
      ran.push(cmd);
      stopMe();
      return { code: 143, output: '' };
    };
    const res = await runReal([], { cwd: r, exec, ctx: t.ctx });
    expect(res.code).toBe(1);
    expect(res.out.split(LINE)).toHaveLength(2);
    expect(res.out).not.toMatch(/^(PASS|FAIL) /m);
    expect(ran).toEqual(['npm test']);
    expect(records().filter((e) => !e.reused)).toEqual([]);
    expect(t.exits).toEqual([]);
    expect(t.removed).toBe(true);
    expect(filesIn(runningAt())).toEqual([]);
    expect(filesIn(seatsAt())).toEqual([]);
  });

  it('exits 143 and prints nothing about a newer run when SIGTERM comes with no note', async () => {
    write();
    const r = realRepo();
    const t = term();
    const exec = async () => {
      t.handler();
      return { code: 143, output: '' };
    };
    const res = await runReal([], { cwd: r, exec, ctx: t.ctx });
    expect(res.out).not.toContain('superseded:');
    expect(t.exits).toEqual([143]);
    expect(filesIn(runningAt())).toEqual([]);
  });

  it('puts no handler on a job run or on a run outside a session', async () => {
    write();
    const r = realRepo();
    let calls = 0;
    const onTerm = () => { calls++; return () => {}; };
    const job = await runReal([], { cwd: r, exec: countingExec().exec, ctx: { onTerm, job: 'w1-new-1', runAlive: () => true, cores: 16 } });
    expect(job.code).toBe(0);
    const outside = await runReal([], { cwd: r, exec: countingExec().exec, session: false, ctx: { onTerm } });
    expect(outside.code).toBe(0);
    expect(calls).toBe(0);
  });

  it('passes a normal run through unchanged, and removes its handler', async () => {
    write();
    const r = realRepo();
    const t = term();
    const res = await runReal([], { cwd: r, exec: countingExec().exec, ctx: t.ctx });
    expect(res.code).toBe(0);
    expect(res.out).toContain('PASS npm test');
    expect(res.out).not.toContain('superseded:');
    expect(t.removed).toBe(true);
    expect(t.exits).toEqual([]);
  });
});
