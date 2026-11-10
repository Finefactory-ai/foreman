// Reads the log of one story session. Sessions run `claude -p --output-format stream-json
// --verbose`, so the log is one JSON event per line, with the odd plain line (a warning on
// stderr) in between. Pure: text in, facts out.
//
//   finalText    the final `result` event's `result` (or its `errors`); without one (the session
//                died mid-run), the text of the main conversation's last assistant message; for
//                a log with no JSON at all, the whole text
//   costUsd      `total_cost_usd`, turns `num_turns`, durationMs `duration_ms`, isError
//                `is_error`, all from the last result event, or null
//   rawTextTail  the readable end of the session for classify.mjs: plain lines, the main
//                conversation's text, and API errors written as `API Error: <status> <category>`
//   sessionId    the init event's `session_id`, else the first event's, or null
//   model        the init event's `model`, or null
//   tokens       the last result event's token counts (tokens.mjs resultTokens: modelUsage,
//                which counts the subagents, else usage), or null with no result or no usage
//   errorText    the session's own error words and nothing from the conversation: the text of the
//                main conversation's assistant events made from an API error (`error` set) since
//                its last real message, then the last result event's `result` and `errors` when
//                it is an error; one per line, '' for a log with no JSON or no error
//   errorCategories  the `error` category of each of those same events (main conversation, made
//                from an API error, since its last real message), in order, e.g.
//                ['authentication_failed']; [] for a log with no JSON or no such event. classify.mjs
//                reads a sign-in that stopped working from it, not from the words in the log
//   firstTurnTokens  the context of the session's first turn: input_tokens +
//                cache_creation_input_tokens + cache_read_input_tokens of the first main
//                conversation assistant event that is not an API error and has a usage object
//                (a part that is missing or not a number counts 0), or null with no such event
//
// readInit(text) is the first {type:'system', subtype:'init'} event in the text (the parsed
// object), or null; the supervisor reads which plugins a session loaded from it.
//
// The event shapes (code.claude.com/docs/en/headless, agent-sdk/typescript; checked against a
// real run in test/fixtures/stream-json-sample.jsonl):
//   {type:'assistant', message:{id, content:[{type:'text', text}|...], usage}, parent_tool_use_id,
//      error?}  one event per content block; `error` is set on a message made from an API error
//   {type:'system', subtype:'init', session_id, model}   first; every event carries session_id
//   {type:'system', subtype:'api_retry', error_status, error}   before each retry
//   {type:'rate_limit_event', rate_limit_info:{status, resetsAt}}
//   {type:'result', subtype, is_error, api_error_status?, result?, errors?, total_cost_usd,
//      num_turns, duration_ms, usage, modelUsage}
// Subagent messages carry a parent_tool_use_id and tool results come back as `user` events;
// neither is the session's own voice, so neither is read (a tool's output may well mention
// "rate limit" or a FACTORY_RESULT of some other story).

import { resultTokens } from './tokens.mjs';

const TAIL_LINES = 200;

const parse = (line) => {
  if (!line.startsWith('{')) return null;
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object' && typeof event.type === 'string' ? event : null;
  } catch {
    return null; // a line cut off by a crash
  }
};

const textOf = (message) =>
  (Array.isArray(message?.content) ? message.content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string' && c.text.trim())
    .map((c) => c.text.trim());

const apiError = (status, category) => `API Error: ${status ?? '-'} ${category ?? 'unknown'}`;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const contextOf = (usage) => ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (num(usage[k]) ?? 0), 0);

// The first {type:'system', subtype:'init'} event in the text; lines cut off or not JSON are
// skipped. null when there is none.
export function readInit(text) {
  for (const raw of String(text ?? '').split('\n')) {
    const event = parse(raw.trim());
    if (event?.type === 'system' && event.subtype === 'init') return event;
  }
  return null;
}

export function readSessionLog(text) {
  const lines = String(text ?? '').split('\n');
  const tail = []; // readable lines, in order
  let pending = []; // API trouble since the last assistant message
  let errorTexts = []; // the words of the main conversation's error messages since the last real one
  let errorCategories = []; // the `error` of those same messages, in order
  let sawJson = false;
  let result = null;
  let lastMain = null; // { id, texts } of the main conversation's last message with text
  let init = null;
  let firstId = null; // the first event's session_id
  let first = true;
  let firstTurnTokens = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const event = parse(line);
    if (!event) {
      tail.push(line);
      continue;
    }
    sawJson = true;
    if (first) firstId = typeof event.session_id === 'string' && event.session_id ? event.session_id : null;
    first = false;
    if (event.type === 'system' && event.subtype === 'init' && !init) init = event;
    if (event.type === 'assistant') {
      // A real message means the API answered: earlier retries are not why the session ended.
      // A message made from an API error is not an answer.
      if (!event.error) {
        pending = [];
        errorTexts = [];
        errorCategories = [];
      }
      if (event.parent_tool_use_id) continue;
      if (firstTurnTokens === null && !event.error && isObject(event.message?.usage)) firstTurnTokens = contextOf(event.message.usage);
      const texts = textOf(event.message);
      if (event.error) {
        errorTexts.push(...texts);
        errorCategories.push(String(event.error));
      }
      const id = event.message?.id ?? null;
      if (texts.length) {
        if (lastMain && id && lastMain.id === id) lastMain.texts.push(...texts);
        else lastMain = { id, texts: [...texts] };
        tail.push(...texts);
      }
      if (event.error) tail.push(apiError(null, event.error));
    } else if (event.type === 'system' && event.subtype === 'api_retry') {
      pending.push(apiError(event.error_status, event.error));
    } else if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') {
      const at = num(event.rate_limit_info.resetsAt);
      pending.push(`Rate limit reached${at ? ` (resets at ${new Date(at * 1000).toISOString()})` : ''}`);
    } else if (event.type === 'result') {
      result = event;
      const said = typeof event.result === 'string' ? event.result.trim() : '';
      if (said) tail.push(said);
      if (Array.isArray(event.errors)) tail.push(...event.errors.map(String));
      if (event.is_error && event.api_error_status) tail.push(apiError(event.api_error_status, 'error'));
    }
  }
  tail.push(...pending);

  let finalText = '';
  if (result) {
    if (typeof result.result === 'string') finalText = result.result.trim();
    else if (Array.isArray(result.errors)) finalText = result.errors.map(String).join('\n').trim();
  }
  if (!finalText && lastMain) finalText = lastMain.texts.join('\n\n');
  if (!finalText && !sawJson) finalText = String(text ?? '').trim();

  if (result?.is_error === true) {
    const said = typeof result.result === 'string' ? result.result.trim() : '';
    if (said) errorTexts.push(said);
    if (Array.isArray(result.errors)) errorTexts.push(...result.errors.map(String));
  }

  return {
    finalText,
    costUsd: num(result?.total_cost_usd),
    turns: num(result?.num_turns),
    durationMs: num(result?.duration_ms),
    isError: typeof result?.is_error === 'boolean' ? result.is_error : null,
    rawTextTail: tail.join('\n').split('\n').slice(-TAIL_LINES).join('\n'),
    sessionId: typeof init?.session_id === 'string' && init.session_id ? init.session_id : firstId,
    model: typeof init?.model === 'string' && init.model ? init.model : null,
    tokens: result ? resultTokens(result) : null,
    errorText: sawJson ? errorTexts.join('\n') : '',
    errorCategories: sawJson ? errorCategories : [],
    firstTurnTokens,
  };
}
