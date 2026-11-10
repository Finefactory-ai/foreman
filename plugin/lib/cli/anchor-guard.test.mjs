// Inside a Foreman run (FOREMAN_RUN=1) the commands that write a project's config, local
// settings, keys or owner controls refuse when their target is the project the run builds
// (FOREMAN_PROJECT_DIR), and work on a scratch git repo around the current folder.
// The commands refused from the slot worktree and from the anchor are in
// anchor-guard-refused.test.mjs, the owner's controls from a changed session in
// anchor-guard-owner.test.mjs; the fixture all three use is test/anchor-guard-fixture.mjs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ownerEnv } from '../engine/run-guard.mjs';
import { anchor, BIN, CONFIG, gitEnv, home, plain, readJson, refusal, repo, run, runEnv, scratch, slot, snapshot, SWITCH, tmp, withAnchorRepos } from '../../../test/anchor-guard-fixture.mjs';

withAnchorRepos();

describe('guarded commands in a story session', () => {
  describe("the supervisor's answers path, which runs without FOREMAN_RUN", () => {
    it('is not refused foreman sf deletes; it fails later, on the Acme config', async () => {
      const r = await run(['sf', 'deletes', 'allow', 'S-1'], { cwd: anchor, env: ownerEnv(runEnv()) });
      expect(r.err).not.toContain(refusal('foreman sf deletes', anchor));
      expect(r.err).toContain('this project does not use the salesforce pack');
    });

    it('is not refused foreman learning keep', async () => {
      const r = await run(['learning', 'keep', 'L-1'], { cwd: anchor, env: ownerEnv(runEnv()) });
      expect(r.err).not.toContain(refusal('foreman learning keep', anchor));
    });
  });

  describe('on a scratch repo, with the same run environment', () => {
    let before;
    beforeEach(() => {
      before = snapshot();
    });
    afterEach(() => {
      expect(snapshot()).toEqual(before);
    });

    it('settings set and reset change the scratch local settings', async () => {
      const set = await run(['settings', 'set', 'workers', '1'], { cwd: scratch });
      expect(set.err).toBe('');
      expect(set.code).toBe(0);
      expect(readJson(path.join(scratch, '.foreman', 'settings.json')).workers).toBe(1);
      const reset = await run(['settings', 'reset', 'workers'], { cwd: scratch });
      expect(reset.code).toBe(0);
      expect(readJson(path.join(scratch, '.foreman', 'settings.json'))).not.toHaveProperty('workers');
    });

    it('features on writes the scratch local settings', async () => {
      const r = await run(['features', 'on', SWITCH], { cwd: scratch });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(readJson(path.join(scratch, '.foreman', 'settings.json'))[`features.${SWITCH}`]).toBe(true);
    });

    it('traits add writes the scratch traits', async () => {
      const r = await run(['traits', 'add', 'all', 'Acme rule'], { cwd: scratch });
      expect(r.code).toBe(0);
      expect(fs.readFileSync(path.join(scratch, '.claude', 'foreman', 'traits', 'all.md'), 'utf8')).toBe('Acme rule\n');
    });

    it('workers and pause write the scratch control file', async () => {
      expect((await run(['workers', '1'], { cwd: scratch })).code).toBe(0);
      expect((await run(['pause'], { cwd: scratch })).code).toBe(0);
      const control = readJson(path.join(scratch, '.foreman', 'control.json'));
      expect(control.workers).toBe(1);
      expect(control.paused).toBe(true);
    });

    it('init write --from writes a fresh scratch config', async () => {
      const fresh = repo('fresh', { config: false });
      const from = path.join(tmp, 'acme-config.json');
      fs.writeFileSync(from, CONFIG);
      const r = await run(['init', 'write', '--from', from, '--no-example'], { cwd: fresh });
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(readJson(path.join(fresh, 'foreman.config.json')).project.name).toBe('Acme');
    });

    it.each([
      [['learning', 'undo', 'L-1']],
      [['decide', 'answer', 'D-1', 'yes']],
      [['learn', 'reopen', 'D-1']],
      [['slot', 'w1', 'park']],
      [['handback', 'S-1']],
      [['next', 'S-1']],
    ])('%j reaches the command', async (argv) => {
      const r = await run(argv, { cwd: scratch });
      expect(r.err).not.toContain('the project this Foreman run builds');
    });
  });

  it('reads work against the anchor from the slot, and against the scratch repo from there', async () => {
    for (const argv of [['settings', 'get', 'workers'], ['settings', 'list'], ['config', 'show'], ['learning', 'list']]) {
      const r = await run(argv, { cwd: slot });
      expect(r.code, argv.join(' ')).toBe(0);
    }
    // From a scratch repo a read reads that repo, like every other command run there.
    const fromScratch = await run(['settings', 'get', 'workers'], { cwd: scratch });
    expect(fromScratch).toEqual({ code: 0, out: '1\n', err: '' });
  });

  it('outside a run nothing changes: settings set writes FOREMAN_PROJECT_DIR', async () => {
    const env = { ...gitEnv(), FOREMAN_PROJECT_DIR: anchor };
    const r = await run(['settings', 'set', 'workers', '1'], { cwd: scratch, env });
    expect(r.code).toBe(0);
    expect(readJson(path.join(anchor, '.foreman', 'settings.json')).workers).toBe(1);
    expect(fs.existsSync(path.join(scratch, '.foreman', 'settings.json'))).toBe(false);
  });

  describe('the real foreman command', () => {
    const foreman = (cwd) => spawnSync(process.execPath, [BIN, 'settings', 'set', 'workers', '1'], { cwd, env: runEnv(), encoding: 'utf8', timeout: 30_000 });

    it('refuses from the slot worktree and leaves the anchor as it was', () => {
      const before = snapshot();
      const r = foreman(slot);
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(refusal('foreman settings set', anchor));
      expect(snapshot()).toEqual(before);
    });

    it('works from the scratch repo', () => {
      const before = snapshot();
      const r = foreman(scratch);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(scratch, '.foreman', 'settings.json'), 'utf8')).toContain('"workers": 1');
      expect(snapshot()).toEqual(before);
    });
  });
});

// Commands that are not guarded (decide add, story, stage, lock, learn apply and the rest) are
// how a story session keeps its own records, so from the slot they act on the run's project.
// Run inside a scratch repo, which is not the run's project, they act on that repo instead, so
// a session checking them there never writes the owner's records.
describe('every other Foreman command in a story session', () => {
  const decisions = (dir) => {
    const d = path.join(dir, '.foreman', 'decisions');
    return fs.existsSync(d) ? fs.readdirSync(d) : [];
  };
  const addDecision = ['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Acme: pick one', '--option', 'Yes', '--option', 'No'];

  it('decide add from a scratch repo writes the scratch repo and leaves the anchor as it was', async () => {
    const before = snapshot();
    const r = await run(addDecision, { cwd: scratch });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(decisions(scratch)).toHaveLength(1);
    expect(snapshot()).toEqual(before);
  });

  it('lock owner-claim from a scratch repo writes the scratch repo and leaves the anchor as it was', async () => {
    const before = snapshot();
    const r = await run(['lock', 'owner-claim', 'S-1'], { cwd: scratch });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(scratch, '.foreman', 'claims', 'S-1.json'))).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it('stage from a scratch repo leaves the anchor as it was (the scratch repo has no story, so nothing is recorded)', async () => {
    const before = snapshot();
    const r = await run(['stage', 'build', 'checking'], { cwd: scratch });
    expect(r.code).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it('a folder inside the scratch repo counts as the scratch repo', async () => {
    const sub = path.join(scratch, 'stories');
    const before = snapshot();
    const r = await run(addDecision, { cwd: sub });
    expect(r.code).toBe(0);
    expect(decisions(scratch)).toHaveLength(1);
    expect(snapshot()).toEqual(before);
  });

  it('decide add from the slot worktree still writes the run\'s project, as the story skill needs', async () => {
    const r = await run(addDecision, { cwd: slot });
    expect(r.code).toBe(0);
    expect(decisions(anchor)).toHaveLength(1);
    expect(decisions(scratch)).toHaveLength(0);
  });

  it('outside any git repo the command acts on that folder, never on FOREMAN_PROJECT_DIR or FOREMAN_STATE_DIR', async () => {
    const before = snapshot();
    const r = await run(addDecision, { cwd: home });
    expect(r.code).not.toBe(0);
    expect(decisions(anchor)).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('decide add from a plain temp project writes that project and leaves the anchor as it was', async () => {
    const before = snapshot();
    const r = await run(addDecision, { cwd: plain });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(decisions(plain)).toHaveLength(1);
    expect(decisions(anchor)).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('outside a run nothing changes: decide add from a scratch repo follows FOREMAN_PROJECT_DIR', async () => {
    const env = runEnv();
    delete env.FOREMAN_RUN;
    const r = await run(addDecision, { cwd: scratch, env });
    expect(r.code).toBe(0);
    expect(decisions(anchor)).toHaveLength(1);
    expect(decisions(scratch)).toHaveLength(0);
  });

  it('the real foreman command: decide add from a scratch repo leaves the anchor as it was', () => {
    const before = snapshot();
    const r = spawnSync(process.execPath, [BIN, ...addDecision], { cwd: scratch, env: runEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(decisions(scratch)).toHaveLength(1);
    expect(snapshot()).toEqual(before);
  });
});

// The run stopped at 04:01 one night with `foreman stop --now`, most likely from a session
// checking it on a temp Acme project that was not a git repo. From every place a session can
// stand, a stop either acts on the temp or scratch project or is refused; the run's own state
// folder never changes.
describe('stopping the run from a story session (Done when)', () => {
  const runState = () => path.join(anchor, '.foreman');
  const stateRefusal = (what) =>
    `${what} would act on ${fs.realpathSync(runState())}, the state folder of the run this session belongs to, so it does not run inside a story session (FOREMAN_RUN=1).\n`;
  const inRunRefusal = (what) => `${what} does not run inside a Foreman story session (FOREMAN_RUN=1); run it yourself from the project's folder.\n`;
  const noStopIn = (dir) => {
    expect(fs.existsSync(path.join(dir, 'STOP'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'service-stopped'))).toBe(false);
  };

  it.each([
    [['stop', '--now'], true],
    [['pause'], false],
    [['resume'], false],
  ])('%j from a plain temp project acts on it, not on the run', async (argv, stops) => {
    const before = snapshot();
    const r = await run(argv, { cwd: plain });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(plain, '.foreman', 'STOP'))).toBe(stops);
    expect(fs.existsSync(path.join(plain, '.foreman', 'service-stopped'))).toBe(stops);
    if (!stops) expect(fs.existsSync(path.join(plain, '.foreman', 'control.json'))).toBe(true);
    expect(snapshot()).toEqual(before);
    noStopIn(runState());
  });

  it('stop --now from a scratch repo acts on the scratch repo', async () => {
    const before = snapshot();
    const r = await run(['stop', '--now'], { cwd: scratch });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(scratch, '.foreman', 'STOP'))).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it('stop --now from the slot worktree is refused', async () => {
    const before = snapshot();
    const r = await run(['stop', '--now'], { cwd: slot });
    expect(r.err).toBe(refusal('foreman stop', anchor));
    expect(r.code).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it('stop --now from a temp folder with no config fails there and leaves the run alone', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const before = snapshot();
    const r = await run(['stop', '--now'], { cwd: empty });
    expect(r.code).toBe(1);
    expect(snapshot()).toEqual(before);
    noStopIn(runState());
    noStopIn(path.join(slot, '.foreman'));
  });

  it.each([
    [['stop'], 'foreman stop'],
    [['run', '--dry-run'], 'foreman run'],
    [['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Acme', '--option', 'Yes'], 'foreman decide'],
  ])('%j from a plain project whose stateDir is the run\'s state folder is refused', async (argv, what) => {
    const sneaky = path.join(tmp, 'sneaky-acme');
    fs.mkdirSync(sneaky);
    fs.writeFileSync(path.join(sneaky, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, stateDir: path.relative(sneaky, runState()) }));
    const before = snapshot();
    const r = await run(argv, { cwd: sneaky });
    expect(r.err).toBe(stateRefusal(what));
    expect(r.code).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it.each([
    [['stop'], 'foreman stop'],
    [['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Acme', '--option', 'Yes'], 'foreman decide'],
  ])('%j from a folder that does not exist is refused', async (argv, what) => {
    const gone = path.join(tmp, 'gone');
    const before = snapshot();
    const r = await run(argv, { cwd: gone });
    expect(r.err).toBe(
      `${what} cannot tell which project ${gone} belongs to (the folder ${gone} does not exist), so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo or a plain temporary folder.\n`,
    );
    expect(r.code).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it.each([
    [['service', 'uninstall'], 'foreman service uninstall'],
    [['service', 'install'], 'foreman service install'],
  ])('%j from a plain project is still refused', async (argv, what) => {
    const before = snapshot();
    const r = await run(argv, { cwd: plain });
    expect(r.err).toBe(inRunRefusal(what));
    expect(r.code).toBe(1);
    expect(snapshot()).toEqual(before);
  });

  it('the real foreman command: stop --now from a plain temp project leaves the run alone', () => {
    const before = snapshot();
    const r = spawnSync(process.execPath, [BIN, 'stop', '--now'], { cwd: plain, env: runEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(plain, '.foreman', 'STOP'))).toBe(true);
    expect(snapshot()).toEqual(before);
    noStopIn(runState());
  });

  it('the real foreman command: stop --now from the slot worktree and from a scratch repo', () => {
    const before = snapshot();
    const fromSlot = spawnSync(process.execPath, [BIN, 'stop', '--now'], { cwd: slot, env: runEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(fromSlot.status).toBe(1);
    expect(fromSlot.stderr).toBe(refusal('foreman stop', anchor));
    const fromScratch = spawnSync(process.execPath, [BIN, 'stop', '--now'], { cwd: scratch, env: runEnv(), encoding: 'utf8', timeout: 30_000 });
    expect(fromScratch.status).toBe(0);
    expect(fs.existsSync(path.join(scratch, '.foreman', 'STOP'))).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it('stop --now signals no supervisor, even a live one the pid file names', async () => {
    const script = path.join(tmp, 'supervisor.mjs');
    fs.writeFileSync(script, 'setTimeout(() => process.exit(0), 60_000); setInterval(() => {}, 1000);\n');
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    try {
      await new Promise((resolve, reject) => child.once('spawn', resolve).once('error', reject));
      fs.writeFileSync(path.join(runState(), 'supervisor.pid'), `${child.pid}\n`);
      const before = snapshot();
      for (const cwd of [slot, anchor]) {
        const r = await run(['stop', '--now'], { cwd });
        expect(r.err).toBe(refusal('foreman stop', anchor));
        expect(r.code).toBe(1);
        expect(r.out).toBe('');
      }
      expect(snapshot()).toEqual(before);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('a stop from a plain project names the session that sent it', async () => {
    const r = await run(['stop'], { cwd: plain });
    expect(r.code).toBe(0);
    const rec = readJson(path.join(plain, '.foreman', 'STOP'));
    expect(rec).toMatchObject({ via: 'cli', run: true, story: 'S-1', slot: 'w1', cwd: plain });
    expect(readJson(path.join(plain, '.foreman', 'service-stopped'))).toEqual(rec);
  });
});
