import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { learningTicks } from './learning-ticks.mjs';
import * as session from './session.mjs';
import { KEEP, pruneTickLogs, reportSupported, tickEnv, tickLogTail, untickEnv } from './tick-log.mjs';

const made = [];
const folder = (name = '') => {
  const dir = mkdtempSync(join(tmpdir(), `foreman-tick-log-${name}`));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const logIn = (dir, text, name = 'learning-tick-20261031-145612.log') => {
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const file = join(dir, 'logs', name);
  writeFileSync(file, text);
  return file;
};

describe('reportSupported', () => {
  it.each(['v22.13.0', 'v23.3.0', 'v24.0.0', 'v26.13.0', '22.13.1'])('is true for %s', (v) => {
    expect(reportSupported(v)).toBe(true);
  });
  it.each(['v22.12.0', 'v23.2.9', 'v20.0.0', null, 'soon', undefined, ''])('is false for %s', (v) => {
    expect(reportSupported(v)).toBe(false);
  });
});

describe('tickEnv', () => {
  const FLAGS = '--report-on-fatalerror --report-exclude-env --report-exclude-network';

  it('appends the report flags after an existing NODE_OPTIONS', () => {
    const env = { PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=64' };
    expect(tickEnv(env, '/acme/state')).toEqual({ PATH: '/bin', NODE_OPTIONS: `--max-old-space-size=64 ${FLAGS} --report-directory="/acme/state/logs"` });
  });
  it('sets the flags alone when there is no NODE_OPTIONS', () => {
    expect(tickEnv({ PATH: '/bin' }, '/acme/state').NODE_OPTIONS).toBe(`${FLAGS} --report-directory="/acme/state/logs"`);
    expect(tickEnv({ NODE_OPTIONS: '' }, '/acme/state').NODE_OPTIONS).toBe(`${FLAGS} --report-directory="/acme/state/logs"`);
  });
  it('adds nothing when the Node does not support the flags, or the folder has a quote in it', () => {
    const env = { PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=64' };
    expect(tickEnv(env, '/acme/state', { report: false })).toEqual(env);
    expect(tickEnv({ PATH: '/bin' }, '/acme/state', { report: false })).toEqual({ PATH: '/bin' });
    expect(tickEnv({ PATH: '/bin' }, '/acme/"state')).toEqual({ PATH: '/bin' });
    expect(tickEnv({ PATH: '/bin' }, '/acme/"state')).not.toHaveProperty('NODE_OPTIONS');
  });
  it('never changes its input', () => {
    const env = { PATH: '/bin' };
    const out = tickEnv(env, '/acme/state');
    expect(env).toEqual({ PATH: '/bin' });
    expect(out).not.toBe(env);
    expect(tickEnv(env, '/acme/state', { report: false })).not.toBe(env);
  });
  it.skipIf(!reportSupported(process.version))('starts a real Node with the report on, the folder as given and the env and network left out', () => {
    const dir = join(folder(), 'an acme folder');
    const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.report.reportOnFatalError, process.report.directory, process.report.excludeEnv, process.report.excludeNetwork]))'], { env: tickEnv(process.env, dir), encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual([true, join(dir, 'logs'), true, true]);
  });
});

describe('untickEnv', () => {
  const FLAGS = '--report-on-fatalerror --report-exclude-env --report-exclude-network';

  it.each(['/acme/state', '/acme/an acme folder'])('undoes tickEnv and keeps an owner NODE_OPTIONS (%s)', (dir) => {
    const env = { PATH: '/bin', NODE_OPTIONS: '--max-old-space-size=64' };
    expect(untickEnv(tickEnv(env, dir))).toStrictEqual(env);
  });
  it('leaves NODE_OPTIONS present and undefined when the flags were all there was', () => {
    const out = untickEnv(tickEnv({ PATH: '/bin' }, '/acme/state'));
    expect(Object.hasOwn(out, 'NODE_OPTIONS')).toBe(true);
    expect(out.NODE_OPTIONS).toBeUndefined();
    expect(out.PATH).toBe('/bin');
  });
  it.each([
    ['an owner option', '--max-old-space-size=64'],
    ['a lone --report-on-fatalerror', '--report-on-fatalerror'],
    ['the old form without --report-exclude-network', '--report-on-fatalerror --report-exclude-env --report-directory="/acme/state/logs"'],
    ['the flags followed by another option', `${FLAGS} --report-directory="/x" --max-old-space-size=64`],
    ['a non-string value', 42],
  ])('comes back unchanged for %s', (_, value) => {
    const env = { PATH: '/bin', NODE_OPTIONS: value };
    const out = untickEnv(env);
    expect(out).toStrictEqual(env);
    expect(out).not.toBe(env);
  });
  it('adds no NODE_OPTIONS key when there was none', () => {
    const out = untickEnv({ PATH: '/bin' });
    expect(out).toStrictEqual({ PATH: '/bin' });
    expect(Object.hasOwn(out, 'NODE_OPTIONS')).toBe(false);
  });
  it('gives {} for null and undefined', () => {
    expect(untickEnv(null)).toStrictEqual({});
    expect(untickEnv(undefined)).toStrictEqual({});
  });
  it('never changes its input', () => {
    const env = tickEnv({ PATH: '/bin' }, '/acme/state');
    const before = { ...env };
    const out = untickEnv(env);
    expect(env).toStrictEqual(before);
    expect(out).not.toBe(env);
  });
});

describe('pruneTickLogs', () => {
  it('keeps the newest four of each kind, and touches nothing else', () => {
    const dir = folder();
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    const base = Date.UTC(2026, 9, 31, 12) / 1000;
    // The older the number, the older the file: file 1 is the oldest.
    for (let i = 1; i <= 7; i++) {
      for (const name of [`learning-tick-20261031-14561${i}.log`, `report.20261031.14561${i}.${1000 + i}.0.00${i}.json`]) {
        writeFileSync(join(logs, name), 'x');
        utimesSync(join(logs, name), base + i, base + i);
      }
    }
    for (const name of ['w1-20261031-145612.log', 'supervisor.out']) {
      writeFileSync(join(logs, name), 'x');
      utimesSync(join(logs, name), base - 1000, base - 1000);
    }
    pruneTickLogs(dir);
    const left = readdirSync(logs).sort();
    const keep = [];
    for (const i of [4, 5, 6, 7]) keep.push(`learning-tick-20261031-14561${i}.log`, `report.20261031.14561${i}.${1000 + i}.0.00${i}.json`);
    expect(left).toEqual([...keep, 'supervisor.out', 'w1-20261031-145612.log'].sort());
    expect(KEEP).toBe(5);
  });
  it('breaks a tie in mtime by the name', () => {
    const dir = folder();
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    for (const name of ['learning-tick-a.log', 'learning-tick-b.log', 'learning-tick-c.log']) {
      writeFileSync(join(logs, name), 'x');
      utimesSync(join(logs, name), 1_800_000_000, 1_800_000_000);
    }
    pruneTickLogs(dir, 3);
    expect(readdirSync(logs).sort()).toEqual(['learning-tick-b.log', 'learning-tick-c.log']);
  });
  it('does not throw when there is no logs folder', () => {
    expect(() => pruneTickLogs(join(folder(), 'nothing'))).not.toThrow();
  });
});

describe('tickLogTail', () => {
  it('joins the last three lines, and drops blank lines, stack frames, carets and the Node version', () => {
    const dir = folder();
    const log = logIn(dir, ['one', 'Acme two', '', '    at foo (x.mjs:1:1)', '  ^^^', 'Acme three', 'Error: acme four', '    at bar (y.mjs:2:2)', '', 'Node.js v26.0.0', ''].join('\n'));
    expect(tickLogTail(log)).toEqual({ quote: 'Acme two / Acme three / Error: acme four', report: null });
  });
  it('ignores everything after the native stack trace', () => {
    const dir = folder();
    const log = logIn(dir, ['FATAL ERROR: Acme heap out of memory', '----- Native stack trace -----', '', ' 1: 0x1 node::Abort() [/usr/bin/node]', ' 2: 0x2 libnode.dylib'].join('\n'));
    const { quote } = tickLogTail(log);
    expect(quote).toBe('FATAL ERROR: Acme heap out of memory');
  });
  it('blanks a KEY=value and an env secret', () => {
    const dir = folder();
    const log = logIn(dir, 'Acme failed with ANTHROPIC_API_KEY=abc123 and acme-secret-value inside\n');
    const { quote } = tickLogTail(log, { env: { GH_TOKEN: 'acme-secret-value' } });
    expect(quote).toContain('•••');
    expect(quote).not.toContain('abc123');
    expect(quote).not.toContain('acme-secret-value');
  });
  it('cuts a long line to 300 characters, starting with an ellipsis', () => {
    const dir = folder();
    const { quote } = tickLogTail(logIn(dir, `${'a'.repeat(100)}${'b'.repeat(300)}\n`));
    expect(quote).toHaveLength(300);
    expect(quote.startsWith('…')).toBe(true);
    expect(quote.endsWith('b'.repeat(299))).toBe(true);
  });
  it('gives an empty quote for an empty log, and null for a missing one', () => {
    const dir = folder();
    expect(tickLogTail(logIn(dir, ''))).toEqual({ quote: '', report: null });
    expect(tickLogTail(join(dir, 'logs', 'nothing.log'))).toBeNull();
  });
  it('finds the Node report of that pid only', () => {
    const dir = folder();
    const log = logIn(dir, 'Error: acme\n');
    const report = join(dir, 'logs', 'report.20261031.145612.4242.0.001.json');
    writeFileSync(report, '{}');
    expect(tickLogTail(log, { pid: 4242 }).report).toBe(report);
    expect(tickLogTail(log, { pid: 99 }).report).toBeNull();
    expect(tickLogTail(log, {}).report).toBeNull();
    expect(tickLogTail(log, { pid: '4242' }).report).toBeNull();
  });
  it('reads the end of a log of 200 KiB', () => {
    const dir = folder();
    const log = logIn(dir, `${'Acme filler line\n'.repeat(12_000)}Acme end\n`);
    expect(tickLogTail(log).quote.endsWith('Acme end')).toBe(true);
  });
});

// Real children, wired as the supervisor wires them.
describe('a real learning tick', () => {
  function wire(dir, script) {
    const file = join(dir, 'tick.mjs');
    writeFileSync(file, script);
    const events = [];
    const ticks = learningTicks({
      spawnTick: (log) => session.start({ cmd: process.execPath, args: [file], env: tickEnv(process.env, dir, { report: reportSupported(process.version) }), cwd: dir, logFile: log }),
      enabled: true,
      auto: () => true,
      event: (text, kind) => events.push([text, kind]),
      newLog: () => session.logPath({ stateDir: dir, slot: 'learning-tick', now: new Date() }),
      readLog: (log, pid) => tickLogTail(log, { pid, env: process.env }),
    });
    return { ticks, events };
  }
  const finished = async (ticks, events) => {
    ticks.start();
    // The child's exit clears running() and logs its event in one step.
    for (let i = 0; i < 500 && ticks.running(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  const logsOf = (dir) => readdirSync(join(dir, 'logs')).filter((n) => /^learning-tick-.*\.log$/.test(n));

  it('a tick that throws leaves a log with the error, and one warn event that quotes its end', async () => {
    const dir = folder();
    const { ticks, events } = wire(dir, "console.log('Acme tick: scanning'); throw new Error('acme learner broke');\n");
    await finished(ticks, events);
    const logs = logsOf(dir);
    expect(logs).toHaveLength(1);
    const path = join(dir, 'logs', logs[0]);
    expect(readFileSync(path, 'utf8')).toContain('acme learner broke');
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe('warn');
    expect(events[0][0]).toContain('exit 1');
    expect(events[0][0]).toContain(path);
    expect(events[0][0]).toMatch(/Error: acme learner broke"\.( Node's diagnostic report: .*)?$/);
  });

  it('a tick that aborts leaves a log, and one warn event with the message and none of the native trace', async () => {
    const dir = folder();
    const { ticks, events } = wire(dir, "console.error('FATAL ERROR: Acme heap out of memory'); process.abort();\n");
    await finished(ticks, events);
    const logs = logsOf(dir);
    expect(logs).toHaveLength(1);
    const path = join(dir, 'logs', logs[0]);
    expect(readFileSync(path, 'utf8')).toContain('FATAL ERROR: Acme heap out of memory');
    expect(events).toHaveLength(1);
    expect(events[0][1]).toBe('warn');
    expect(events[0][0]).toContain('killed by SIGABRT');
    expect(events[0][0]).toContain(path);
    expect(events[0][0]).toContain('FATAL ERROR: Acme heap out of memory');
    expect(events[0][0]).not.toContain('Native stack trace');
    expect(events[0][0]).not.toContain('libnode');
  });

  it('a tick that exits 0 logs no event, and still has its log', async () => {
    const dir = folder();
    const { ticks, events } = wire(dir, "console.log('Acme tick: No new lessons');\n");
    await finished(ticks, events);
    expect(events).toEqual([]);
    const logs = logsOf(dir);
    expect(logs).toHaveLength(1);
    expect(existsSync(join(dir, 'logs', logs[0]))).toBe(true);
  });
});
