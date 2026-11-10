// `foreman checks --start` and `--wait`, with real processes: the run is detached, returns at
// once, and gives the result a foreground run gives, recorded the same way.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';
import { JOB_ID } from '../../engine/check-jobs.mjs';
import { sessionEnvPath } from '../../engine/session-env.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-checks-start-'));
});
afterEach(() => {
  const jobs = path.join(dir, 'state', 'check-jobs');
  for (const f of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
    if (!f.endsWith('.json') || f.endsWith('.result.json')) continue;
    try {
      process.kill(-JSON.parse(fs.readFileSync(path.join(jobs, f), 'utf8')).pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const config = (checks, where = dir, extra = {}) => fs.writeFileSync(path.join(where, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 2, checks, ...extra }));
const stateOf = () => path.join(dir, 'state');
const jobsAt = () => path.join(stateOf(), 'check-jobs');

async function foreman(argv, { cwd = dir, env: given } = {}) {
  let out = '';
  let err = '';
  const env = given ?? { ...process.env, FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: stateOf() };
  if (!given) delete env.FOREMAN_RUN;
  const code = await main(argv, { cwd, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

const idOf = (res) => /started the checks as (\S+);/.exec(res.out)?.[1];
const job = (id) => JSON.parse(fs.readFileSync(path.join(jobsAt(), `${id}.json`), 'utf8'));

// Waits until the run ends, as an agent would: again while it says still running.
async function finish(id, seconds = 10, opts = {}) {
  for (let i = 0; i < 60; i++) {
    const res = await foreman(['checks', '--wait', id, '--for', String(seconds)], opts);
    if (res.code !== 75) return res;
  }
  throw new Error('the check run never ended');
}

const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const gitIn = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// The anchor: a git repo at <dir>/repo with one commit and the config (untracked, so worktrees of
// the commit are the same tree).
function anchor(checks, extra = {}) {
  const r = path.join(dir, 'repo');
  fs.mkdirSync(r);
  gitIn(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'a.txt'), 'a\n');
  gitIn(r, 'add', '-A');
  gitIn(r, 'commit', '-q', '-m', 'one');
  config(checks, r, extra);
  return r;
}

// A worktree of the anchor and the environment of a session in it, with its env file seeded.
function slotIn(r, slot, extra = {}) {
  const wt = path.join(dir, slot);
  gitIn(r, 'worktree', 'add', '-q', wt);
  const env = {
    PATH: process.env.PATH,
    ACME_SESSION_VAR: 'yes',
    FOREMAN_RUN: '1',
    FOREMAN_SLOT: slot,
    FOREMAN_STORY: `ACME-${slot}`,
    FOREMAN_PROJECT_DIR: r,
    FOREMAN_STATE_DIR: stateOf(),
    ...extra,
  };
  fs.mkdirSync(path.join(stateOf(), 'session-config'), { recursive: true });
  fs.writeFileSync(sessionEnvPath(stateOf(), slot), JSON.stringify(env));
  return { cwd: wt, env };
}

const records = () => fs.readFileSync(path.join(stateOf(), 'check-runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('foreman checks --start', () => {
  it('returns at once with an id, and --wait says still running while the check does', async () => {
    config([{ run: 'sleep 20', when: 'always' }]);
    const t0 = Date.now();
    const started = await foreman(['checks', '--start']);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(started.code).toBe(0);
    const id = idOf(started);
    expect(id).toMatch(/^here-/);
    expect(started.out).toBe(`started the checks as ${id}; collect the result with: foreman checks --wait ${id}\n`);
    const j = job(id);
    expect(gone(j.pid)).toBe(false);
    expect(j).toMatchObject({ id, slot: null, args: [], cwd: dir });

    const t1 = Date.now();
    const waited = await foreman(['checks', '--wait', id, '--for', '1']);
    expect(Date.now() - t1).toBeLessThan(4000);
    expect(waited.code).toBe(75);
    expect(waited.out).toContain(`still running: ${id}, `);
  });

  it('gives exactly the stdout, stderr and exit code of a foreground run', async () => {
    config([
      { run: 'echo hello-from-check; echo to-err 1>&2', when: 'always' },
      { run: 'exit 3', when: 'always' },
    ]);
    const fg = await foreman(['checks']);
    expect(fg.code).toBe(1);
    expect(fg.out).toContain('hello-from-check');
    expect(fg.err).toContain('to-err');
    const started = await foreman(['checks', '--start']);
    const res = await finish(idOf(started));
    expect(res.out).toBe(fg.out);
    expect(res.err).toBe(fg.err);
    expect(res.code).toBe(1);
  });

  it('records the run on the tree and a later --reuse prints it without running', async () => {
    const r = anchor([{ run: `echo x >> ${path.join(dir, 'count')}; echo ran`, when: 'always' }]);
    const one = slotIn(r, 'w1');
    const two = slotIn(r, 'w2');
    const started = await foreman(['checks', '--start'], one);
    const res = await finish(idOf(started), 10, one);
    expect(res.code).toBe(0);
    const lines = records();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ exit: 0, tail: 'ran', env: 'session', slot: 'w1' });
    expect(lines[0].tree).toBe(gitIn(r, 'rev-parse', 'HEAD^{tree}').trim());
    const again = await foreman(['checks', '--reuse'], two);
    expect(again.code).toBe(0);
    expect(again.out).toContain('reused:');
    expect(again.out).toContain('(reused)');
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf8')).toBe('x\n');
  });

  it('forwards --quick: the started run runs the quick command and records it as a quick run', async () => {
    const r = anchor([{ run: 'echo full', when: 'always', quick: 'echo quick' }]);
    const one = slotIn(r, 'w1');
    const started = await foreman(['checks', '--start', '--quick'], one);
    expect(started.code).toBe(0);
    const id = idOf(started);
    expect(job(id).args).toEqual(['--quick']);
    const res = await finish(id, 10, one);
    expect(res.code).toBe(0);
    expect(res.out).toContain('$ echo quick\n');
    expect(res.out).toContain('PASS echo quick (quick)\n');
    expect(res.out).not.toContain('echo full');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ run: 'echo full', quick: true, cmd: 'echo quick', exit: 0, env: 'session' });
  });

  it('does not let a variable set only on the calling shell reach the check, foreground or started', async () => {
    const r = anchor([{ run: 'echo "shell=${ACME_SHELL_ONLY:-unset} session=${ACME_SESSION_VAR:-unset}"', when: 'always' }]);
    const one = slotIn(r, 'w1');
    const shell = { cwd: one.cwd, env: { ...one.env, ACME_SHELL_ONLY: '1', NODE_OPTIONS: `--require ${path.join(dir, 'missing-preload.js')}` } };
    const fg = await foreman(['checks'], shell);
    expect(fg.code).toBe(0);
    expect(fg.out).toContain('shell=unset session=yes');
    // The worker is a node process: a preload that cannot load would end it before it ran anything.
    const started = await foreman(['checks', '--start'], shell);
    const res = await finish(idOf(started), 10, shell);
    expect(res.err).not.toContain('missing-preload');
    expect(res.code).toBe(0);
    expect(res.out).toContain('shell=unset session=yes');
    expect(res.out).not.toContain('shell=1');
    expect(records().every((e) => e.env === 'session')).toBe(true);
  });

  it('does not trust an env file for a slot the project does not have: a started w9 run is a caller-env run', async () => {
    const r = anchor([{ run: 'echo "shell=${ACME_SHELL_ONLY:-unset} session=${ACME_SESSION_VAR:-unset}"', when: 'always' }]);
    const nine = slotIn(r, 'w9');
    const shell = { cwd: nine.cwd, env: { ...nine.env, ACME_SHELL_ONLY: '1' } };
    const res = await finish(idOf(await foreman(['checks', '--start'], shell)), 10, shell);
    expect(res.code).toBe(0);
    expect(res.out).toContain('shell=1 session=yes');
    expect(records().every((e) => e.env === 'caller')).toBe(true);
  });

  it('two slots started back to back run the check once; the other waits and prints its result', async () => {
    const count = path.join(dir, 'count');
    const release = path.join(dir, 'release');
    const r = anchor([{ run: `echo x >> ${count}; while [ ! -f ${release} ]; do sleep 0.1; done; echo ran-once; exit 3`, when: 'always' }]);
    const one = slotIn(r, 'w1');
    const two = slotIn(r, 'w2');
    const id1 = idOf(await foreman(['checks', '--start'], one));
    const id2 = idOf(await foreman(['checks', '--start'], two));
    expect(id1).toMatch(/^w1-/);
    expect(id2).toMatch(/^w2-/);
    // Let the check go once one of the two says it is waiting on the other.
    const said = () => [id1, id2].some((id) => fs.existsSync(path.join(jobsAt(), `${id}.out`)) && fs.readFileSync(path.join(jobsAt(), `${id}.out`), 'utf8').includes('waiting:'));
    for (let i = 0; i < 600 && !said(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(said()).toBe(true);
    fs.writeFileSync(release, '');
    const [a, b] = await Promise.all([finish(id1, 10, one), finish(id2, 10, two)]);
    expect(fs.readFileSync(count, 'utf8')).toBe('x\n');
    expect(a.code).toBe(1);
    expect(b.code).toBe(1);
    expect(a.out).toContain('ran-once');
    expect(b.out).toContain('ran-once');
    expect([a.out, b.out].filter((o) => o.includes('waiting:'))).toHaveLength(1);
    const lines = records();
    const real = lines.filter((e) => !e.reused);
    const waited = lines.filter((e) => e.reused === true && e.waited === true);
    expect(real).toHaveLength(1);
    expect(real[0]).toMatchObject({ exit: 3, env: 'session', tail: 'ran-once' });
    expect(waited).toHaveLength(1);
    expect(waited[0].from).toBe(real[0].at);
    expect(lines).toHaveLength(2);
    const claims = path.join(stateOf(), 'check-claims');
    expect(fs.existsSync(claims) ? fs.readdirSync(claims) : []).toEqual([]);
  });

  it('forwards --changed: a check whose file changed runs', async () => {
    const r = path.join(dir, 'repo');
    fs.mkdirSync(r);
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: r, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(r, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    fs.writeFileSync(path.join(r, 'new.sql'), 'select 1;\n');
    config([
      { run: 'echo always-ran', when: 'always' },
      { run: 'echo sql-ran', when: '**/*.sql' },
      { run: 'echo ui-ran', when: 'src/ui/**' },
    ]);
    const started = await foreman(['checks', '--changed', '--start'], { cwd: r });
    const id = idOf(started);
    expect(job(id).args).toEqual(['--changed']);
    const res = await finish(id);
    expect(res.code).toBe(0);
    expect(res.out).toContain('sql-ran');
    expect(res.out).not.toContain('ui-ran');
  });

  it('forwards --all: a glob check no file chose runs', async () => {
    config([
      { run: 'echo always-ran', when: 'always' },
      { run: 'echo ui-ran', when: 'src/ui/**' },
    ]);
    const id = idOf(await foreman(['checks', '--all', '--start']));
    expect(job(id).args).toEqual(['--all']);
    const res = await finish(id);
    expect(res.code).toBe(0);
    expect(res.out).toContain('ui-ran');
    expect((await foreman(['checks', '--all', '--changed', '--start'])).code).toBe(64);
  });

  it('says the process is gone, within one call, when the run was killed', async () => {
    config([{ run: 'sleep 20', when: 'always' }]);
    const id = idOf(await foreman(['checks', '--start']));
    const { pid } = job(id);
    process.kill(-pid, 'SIGKILL');
    for (let i = 0; i < 50 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(gone(pid)).toBe(true);
    const t0 = Date.now();
    const res = await foreman(['checks', '--wait', id, '--for', '30']);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.code).toBe(1);
    expect(res.out + res.err).toContain('is gone');
  });

  it('says the process is gone when its pid now belongs to another program', async () => {
    config([{ run: 'sleep 20', when: 'always' }]);
    const id = idOf(await foreman(['checks', '--start']));
    const { pid } = job(id);
    process.kill(-pid, 'SIGKILL');
    for (let i = 0; i < 50 && !gone(pid); i++) await new Promise((r) => setTimeout(r, 100));
    // An unrelated program under the pid the job names (here this test's own process).
    fs.writeFileSync(path.join(jobsAt(), `${id}.json`), JSON.stringify({ ...job(id), pid: process.pid }));
    const res = await foreman(['checks', '--wait', id, '--for', '30']);
    expect(res.code).toBe(1);
    expect(res.out + res.err).toContain('is gone');
  });

  it('keeps the output files of a run to their owner, and --wait still prints them', async () => {
    config([{ run: 'echo acme-secret; echo acme-err 1>&2', when: 'always' }]);
    const id = idOf(await foreman(['checks', '--start']));
    const res = await finish(id);
    expect(res.out).toContain('acme-secret');
    for (const ext of ['out', 'err']) expect(fs.statSync(path.join(jobsAt(), `${id}.${ext}`)).mode & 0o077).toBe(0);
  });

  it('writes nothing outside check-jobs/ when the slot holds a path', async () => {
    config([{ run: 'true', when: 'always' }]);
    const env = { ...process.env, FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: stateOf(), FOREMAN_SLOT: '../../evil' };
    delete env.FOREMAN_RUN;
    const started = await foreman(['checks', '--start'], { env });
    expect(started.code).toBe(0);
    const id = idOf(started);
    expect(id).toMatch(JOB_ID);
    expect(id).not.toContain('/');
    expect(fs.existsSync(path.join(jobsAt(), `${id}.json`))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('evil'))).toEqual([]);
    expect(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('evil'))).toEqual([]);
    const res = await finish(id, 10, { env });
    expect(res.code).toBe(0);
  });

  it('starts nothing on a bad config', async () => {
    const res = await foreman(['checks', '--start']);
    expect(res.code).toBe(1);
    expect(fs.existsSync(jobsAt())).toBe(false);
  });
});

const until = async (test, what, tries = 600) => {
  for (let i = 0; i < tries && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!test()) throw new Error(`never happened: ${what}`);
};
const outOf = (id) => (fs.existsSync(path.join(jobsAt(), `${id}.out`)) ? fs.readFileSync(path.join(jobsAt(), `${id}.out`), 'utf8') : '');
const filesIn = (name) => {
  const d = path.join(stateOf(), name);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => !f.endsWith('.tmp')) : [];
};

describe('foreman checks --start: one full run per worktree, and a cap across slots', () => {
  it('a newer run on a changed tree stops the older one, and --wait on the older follows the newer', async () => {
    const count = path.join(dir, 'count');
    const release = path.join(dir, 'release');
    const r = anchor([{ run: `while [ ! -f ${release} ]; do sleep 0.1; done; echo x >> ${count}; echo done-$(cat a.txt)`, when: 'always' }]);
    const one = slotIn(r, 'w1');
    const first = idOf(await foreman(['checks', '--start'], one));
    // The first run has hashed its tree and registered before the edit changes the tree.
    await until(() => filesIn('check-running').length === 1, 'the first run registered');
    fs.writeFileSync(path.join(one.cwd, 'a.txt'), 'edited\n');
    const second = idOf(await foreman(['checks', '--start'], one));
    const firstPid = job(first).pid;
    await until(() => gone(firstPid), 'the older run stopped');
    expect(gone(job(second).pid)).toBe(false);
    fs.writeFileSync(release, '');
    const res = await finish(first, 10, one);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`superseded: ${first} was stopped for a newer run in its worktree (${second}); following ${second}\n`);
    expect(res.out).toContain('done-edited');
    const lines = records();
    expect(lines).toHaveLength(1);
    expect(lines[0].tree).not.toBe(gitIn(r, 'rev-parse', 'HEAD^{tree}').trim());
    expect(lines[0]).toMatchObject({ exit: 0, slot: 'w1' });
    // Nothing of the stopped run is left to finish after the release.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(fs.readFileSync(count, 'utf8')).toBe('x\n');
    expect(filesIn('check-running')).toEqual([]);
    expect(filesIn('check-slots')).toEqual([]);
  });

  it('a foreground run that a newer run stops says it was superseded', async () => {
    const release = path.join(dir, 'release');
    const r = anchor([{ run: `while [ ! -f ${release} ]; do sleep 0.1; done; echo ran-$(cat a.txt)`, when: 'always' }]);
    const one = slotIn(r, 'w1');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../../bin/foreman', import.meta.url)), 'checks'], { cwd: one.cwd, env: one.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    try {
      await until(() => filesIn('check-running').length === 1, 'the foreground run registered');
      const [mine] = filesIn('check-running');
      fs.writeFileSync(path.join(one.cwd, 'a.txt'), 'edited\n');
      const second = idOf(await foreman(['checks', '--start'], one));
      // 143 when its SIGTERM handler ran first, 1 when it saw its check end first (a loaded
      // machine). Either way it says why.
      expect([143, 1]).toContain(await exited);
      expect(out).toContain('superseded: stopped for a newer run in this worktree');
      expect(filesIn('check-running')).not.toContain(mine);
      expect(filesIn('check-running').filter((f) => f.startsWith(mine.replace('.json', '')))).toEqual([]);
      fs.writeFileSync(release, '');
      const res = await finish(second, 10, one);
      expect(res.code).toBe(0);
      expect(res.out).toContain('ran-edited');
      expect(filesIn('check-running')).toEqual([]);
      expect(filesIn('check-slots')).toEqual([]);
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  it('queues the second full run over the cap, beating its slot meanwhile, and both end well', async () => {
    const release = path.join(dir, 'release');
    const r = anchor([{ run: `while [ ! -f ${release} ]; do sleep 0.1; done; echo ran-$(cat a.txt)`, when: 'always' }], { checkRuns: { maxParallel: 1 } });
    const one = slotIn(r, 'w1');
    const two = slotIn(r, 'w2');
    fs.writeFileSync(path.join(two.cwd, 'a.txt'), 'other tree\n');
    const id1 = idOf(await foreman(['checks', '--start'], one));
    const id2 = idOf(await foreman(['checks', '--start'], two));
    const queued = () => [id1, id2].find((id) => outOf(id).includes('waiting for a free check slot: 1 of 1 in use'));
    await until(() => queued(), 'one of the two queued');
    const waiting = queued() === id1 ? 'w1' : 'w2';
    const slotFile = path.join(stateOf(), 'slots', `${waiting}.json`);
    await until(() => fs.existsSync(slotFile) && typeof JSON.parse(fs.readFileSync(slotFile, 'utf8')).lastBeat === 'string', 'the queued slot beat');
    expect([id1, id2].filter((id) => outOf(id).includes('waiting for a free check slot'))).toHaveLength(1);
    fs.writeFileSync(release, '');
    const [a, b] = await Promise.all([finish(id1, 10, one), finish(id2, 10, two)]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.out + b.out).toContain('got a free check slot after');
    expect(a.out).toContain('ran-a');
    expect(b.out).toContain('ran-other tree');
    expect(filesIn('check-slots')).toEqual([]);
    expect(filesIn('check-running')).toEqual([]);
  });
});

