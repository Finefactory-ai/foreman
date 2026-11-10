import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CPU_BUSY_SHARE, CPU_SAMPLE_MS, cpuSampleMs, cpuWatch, groupCpuMs, MIN_CPU_SAMPLE_MS, parseCpuTime } from './session-cpu.mjs';

describe('parseCpuTime', () => {
  it('reads macOS minutes:seconds and Linux [D-]HH:MM:SS', () => {
    expect(parseCpuTime('0:01.20')).toBe(1200);
    expect(parseCpuTime('88:56.49')).toBe(5336490);
    expect(parseCpuTime('00:01:23')).toBe(83000);
    expect(parseCpuTime('1-02:03:04')).toBe(93784000);
    expect(parseCpuTime(' 0:00.00 ')).toBe(0);
  });

  it('refuses anything else', () => {
    expect(parseCpuTime('x')).toBeNull();
    expect(parseCpuTime('')).toBeNull();
    expect(parseCpuTime(null)).toBeNull();
    expect(parseCpuTime('1:2:3:4')).toBeNull();
    expect(parseCpuTime('a:01')).toBeNull();
  });
});

describe('groupCpuMs', () => {
  // pid ppid pgid time: the leader 500, a child in its group, a grandchild that called setsid
  // (its own group, still a descendant) and an unrelated process.
  const PS = [
    '  500     1   500   0:01.00',
    '  501   500   500   0:02.00',
    '  502   501   502   00:00:03',
    '  900     1   900   9:00.00',
    '',
  ].join('\n');

  it('sums the group and every descendant, nothing else', () => {
    expect(groupCpuMs(500, { ps: () => PS })).toBe(6000);
  });

  it('is null when ps fails or nothing matches', () => {
    expect(groupCpuMs(500, { ps: () => null })).toBeNull();
    expect(groupCpuMs(777, { ps: () => PS })).toBeNull();
    expect(groupCpuMs(500, { ps: () => { throw new Error('no ps'); } })).toBeNull();
  });

  it('reads this machine’s ps', () => {
    const ms = groupCpuMs(process.pid);
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});

describe('cpuWatch', () => {
  const T0 = 1_000_000;

  it('samples once a minute and says when the session last used CPU', () => {
    expect(CPU_SAMPLE_MS).toBe(60_000);
    expect(CPU_BUSY_SHARE).toBe(0.1);
    const values = [10_000, 40_000, 41_000, null];
    const calls = [];
    const watch = cpuWatch({ probe: (pid) => (calls.push(pid), values.shift()) });

    expect(watch.activeAt('w1', 42, T0)).toBeNull(); // the baseline
    expect(watch.activeAt('w1', 42, T0 + 30_000)).toBeNull(); // too soon to sample again
    expect(calls).toEqual([42]);
    expect(watch.activeAt('w1', 42, T0 + 60_000)).toBe(T0 + 60_000); // 30 s of CPU in 60 s
    expect(watch.activeAt('w1', 42, T0 + 120_000)).toBe(T0 + 60_000); // 1 s in 60 s: idle
    expect(watch.activeAt('w1', 42, T0 + 180_000)).toBe(T0 + 60_000); // the probe failed
    expect(calls).toEqual([42, 42, 42, 42]);
  });

  it('cpuWatch samples every sampleMs when given', () => {
    const values = [0, 1000, 1050];
    const calls = [];
    const watch = cpuWatch({ probe: (pid) => (calls.push(pid), values.shift()), sampleMs: 2000 });

    expect(watch.activeAt('w1', 42, T0)).toBeNull(); // the baseline
    expect(watch.activeAt('w1', 42, T0 + 1000)).toBeNull(); // too soon to sample again
    expect(calls).toEqual([42]);
    expect(watch.activeAt('w1', 42, T0 + 2000)).toBe(T0 + 2000); // 1 s of CPU in 2 s
    expect(watch.activeAt('w1', 42, T0 + 4000)).toBe(T0 + 2000); // 50 ms in 2 s: idle
    expect(calls).toEqual([42, 42, 42]);
  });

  it('a new pid for the slot starts again from a baseline', () => {
    const values = [0, 60_000, 0];
    const watch = cpuWatch({ probe: () => values.shift() });
    watch.activeAt('w1', 42, T0);
    expect(watch.activeAt('w1', 42, T0 + 60_000)).toBe(T0 + 60_000);
    expect(watch.activeAt('w1', 43, T0 + 61_000)).toBeNull();
  });

  it('slots are separate', () => {
    const values = { 1: [0, 60_000], 2: [0, 0] };
    const watch = cpuWatch({ probe: (pid) => values[pid].shift() });
    watch.activeAt('w1', 1, T0);
    watch.activeAt('w2', 2, T0);
    expect(watch.activeAt('w1', 1, T0 + 60_000)).toBe(T0 + 60_000);
    expect(watch.activeAt('w2', 2, T0 + 60_000)).toBeNull();
  });
});

describe('cpuSampleMs', () => {
  it('is the once-a-minute default for no value, an empty value, a non-integer, zero and a negative', () => {
    for (const v of [undefined, '', 'abc', '0', '-5', '1.5']) expect(cpuSampleMs(v)).toBe(CPU_SAMPLE_MS);
  });

  it('takes a shorter interval, never a longer one, and never under 500 ms', () => {
    expect(MIN_CPU_SAMPLE_MS).toBe(500);
    expect(cpuSampleMs('2000')).toBe(2000);
    expect(cpuSampleMs('500')).toBe(500);
    expect(cpuSampleMs('10')).toBe(500);
    expect(cpuSampleMs('999999')).toBe(60_000);
  });

  it('the supervisor reads its sample interval from FOREMAN_CPU_SAMPLE_MS through cpuSampleMs', () => {
    const src = readFileSync(new URL('./supervisor.mjs', import.meta.url), 'utf8');
    expect(src).toContain('const cpu = cpuWatch({ sampleMs: cpuSampleMs(process.env.FOREMAN_CPU_SAMPLE_MS) });');
  });
});
