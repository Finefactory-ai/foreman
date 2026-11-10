// Who stopped a run: the record `foreman stop`, the dashboard and the cloud runner leave in STOP
// and service-stopped, how it reads back (old ISO-only files included), and the words status,
// the dashboard and the email use.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearLastStop, LAST_STOP, readStopRecord, stopperDetail, stopperOf, stopperText, takeStop, unexpectedStop } from './stopper.mjs';

const AT = new Date('2026-10-26T04:01:15.000Z');
const SESSION_ENV = { FOREMAN_RUN: '1', FOREMAN_STORY: 'ACME-9', FOREMAN_SLOT: 'w2' };

// A fake `ps` that answers one command line for the parent pid.
const psSays = (line, calls = []) => (cmd, args) => {
  calls.push([cmd, ...args]);
  return { status: 0, stdout: `${line}\n`, stderr: '' };
};

describe('stopperOf', () => {
  it('records the time, the pids, the folder and the session from the env', () => {
    const calls = [];
    const rec = stopperOf({ via: 'cli', env: SESSION_ENV, cwd: '/tmp/acme-check', at: AT, pid: 4242, ppid: 4200, sh: psSays('/bin/zsh -c foreman stop --now', calls) });
    expect(rec).toEqual({
      at: '2026-10-26T04:01:15.000Z',
      via: 'cli',
      pid: 4242,
      ppid: 4200,
      parent: '/bin/zsh -c foreman stop --now',
      cwd: '/tmp/acme-check',
      run: true,
      story: 'ACME-9',
      slot: 'w2',
    });
    expect(calls).toEqual([['ps', '-p', '4200', '-o', 'command=']]);
  });

  it('outside a session: run false, no story, no slot', () => {
    const rec = stopperOf({ via: 'cli', env: {}, cwd: '/tmp/acme', at: AT, pid: 1, ppid: 2, sh: psSays('-zsh') });
    expect(rec).toMatchObject({ via: 'cli', run: false, story: null, slot: null, parent: '-zsh' });
  });

  it('blanks a key in the parent command line and the folder, and cuts them to 200 characters', () => {
    const key = `sk-ant-${'a'.repeat(20)}`;
    const rec = stopperOf({ via: 'unknown', env: {}, cwd: `/tmp/${key}`, at: AT, sh: psSays(`claude --key ${key}`) });
    expect(rec.parent).toBe('claude --key •••');
    expect(rec.cwd).toBe('/tmp/•••');
    expect(JSON.stringify(rec)).not.toContain('sk-ant-');
    const long = stopperOf({ via: 'unknown', env: {}, cwd: `/tmp/${'d'.repeat(300)}`, at: AT, sh: psSays(`node ${'x'.repeat(400)}`) });
    expect(long.parent).toHaveLength(200);
    expect(long.cwd).toHaveLength(200);
  });

  it('blanks the env secret values before cutting', () => {
    const env = { GH_TOKEN: 'acme-plain-token-value' };
    const rec = stopperOf({ via: 'unknown', env, at: AT, sh: psSays('git push https://acme-plain-token-value@example.com') });
    expect(rec.parent).toBe('git push https://•••@example.com');
  });

  // FM-284: a secret in the parent shell's command line must not reach STOP, the event or the
  // email: NAME=value and flag pairs by name, -u user:pass, URL credentials and env values by name.
  it.each([
    ['/bin/zsh -c JIRA_API_TOKEN=xyz123abc foreman stop', '/bin/zsh -c JIRA_API_TOKEN=••• foreman stop', 'xyz123abc'],
    ['curl -u acme:hunter22 https://acme.example && foreman stop', 'curl -u acme:••• https://acme.example && foreman stop', 'hunter22'],
    ['node deploy.mjs --api-key abc123 --password=pw1 --verbose', 'node deploy.mjs --api-key ••• --password=••• --verbose', 'abc123'],
    ['node deploy.mjs --api-key abc123 --password=pw1 --verbose', 'node deploy.mjs --api-key ••• --password=••• --verbose', 'pw1'],
    ['git clone https://acme:s3cret@example.com/x.git', 'git clone https://acme:•••@example.com/x.git', 's3cret'],
    ['curl --user acme:hunter22 https://acme.example', 'curl --user acme:••• https://acme.example', 'hunter22'],
    ['curl --user=acme:hunter22 https://acme.example', 'curl --user=acme:••• https://acme.example', 'hunter22'],
    [`sh -c ACME_PASSWORD="two words" foreman stop`, 'sh -c ACME_PASSWORD=••• foreman stop', 'two words'],
    [`sh -c ACME_AUTH='quoted one';foreman stop`, 'sh -c ACME_AUTH=•••;foreman stop', 'quoted one'],
    ['acme -secret topsecret1 stop', 'acme -secret ••• stop', 'topsecret1'],
  ])('blanks the secret in %j', (line, cleaned, secret) => {
    const rec = stopperOf({ via: 'unknown', env: {}, at: AT, sh: psSays(line) });
    expect(rec.parent).toBe(cleaned);
    expect(JSON.stringify(rec)).not.toContain(secret);
  });

  it('blanks the values of env variables named like a secret, 8 characters or more', () => {
    const rec = stopperOf({ via: 'unknown', env: { ACME_SECRET: 'acme-env-secret-1' }, cwd: '/tmp/acme-env-secret-1', at: AT, sh: psSays('node run.mjs acme-env-secret-1') });
    expect(rec.parent).toBe('node run.mjs •••');
    expect(rec.cwd).toBe('/tmp/•••');
    expect(JSON.stringify(rec)).not.toContain('acme-env-secret-1');
    expect(stopperOf({ via: 'unknown', env: { ACME_KEY: '1' }, at: AT, sh: psSays('node a1.js') }).parent).toBe('node a1.js');
  });

  it('keeps the pairs that are not secrets as they are', () => {
    const line = 'FOREMAN_RUN=1 foreman settings --group run set workers 1 --now';
    expect(stopperOf({ via: 'cli', env: {}, at: AT, sh: psSays(line) }).parent).toBe(line);
  });

  it('does not take the next flag as the value of a secret flag', () => {
    const parent = (line) => stopperOf({ via: 'cli', env: {}, at: AT, sh: psSays(line) }).parent;
    expect(parent('acme login --token --dry-run')).toBe('acme login --token --dry-run');
    expect(parent('acme login --now --api-key abc123')).toBe('acme login --now --api-key •••');
  });

  it('keeps an empty parent when ps fails', () => {
    expect(stopperOf({ via: 'cli', at: AT, sh: () => ({ status: 1, stdout: '', stderr: 'no such process' }) }).parent).toBe('');
    expect(stopperOf({ via: 'cli', at: AT, sh: () => ({ error: new Error('ENOENT'), status: null }) }).parent).toBe('');
    expect(stopperOf({ via: 'cli', at: AT, sh: () => { throw new Error('boom'); } }).parent).toBe('');
  });

  it('for the dashboard: no ps, no pids, the user agent cut to 120 characters', () => {
    let asked = false;
    const rec = stopperOf({ via: 'dashboard', agent: 'Mozilla/5.0 (Macintosh)', at: AT, sh: () => { asked = true; return { status: 0, stdout: 'x' }; } });
    expect(asked).toBe(false);
    expect(rec).toEqual({ at: AT.toISOString(), via: 'dashboard', cwd: null, run: false, story: null, slot: null, agent: 'Mozilla/5.0 (Macintosh)' });
    expect(stopperOf({ via: 'dashboard', agent: 'a'.repeat(300), at: AT }).agent).toHaveLength(120);
  });

  it('an unknown via is recorded as unknown', () => {
    expect(stopperOf({ via: 'acme', at: AT, sh: psSays('x') }).via).toBe('unknown');
  });
});

describe('readStopRecord', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-stopper-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const file = (text) => {
    writeFileSync(join(dir, 'STOP'), text);
    return join(dir, 'STOP');
  };

  it('reads a JSON record back', () => {
    const rec = stopperOf({ via: 'cli', env: SESSION_ENV, cwd: '/tmp/acme', at: AT, pid: 7, ppid: 8, sh: psSays('zsh') });
    expect(readStopRecord(file(`${JSON.stringify(rec)}\n`))).toEqual(rec);
  });

  it('drops the fields of the wrong type', () => {
    const rec = readStopRecord(file(JSON.stringify({ at: AT.toISOString(), via: 'cli', pid: 'x', ppid: -1, parent: 5, cwd: '/tmp/acme', run: 'yes', story: 9, slot: 'w1', agent: {} })));
    expect(rec).toEqual({ at: AT.toISOString(), via: 'cli', cwd: '/tmp/acme', slot: 'w1' });
    expect(readStopRecord(file(JSON.stringify({ at: 'not a date', via: 'nobody' })))).toEqual({});
  });

  it('reads an old ISO-only file as its time, with no via', () => {
    expect(readStopRecord(file('2026-10-26T04:01:15.000Z\n'))).toEqual({ at: '2026-10-26T04:01:15.000Z' });
  });

  // FM-284: STOP can be written by any process, so what it says is cut and cleaned as stopperOf does.
  it('cuts each text field to the limits stopperOf keeps', () => {
    const rec = readStopRecord(file(JSON.stringify({ at: AT.toISOString(), via: 'unknown', story: 'A'.repeat(100000), slot: 'w'.repeat(1000), parent: 'x'.repeat(100000), cwd: 'x'.repeat(100000), agent: 'y'.repeat(100000) })));
    expect([rec.story.length, rec.slot.length, rec.parent.length, rec.cwd.length, rec.agent.length]).toEqual([80, 20, 200, 200, 120]);
    expect(stopperDetail(rec).length).toBeLessThan(700);
  });

  it('blanks a secret in a STOP written directly', () => {
    const rec = readStopRecord(file(JSON.stringify({ via: 'unknown', parent: 'JIRA_API_TOKEN=xyz foreman stop', cwd: '/tmp/acme --password=pw1' })));
    expect(rec.parent).toBe('JIRA_API_TOKEN=••• foreman stop');
    expect(rec.cwd).toBe('/tmp/acme --password=•••');
  });

  it('keeps a null folder, story and slot null', () => {
    expect(readStopRecord(file(JSON.stringify({ via: 'cli', cwd: null, story: null, slot: null })))).toEqual({ via: 'cli', cwd: null, story: null, slot: null });
  });

  it('is null for a missing file and {} for garbage', () => {
    expect(readStopRecord(join(dir, 'none'))).toBeNull();
    expect(readStopRecord(file('old\n'))).toEqual({});
    expect(readStopRecord(file('[1,2]'))).toEqual({});
    expect(readStopRecord(file(''))).toEqual({});
  });
});

// FM-284: the supervisor keeps who stopped the run in last-stop once it has taken STOP, so a cloud
// run's stop stays named; a fresh start removes it.
describe('takeStop and clearLastStop', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-stopper-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is the file name last-stop', () => {
    expect(LAST_STOP).toBe('last-stop');
  });

  it('takes STOP: returns the record, removes STOP and keeps the record in last-stop', () => {
    const rec = { at: AT.toISOString(), via: 'cloud' };
    writeFileSync(join(dir, 'STOP'), `${JSON.stringify(rec)}\n`);
    expect(takeStop(dir)).toEqual(rec);
    expect(existsSync(join(dir, 'STOP'))).toBe(false);
    expect(readStopRecord(join(dir, LAST_STOP))).toEqual(rec);
  });

  it('keeps the cleaned and cut record, not what STOP said', () => {
    writeFileSync(join(dir, 'STOP'), JSON.stringify({ via: 'unknown', parent: 'JIRA_API_TOKEN=xyz foreman stop', story: 'A'.repeat(1000) }));
    const rec = takeStop(dir);
    expect(rec).toEqual({ via: 'unknown', parent: 'JIRA_API_TOKEN=••• foreman stop', story: 'A'.repeat(80) });
    expect(readFileSync(join(dir, LAST_STOP), 'utf8')).toBe(`${JSON.stringify(rec)}\n`);
  });

  it('is null with no STOP and writes no last-stop', () => {
    expect(takeStop(dir)).toBeNull();
    expect(existsSync(join(dir, LAST_STOP))).toBe(false);
  });

  it('a garbage STOP gives {} and last-stop holds {}', () => {
    writeFileSync(join(dir, 'STOP'), 'old\n');
    expect(takeStop(dir)).toEqual({});
    expect(existsSync(join(dir, 'STOP'))).toBe(false);
    expect(readFileSync(join(dir, LAST_STOP), 'utf8')).toBe('{}\n');
  });

  it('clearLastStop removes last-stop, and does nothing when it is missing', () => {
    writeFileSync(join(dir, LAST_STOP), '{}\n');
    clearLastStop(dir);
    expect(existsSync(join(dir, LAST_STOP))).toBe(false);
    expect(() => clearLastStop(dir)).not.toThrow();
  });
});

describe('stopperText and stopperDetail', () => {
  const at = AT.toISOString();
  it.each([
    [{ at, via: 'unknown', run: true, story: 'ACME-9' }, "ACME-9's session at 04:01 UTC"],
    [{ at, via: 'cli', run: true, story: null }, 'a Foreman run process at 04:01 UTC'],
    [{ at, via: 'cli', run: false }, 'your terminal at 04:01 UTC'],
    [{ at, via: 'dashboard', agent: 'Mozilla/5.0 (Macintosh)' }, 'the dashboard at 04:01 UTC'],
    [{ at, via: 'dashboard', agent: 'curl/8.7.1' }, 'a request to the dashboard (curl/8.7.1) at 04:01 UTC'],
    [{ at, via: 'dashboard' }, 'a request to the dashboard (no user agent) at 04:01 UTC'],
    [{ at, via: 'cloud' }, 'the cloud runner at 04:01 UTC'],
    [{ at }, 'an unknown process at 04:01 UTC'],
    [{}, 'an unknown process'],
    [null, 'an unknown process'],
  ])('%j reads %s', (rec, text) => {
    expect(stopperText(rec)).toBe(text);
  });

  it('the detail adds the pid, the parent and the folder that are there', () => {
    const rec = { at, via: 'unknown', pid: 4242, parent: 'node /tmp/acme/x.mjs', cwd: '/tmp/acme-check', run: true, story: 'ACME-9' };
    expect(stopperDetail(rec)).toBe('ACME-9\'s session at 04:01 UTC (pid 4242, parent "node /tmp/acme/x.mjs", in /tmp/acme-check)');
    expect(stopperDetail({ at, via: 'cli', pid: 7 })).toBe('your terminal at 04:01 UTC (pid 7)');
    expect(stopperDetail({ at, via: 'cloud' })).toBe('the cloud runner at 04:01 UTC');
    expect(stopperDetail(null)).toBe('an unknown process');
  });
});

describe('unexpectedStop', () => {
  it.each([
    [{ via: 'cli', run: false, story: null }, false],
    [{ via: 'cli', run: true, story: null }, true],
    [{ via: 'cli', run: false, story: 'ACME-9' }, true],
    [{ via: 'dashboard', agent: 'Mozilla/5.0 (Macintosh)' }, false],
    [{ via: 'dashboard', agent: 'curl/8.7.1' }, true],
    [{ via: 'dashboard' }, true],
    [{ via: 'cloud' }, false],
    [{ via: 'unknown', run: false }, true],
    [{ at: '2026-10-26T04:01:15.000Z' }, true],
    [{}, true],
    [null, true],
  ])('%j -> %s', (rec, expected) => {
    expect(unexpectedStop(rec)).toBe(expected);
  });
});
