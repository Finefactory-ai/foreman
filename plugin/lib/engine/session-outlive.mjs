// Whether a story session has outlived its final result: its log's last event is a `result`
// carrying a known FACTORY_RESULT, no background task is open, and the log has been quiet for
// watchdog.outliveMinutes (1). The supervisor's watch() then ends the session's process group,
// and the result the session printed stands.
//
// Why: `claude -p` can print its final result and then never exit, waiting on a tool (MCP)
// server child that never closes, with no task of its own still open. Without this the slot
// stays busy until the quiet watchdog, half an hour later.
//
// A session still alive watchdog.outliveMinutes after its own `foreman story end` is ended the
// same way, even while a workflow it started is still active (endedLate): the session has
// recorded how its story ended, so nothing it still runs counts. That covers only a session with
// no final result in its log, such as one that printed nothing or whose result has a background
// task still open. A session that printed its result is left to `outlived`.
//
// Pure apart from readTail and readHead.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { lastResult, RESULTS } from './classify.mjs';

export const OUTLIVE_MINUTES = 1;

// The last `bytes` of the file, starting at a whole line; '' when it is missing or unreadable.
export function readTail(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The first `bytes` of the file, up to and including the last newline in them, so only whole
// lines; `cut` is whether the file is longer than that. { text: '', cut: false } when it is
// missing or unreadable.
export function readHead(file, bytes = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const buf = Buffer.alloc(Math.min(size, bytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.subarray(0, n).lastIndexOf(0x0a);
    return { text: nl === -1 ? '' : buf.subarray(0, nl + 1).toString('utf8'), cut: size > bytes };
  } catch {
    return { text: '', cut: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A line's JSON object, or null for anything else (stderr text, a cut-off line).
function eventOf(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// { result, story } when the tail's last event is a final result and no background task is open
// (the nearest earlier background_tasks_changed lists none), else null.
export function finalResult(tail) {
  if (!tail) return null;
  const lines = String(tail).split('\n');
  let i = lines.length - 1;
  let last = null;
  for (; i >= 0; i--) {
    last = eventOf(lines[i]);
    if (last) break;
  }
  if (!last || last.type !== 'result' || typeof last.result !== 'string') return null;
  const found = lastResult(last.result);
  if (!found) return null;
  for (i--; i >= 0; i--) {
    const e = eventOf(lines[i]);
    if (e?.type === 'system' && e.subtype === 'background_tasks_changed') {
      if (Array.isArray(e.tasks) && e.tasks.length > 0) return null;
      break;
    }
  }
  return found;
}

// { result, story, forMs } once the log has been quiet for graceMs after a final result, else null.
export function outlived({ tail, quietSince, now, graceMs }) {
  if (now - quietSince < graceMs) return null;
  const found = finalResult(tail);
  return found ? { ...found, forMs: now - quietSince } : null;
}

// { result, forMs } once this session's own `foreman story end` (the slot's result for `id`, with
// a known result and no story back in the slot) is graceMs old, else null. An endedAt that does
// not parse gives null (hung's ended-quiet still covers that session). Covers only a session with
// no final result in its log: when tailOf() (the log's tail, read only once the grace has passed)
// holds one, that is `outlived`'s case and this gives null.
export function endedLate({ slotResult, slotStory, id, now, graceMs, tailOf = () => '' }) {
  if (slotStory || !slotResult || slotResult.id !== id || !RESULTS.includes(slotResult.result)) return null;
  const at = Date.parse(slotResult.endedAt);
  if (!Number.isFinite(at)) return null;
  const forMs = now - at;
  if (forMs < graceMs) return null;
  if (finalResult(tailOf())) return null;
  return { result: slotResult.result, forMs };
}

// How long a session may outlive its final result, from watchdog.outliveMinutes.
export const outliveMs = (config) => (config?.watchdog?.outliveMinutes ?? OUTLIVE_MINUTES) * 60_000;
