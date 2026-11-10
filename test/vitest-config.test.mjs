import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { matchesGlob } from '../plugin/lib/engine/glob.mjs';
import config, { ALL, testCores, WAITS, WORKERS, workersFor } from '../vitest.config.mjs';
import { testCoreShare } from '../plugin/lib/engine/session.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const project = (name) => config.test.projects.find((p) => p.test?.name === name);

// Every test file under plugin/, test/ and workshop/, relative to the root, with / separators.
function testFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(rel);
      } else if (e.name.endsWith('.test.mjs')) out.push(rel);
    }
  };
  // The published copy has no workshop/.
  for (const dir of ['plugin', 'test', 'workshop']) if (fs.existsSync(path.join(ROOT, dir))) walk(dir);
  return out;
}

const inProject = (file, p) => p.test.include.some((g) => matchesGlob(file, g)) && !(p.test.exclude ?? []).some((g) => matchesGlob(file, g));

// The worker counts follow the machine's cores, so an idle machine runs the suite on all of them.
// The two projects run at the same time, so they share the cores: one worker per core in all.
describe('workersFor', () => {
  it('shares the cores between the two projects, one worker per core in all', () => {
    expect(workersFor(18)).toEqual({ unit: 6, waits: 12 });
    expect(workersFor(6)).toEqual({ unit: 2, waits: 4 });
    expect(workersFor(2)).toEqual({ unit: 1, waits: 1 });
    for (let n = 2; n <= 32; n++) {
      const w = workersFor(n);
      expect(w.unit + w.waits, String(n)).toBe(n);
    }
  });

  // They hold most of the file-seconds, and mostly wait rather than compute.
  it('gives the waiting files two cores in three', () => {
    expect(workersFor(5)).toEqual({ unit: 1, waits: 4 });
    expect(workersFor(4)).toEqual({ unit: 1, waits: 3 });
    expect(workersFor(3)).toEqual({ unit: 1, waits: 2 });
  });

  it('never gives a project fewer than one worker', () => {
    expect(workersFor(1)).toEqual({ unit: 1, waits: 1 });
  });

  it('gives one worker each, never 0 or NaN, when the core count is not a positive whole number', () => {
    for (const cores of [0, -2, NaN, undefined, 2.5]) expect(workersFor(cores), String(cores)).toEqual({ unit: 1, waits: 1 });
  });
});

// A story session gets FOREMAN_TEST_CORES, its share of the machine's cores, from the supervisor;
// the owner's own `npm test` has none and runs on every core.
describe('testCores', () => {
  it('uses FOREMAN_TEST_CORES when it is a positive whole number', () => {
    expect(testCores({ FOREMAN_TEST_CORES: '3' }, 18)).toBe(3);
    expect(testCores({ FOREMAN_TEST_CORES: '4' }, 18)).toBe(4);
  });

  it('falls back to all the cores when the variable is unset or not a positive whole number', () => {
    expect(testCores({}, 18)).toBe(18);
    for (const value of ['', '0', '-1', '2.5', 'abc']) expect(testCores({ FOREMAN_TEST_CORES: value }, 18), JSON.stringify(value)).toBe(18);
  });

  it('defaults to the machine and its cores', () => {
    expect(testCores({})).toBe(os.availableParallelism());
  });

  it("gives the owner's plain npm test on 18 cores 12 waits workers and 6 unit", () => {
    expect(workersFor(testCores({}, 18))).toEqual({ unit: 6, waits: 12 });
  });

  it('keeps five slots on 18 cores near 18 workers in all, and one slot at 18', () => {
    const total = (slots) => {
      const share = testCoreShare(18, slots);
      const w = workersFor(testCores({ FOREMAN_TEST_CORES: String(share) }, 18));
      return slots * (w.unit + w.waits);
    };
    expect(testCoreShare(18, 5)).toBe(3);
    expect(total(5)).toBeGreaterThanOrEqual(13);
    expect(total(5)).toBeLessThanOrEqual(18);
    expect(total(1)).toBe(18);
  });

  // test/clean-env.mjs takes FOREMAN_* out of this worker, so WORKERS above saw all the cores;
  // a fresh copy of the config, loaded with the variable set, shows the session's share sizes it.
  it('sizes the workers from FOREMAN_TEST_CORES when the config is loaded with it', async () => {
    vi.stubEnv('FOREMAN_TEST_CORES', '3');
    try {
      vi.resetModules();
      const fresh = await import('../vitest.config.mjs');
      expect(fresh.WORKERS).toEqual({ unit: 1, waits: 2 });
      expect(fresh.default.test.projects.find((p) => p.test?.name === 'unit').test.maxWorkers).toBe(1);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// Several Foreman runs share one machine, so the git, hook and child-process tests need more than vitest's 5 s.
describe('vitest config', () => {
  it('gives every test and hook at least 30 s, one retry, and the unit files their share of the cores', () => {
    expect(config.test.testTimeout).toBeGreaterThanOrEqual(30_000);
    expect(config.test.hookTimeout).toBeGreaterThanOrEqual(30_000);
    expect(config.test.retry).toBeGreaterThanOrEqual(1);
    expect(WORKERS).toEqual(workersFor(testCores(process.env)));
    expect(project('unit').test.maxWorkers).toBe(WORKERS.unit);
  });

  it('both projects inherit the limits, the retry, and the env and slow-test setup', () => {
    expect(config.test.setupFiles).toEqual(expect.arrayContaining(['./test/clean-env.mjs', './test/slow-guard.mjs']));
    for (const name of ['waits', 'unit']) {
      const p = project(name);
      expect(p, name).toBeTruthy();
      expect(p.extends, name).toBe(true);
      for (const key of ['testTimeout', 'hookTimeout', 'retry', 'setupFiles']) expect(p.test[key], `${name} ${key}`).toBeUndefined();
    }
  });

  it('gives the waiting files their share of the cores, in another group from the unit files', () => {
    const unit = project('unit');
    const waits = project('waits');
    expect(waits.test.maxWorkers).toBe(WORKERS.waits);
    expect(unit.test.sequence.groupOrder).not.toBe(waits.test.sequence.groupOrder);
    expect(waits.test.include).toEqual(WAITS);
    expect(unit.test.include).toEqual(ALL);
  });

  it('puts every test file in exactly one project', () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(100);
    const projects = [project('waits'), project('unit')];
    for (const file of files) expect(projects.filter((p) => inProject(file, p)).map((p) => p.test.name), file).toHaveLength(1);
    expect(files.filter((f) => inProject(f, project('waits')))).toEqual(
      expect.arrayContaining([
        'plugin/lib/engine/supervisor-standby.test.mjs',
        'plugin/lib/engine/supervisor-watchdog-ended.test.mjs',
        'plugin/lib/engine/supervisor-watchdog-release.test.mjs',
        'plugin/lib/engine/supervisor-watchdog-overrun.test.mjs',
        'plugin/lib/engine/supervisor-signin-resume.test.mjs',
        'plugin/lib/engine/supervisor-build-limit-stall.test.mjs',
        'test/cloud-tick.test.mjs',
        'plugin/lib/cli/commands/run.test.mjs',
        'plugin/lib/state-store/branch.test.mjs',
        'plugin/lib/hooks/agent-events.test.mjs',
      ]),
    );
    expect(inProject('plugin/lib/engine/wake.test.mjs', project('unit'))).toBe(true);
  });

  it('a test with no limit of its own gets the 30 s limit', ({ task }) => {
    expect(task.timeout).toBeGreaterThanOrEqual(30_000);
  });
});
