// The owner's controls from a story session whose FOREMAN_RUN is changed or unset, and from any
// process the run's live supervisor started, whatever its environment (FM-279). They refuse from
// a plain folder, a scratch repo and the slot worktree, and leave the anchor's state as it was;
// the owner's own terminal still runs them. The fixture is test/anchor-guard-fixture.mjs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { anchor, BIN, gitEnv, plain, readJson, run, runEnv, scratch, slot, snapshot, SWITCH, tmp, withAnchorRepos } from '../../../test/anchor-guard-fixture.mjs';

withAnchorRepos();

// The run stopped at 19:12 UTC on 2026-10-29: a tester probing FM-261 from a temp folder ran
// `foreman stop` with FOREMAN_RUN unset but its story, slot and the run's location variables
// still set, and it wrote the real STOP file. Later a session's `settings set` changed the real
// local settings. The owner's controls now refuse from such a session wherever it stands, and
// from any process the run's live supervisor started, whatever its environment.
describe('a story session whose FOREMAN_RUN is changed or unset (FM-279)', () => {
  const changed = (what) =>
    `${what} does not run from a Foreman story session whose FOREMAN_RUN is changed or unset (FOREMAN_STORY or FOREMAN_SLOT is still set); the owner runs it from their own terminal or the dashboard, and a test builds an owner environment from scratch in a temporary project.\n`;
  const STARTED = 'the state folder of the Foreman run (supervisor 4242) that started this process';
  const startedByRun = (what) =>
    `${what} would act on ${fs.realpathSync(path.join(anchor, '.foreman'))}, the state folder of the Foreman run (supervisor 4242) that started this process, so it does not run here; the owner runs it from their own terminal or the dashboard, and a test builds an owner environment from scratch in a temporary project.\n`;
  const drop = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
  const withoutRun = () => drop({ ...runEnv(), FOREMAN_RUN: undefined });
  const location = () => ({ FOREMAN_PROJECT_DIR: anchor, FOREMAN_STATE_DIR: path.join(anchor, '.foreman'), FOREMAN_STATE_SYNC: 'off' });
  const PLACES = [['a plain temp folder', () => plain], ['a scratch repo', () => scratch], ['the slot worktree', () => slot]];
  const ENVS = [
    ['FOREMAN_RUN unset', withoutRun],
    ['FOREMAN_RUN unset, FOREMAN_STORY and the location variables', () => ({ ...gitEnv(), FOREMAN_STORY: 'S-1', ...location() })],
    ["FOREMAN_RUN='0', FOREMAN_SLOT and the location variables", () => ({ ...gitEnv(), FOREMAN_RUN: '0', FOREMAN_SLOT: 'w1', ...location() })],
    // The FM-261 probe: an unquoted zsh string that did not split into separate variables.
    ['FOREMAN_RUN holding the unsplit string, FOREMAN_STORY and the location variables', () => ({ ...gitEnv(), FOREMAN_RUN: `1 FOREMAN_PROJECT_DIR=${anchor}`, FOREMAN_STORY: 'S-1', ...location() })],
  ];
  const noStopIn = (dir) => {
    expect(fs.existsSync(path.join(dir, 'STOP')), dir).toBe(false);
    expect(fs.existsSync(path.join(dir, 'service-stopped')), dir).toBe(false);
  };
  const noStopAnywhere = () => {
    for (const dir of [anchor, plain, scratch, slot]) noStopIn(path.join(dir, '.foreman'));
  };
  const writePid = (pid) => fs.writeFileSync(path.join(anchor, '.foreman', 'supervisor.pid'), `${pid}\n`);
  const alive = (pid) => pid === 4242;

  describe.each(PLACES)('from %s', (_, where) => {
    it.each(ENVS)('stop refuses with %s', async (_label, env) => {
      const before = snapshot();
      const r = await run(['stop'], { cwd: where(), env: env() });
      expect(r).toEqual({ code: 1, out: '', err: changed('foreman stop') });
      expect(snapshot()).toEqual(before);
      noStopAnywhere();
    });
  });

  it.each([
    [['pause'], 'foreman pause'],
    [['resume'], 'foreman resume'],
    [['stop', '--now'], 'foreman stop'],
    [['run', '--dry-run'], 'foreman run'],
    [['slot', 'w1', 'park'], 'foreman slot'],
    [['workers', '1'], 'foreman workers'],
    [['fixed'], 'foreman fixed'],
    [['handback', 'S-1'], 'foreman handback'],
    [['next', 'S-1'], 'foreman next'],
    [['service', 'install'], 'foreman service install'],
    [['service', 'uninstall'], 'foreman service uninstall'],
    [['settings', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', 'set', 'workers', '1', '--team'], 'foreman settings set'],
    [['settings', '--group', 'run', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', '--group=run', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', 'reset', 'workers'], 'foreman settings reset'],
    [['features', 'on', SWITCH], 'foreman features on'],
    [['features', 'off', SWITCH], 'foreman features off'],
  ])('%j refuses from the plain folder with FOREMAN_RUN unset', async (argv, what) => {
    const before = snapshot();
    const r = await run(argv, { cwd: plain, env: withoutRun() });
    expect(r).toEqual({ code: 1, out: '', err: changed(what) });
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(path.join(anchor, '.foreman', 'settings.json'), 'utf8')).toBe('{\n  "workers": 2\n}\n');
    expect(fs.existsSync(path.join(anchor, '.foreman', 'control.json'))).toBe(false);
    noStopAnywhere();
  });

  it('settings get and decide add are not owner controls and run as before', async () => {
    const get = await run(['settings', 'get', 'workers'], { cwd: plain, env: withoutRun() });
    expect(get).toEqual({ code: 0, out: '2\n', err: '' });
    const add = await run(['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Acme: pick one', '--option', 'Yes'], { cwd: plain, env: withoutRun() });
    expect(add.err).not.toContain('changed or unset');
    expect(add.code).toBe(0);
  });

  describe('a process the run started, with no session variable', () => {
    const started = () => ({ ...gitEnv(), FOREMAN_PROJECT_DIR: anchor, FOREMAN_STATE_DIR: path.join(anchor, '.foreman'), FOREMAN_STATE_SYNC: 'off' });
    beforeEach(() => writePid(4242));

    it.each(PLACES)('stop refuses from %s', async (_, where) => {
      const before = snapshot();
      const r = await run(['stop'], { cwd: where(), env: started(), alive, parents: () => [9, 4242, 1] });
      expect(r.code).toBe(1);
      expect(r.err).toContain(STARTED);
      expect(r.err).toBe(startedByRun('foreman stop'));
      expect(snapshot()).toEqual(before);
      noStopAnywhere();
    });

    it('settings set refuses and leaves the local settings as they were', async () => {
      const before = snapshot();
      const r = await run(['settings', 'set', 'workers', '1'], { cwd: plain, env: started(), alive, parents: () => [4242] });
      expect(r.err).toBe(startedByRun('foreman settings set'));
      expect(r.code).toBe(1);
      expect(snapshot()).toEqual(before);
    });

    it('stop refuses from the slot with every variable stripped: git finds the run', async () => {
      const before = snapshot();
      const r = await run(['stop'], { cwd: slot, env: gitEnv(), alive, parents: () => [9, 4242, 1] });
      expect(r.code).toBe(1);
      expect(r.err).toBe(startedByRun('foreman stop'));
      expect(snapshot()).toEqual(before);
      noStopAnywhere();
    });

    it('stop refuses under a session adopted from an earlier supervisor after a restart', async () => {
      fs.writeFileSync(path.join(anchor, '.foreman', 'supervisor-adopted.json'), `${JSON.stringify({ by: process.pid, pids: [5151] })}\n`);
      const before = snapshot();
      const r = await run(['stop'], { cwd: slot, env: gitEnv(), alive, parents: () => [9, 5151, 1] });
      expect(r.code).toBe(1);
      expect(r.err).toBe(startedByRun('foreman stop'));
      expect(snapshot()).toEqual(before);
      noStopAnywhere();
    });

    it('when the parents cannot be read, refuses with a location variable and lets it through without one', async () => {
      const before = snapshot();
      const refused = await run(['stop'], { cwd: plain, env: { ...gitEnv(), FOREMAN_STATE_DIR: path.join(anchor, '.foreman') }, alive, parents: () => null });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(STARTED);
      expect(snapshot()).toEqual(before);
      const allowed = await run(['stop'], { cwd: slot, env: gitEnv(), alive, parents: () => null });
      expect(allowed.err).toBe('');
      expect(allowed.code).toBe(0);
      expect(fs.existsSync(path.join(anchor, '.foreman', 'STOP'))).toBe(true);
    });
  });

  it("the owner's own terminal still stops the run and changes its settings", async () => {
    writePid(4242);
    const r = await run(['stop'], { cwd: anchor, env: gitEnv(), alive, parents: () => [9, 1] });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const rec = readJson(path.join(anchor, '.foreman', 'STOP'));
    expect(rec).toMatchObject({ via: 'cli', run: false, story: null, slot: null });
    expect(readJson(path.join(anchor, '.foreman', 'service-stopped'))).toEqual(rec);
    const set = await run(['settings', 'set', 'workers', '1'], { cwd: anchor, env: gitEnv(), alive, parents: () => [9, 1] });
    expect(set.err).toBe('');
    expect(set.code).toBe(0);
    expect(readJson(path.join(anchor, '.foreman', 'settings.json')).workers).toBe(1);
  });

  it('with no live supervisor the parents are never read', async () => {
    const parents = () => {
      throw new Error('parents read without a live supervisor');
    };
    const r = await run(['pause'], { cwd: scratch, env: { ...gitEnv(), FOREMAN_PROJECT_DIR: anchor }, parents });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(readJson(path.join(anchor, '.foreman', 'control.json')).paused).toBe(true);
  });

  // The real binary, started by a stand-in supervisor (a script named supervisor.mjs, so ps
  // counts it as one), with the default parent lookup and liveness check on this machine.
  describe('the real foreman command', () => {
    const fakes = [];
    afterEach(() => {
      for (const child of fakes.splice(0)) {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    });
    const writeFake = (body) => {
      const dir = path.join(tmp, `fake-${fakes.length}-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(dir);
      const file = path.join(dir, 'supervisor.mjs');
      fs.writeFileSync(file, body);
      return file;
    };
    const pidFile = () => path.join(anchor, '.foreman', 'supervisor.pid');
    const withoutPid = (snap) => Object.fromEntries(Object.entries(snap).filter(([rel]) => rel !== path.join('.foreman', 'supervisor.pid')));
    const STOPPER = [
      "import { spawnSync } from 'node:child_process';",
      "import fs from 'node:fs';",
      'const [pidFile, foreman, cwd, env] = process.argv.slice(2);',
      'fs.writeFileSync(pidFile, `${process.pid}\\n`);',
      "const r = spawnSync(process.execPath, [foreman, 'stop'], { cwd, env: JSON.parse(env), encoding: 'utf8', timeout: 30000 }); // supervisor-guard: not a supervisor",
      'process.stdout.write(JSON.stringify({ status: r.status, stderr: r.stderr }));',
      '',
    ].join('\n');
    const stopUnder = (cwd, env) => {
      const r = spawnSync(process.execPath, [writeFake(STOPPER), pidFile(), BIN, cwd, JSON.stringify(env)], { encoding: 'utf8', timeout: 60_000 }); // supervisor-guard: not a supervisor
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout);
    };

    it('refuses under a live supervisor with every variable stripped, from the slot', () => {
      const before = withoutPid(snapshot());
      const r = stopUnder(slot, gitEnv());
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/the state folder of the Foreman run \(supervisor \d+\) that started this process/);
      expect(withoutPid(snapshot())).toEqual(before);
      noStopAnywhere();
    });

    it('refuses with FOREMAN_RUN unset and the session variables left, from a plain folder', () => {
      const before = withoutPid(snapshot());
      const r = stopUnder(plain, withoutRun());
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(changed('foreman stop'));
      expect(withoutPid(snapshot())).toEqual(before);
      noStopAnywhere();
    });

    it("stops the run from the owner's terminal while a supervisor it did not start runs", async () => {
      const body = ["import fs from 'node:fs';", 'fs.writeFileSync(process.argv[2], `${process.pid}\\n`);', 'setInterval(() => {}, 1000);', ''].join('\n');
      const child = spawn(process.execPath, [writeFake(body), pidFile()], { stdio: 'ignore' });
      fakes.push(child);
      const deadline = Date.now() + 20_000;
      const held = () => {
        try {
          return fs.readFileSync(pidFile(), 'utf8').trim();
        } catch {
          return '';
        }
      };
      while (held() !== String(child.pid)) {
        if (Date.now() > deadline) throw new Error('the stand-in supervisor did not start');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const r = spawnSync(process.execPath, [BIN, 'stop'], { cwd: anchor, env: gitEnv(), encoding: 'utf8', timeout: 30_000 });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.join(anchor, '.foreman', 'STOP'))).toBe(true);
      expect(fs.existsSync(path.join(anchor, '.foreman', 'service-stopped'))).toBe(true);
    });
  });
});
