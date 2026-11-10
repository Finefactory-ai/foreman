import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readInit, readSessionLog } from './session-log.mjs';

const fixture = (name) => readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8');
const line = (event) => JSON.stringify(event);

describe('readSessionLog', () => {
  it('reads a real `claude -p --output-format stream-json --verbose` run', () => {
    const log = readSessionLog(fixture('stream-json-sample.jsonl'));
    expect(log).toMatchObject({ finalText: 'Hi. What are we working on?', costUsd: 0.180167, turns: 1, durationMs: 2166, isError: false });
    // an allowed rate-limit warning is not a sign of trouble
    expect(log.rawTextTail).not.toMatch(/rate.?limit/i);
  });

  it('reads a finished story: the result text, cost, turns and time', () => {
    const log = readSessionLog(fixture('stream-json-shipped.jsonl'));
    expect(log.finalText).toBe('**S-1 shipped.** Pull request: https://example.com/pr/1\n\nFACTORY_RESULT: shipped S-1');
    expect(log).toMatchObject({ costUsd: 2.5, turns: 14, durationMs: 1800000, isError: false });
  });

  it('keeps plain lines and the main conversation, not tool output or subagents', () => {
    const tail = readSessionLog(fixture('stream-json-shipped.jsonl')).rawTextTail;
    expect(tail).toContain('Warning: no stdin data received');
    expect(tail).toContain('Starting S-1 through the pipeline.');
    expect(tail).not.toContain('FACTORY_RESULT: failed S-9');
    expect(tail).not.toContain("app's own AI budget");
    expect(tail).not.toContain('"type"');
  });

  it('survives a crash: no result event and a cut-off last line', () => {
    const log = readSessionLog(fixture('stream-json-crash.jsonl'));
    expect(log).toMatchObject({ costUsd: null, turns: null, durationMs: null, isError: null });
    expect(log.finalText).toBe('Building S-2 now.\n\nThe architect plan is ready.');
    // the overload was retried and the session went on, so it is not why the session ended
    expect(log.rawTextTail).not.toMatch(/overloaded|API Error/);
  });

  it('turns an API error into words the classifier knows', () => {
    const log = readSessionLog(fixture('stream-json-429.jsonl'));
    expect(log.isError).toBe(true);
    expect(log.costUsd).toBe(0.4);
    expect(log.finalText).toMatch(/^API Error: 429/);
    expect(log.rawTextTail).toMatch(/API Error: 429 rate_limit/);
  });

  it('reports retries the session was still waiting on when it died', () => {
    const text = [
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Working.' }] }, parent_tool_use_id: null }),
      line({ type: 'system', subtype: 'api_retry', attempt: 4, max_retries: 10, retry_delay_ms: 9000, error_status: 529, error: 'overloaded' }),
    ].join('\n');
    expect(readSessionLog(text).rawTextTail).toMatch(/API Error: 529 overloaded/);
  });

  it('names a billing error and a rejected rate limit with its reset time', () => {
    const billing = line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Credit balance is too low' }] }, parent_tool_use_id: null, error: 'billing_error' });
    expect(readSessionLog(billing).rawTextTail).toMatch(/billing_error/);
    const rejected = line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1792173600, rateLimitType: 'five_hour' } });
    expect(readSessionLog(rejected).rawTextTail).toMatch(/Rate limit reached .*resets at 2026-/);
  });

  it('falls back to the whole text for a plain-text log', () => {
    const text = 'Did the work.\nFACTORY_RESULT: shipped P1-01\n';
    const log = readSessionLog(text);
    expect(log.finalText).toBe('Did the work.\nFACTORY_RESULT: shipped P1-01');
    expect(log.rawTextTail).toContain('FACTORY_RESULT: shipped P1-01');
    expect(log.costUsd).toBeNull();
  });

  it('uses the last result event when a session has several turns', () => {
    const text = [
      line({ type: 'result', subtype: 'success', is_error: false, result: 'first', total_cost_usd: 1, num_turns: 3, duration_ms: 10 }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'second', total_cost_usd: 1.5, num_turns: 5, duration_ms: 20 }),
    ].join('\n');
    expect(readSessionLog(text)).toMatchObject({ finalText: 'second', costUsd: 1.5, turns: 5, durationMs: 20 });
  });

  it('takes an error result without text from its errors list', () => {
    const text = line({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'], total_cost_usd: 3, num_turns: 50, duration_ms: 5 });
    expect(readSessionLog(text)).toMatchObject({ finalText: 'Reached max turns', isError: true, costUsd: 3 });
  });

  it("keeps the session's own error words apart", () => {
    const said = 'API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.';
    const error = line({ type: 'assistant', error: 'unknown', api_error_status: 400, parent_tool_use_id: null, message: { model: '<synthetic>', content: [{ type: 'text', text: said }] } });
    const result = line({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, terminal_reason: 'api_error', result: ` ${said} `, errors: ['Acme error'] });
    expect(readSessionLog([error, result].join('\n')).errorText).toBe(`${said}\n${said}\nAcme error`);
    // the API answered after the error, so it is not why the session ended
    const answer = line({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm9', content: [{ type: 'text', text: 'Back to ACME-1.' }] } });
    expect(readSessionLog([error, answer].join('\n')).errorText).toBe('');
    // a result that is not an error adds nothing
    const fine = line({ type: 'result', subtype: 'success', is_error: false, result: said });
    expect(readSessionLog(fine).errorText).toBe('');
    expect(readSessionLog(fixture('stream-json-shipped.jsonl')).errorText).toBe('');
    expect(readSessionLog(`Did the work.\n${said}\n`).errorText).toBe('');
  });

  describe('errorCategories', () => {
    const failure = (error, extra = {}) => line({ type: 'assistant', error, parent_tool_use_id: null, message: { id: `m-${error}`, content: [{ type: 'text', text: 'Please run /login.' }] }, ...extra });
    const answer = line({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm9', content: [{ type: 'text', text: 'Back to ACME-1.' }] } });
    it('holds the category of a main error event', () => {
      expect(readSessionLog(failure('authentication_failed')).errorCategories).toEqual(['authentication_failed']);
    });
    it('holds every category since the last real message, in order', () => {
      expect(readSessionLog([failure('rate_limit'), failure('authentication_failed')].join('\n')).errorCategories).toEqual(['rate_limit', 'authentication_failed']);
    });
    it('is empty after a later real assistant message', () => {
      expect(readSessionLog([failure('authentication_failed'), answer].join('\n')).errorCategories).toEqual([]);
    });
    it('is empty for a subagent error event', () => {
      expect(readSessionLog(failure('authentication_failed', { parent_tool_use_id: 'toolu_1' })).errorCategories).toEqual([]);
    });
    it('is empty for text or a plain line that only says the marker', () => {
      const said = 'API Error: 401 authentication_failed';
      const text = line({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: said }] } });
      expect(readSessionLog(text).errorCategories).toEqual([]);
      expect(readSessionLog(`${said}\n`).errorCategories).toEqual([]);
    });
  });

  it('copes with nothing at all', () => {
    expect(readSessionLog('')).toEqual({ finalText: '', costUsd: null, turns: null, durationMs: null, isError: null, rawTextTail: '', sessionId: null, model: null, tokens: null, errorText: '', errorCategories: [], firstTurnTokens: null });
    expect(readSessionLog(undefined).finalText).toBe('');
  });

  it("reads the session's id, model and token counts", () => {
    const log = readSessionLog(fixture('stream-json-sample.jsonl'));
    expect(log.sessionId).toBe('4947378a-6485-4e40-9357-671b81c4acf3');
    expect(log.model).toBe('claude-opus-5-5');
    expect(log.tokens).toMatchObject({ input: 2, output: 61, cacheRead: 21695, cacheWrite: 21825 });
  });

  it('has no token counts when there is no result', () => {
    const log = readSessionLog(fixture('stream-json-crash.jsonl'));
    expect(log.tokens).toBeNull();
  });

  it('takes the session id from the first event when there is no init', () => {
    const text = [line({ type: 'system', subtype: 'hook_started', session_id: 'a-b' }), line({ type: 'result', session_id: 'c-d', result: 'done' })].join('\n');
    expect(readSessionLog(text)).toMatchObject({ sessionId: 'a-b', model: null, tokens: null });
  });

  it("counts the first turn's context: input, cache writes and cache reads", () => {
    expect(readSessionLog(fixture('stream-json-sample.jsonl')).firstTurnTokens).toBe(43522);
  });

  it("skips subagents and API errors, and counts a missing part as 0", () => {
    const usage = (input_tokens, cache_creation_input_tokens, cache_read_input_tokens) => ({ input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens: 9 });
    const sub = line({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 's1', content: [], usage: usage(1, 1, 1) } });
    const error = line({ type: 'assistant', parent_tool_use_id: null, error: 'unknown', message: { id: 'e1', content: [], usage: usage(5, 5, 5) } });
    const main = line({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [], usage: usage(2, 20000, 'x') } });
    const later = line({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [], usage: usage(3, 30000, 30000) } });
    expect(readSessionLog([sub, error, main, later].join('\n')).firstTurnTokens).toBe(20002);
    const noUsage = line({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm0', content: [{ type: 'text', text: 'Acme.' }] } });
    expect(readSessionLog([noUsage, later].join('\n')).firstTurnTokens).toBe(60003);
  });

  it('has no first turn without a main assistant event with usage', () => {
    expect(readSessionLog(fixture('stream-json-crash.jsonl')).firstTurnTokens).toBeNull();
    expect(readSessionLog('Did the work.\nFACTORY_RESULT: shipped S-1\n').firstTurnTokens).toBeNull();
    const noUsage = line({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm0', content: [{ type: 'text', text: 'Acme.' }] } });
    expect(readSessionLog(noUsage).firstTurnTokens).toBeNull();
    const sub = line({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { id: 's1', content: [], usage: { input_tokens: 4 } } });
    expect(readSessionLog(sub).firstTurnTokens).toBeNull();
  });
});

describe('readInit', () => {
  const init = (id) => JSON.stringify({ type: 'system', subtype: 'init', session_id: id, plugins: [{ name: 'foreman', path: '/opt/acme/plugin' }] });

  it('finds the init event after a plain stderr line and a cut-off line', () => {
    const text = `Warning: Acme MCP server is slow\n{"type":"system","subty\n${init('a')}\n{"type":"assistant"}\n`;
    expect(readInit(text)).toMatchObject({ type: 'system', subtype: 'init', session_id: 'a', plugins: [{ name: 'foreman' }] });
  });

  it('returns the first init when there are two', () => {
    expect(readInit(`${init('first')}\n${init('second')}\n`).session_id).toBe('first');
  });

  it('skips other system events, and is null for an empty text or one with no init', () => {
    const hook = JSON.stringify({ type: 'system', subtype: 'hook_started' });
    expect(readInit(`${hook}\n${init('a')}\n`).session_id).toBe('a');
    expect(readInit('')).toBeNull();
    expect(readInit(undefined)).toBeNull();
    expect(readInit(`Plain line\n${hook}\n{"type":"assistant"}\n`)).toBeNull();
  });
});
