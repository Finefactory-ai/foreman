// `npm test` runs the waits and unit projects at the same time, each with its own worker cap,
// and any extra args as one plain `vitest run` (test/run-suite.mjs).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { suiteEnv } from './real-git.mjs';
import { runSuite, vitestBin } from './run-suite.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/run-suite/fake-vitest.mjs', import.meta.url));
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function suite(env = {}, args = [], extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-run-suite-'));
  dirs.push(dir);
  let out = '';
  const result = runSuite({
    bin: FAKE,
    args,
    env: { ...process.env, FAKE_DIR: dir, ...env },
    write: (s) => {
      out += s;
    },
    ...extra,
  });
  return { dir, result, output: () => out };
}

describe('runSuite', () => {
  it('finds the installed vitest bin', () => {
    expect(fs.existsSync(vitestBin())).toBe(true);
    expect(path.basename(vitestBin())).toBe('vitest.mjs');
  });

  it('runs both projects at once and prints each one whole, exit 0 when both pass', async () => {
    const s = suite();
    expect(await s.result).toBe(0);
    const out = s.output();
    expect(out).toContain('args: run --project waits\n');
    expect(out).toContain('args: run --project unit\n');
    expect(out).toContain('stderr of waits');
    expect(out).toContain('stderr of unit');
    expect(out).not.toContain('never started');
    expect(out).toMatch(/^.*waits.*exit 0.*$/m);
    expect(out).toMatch(/^.*unit.*exit 0.*$/m);
    // Each project's output stays together under its header.
    for (const name of ['waits', 'unit']) {
      const header = out.split('\n').findIndex((l) => l.includes(`project ${name}`) && l.includes('exit'));
      const rest = out.split('\n').slice(header + 1, header + 3).join('\n');
      expect(rest).toContain(`args: run --project ${name}`);
      expect(rest).toContain(`stderr of ${name}`);
    }
  });

  it('exits 1 when either project fails', async () => {
    expect(await suite({ FAKE_FAIL: 'waits' }).result).toBe(1);
    expect(await suite({ FAKE_FAIL: 'unit' }).result).toBe(1);
  });

  it('exits 1 when a project is killed', async () => {
    const s = suite({ FAKE_KILL: 'unit' });
    expect(await s.result).toBe(1);
    expect(s.output()).toMatch(/unit.*SIGKILL/);
  });

  it('passes SIGTERM on to both projects', async () => {
    const signals = new EventEmitter();
    const s = suite({ FAKE_HANG: 'both' }, [], { signals });
    const until = Date.now() + 10_000;
    while (!['waits', 'unit'].every((n) => fs.existsSync(path.join(s.dir, `${n}.started`)))) {
      if (Date.now() > until) throw new Error('the projects never started');
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 100));
    signals.emit('SIGTERM');
    expect(await s.result).toBe(1);
    expect(fs.existsSync(path.join(s.dir, 'waits.signalled'))).toBe(true);
    expect(fs.existsSync(path.join(s.dir, 'unit.signalled'))).toBe(true);
  });

  it('with args, runs one plain vitest run and gives its exit code', async () => {
    const pass = suite({}, ['test/acme.test.mjs', '--retry=0']);
    expect(await pass.result).toBe(0);
    expect(fs.readdirSync(pass.dir)).toEqual(['single.args']);
    expect(fs.readFileSync(path.join(pass.dir, 'single.args'), 'utf8')).toBe('run test/acme.test.mjs --retry=0');
    expect(await suite({ FAKE_CODE: '3' }, ['test/acme.test.mjs']).result).toBe(3);
  });

  describe('with no env given', () => {
    // A spawn that records each child's env and ends it with exit 0.
    function recorder() {
      const envs = [];
      const spawn = (cmd, argv, opts) => {
        envs.push(opts.env);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        setImmediate(() => child.emit('close', 0, null));
        return child;
      };
      return { envs, spawn };
    }
    // Runs `fn` with PATH set to one whose git is /usr/bin's, so on a Mac suiteEnv moves it.
    async function withPath(fn) {
      const saved = process.env.PATH;
      process.env.PATH = '/usr/bin:/bin';
      try {
        return await fn();
      } finally {
        process.env.PATH = saved;
      }
    }
    const expectSuiteEnv = (env) => {
      const want = suiteEnv();
      expect(env).not.toBe(process.env);
      expect(env.PATH).toBe(want.PATH);
      expect(env).toEqual(want);
    };

    it('gives both projects the suite env, with the real git on PATH', async () => {
      await withPath(async () => {
        const { envs, spawn } = recorder();
        expect(await runSuite({ spawn, signals: new EventEmitter(), write: () => {} })).toBe(0);
        expect(envs).toHaveLength(2);
        for (const env of envs) expectSuiteEnv(env);
      });
    });

    it('gives the single run with args the suite env too', async () => {
      await withPath(async () => {
        const { envs, spawn } = recorder();
        expect(await runSuite({ args: ['test/acme.test.mjs'], spawn, signals: new EventEmitter() })).toBe(0);
        expect(envs).toHaveLength(1);
        expectSuiteEnv(envs[0]);
      });
    });
  });
});
