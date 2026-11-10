import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineCommand, ENGINE_CLI, newRelayId, parseEngineOutput, readRelay, readRelayResult, RELAY_ID, relayAlive, relayFiles, VERDICT_SCHEMA, writeRelay, writeRelayResult, DEFAULT_OUTAGE_MS, DOWN_FILE, OUTAGE_MARGIN_MS, quotaOutage, readEngineDown, writeEngineDown } from './review-engine.mjs';

const verdict = { approved: false, findings: [{ severity: 'minor', rule: 'r', where: 'a.js:1', observed: 'o', fix: 'f' }], checked: 'read it' };

describe('engineCommand', () => {
  it('runs the Antigravity CLI headless, in plan mode, with the verdict schema and the time limit', () => {
    const { cmd, args } = engineCommand({ name: 'antigravity', model: 'claude-opus-4-6-thinking', minutes: 20 }, 'the prompt');
    expect(cmd).toBe('agy');
    expect(args.slice(0, 2)).toEqual(['-p', 'the prompt']);
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-6-thinking');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--disable-slash-commands');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1])).toEqual(VERDICT_SCHEMA);
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('20m');
  });
  it('defaults the time limit to 20 minutes and names the CLI per engine', () => {
    expect(engineCommand({ name: 'antigravity', model: 'm' }, 'p').args).toContain('20m');
    expect(ENGINE_CLI.antigravity).toBe('agy');
    expect(() => engineCommand({ name: 'other', model: 'm' }, 'p')).toThrow(/engine/);
  });
});

describe('parseEngineOutput', () => {
  const wrap = (over) => JSON.stringify({ conversation_id: 'c', status: 'SUCCESS', response: JSON.stringify(verdict), duration_seconds: 12.5, num_turns: 1, usage: { input_tokens: 10, output_tokens: 2 }, ...over });

  it('takes the structured output first', () => {
    const r = parseEngineOutput(wrap({ structured_output: verdict, response: 'narration' }));
    expect(r).toEqual({ ok: true, verdict, seconds: 12.5, usage: { input_tokens: 10, output_tokens: 2 } });
  });
  it('falls back to the response text, with a fence or narration around the JSON', () => {
    expect(parseEngineOutput(wrap({ response: '```json\n' + JSON.stringify(verdict) + '\n```' })).verdict).toEqual(verdict);
    expect(parseEngineOutput(wrap({ response: 'I read the diff.\n' + JSON.stringify(verdict) + '\n' })).verdict).toEqual(verdict);
  });
  it('skips a warning line before the JSON', () => {
    expect(parseEngineOutput('Update available\n' + wrap({})).ok).toBe(true);
  });
  it('refuses a failed run, empty output, or a verdict of the wrong shape', () => {
    expect(parseEngineOutput('')).toEqual({ ok: false, reason: 'the engine printed nothing' });
    expect(parseEngineOutput('not json')).toEqual({ ok: false, reason: 'the engine did not print JSON' });
    expect(parseEngineOutput(wrap({ status: 'ERROR', error: 'quota exhausted' })).reason).toMatch(/quota exhausted/);
    expect(parseEngineOutput(wrap({ response: '{"approved": "yes"}', structured_output: undefined })).reason).toMatch(/verdict/);
    expect(parseEngineOutput(wrap({ structured_output: { approved: true, findings: [{ severity: 'huge' }], checked: 'x' } })).reason).toMatch(/severity/);
  });
  it('fills a finding whose text fields are missing, so a sparse verdict still counts', () => {
    const r = parseEngineOutput(wrap({ structured_output: { approved: false, findings: [{ severity: 'major', rule: 'r' }], checked: 'x' } }));
    expect(r.verdict.findings[0]).toEqual({ severity: 'major', rule: 'r', where: '-', observed: '', fix: '' });
  });
  it('keeps a repeats string, trimmed, and drops one that is empty or not a string', () => {
    const findings = [
      { severity: 'major', rule: 'a', repeats: ' E2 ' },
      { severity: 'major', rule: 'b', repeats: '  ' },
      { severity: 'major', rule: 'c', repeats: 2 },
      { severity: 'major', rule: 'd' },
    ];
    const r = parseEngineOutput(wrap({ structured_output: { approved: false, findings, checked: 'x' } }));
    expect(r.verdict.findings.map((f) => f.repeats)).toEqual(['E2', undefined, undefined, undefined]);
    expect(r.verdict.findings.map((f) => Object.hasOwn(f, 'repeats'))).toEqual([true, false, false, false]);
  });
});

describe('relay files', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-relay-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('names an id by slot and time that matches RELAY_ID', () => {
    const id = newRelayId({ slot: 'w1', now: new Date(0), random: () => 'abc' });
    expect(id).toBe('w1-0-abc');
    expect(RELAY_ID.test(id)).toBe(true);
    expect(newRelayId({ slot: null, now: new Date(0), random: () => 'abc' })).toBe('here-0-abc');
  });
  it('writes and reads the job and its result, with the prompt beside them', () => {
    const files = relayFiles(dir, 'here-1-a');
    expect(files.prompt.endsWith('here-1-a.prompt.md')).toBe(true);
    writeRelay(dir, { id: 'here-1-a', pid: 1, slot: null, story: 'S-1', reviewer: 'compliance', engine: { name: 'antigravity', model: 'm' }, cwd: '/x', startedAt: 't' });
    expect(readRelay(dir, 'here-1-a')).toMatchObject({ id: 'here-1-a', reviewer: 'compliance', engine: { name: 'antigravity', model: 'm' } });
    expect(readRelayResult(dir, 'here-1-a')).toBeNull();
    writeRelayResult(dir, 'here-1-a', { ok: true, verdict, seconds: 3, endedAt: 't2' });
    expect(readRelayResult(dir, 'here-1-a')).toEqual({ ok: true, verdict, seconds: 3, endedAt: 't2' });
    expect(readRelay(dir, 'missing')).toBeNull();
  });
  it('says the worker is alive only when its pid runs this job’s worker', () => {
    const job = { id: 'here-1-a', pid: 4242 };
    const kill = () => {};
    expect(relayAlive(job, { kill, ps: () => ({ status: 0, stdout: 'node /x/review-engine-job.mjs /state here-1-a\n' }) })).toBe(true);
    expect(relayAlive(job, { kill, ps: () => ({ status: 0, stdout: 'node /x/check-job.mjs /state here-1-a\n' }) })).toBe(false);
    expect(relayAlive(job, { kill: () => { throw new Error('ESRCH'); }, ps: () => ({ status: 0, stdout: '' }) })).toBe(false);
  });
});

describe('an engine out of quota', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');
  const AGY = [
    'warning: --mode plan has no effect while slash command expansion is disabled.',
    'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h16m58s.',
    'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached.","status":"RESOURCE_EXHAUSTED","error_code":429}',
  ].join('\n');

  it('reads the reset time from the CLI\u2019s message, with a minute of margin', () => {
    const o = quotaOutage(AGY, now);
    expect(o.reason).toBe('error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h16m58s.');
    expect(Date.parse(o.until) - now.getTime()).toBe(((4 * 3600 + 16 * 60 + 58) * 1000) + OUTAGE_MARGIN_MS);
    expect(Date.parse(quotaOutage('RESOURCE_EXHAUSTED: resets in 30m', now).until) - now.getTime()).toBe(30 * 60 * 1000 + OUTAGE_MARGIN_MS);
  });
  it('takes the default outage without a reset time, and sees no outage in another error', () => {
    const o = quotaOutage('error: quota exceeded for today', now);
    expect(Date.parse(o.until) - now.getTime()).toBe(DEFAULT_OUTAGE_MS + OUTAGE_MARGIN_MS);
    expect(quotaOutage('error: the model is not available', now)).toBeNull();
    expect(quotaOutage('', now)).toBeNull();
  });

  describe('the down record', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-relay-down-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('is read while its until is ahead, and gone once it has passed or when there is none', () => {
      expect(readEngineDown(dir, now)).toBeNull();
      writeEngineDown(dir, { engine: 'antigravity', until: '2026-11-09T16:18:00.000Z', reason: 'quota', at: now.toISOString() });
      expect(DOWN_FILE(dir)).toBe(path.join(dir, 'review-engine', 'down.json'));
      expect(readEngineDown(dir, now)).toEqual({ engine: 'antigravity', until: '2026-11-09T16:18:00.000Z', reason: 'quota', at: now.toISOString() });
      expect(readEngineDown(dir, new Date('2026-11-09T16:18:00.000Z'))).toBeNull();
      fs.writeFileSync(DOWN_FILE(dir), 'not json');
      expect(readEngineDown(dir, now)).toBeNull();
    });
  });
});
