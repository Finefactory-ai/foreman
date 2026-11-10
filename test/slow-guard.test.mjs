// The 5 s guard: a test over LIMIT_MS fails the run unless SLOW_TESTS lists it with a reason, or
// the machine is busy, when it is a warning instead (test/slow-tests.mjs, run by
// test/slow-guard.mjs in every test file).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  GUARD_WARNING,
  IDLE_LOAD_PER_CORE,
  LIMIT_MS,
  SLOW_TESTS,
  guardLimitMs,
  loadPerCore,
  slowTestError,
  slowTestFinding,
  stretchByLoad,
} from './slow-tests.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'plugin/lib/acme.test.mjs > acme > signs in';

describe('slowTestError', () => {
  it('is null at or under the limit', () => {
    expect(LIMIT_MS).toBe(5000);
    expect(slowTestError({ fullName: NAME, ms: 4999, list: {} })).toBeNull();
    expect(slowTestError({ fullName: NAME, ms: 5000, list: {} })).toBeNull();
  });

  it('names an unlisted test over the limit, its time and how to fix it', () => {
    expect(slowTestError({ fullName: NAME, ms: 5001, list: {} })).toBe(
      `${NAME} took 5.0 s, over the 5 s limit for one test. Make it faster, or list it in SLOW_TESTS in test/slow-tests.mjs with the reason it waits.`,
    );
  });

  it('is null for a listed test however long it takes', () => {
    expect(slowTestError({ fullName: NAME, ms: 9000, list: { [NAME]: 'waits on a real 5 s tick' } })).toBeNull();
  });

  it('honours a custom limit', () => {
    expect(slowTestError({ fullName: NAME, ms: 300, list: {}, limitMs: 200 })).toMatch(/took 0\.3 s, over the 0\.2 s limit for one test\./);
    expect(slowTestError({ fullName: NAME, ms: 300, list: {}, limitMs: 400 })).toBeNull();
  });
});

describe('stretchByLoad', () => {
  it('keeps a time bound while the machine has a core per runnable process', () => {
    expect(stretchByLoad(1000, { load: 0, cpus: 18 })).toBe(1000);
    expect(stretchByLoad(1000, { load: 18, cpus: 18 })).toBe(1000);
  });

  it('stretches it by the load per core past one, and never shrinks it', () => {
    expect(stretchByLoad(1000, { load: 47, cpus: 18 })).toBe(2611);
    expect(stretchByLoad(1000, { load: Number.NaN, cpus: 18 })).toBe(1000);
    expect(stretchByLoad(1000, { load: 36, cpus: 0 })).toBe(1000);
  });

  it('reads the machine load and core count when none are given', () => {
    vi.spyOn(os, 'loadavg').mockReturnValue([36, 30, 20]);
    vi.spyOn(os, 'cpus').mockReturnValue(Array.from({ length: 18 }, () => ({})));
    try {
      expect(stretchByLoad(1000)).toBe(2000);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('guardLimitMs', () => {
  it('is the 5 s limit on a machine with a core free per runnable process', () => {
    expect(guardLimitMs({ load: 0, cpus: 18 })).toBe(5000);
    expect(guardLimitMs({ load: 18, cpus: 18 })).toBe(5000);
  });

  it('stretches with the load past one per core, so a busy shared machine is not read as a slow test', () => {
    expect(guardLimitMs({ load: 36, cpus: 18 })).toBe(10000);
    expect(guardLimitMs({ load: 45, cpus: 18 })).toBe(12500);
  });

  it('takes a set limit exactly, whatever the load', () => {
    expect(guardLimitMs({ explicit: '200', load: 45, cpus: 18 })).toBe(200);
    expect(guardLimitMs({ explicit: '9000', load: 0, cpus: 18 })).toBe(9000);
  });

  it('ignores a set limit that is not a positive number, and a load it cannot read', () => {
    for (const explicit of ['', 'abc', '0', '-5', undefined]) expect(guardLimitMs({ explicit, load: 36, cpus: 18 }), String(explicit)).toBe(10000);
    expect(guardLimitMs({ load: Number.NaN, cpus: 18 })).toBe(5000);
    expect(guardLimitMs({ load: 36, cpus: 0 })).toBe(5000);
  });

});

describe('loadPerCore', () => {
  it('is the load over the cores, and NaN when either cannot be read', () => {
    expect(loadPerCore({ load: 36, cpus: 18 })).toBe(2);
    expect(loadPerCore({ load: 0, cpus: 18 })).toBe(0);
    expect(loadPerCore({ load: Number.NaN, cpus: 18 })).toBeNaN();
    expect(loadPerCore({ load: 36, cpus: 0 })).toBeNaN();
    expect(loadPerCore({ load: 36, cpus: -2 })).toBeNaN();
    expect(loadPerCore({ load: 36 })).toBeNaN();
    expect(loadPerCore({ cpus: 18 })).toBeNaN();
    expect(loadPerCore({})).toBeNaN();
  });
});

describe('slowTestFinding', () => {
  const find = (opts) => slowTestFinding({ fullName: NAME, list: {}, ...opts });
  const strict = (ms, limitMs) => slowTestError({ fullName: NAME, ms, list: {}, limitMs });

  it('passes a 9 s test at load 2.0 per core, where the limit is 10 s', () => {
    expect(find({ ms: 9000, load: 36, cpus: 18 })).toBeNull();
  });

  it('fails a 9 s test at load 0.2 per core, with the strict message', () => {
    expect(find({ ms: 9000, load: 3.6, cpus: 18 })).toEqual({ level: 'fail', message: strict(9000, 5000) });
  });

  it('fails a new unlisted 6 s test on an idle machine', () => {
    expect(IDLE_LOAD_PER_CORE).toBe(0.5);
    expect(find({ ms: 6000, load: 0, cpus: 18 })).toEqual({ level: 'fail', message: strict(6000, 5000) });
    expect(find({ ms: 6000, load: 8.8, cpus: 18 })?.level).toBe('fail');
  });

  it('warns, and does not fail, a test over the limit while the machine is busy', () => {
    for (const [ms, load, perCore] of [
      [6000, 9, '0.5'],
      [12000, 36, '2.0'],
    ]) {
      const finding = find({ ms, load, cpus: 18 });
      expect(finding?.level, String(load)).toBe('warn');
      expect(finding.message.startsWith(`${GUARD_WARNING} `)).toBe(true);
      expect(finding.message).toContain(NAME);
      expect(finding.message).toContain(`at load ${perCore} per core`);
      expect(finding.message).toContain('the machine is busy');
    }
    expect(find({ ms: 12000, load: 36, cpus: 18 }).message).toBe(
      `${GUARD_WARNING} ${NAME} took 12.0 s, over the 10 s limit for one test, at load 2.0 per core. Not failed: the machine is busy (a test fails only under 0.5 per core).`,
    );
  });

  it('treats a load it cannot read as idle, so the guard stays strict', () => {
    expect(find({ ms: 6000, load: Number.NaN, cpus: 18 })?.level).toBe('fail');
    expect(find({ ms: 6000, load: 36, cpus: 0 })?.level).toBe('fail');
  });

  it('is null for a listed test, or one at or under the limit, in every mode', () => {
    for (const mode of [undefined, '', 'fail', 'report']) {
      expect(slowTestFinding({ fullName: NAME, ms: 60000, list: { [NAME]: 'waits on a real tick' }, mode, load: 0, cpus: 18 }), String(mode)).toBeNull();
      expect(find({ ms: 5000, mode, load: 0, cpus: 18 }), String(mode)).toBeNull();
      expect(find({ ms: 9000, mode, load: 36, cpus: 18 }), String(mode)).toBeNull();
    }
  });

  it('never fails in report mode, and says the test fails npm test on an idle machine', () => {
    const idle = find({ ms: 6000, mode: 'report', load: 0, cpus: 18 });
    expect(idle).toEqual({
      level: 'warn',
      message: `${GUARD_WARNING} ${strict(6000, 5000)} Not failed here (SLOW_TEST_GUARD=report); it fails npm test on an idle machine.`,
    });
    expect(find({ ms: 12000, mode: 'report', load: 36, cpus: 18 })).toEqual(find({ ms: 12000, load: 36, cpus: 18 }));
    for (const mode of ['', 'fail', undefined, 'REPORT']) expect(find({ ms: 6000, mode, load: 0, cpus: 18 })?.level, String(mode)).toBe('fail');
  });

  it('takes a set limit exactly, with no load excuse, except in report mode', () => {
    const set = find({ explicit: '200', ms: 300, load: 36, cpus: 18 });
    expect(set?.level).toBe('fail');
    expect(set.message).toContain('over the 0.2 s limit');
    expect(find({ explicit: '200', ms: 300, mode: 'report', load: 36, cpus: 18 })?.level).toBe('warn');
  });

  it('uses the shared SLOW_TESTS list when none is given', () => {
    const [listed] = Object.keys(SLOW_TESTS);
    expect(slowTestFinding({ fullName: listed, ms: 60000, load: 0, cpus: 18 })).toBeNull();
  });

  it('is what the guard uses, with the machine load and core count, and throws only on a failure', () => {
    const src = fs.readFileSync(path.join(ROOT, 'test', 'slow-guard.mjs'), 'utf8');
    expect(src).toContain('slowTestFinding({');
    for (const arg of [
      'fullName: ctx.task.fullName',
      'explicit: process.env.SLOW_TEST_LIMIT_MS',
      'mode: process.env.SLOW_TEST_GUARD',
      'load: os.loadavg()[0]',
      'cpus: os.cpus().length',
    ])
      expect(src, arg).toContain(arg);
    expect(src).toContain("if (finding?.level === 'fail') throw new Error(finding.message);");
    expect(src).toContain('else if (finding) process.stderr.write(`${finding.message}\\n`);');
    expect(src.match(/throw /g)).toHaveLength(1);
  });
});

describe('SLOW_TESTS', () => {
  const entries = Object.entries(SLOW_TESTS);

  it('gives every entry a reason and a test file that exists', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, reason] of entries) {
      expect(typeof reason, name).toBe('string');
      expect(reason.trim(), name).not.toBe('');
      const file = name.split(' > ')[0];
      expect(name.includes(' > '), name).toBe(true);
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });

  // A test that was renamed, moved to another file or removed leaves a stale entry behind. The
  // title is looked for in the source with its quotes unescaped, or as an it.each title whose
  // %s, %i or %d stand for the values.
  const titleIn = (title, src) => {
    const text = src.replace(/\\(['"`])/g, '$1');
    if (text.includes(title)) return true;
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const [, , each] of text.matchAll(/\]\)\(\s*(['"`])((?:(?!\1).)*%[sid](?:(?!\1).)*)\1/g)) {
      if (new RegExp(`^${each.split(/%[sid]/).map(escape).join('.+')}$`).test(title)) return true;
    }
    return false;
  };

  it('names a test title that is in its file', () => {
    const stale = entries
      .map(([name]) => name)
      .filter((name) => {
        const parts = name.split(' > ');
        const file = path.join(ROOT, parts[0]);
        return !fs.existsSync(file) || !titleIn(parts.at(-1), fs.readFileSync(file, 'utf8'));
      });
    expect(stale).toEqual([]);
  });

  it('finds a title written with escaped quotes, or by it.each, and misses one that is not there', () => {
    expect(titleIn("shows the agent's stage", "it('shows the agent\\'s stage', () => {});")).toBe(true);
    expect(titleIn('with a story count', "it.each([\n  ['a story count', 1],\n])('with %s', () => {});")).toBe(true);
    expect(titleIn('restarts once the story finished', "it('restarts at once', () => {});")).toBe(false);
    expect(titleIn('without a story count', "it.each([['x', 1]])('with %s', () => {});")).toBe(false);
  });

  // The one supervisor test kept at the real 5 s tick: its waits are its point.
  it('supervisor-stuck runs at the real tick', () => {
    const file = 'plugin/lib/engine/supervisor-stuck.test.mjs';
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expect(src).not.toMatch(/fast-tick|FOREMAN_TICK_MS|TEST_TICK_MS/);
    expect(entries.some(([name]) => name.startsWith(`${file} > `))).toBe(true);
  });

  // The published copy has no workshop/, so the private words are checked only here.
  const manifest = path.join(ROOT, 'workshop', 'publish', 'manifest.mjs');
  it.skipIf(!fs.existsSync(manifest))('names no workshop file and no private word', async () => {
    const { PRIVATE_WORDS } = await import(pathToFileURL(manifest).href);
    for (const [name, reason] of entries) {
      expect(name.startsWith('workshop/'), name).toBe(false);
      for (const word of PRIVATE_WORDS) {
        expect(word.test(name), `${name} ${word}`).toBe(false);
        expect(word.test(reason), `${reason} ${word}`).toBe(false);
      }
    }
  });
});

describe('the guard in a real run', () => {
  const bin = path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  // SLOW_TEST_GUARD and the coding-agent markers vitest reads (AI_AGENT, CLAUDECODE) are taken
  // out of the shell's environment unless a case sets them.
  const run = (limit, extraEnv = {}) => {
    const { SLOW_TEST_GUARD, AI_AGENT, CLAUDECODE, ...env } = process.env;
    return spawnSync(process.execPath, [bin, 'run', '--config', 'test/fixtures/slow-guard/vitest.config.mjs'], {
      cwd: ROOT,
      env: { ...env, SLOW_TEST_LIMIT_MS: String(limit), CI: '1', ...extraEnv },
      encoding: 'utf8',
      timeout: 25_000,
    });
  };

  it('fails the run when an unlisted test is over the limit', () => {
    const r = run(200);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('over the 0.2 s limit for one test');
  });

  // Under a coding agent vitest uses its minimal reporter, which hides a passing test's console
  // output; a story's checks run there, so the warning must show in both.
  it.each([
    ['in a plain shell', {}],
    ['under a coding agent', { AI_AGENT: 'claude' }],
  ])('with SLOW_TEST_GUARD=report, passes the run and prints the finding as a warning, %s', (_, agentEnv) => {
    const r = run(200, { SLOW_TEST_GUARD: 'report', ...agentEnv });
    const out = r.stdout + r.stderr;
    expect(out).toContain(GUARD_WARNING);
    expect(out).toContain('over the 0.2 s limit');
    expect(r.status).toBe(0);
  });

  it('passes the same run under a higher limit', () => {
    const r = run(2000);
    expect(r.stdout + r.stderr).not.toContain('limit for one test');
    expect(r.status).toBe(0);
  });
});
