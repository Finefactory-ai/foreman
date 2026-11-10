import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WAIT_SCALE_VAR, slow, waitScale } from './wait-scale.mjs';

const CLEAN_ENV = fileURLToPath(new URL('./clean-env.mjs', import.meta.url));

describe('waitScale', () => {
  it('is 1 when the variable is unset or cannot stretch a wait', () => {
    expect(waitScale({})).toBe(1);
    for (const value of ['', 'abc', '0', '-2', '0.5', 'Infinity', 'NaN']) expect(waitScale({ TEST_WAIT_SCALE: value }), value).toBe(1);
  });

  it('is the number the variable holds when it is 1 or more', () => {
    expect(waitScale({ TEST_WAIT_SCALE: '3' })).toBe(3);
    expect(waitScale({ TEST_WAIT_SCALE: '2.5' })).toBe(2.5);
    expect(waitScale({ TEST_WAIT_SCALE: '1' })).toBe(1);
  });
});

describe('slow', () => {
  it('leaves a wait as it is with no scale, and multiplies it with one', () => {
    expect(slow(40_000, {})).toBe(40_000);
    expect(slow(40_000, { TEST_WAIT_SCALE: '3' })).toBe(120_000);
    expect(slow(40_000, { TEST_WAIT_SCALE: '0.5' })).toBe(40_000);
    expect(slow(15_000, { TEST_WAIT_SCALE: '2.5' })).toBe(37_500);
  });

  it('reads the process environment by default', () => {
    const before = process.env.TEST_WAIT_SCALE;
    try {
      process.env.TEST_WAIT_SCALE = '2';
      expect(slow(1000)).toBe(2000);
    } finally {
      if (before === undefined) delete process.env.TEST_WAIT_SCALE;
      else process.env.TEST_WAIT_SCALE = before;
    }
  });
});

describe('the variable and clean-env.mjs', () => {
  it('is not a FOREMAN_ or FACTORY_ name', () => {
    expect(WAIT_SCALE_VAR).toBe('TEST_WAIT_SCALE');
    expect(WAIT_SCALE_VAR).not.toMatch(/^(FOREMAN|FACTORY)_/);
  });

  it('survives clean-env.mjs, which drops FOREMAN_ and FACTORY_ variables in the test workers', () => {
    const script = 'console.log(JSON.stringify([process.env.TEST_WAIT_SCALE ?? null, process.env.FOREMAN_TEST_SLOW ?? null]))';
    const r = spawnSync(process.execPath, ['--import', CLEAN_ENV, '-e', script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TEST_WAIT_SCALE: '2', FOREMAN_TEST_SLOW: '2' },
    });
    expect(r.stderr).toBe('');
    // The control: a FOREMAN_ name set the same way does not get through.
    expect(JSON.parse(r.stdout)).toEqual(['2', null]);
  });
});
