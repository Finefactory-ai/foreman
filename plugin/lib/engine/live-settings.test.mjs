import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDefaults } from '../config/defaults.mjs';
import { changed, changedAt, fileStamps, liveSettings, nextWorkers, recordsRuns, startWorkers, watchdogLimits } from './live-settings.mjs';

const config = (extra = {}) => withDefaults({ version: 1, project: { name: 'x' }, slots: 4, ...extra });

describe('changed and changedAt', () => {
  it('sees a change to either file, a file appearing and a file going', () => {
    expect(changed({ config: 'a', local: null }, { config: 'a', local: null })).toBe(false);
    expect(changed({ config: 'a', local: null }, { config: 'b', local: null })).toBe(true);
    expect(changed({ config: 'a', local: null }, { config: 'a', local: 'l' })).toBe(true);
    expect(changed({ config: 'a', local: 'l' }, { config: 'a', local: null })).toBe(true);
  });
  it('dates the change by the newest mtime among the files that changed', () => {
    expect(changedAt({ config: 'a', local: 'l' }, { config: 'a', local: 'm' }, { config: 900, local: 500 })).toBe(500);
    expect(changedAt({ config: 'a', local: 'l' }, { config: 'b', local: 'm' }, { config: 900, local: 500 })).toBe(900);
    expect(changedAt({ config: 'a', local: 'l' }, { config: 'a', local: null }, { config: 900, local: null })).toBe(0);
  });
});

describe('startWorkers', () => {
  it('takes the --workers flag when given', () => {
    expect(startWorkers({ flag: 3, config: config({ workers: 2 }), slots: 4 })).toEqual({ workers: 3, from: 'flag', events: [] });
  });
  it('takes the workers setting in effect otherwise', () => {
    expect(startWorkers({ flag: null, config: config({ workers: 2 }), slots: 4 })).toEqual({ workers: 2, from: 'settings', events: [] });
    expect(startWorkers({ flag: undefined, config: config(), slots: 4 }).workers).toBe(1);
  });
  it('caps it at the run\'s slots, with a warning (a local slots below the team workers)', () => {
    expect(startWorkers({ flag: null, config: config({ workers: 4 }), slots: 2 })).toEqual({
      workers: 2,
      from: 'settings',
      events: [{ text: 'Workers 4 is more than the 2 slots this run has; using 2.', kind: 'warn' }],
    });
  });
});

describe('nextWorkers', () => {
  const control = (value, at) => ({ from: 'control', value, at });
  const settings = (value, at) => ({ from: 'settings', value, at });

  it('keeps the current count with no change', () => {
    expect(nextWorkers({ current: 2, changes: [], slots: 4 })).toEqual({ workers: 2, events: [] });
  });
  it('applies a control.json change', () => {
    expect(nextWorkers({ current: 1, changes: [control(3, 10)], slots: 4 })).toEqual({ workers: 3, from: 'control', events: [{ text: 'Worker count set to 3; applied at the next pick.', kind: 'info' }] });
  });
  it('applies a settings change', () => {
    expect(nextWorkers({ current: 1, changes: [settings(2, 10)], slots: 4 }).events).toEqual([{ text: 'Worker count set to 2 in the settings; applied at the next pick.', kind: 'info' }]);
  });
  it('lets the newer change win, whichever it is', () => {
    expect(nextWorkers({ current: 1, changes: [control(3, 20), settings(2, 10)], slots: 4 }).workers).toBe(3);
    expect(nextWorkers({ current: 1, changes: [control(3, 10), settings(2, 20)], slots: 4 }).workers).toBe(2);
  });
  it('lets the settings change win a tie', () => {
    expect(nextWorkers({ current: 1, changes: [control(3, 10), settings(2, 10)], slots: 4 }).workers).toBe(2);
  });
  it('caps a change at the run\'s slots, with a warning', () => {
    expect(nextWorkers({ current: 1, changes: [settings(6, 10)], slots: 4 })).toMatchObject({ workers: 4, events: [{ text: 'Workers 6 is more than the 4 slots this run has; using 4.', kind: 'warn' }, { kind: 'info' }] });
  });
  it('says nothing when the count stays the same', () => {
    expect(nextWorkers({ current: 2, changes: [settings(2, 10)], slots: 4 }).events).toEqual([]);
  });
  it('ignores a value that is not a count', () => {
    expect(nextWorkers({ current: 2, changes: [settings(0, 10), control('x', 11)], slots: 4 })).toEqual({ workers: 2, events: [] });
  });
});

describe('watchdogLimits and recordsRuns', () => {
  it('reads the watchdog limits, in ms too', () => {
    expect(watchdogLimits(config({ watchdog: { quietMinutes: 5 } }))).toEqual({ quietMinutes: 5, buildMinutes: 120, quietMs: 300_000, buildMs: 7_200_000, ceilingMinutes: 480, ceilingMs: 28_800_000 });
  });
  it('puts the hard ceiling at 4 times the build limit', () => {
    expect(watchdogLimits(config({ watchdog: { buildMinutes: 5 } }))).toMatchObject({ buildMinutes: 5, ceilingMinutes: 20, ceilingMs: 1_200_000 });
  });
  it('records runs unless features.costMetrics is off', () => {
    expect(recordsRuns(config())).toBe(true);
    expect(recordsRuns(config({ features: { costMetrics: false } }))).toBe(false);
  });
});

describe('liveSettings with fake files', () => {
  function fake(initial) {
    const files = { '/p/foreman.config.json': { mtimeMs: 100, size: 10 }, '/p/.foreman/settings.json': null };
    const state = { config: initial, loads: 0 };
    const live = liveSettings({
      root: '/p',
      dir: '/p/.foreman',
      slots: 4,
      stat: (file) => files[file] ?? null,
      load: () => {
        state.loads += 1;
        return typeof state.config === 'function' ? state.config() : { config: state.config, errors: [], localWarnings: [] };
      },
    });
    const touchLocal = (mtimeMs, next) => {
      files['/p/.foreman/settings.json'] = { mtimeMs, size: 2 };
      state.config = next;
    };
    const touchConfig = (mtimeMs, next) => {
      files['/p/foreman.config.json'] = { mtimeMs, size: 11 };
      state.config = next;
    };
    return { live, state, touchLocal, touchConfig };
  }

  it('reads the files once at start and again only after one of them changed', () => {
    const f = fake(config({ workers: 2 }));
    expect(f.state.loads).toBe(1);
    expect(f.live.beforePick({ current: 2 })).toMatchObject({ workers: 2, events: [] });
    expect(f.live.beforePick({ current: 2 })).toMatchObject({ workers: 2, events: [] });
    expect(f.state.loads).toBe(1);
    f.touchLocal(200, config({ workers: 2, rounds: 5 }));
    expect(f.live.beforePick({ current: 2 }).config.rounds).toBe(5);
    expect(f.state.loads).toBe(2);
  });

  it('applies a workers change in the settings at the next pick', () => {
    const f = fake(config({ workers: 1 }));
    f.touchLocal(200, config({ workers: 3 }));
    expect(f.live.beforePick({ current: 1 })).toMatchObject({ workers: 3, events: [{ text: 'Worker count set to 3 in the settings; applied at the next pick.' }] });
  });

  it('a reload that leaves workers alone never undoes a newer foreman workers', () => {
    const f = fake(config({ workers: 1 }));
    expect(f.live.beforePick({ current: 1, control: [{ value: 3, at: 150 }] }).workers).toBe(3);
    f.touchLocal(200, config({ workers: 1, rounds: 5 }));
    expect(f.live.beforePick({ current: 3 }).workers).toBe(3);
  });

  it('a settings change after a foreman workers wins, and one before it loses', () => {
    const f = fake(config({ workers: 1 }));
    f.touchLocal(300, config({ workers: 2 }));
    expect(f.live.beforePick({ current: 1, control: [{ value: 4, at: 200 }] }).workers).toBe(2);
    f.touchLocal(400, config({ workers: 3 }));
    expect(f.live.beforePick({ current: 2, control: [{ value: 4, at: 500 }] }).workers).toBe(4);
  });

  it('applies the new watchdog limits and switches from the reloaded config', () => {
    const f = fake(config());
    f.touchConfig(200, config({ watchdog: { quietMinutes: 5 }, features: { costMetrics: false } }));
    const { config: now } = f.live.beforePick({ current: 1 });
    expect(watchdogLimits(now).quietMinutes).toBe(5);
    expect(recordsRuns(now)).toBe(false);
  });

  it('keeps the settings from before when the config turns invalid, and says so once', () => {
    const f = fake(config({ rounds: 4 }));
    f.touchConfig(200, () => ({ config: null, errors: [{ path: 'rounds', message: 'must be an integer from 1 to 10' }] }));
    const r = f.live.beforePick({ current: 1 });
    expect(r.config.rounds).toBe(4);
    expect(r.events).toEqual([{ text: 'foreman.config.json is invalid now (rounds: must be an integer from 1 to 10); keeping the settings from before.', kind: 'warn' }]);
    expect(f.live.beforePick({ current: 1 }).events).toEqual([]);
  });

  describe('while the config is invalid', () => {
    const invalid = (path, message) => () => ({ config: null, errors: [{ path, message }] });
    const valid = (c) => () => ({ config: c, team: c, errors: [], localWarnings: [] });
    const warn = (reason) => ({ text: `foreman.config.json is invalid now (${reason}); keeping the settings from before.`, kind: 'warn' });

    it('starts with the first load\'s team and no problem', () => {
      const team = config({ rounds: 4 });
      const f = fake(valid(team));
      expect(f.live.team).toBe(team);
      expect(f.live.problem).toBeNull();
    });

    it('warns once per reason, and says when the file is valid again', () => {
      const f = fake(config());
      f.touchConfig(200, invalid('bogusKey', 'unknown key'));
      expect(f.live.beforePick({ current: 1 }).events).toEqual([warn('bogusKey: unknown key')]);
      expect(f.live.problem).toBe('bogusKey: unknown key');

      f.touchConfig(300, invalid('bogusKey', 'unknown key'));
      expect(f.live.beforePick({ current: 1 }).events).toEqual([]);
      expect(f.live.problem).toBe('bogusKey: unknown key');

      f.touchConfig(400, invalid('rounds', 'must be an integer from 1 to 10'));
      expect(f.live.beforePick({ current: 1 }).events).toEqual([warn('rounds: must be an integer from 1 to 10')]);
      expect(f.live.problem).toBe('rounds: must be an integer from 1 to 10');

      const fixed = config({ rounds: 6 });
      f.touchConfig(500, valid(fixed));
      const r = f.live.beforePick({ current: 1 });
      expect(r.events).toEqual([{ text: 'foreman.config.json is valid again; using it from the next pick.', kind: 'info' }]);
      expect(r.config.rounds).toBe(6);
      expect(f.live.problem).toBeNull();
      expect(f.live.team).toBe(fixed);
    });
  });

  it('passes on why a local value is ignored', () => {
    const f = fake(config());
    f.touchLocal(200, () => ({ config: config(), errors: [], localWarnings: ['local setting workers ignored: must be a whole number from 1 to 4'] }));
    expect(f.live.beforePick({ current: 1 }).events).toEqual([{ text: 'local setting workers ignored: must be a whole number from 1 to 4', kind: 'warn' }]);
  });

  it('says a slots change waits for a restart, once, and keeps the run\'s slots as the cap', () => {
    const f = fake(config({ slots: 4 }));
    f.touchLocal(200, config({ slots: 2, workers: 2 }));
    const r = f.live.beforePick({ current: 1 });
    expect(r.events).toContainEqual({ text: 'slots is now 2 in the settings; it applies when the run restarts (this run keeps 4).', kind: 'info' });
    expect(r.workers).toBe(2);
    f.touchLocal(300, config({ slots: 2, workers: 2, rounds: 4 }));
    expect(f.live.beforePick({ current: 2 }).events).toEqual([]);
  });
});

// The supervisor's loop, dry: real files, two ticks, a workers change made between them.
describe('liveSettings on a real project (dry run of two ticks)', () => {
  let root;
  const dir = () => join(root, '.foreman');
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'foreman-live-'));
    writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'x' }, slots: 3 }));
    mkdirSync(dir(), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('applies a workers change made between ticks at the next pick', () => {
    const live = liveSettings({ root, dir: dir(), env: {}, slots: 3 });
    let { workers } = live.startWorkers(null);
    expect(workers).toBe(1);

    // tick 1: nothing changed
    let tick = live.beforePick({ current: workers });
    expect(tick).toMatchObject({ workers: 1, events: [] });
    workers = tick.workers;

    // between ticks: `foreman settings set workers 2`
    const file = join(dir(), 'settings.json');
    writeFileSync(file, JSON.stringify({ workers: 2 }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);

    // tick 2: applied
    tick = live.beforePick({ current: workers });
    expect(tick.workers).toBe(2);
    expect(tick.events).toEqual([{ text: 'Worker count set to 2 in the settings; applied at the next pick.', kind: 'info' }]);
    workers = tick.workers;

    // tick 3: a newer `foreman workers 3` wins over it
    tick = live.beforePick({ current: workers, control: [{ value: 3, at: later.getTime() + 1000 }] });
    expect(tick.workers).toBe(3);
  });

  it('starts from the --workers flag even when the settings say otherwise', () => {
    writeFileSync(join(dir(), 'settings.json'), JSON.stringify({ workers: 2 }));
    const live = liveSettings({ root, dir: dir(), env: {}, slots: 3 });
    expect(live.startWorkers(3).workers).toBe(3);
    expect(live.beforePick({ current: 3 }).workers).toBe(3);
  });
});

describe('fileStamps', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'foreman-stamps-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('gives null stamps for missing files, and a different stamp after a write that changes the size', () => {
    const dir = join(root, '.foreman');
    expect(fileStamps({ root, dir })).toEqual({ config: null, local: null });
    writeFileSync(join(root, 'foreman.config.json'), '{"version":1}');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{}');
    const first = fileStamps({ root, dir });
    expect(first.config).not.toBeNull();
    expect(first.local).not.toBeNull();
    writeFileSync(join(root, 'foreman.config.json'), '{"version":1,"slots":2}');
    const next = fileStamps({ root, dir });
    expect(next.config).not.toBe(first.config);
    expect(next.local).toBe(first.local);
    expect(changed(first, next)).toBe(true);
  });

  it('takes an injected stat', () => {
    const stat = (file) => (file.endsWith('foreman.config.json') ? { mtimeMs: 5, size: 10 } : null);
    expect(fileStamps({ root, dir: join(root, '.foreman') }, stat)).toEqual({ config: '5:10', local: null });
  });
});
