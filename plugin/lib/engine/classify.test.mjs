import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyRun, classifySession, lastResult } from './classify.mjs';

const fixture = (name) => readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8');
const line = (event) => JSON.stringify(event);

// The exact words Claude Code wrote when a Console key hit the usage limit set on it.
const USAGE = 'API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.';
const usageEvent = { type: 'assistant', error: 'unknown', api_error_status: 400, parent_tool_use_id: null, session_id: 'acme', message: { model: '<synthetic>', content: [{ type: 'text', text: USAGE }] } };
const usageResult = { type: 'result', subtype: 'success', is_error: true, api_error_status: 400, terminal_reason: 'api_error', result: USAGE, total_cost_usd: 0, num_turns: 3, duration_ms: 10, session_id: 'acme' };
const usageCause = { result: null, story: null, cause: 'api-credit', resetAt: '2026-11-01 at 00:00 UTC', limit: 'usage' };

describe('classifyRun', () => {
  it('reads the last result line', () => {
    expect(classifyRun('x\nFACTORY_RESULT: failed P7-01\nFACTORY_RESULT: shipped P7-01\n')).toMatchObject({ result: 'shipped', story: 'P7-01', cause: null });
    expect(classifyRun('FACTORY_RESULT: empty -')).toMatchObject({ result: 'empty', story: null });
    expect(classifyRun('FACTORY_RESULT: deferred P8-03')).toMatchObject({ result: 'deferred', story: 'P8-03' });
  });
  it('reads a parked release as ready-to-promote', () => {
    expect(classifyRun('FACTORY_RESULT: ready-to-promote FM-1')).toMatchObject({ result: 'ready-to-promote', story: 'FM-1' });
  });
  it('spots an API rate limit only when there is no result', () => {
    expect(classifyRun('working\nAPI Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).toMatchObject({ result: null, cause: 'rate-limit' });
    expect(classifyRun('API Error: 429\nFACTORY_RESULT: shipped P7-01').cause).toBe(null);
  });
  it('does not mistake the app\'s own rate limits for an API limit', () => {
    expect(classifyRun('$ psql -c "select app.rate_limit_hit()"\nrate_limit_counters ok').cause).toBe(null);
  });
  it('spots an outage', () => {
    expect(classifyRun('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}').cause).toBe('outage');
    expect(classifyRun('API Error: 500 Internal server error').cause).toBe('outage');
  });
  it('spots an empty Console credit balance in the error text, apart from a subscription usage limit', () => {
    expect(classifyRun('', { errorText: 'Credit balance is too low' }).cause).toBe('api-credit');
    expect(classifyRun("You've hit your usage limit · resets 3pm (Europe/London)")).toMatchObject({ cause: 'credit', resetAt: '3pm (Europe/London)' });
    expect(classifyRun('Claude usage limit reached').cause).toBe('credit');
  });
  it('caps the reset text of a usage-limit line, however long the line is', () => {
    const run = classifyRun("You've hit your usage limit · resets " + '1' + ' '.repeat(5000) + 'x');
    expect(run.cause).toBe('credit');
    expect(run.resetAt.length).toBeLessThanOrEqual(60);
  });
  it('reads a credit error sent as a 429 as credit, not a rate limit', () => {
    const low = 'API Error: 429 {"type":"error","error":{"message":"Credit balance is too low"}}';
    expect(classifyRun(low, { errorText: low }).cause).toBe('api-credit');
    expect(classifyRun("API Error: 429 You've hit your limit · resets 3pm").cause).toBe('credit');
  });
  it('does not mistake the app\'s AI budget for Claude credit', () => {
    expect(classifyRun('account over its AI usage limit: degrading to templates').cause).toBe(null);
  });
  it('names an empty balance as the balance limit', () => {
    expect(classifyRun('', { errorText: 'Credit balance is too low' })).toEqual({ result: null, story: null, cause: 'api-credit', resetAt: null, limit: 'balance' });
  });
  it('reads the credit balance only from the error text, never from the log', () => {
    expect(classifyRun('Credit balance is too low').cause).toBe(null);
    expect(classifyRun('API Error: 400 billing_error').cause).toBe(null);
    // a result line still wins
    expect(classifyRun('FACTORY_RESULT: shipped ACME-1', { errorText: 'Credit balance is too low' })).toMatchObject({ result: 'shipped', cause: null });
  });
  it('reads the key usage limit only from the error text, never from the log', () => {
    expect(classifyRun(USAGE)).toEqual({ result: null, story: null, cause: null, resetAt: null });
    expect(classifyRun('', { errorText: USAGE })).toEqual({ result: null, story: null, cause: 'api-credit', resetAt: '2026-11-01 at 00:00 UTC', limit: 'usage' });
    expect(classifyRun('', { errorText: 'API Error: 400 You have reached your specified API usage limits.' })).toMatchObject({ cause: 'api-credit', resetAt: null, limit: 'usage' });
    // a result line still wins
    expect(classifyRun('FACTORY_RESULT: shipped ACME-1', { errorText: USAGE })).toMatchObject({ result: 'shipped', cause: null });
  });
  it('calls anything else a plain crash', () => {
    expect(classifyRun('Segmentation fault')).toEqual({ result: null, story: null, cause: null, resetAt: null });
  });
});

// Sessions log stream-json; classifySession reads it and feeds classifyRun the session's own words.
describe('classifySession', () => {
  it('reads the result line of a finished story, not one from a tool or a subagent', () => {
    expect(classifySession(fixture('stream-json-shipped.jsonl'))).toEqual({ result: 'shipped', story: 'S-1', cause: null, resetAt: null });
  });
  it('calls a session that died mid-run with no result event a plain crash', () => {
    // the log also has an overload that was retried successfully before the crash
    expect(classifySession(fixture('stream-json-crash.jsonl'))).toEqual({ result: null, story: null, cause: null, resetAt: null });
  });
  it('spots a 429 that ended the session', () => {
    expect(classifySession(fixture('stream-json-429.jsonl'))).toMatchObject({ result: null, cause: 'rate-limit' });
  });
  it('spots an outage the session was still retrying when it died', () => {
    const text = [
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Working on S-4.' }] }, parent_tool_use_id: null }),
      line({ type: 'system', subtype: 'api_retry', attempt: 9, max_retries: 10, retry_delay_ms: 30000, error_status: 529, error: 'overloaded' }),
    ].join('\n');
    expect(classifySession(text).cause).toBe('outage');
    const noStatus = line({ type: 'system', subtype: 'api_retry', attempt: 3, error_status: null, error: 'server_error' });
    expect(classifySession(noStatus).cause).toBe('outage');
  });
  it('spots a billing error naming the credit balance as api-credit, and a usage limit as credit with its reset time', () => {
    const billing = line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Credit balance is too low' }] }, parent_tool_use_id: null, error: 'billing_error' });
    const low = line({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low', total_cost_usd: 0, num_turns: 1, duration_ms: 1 });
    expect(classifySession([billing, low].join('\n'))).toEqual({ result: null, story: null, cause: 'api-credit', resetAt: null, limit: 'balance' });
    expect(classifySession(low)).toMatchObject({ cause: 'api-credit', limit: 'balance' });
    // a billing error that does not name the credit balance is not api-credit
    const problem = line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Your account has a problem.' }] }, parent_tool_use_id: null, error: 'billing_error' });
    expect(classifySession(problem).cause).toBe(null);
    const limit = line({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm (Europe/London)", total_cost_usd: 0, num_turns: 1, duration_ms: 1 });
    expect(classifySession(limit)).toMatchObject({ cause: 'credit', resetAt: '3pm (Europe/London)' });
  });
  it('reads the key usage limit from the error event and the error result', () => {
    expect(classifySession([line(usageEvent), line(usageResult)].join('\n'))).toEqual(usageCause);
    // an earlier turn ended cleanly; the last result event is the one that counts
    const earlier = { type: 'result', subtype: 'success', is_error: false, result: 'Working on ACME-3.', total_cost_usd: 1, num_turns: 2, duration_ms: 5, session_id: 'acme' };
    const work = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'Carrying on with ACME-3.' }] } };
    expect(classifySession([line(earlier), line(work), line(usageEvent), line(usageResult)].join('\n'))).toEqual(usageCause);
  });
  it('does not read the credit balance from the conversation, a plain line or a result that is not an error', () => {
    const none = { result: null, story: null, cause: null, resetAt: null };
    const said = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: "The brief says the app shows 'Credit balance is too low' when the wallet is empty" }] } };
    expect(classifySession(line(said))).toEqual(none);
    const fine = { type: 'result', subtype: 'success', is_error: false, result: 'The Acme wallet says: Credit balance is too low', total_cost_usd: 0, num_turns: 1, duration_ms: 1 };
    expect(classifySession(line(fine))).toEqual(none);
    const work = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'text', text: 'Working on ACME-1.' }] } };
    expect(classifySession([line(work), 'Credit balance is too low', line(work)].join('\n'))).toEqual(none);
    const marker = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm3', content: [{ type: 'text', text: 'API Error: 400 billing_error' }] } };
    expect(classifySession(line(marker))).toEqual(none);
  });
  it('does not read the usage limit from the conversation, a tool or a subagent', () => {
    const quoted = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: `The docs say: ${USAGE}` }] } };
    expect(classifySession(line(quoted)).cause).toBe(null);
    const tool = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: USAGE }] } };
    expect(classifySession(line(tool)).cause).toBe(null);
    const subagent = { ...usageEvent, parent_tool_use_id: 'toolu_1' };
    expect(classifySession(line(subagent)).cause).toBe(null);
    const subagentText = { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 'm3', content: [{ type: 'text', text: USAGE }] } };
    expect(classifySession(line(subagentText)).cause).toBe(null);
  });
  it('still reads a plain-text log', () => {
    expect(classifySession('done\nFACTORY_RESULT: blocked P2-01\n')).toMatchObject({ result: 'blocked', story: 'P2-01' });
    expect(classifySession('API Error: 529 overloaded_error').cause).toBe('outage');
  });
});

// The words Claude Code ends a session with when its sign-in no longer works.
const EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const signinCause = { result: null, story: null, cause: 'signin', resetAt: null };

describe('a Claude sign-in that stopped working', () => {
  it('reads the session\'s own error result as signin, apart from the story', () => {
    const result = { type: 'result', subtype: 'success', is_error: true, num_turns: 0, duration_ms: 10, total_cost_usd: 0, result: EXPIRED, session_id: 'acme' };
    const work = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Working on ACME-1.' }] } };
    const got = classifySession([line(work), line(result)].join('\n'));
    expect(got).toEqual(signinCause);
    expect(got).not.toHaveProperty('limit');
  });
  it.each([
    'invalid_grant',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}',
    'OAuth token has expired',
    EXPIRED,
  ])('reads %s in the error text as signin', (errorText) => {
    expect(classifyRun('', { errorText })).toEqual(signinCause);
  });
  it('reads an assistant event made from an authentication_failed error as signin', () => {
    const failed = { type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'm1', content: [{ type: 'text', text: 'Please run /login.' }] } };
    expect(classifySession(line(failed))).toEqual(signinCause);
  });
  it('does not read the sign-in words from the conversation, a tool or a subagent', () => {
    for (const words of ['invalid_grant: expired access/refresh token', EXPIRED]) {
      const said = { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: `The Salesforce login says: ${words}` }] } };
      expect(classifySession(line(said)), words).toEqual({ result: null, story: null, cause: null, resetAt: null });
      const tool = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: words }] } };
      expect(classifySession(line(tool)), words).toEqual({ result: null, story: null, cause: null, resetAt: null });
      const subagent = { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 'm2', content: [{ type: 'text', text: words }] } };
      expect(classifySession(line(subagent)), words).toEqual({ result: null, story: null, cause: null, resetAt: null });
      const subagentError = { ...subagent, error: 'authentication_failed' };
      expect(classifySession(line(subagentError)), words).toEqual({ result: null, story: null, cause: null, resetAt: null });
    }
    // nor from a plain log: the app's own 401 is the story's business
    expect(classifyRun(`${EXPIRED}\nAPI Error: 401 authentication_error\ninvalid_grant`).cause).toBe(null);
  });
  describe('the authentication_failed marker', () => {
    const nothing = { result: null, story: null, cause: null, resetAt: null };
    const main = (event) => ({ type: 'assistant', parent_tool_use_id: null, ...event });
    const MARKER = 'API Error: 401 authentication_failed';
    it('is not read from a session that says it in its own words', () => {
      const said = main({ message: { id: 'm1', content: [{ type: 'text', text: MARKER }] } });
      expect(classifySession(line(said))).toEqual(nothing);
    });
    it('is not read from a quote, with a result that is not an error', () => {
      const text = 'The org said API Error: 400 authentication_failed';
      const said = main({ message: { id: 'm1', content: [{ type: 'text', text }] } });
      const result = { type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0, num_turns: 1, duration_ms: 10, session_id: 'acme' };
      expect(classifySession([line(said), line(result)].join('\n')).cause).toBe(null);
    });
    it('is not read from a plain log', () => {
      expect(classifyRun(MARKER).cause).toBe(null);
      expect(classifySession(MARKER).cause).toBe(null);
    });
    it('is read from the category of the error event, given as errorCategories', () => {
      expect(classifyRun('', { errorCategories: ['authentication_failed'] })).toEqual(signinCause);
      expect(classifyRun('API Error: - authentication_failed', { errorCategories: [] }).cause).toBe(null);
    });
    it('is not read once a real message follows the error event', () => {
      const failed = main({ error: 'authentication_failed', message: { id: 'm1', content: [{ type: 'text', text: 'Please run /login.' }] } });
      const answer = main({ message: { id: 'm2', content: [{ type: 'text', text: 'Carrying on.' }] } });
      expect(classifySession([line(failed), line(answer)].join('\n')).cause).toBe(null);
    });
  });
  it('lets a result line win over a sign-in error', () => {
    expect(classifyRun('FACTORY_RESULT: shipped ACME-1', { errorText: EXPIRED })).toEqual({ result: 'shipped', story: 'ACME-1', cause: null, resetAt: null });
  });
});

describe('lastResult', () => {
  it('is exported and gives the last known result line', () => {
    expect(lastResult('FACTORY_RESULT: blocked ACME-1\nFACTORY_RESULT: shipped ACME-1')).toEqual({ result: 'shipped', story: 'ACME-1' });
  });
});
