import { describe, expect, it } from 'vitest';
import { afterCheck, PROBE_EVERY_TICKS, PROBE_TIMEOUT_MS, probeArgs, probeDue, probeEnv, probeSignIn, SIGNIN_PAUSE, STATUS_TIMEOUT_MS } from './signin-probe.mjs';

const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const json = (v) => JSON.stringify(v);

// A fake `run` that answers `claude auth status` and the probe from the given replies, and
// records every call.
function recorder({ status = { status: 0, stdout: json({ loggedIn: true }), timedOut: false }, probe = { status: 0, stdout: json({ type: 'result', is_error: false, result: 'ok' }), timedOut: false } } = {}) {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return args[0] === 'auth' ? status : probe;
  };
  return { run, calls };
}

describe('the sign-in probe', () => {
  it('names the pause and its limits', () => {
    expect(SIGNIN_PAUSE).toBe('Claude sign-in expired: run `claude` to sign in again.');
    expect(PROBE_TIMEOUT_MS).toBe(60_000);
    expect(STATUS_TIMEOUT_MS).toBe(30_000);
    expect(PROBE_EVERY_TICKS).toBe(12);
  });
  it('asks for one cheap turn with no tools, no customisations and nothing kept', () => {
    expect(probeArgs()).toEqual(['-p', 'Reply with the word ok.', '--safe-mode', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--no-session-persistence', '--output-format', 'json']);
  });
  it('says signed out without running the probe when auth status says so', async () => {
    const { run, calls } = recorder({ status: { status: 0, stdout: json({ loggedIn: false }), timedOut: false } });
    expect(await probeSignIn({ env: { HOME: '/acme' }, run })).toEqual({ ok: false, why: 'signed out' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cmd: 'claude', args: ['auth', 'status', '--json'] });
  });
  it('is ok when auth status says logged in and the probe answers', async () => {
    const env = { HOME: '/acme', CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake' };
    const { run, calls } = recorder();
    expect(await probeSignIn({ env, run })).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ cmd: 'claude', args: ['auth', 'status', '--json'], opts: { env, timeout: STATUS_TIMEOUT_MS } });
    expect(calls[1]).toEqual({ cmd: 'claude', args: probeArgs(), opts: { env, timeout: PROBE_TIMEOUT_MS } });
  });
  it('lets the probe decide when auth status cannot be read', async () => {
    for (const status of [{ status: 1, stdout: '', timedOut: false }, { status: 0, stdout: 'Logged in as someone', timedOut: false }, { status: 0, stdout: '', timedOut: true }]) {
      const { run, calls } = recorder({ status });
      expect(await probeSignIn({ env: {}, run })).toEqual({ ok: true });
      expect(calls).toHaveLength(2);
    }
  });
  it('reads the last line of the probe, past any warning before it', async () => {
    const { run } = recorder({ probe: { status: 0, stdout: `a warning\n${json({ type: 'result', is_error: false, result: 'ok' })}\n`, timedOut: false } });
    expect(await probeSignIn({ env: {}, run })).toEqual({ ok: true });
  });
  it('fails a probe that answers with an error, exits non-zero or says nothing readable, and never repeats what it said', async () => {
    const planted = `${EXPIRED} for owner@acme.example`;
    const replies = [
      { status: 0, stdout: json({ type: 'result', is_error: true, result: planted }), timedOut: false },
      { status: 1, stdout: json({ type: 'result', is_error: false, result: planted }), timedOut: false },
      { status: 1, stdout: planted, timedOut: false },
      { status: 0, stdout: planted, timedOut: false },
      { status: 0, stdout: '', timedOut: false },
    ];
    for (const probe of replies) {
      const { run } = recorder({ probe });
      const r = await probeSignIn({ env: {}, run });
      expect(r).toEqual({ ok: false, why: 'the test reply failed' });
      expect(r.why).not.toContain('owner@acme.example');
      expect(r.why).not.toContain('OAuth');
    }
  });
  it('says the probe did not reply in time', async () => {
    const { run } = recorder({ probe: { status: 1, stdout: '', timedOut: true } });
    expect(await probeSignIn({ env: {}, run })).toEqual({ ok: false, why: 'no reply within 60 s' });
  });
  it('fails, never throws, when the runner rejects', async () => {
    const run = async () => {
      throw new Error('spawn claude ENOENT');
    };
    expect(await probeSignIn({ env: {}, run })).toEqual({ ok: false, why: 'the test reply failed' });
  });
});

describe('probeEnv', () => {
  it('fills the sign-in gaps from the keys file and never overrides the environment', () => {
    const env = probeEnv({ env: { PATH: '/bin', ANTHROPIC_API_KEY: 'from-env' }, fileKeys: { ANTHROPIC_API_KEY: 'from-file', CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake' }, useSubscription: false });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'from-env', CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake' });
  });
  it('drops ANTHROPIC_API_KEY once the run uses the subscription, even when the file has it', () => {
    const env = probeEnv({ env: { PATH: '/bin', ANTHROPIC_API_KEY: 'from-env' }, fileKeys: { ANTHROPIC_API_KEY: 'from-file', CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake' }, useSubscription: true });
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake' });
    expect(probeEnv({ env: {}, fileKeys: { ANTHROPIC_API_KEY: 'from-file' }, useSubscription: true })).toEqual({});
  });
  it("leaves out the story session's variables", () => {
    const env = probeEnv({ env: { PATH: '/bin', FOREMAN_RUN: '1', FOREMAN_STORY: 'ACME-1', FOREMAN_SLOT: 'w1', FOREMAN_STATE_DIR: '/acme/.foreman' }, fileKeys: {}, useSubscription: false });
    expect(env).toEqual({ PATH: '/bin', FOREMAN_STATE_DIR: '/acme/.foreman' });
  });
  it('takes only the sign-in names from the keys file', () => {
    expect(probeEnv({ env: {}, fileKeys: { JIRA_API_TOKEN: 'acme-jira' }, useSubscription: false })).toEqual({});
  });
});

describe('probeDue', () => {
  it('waits while one runs and until everyMs has passed since the last', () => {
    expect(probeDue({ running: true, lastAt: 0, now: 100_000, everyMs: 6000 })).toBe(false);
    expect(probeDue({ running: false, lastAt: 10_000, now: 15_999, everyMs: 6000 })).toBe(false);
    expect(probeDue({ running: false, lastAt: 10_000, now: 16_000, everyMs: 6000 })).toBe(true);
    expect(probeDue({ running: false, lastAt: 10_000, now: 20_000, everyMs: 6000 })).toBe(true);
    // after a restart nothing has run yet
    expect(probeDue({ running: false, lastAt: 0, now: 1000, everyMs: 6000 })).toBe(false);
    expect(probeDue({ running: false, lastAt: 0, now: Date.now(), everyMs: 60_000 })).toBe(true);
  });
});

describe('afterCheck', () => {
  const THREE = 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.';
  const at = '2026-10-30T09:00:00.000Z';
  it('lifts a pause for the sign-in when the check passes, with one good event', () => {
    expect(afterCheck({ ok: true, pausedAt: at, pauseReason: SIGNIN_PAUSE, ids: ['ACME-1'] })).toEqual({ resume: true, pause: false, forget: [], event: { text: 'Claude sign-in works again; carrying on.', kind: 'good' } });
  });
  it('leaves a pause for another reason alone when the check passes, and names the stories', () => {
    for (const pauseReason of [THREE, 'Out of credit for the Acme key.', '']) {
      expect(afterCheck({ ok: true, pausedAt: at, pauseReason, ids: ['ACME-4', 'ACME-5'] })).toEqual({ resume: false, pause: false, forget: [], event: { text: 'Claude sign-in failed for ACME-4 and ACME-5; it works again, so they carry on.', kind: 'warn' } });
      expect(afterCheck({ ok: true, pausedAt: at, pauseReason, ids: [] })).toEqual({ resume: false, pause: false, forget: [], event: null });
    }
  });
  it('names one, two or three stories when not paused', () => {
    const text = (ids) => afterCheck({ ok: true, pausedAt: null, pauseReason: '', ids }).event?.text;
    expect(text(['ACME-1'])).toBe('Claude sign-in failed for ACME-1; it works again, so they carry on.');
    expect(text(['ACME-1', 'ACME-2', 'ACME-3'])).toBe('Claude sign-in failed for ACME-1, ACME-2 and ACME-3; it works again, so they carry on.');
    expect(text([])).toBeUndefined();
  });
  it('a reason that is only SIGNIN_PAUSE with no pause time lifts nothing', () => {
    expect(afterCheck({ ok: true, pausedAt: null, pauseReason: SIGNIN_PAUSE, ids: [] })).toEqual({ resume: false, pause: false, forget: [], event: null });
  });
  it('pauses for the sign-in when the check fails, paused or not', () => {
    expect(afterCheck({ ok: false, pausedAt: null, pauseReason: '', ids: ['ACME-1'] })).toEqual({ resume: false, pause: true, forget: ['ACME-1'], event: null });
    expect(afterCheck({ ok: false, pausedAt: null, pauseReason: '', ids: ['ACME-1', 'ACME-2'] }).forget).toEqual(['ACME-1', 'ACME-2']);
    expect(afterCheck({ ok: false, pausedAt: at, pauseReason: THREE, ids: [] })).toEqual({ resume: false, pause: true, forget: [], event: null });
  });
});
