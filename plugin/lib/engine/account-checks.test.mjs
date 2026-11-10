// The Claude sign-in, credit and subscription checks, called directly, with no `claude`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountChecks } from './account-checks.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-account-checks-'));
  made.push(dir);
  const event = vi.fn();
  const notify = vi.fn();
  const checks = accountChecks({
    root: dir,
    config: { project: 'Acme' },
    dir,
    creditRetryMs: 1000,
    state: () => ({}),
    saveRun: vi.fn(),
    event,
    notify,
    autoPause: vi.fn(),
    guarded: (what, fn) => fn,
    signins: new Map(),
    now: () => new Date('2026-01-01T10:00:00Z'),
  });
  return { dir, event, notify, ...checks };
}

describe('runProbe', () => {
  it('resolves the status and output of a command that ends', async () => {
    const { runProbe } = setup();
    const r = await runProbe(process.execPath, ['-e', "process.stdout.write('hi')"], { env: process.env, timeout: 5000 });
    expect(r).toEqual({ status: 0, stdout: 'hi', timedOut: false });
  });

  it('resolves status 1 for a command that does not exist, and never rejects', async () => {
    const { runProbe } = setup();
    const r = await runProbe('/no/such/acme-command', [], { env: process.env, timeout: 5000 });
    expect(r.status).toBe(1);
    expect(r.timedOut).toBe(false);
  });

  it('ends a command that outlasts its time limit', async () => {
    const { runProbe } = setup();
    const r = await runProbe(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { env: process.env, timeout: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.status).not.toBe(0);
  });
});

describe('switchToSubscription', () => {
  it('records the switch once, with one warn event and one credits notification', () => {
    const { dir, event, notify, switchToSubscription } = setup();
    switchToSubscription({ limit: null, resetAt: null, slot: 'w1' });
    const record = JSON.parse(readFileSync(join(dir, 'claude-signin.json'), 'utf8'));
    expect(record.using).toBe('subscription');
    expect(event).toHaveBeenCalledTimes(1);
    const [text, kind, slot] = event.mock.calls[0];
    expect(text.endsWith('; later sessions use your subscription.')).toBe(true);
    expect([kind, slot]).toEqual(['warn', 'w1']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('credits');
    switchToSubscription({ limit: null, resetAt: null, slot: 'w1' });
    expect(event).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('writes nothing before the first switch', () => {
    const { dir } = setup();
    expect(existsSync(join(dir, 'claude-signin.json'))).toBe(false);
  });
});

describe('the state objects', () => {
  it('start idle', () => {
    const { signInCheck, creditCheck, subscriptionCheck } = setup();
    expect(signInCheck.running).toBe(false);
    expect(creditCheck.running).toBe(false);
    expect(subscriptionCheck.running).toBe(false);
  });
});
