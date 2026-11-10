// A Claude Code transcript (one JSON event per line, the files session-files.mjs finds) turned
// into the entries the command centre's conversation view draws. Pure except for the reader.
//
//   parseLines(lines, { root, clean, task })
//                    entries { kind, at, ... } in order: task (the first user text), user, text
//                    (an assistant's words), tool { id, name, says, raw } (says in plain words,
//                    raw the command or the input as JSON) and result { for, error, text }.
//                    Thinking, attachments, api-request lines, meta lines and lines that do not
//                    parse are left out. clean(text) is the redactor and runs on every text
//                    before it is cut; a text over 20000 characters is kept to 20000 with
//                    `cut: <its real length>`. task says a task was already seen.
//   markReport(entries, running)
//                    a copy where, for an agent that is not running, the last text (or the last
//                    StructuredOutput call, whose `text` is then its input as JSON) has
//                    report: true
//   cutEntries(entries)
//                    what is sent: task, text and user cut at 4000 characters, result and raw at
//                    2000, a cut text ending in … and the entry carrying `cut: <real length>`; a
//                    report keeps its 20000
//   pageOf(entries, { after, before }, limit = 200)
//                    { total, first, entries }: the last `limit` entries, or those after / before
//                    an index; each carries its index `i`, first being the first one's (total when
//                    none)
//   fingerprint(values)
//                    sha256 of the secret values, sorted and joined with \0: a change in the key
//                    files re-parses a cached file
//   transcriptReader({ root, limit, size, onRead })
//                    .read(path, clean, fp) -> { entries, skipped }: reads a regular file (never a
//                    symlink; throws for anything else) incrementally. An LRU cache of 8 files
//                    holds each one's parsed entries and the unfinished last line, so a file that
//                    grew is read from where it stopped, and one that shrank, was replaced, was
//                    rewritten (the last bytes already read are compared first: a new file can
//                    get a deleted file's inode) or was parsed with another `fp` is read again.
//                    A file over `limit` (64 MB) is read
//                    from its last `limit` bytes, the first partial line dropped, with
//                    skipped: true. onRead(from, to) is called for each read (for tests).

import { createHash } from 'node:crypto';

const TAIL = 64;
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { plainWords } from './state.mjs';

const KEEP = 20_000;
const CUTS = { task: 4000, text: 4000, user: 4000, result: 2000, raw: 2000 };
const LIMIT = 64 * 1024 * 1024;
const CACHE = 8;

// A text kept to `n` characters, ending in … when it was cut.
const cutText = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// The redacted text, kept to KEEP; the entry remembers a longer original's length.
function kept(clean, value) {
  const text = clean(String(value ?? ''));
  return text.length > KEEP ? { text: cutText(text, KEEP), cut: text.length } : { text };
}

const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c?.type === 'image' ? '[image]' : typeof c?.text === 'string' ? c.text : '')).join('\n');
};

export function parseLines(lines, { root, clean = (t) => t, task = false } = {}) {
  const entries = [];
  let seenTask = task;
  const push = (entry) => entries.push(entry);
  for (const l of lines) {
    if (typeof l !== 'string' || !l.startsWith('{') || l.startsWith('{"type":"api-request')) continue;
    let event;
    try {
      event = JSON.parse(l);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || event.isMeta === true) continue;
    const at = event.timestamp ?? null;
    const content = event.message?.content;
    if (event.type === 'user') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          push({ kind: seenTask ? 'user' : 'task', at, ...kept(clean, b.text) });
          seenTask = true;
        } else if (b?.type === 'tool_result') {
          push({ kind: 'result', at, for: b.tool_use_id ?? null, error: b.is_error === true, ...kept(clean, resultText(b.content)) });
        }
      }
    } else if (event.type === 'assistant') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          push({ kind: 'text', at, ...kept(clean, b.text) });
        } else if (b?.type === 'tool_use') {
          const input = b.input && typeof b.input === 'object' ? b.input : {};
          const raw = b.name === 'Bash' && typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2);
          const { text, cut } = kept(clean, raw);
          push({ kind: 'tool', at, id: b.id ?? null, name: b.name ?? null, says: clean(plainWords(b.name, input, root)), raw: text, ...(cut ? { cut } : {}) });
        }
      }
    }
  }
  return entries;
}

export function markReport(entries, running) {
  if (running) return entries.slice();
  let at = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'text' || (e.kind === 'tool' && e.name === 'StructuredOutput')) {
      at = i;
      break;
    }
  }
  const out = entries.slice();
  if (at === -1) return out;
  const { raw, ...rest } = out[at];
  out[at] = out[at].kind === 'tool' ? { ...rest, text: raw, report: true } : { ...out[at], report: true };
  return out;
}

export function cutEntries(entries) {
  return entries.map((e) => {
    if (e.report) return e;
    const field = e.kind === 'tool' ? 'raw' : 'text';
    const cap = CUTS[e.kind === 'tool' ? 'raw' : e.kind];
    const value = e[field];
    if (typeof value !== 'string' || value.length <= cap) return e;
    return { ...e, [field]: cutText(value, cap), cut: e.cut ?? value.length };
  });
}

export function pageOf(entries, { after, before } = {}, limit = 200) {
  const total = entries.length;
  let start;
  let end;
  if (after !== undefined) {
    start = Math.min(total, after + 1);
    end = Math.min(total, start + limit);
  } else if (before !== undefined) {
    end = Math.min(total, before);
    start = Math.max(0, end - limit);
  } else {
    end = total;
    start = Math.max(0, total - limit);
  }
  const page = entries.slice(start, end).map((e, k) => ({ ...e, i: start + k }));
  return { total, first: page.length ? start : total, entries: page };
}

export const fingerprint = (values) => createHash('sha256').update([...values].sort().join('\0')).digest('hex');

export function transcriptReader({ root, limit = LIMIT, size = CACHE, onRead } = {}) {
  const cache = new Map();

  // The last bytes read of a cached file still end it: a file rewritten in place, or a new file
  // that got the deleted one's inode, fails this and is read from the start.
  const sameTail = (path, was) => was.tail.length === 0 || bytes(path, was.size - was.tail.length, was.size, false).equals(was.tail);

  // bytes [from, to) of the file as a Buffer, however many reads that takes. A check read
  // (report false) is not reported to onRead.
  function bytes(path, from, to, report = true) {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(to - from);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      if (report) onRead?.(from, from + got);
      return buf.subarray(0, got);
    } finally {
      closeSync(fd);
    }
  }

  function read(path, clean, fp) {
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error('Not a regular file.');
    const was = cache.get(path);
    let from = 0;
    let c;
    if (was && was.ino === st.ino && was.fp === fp && st.size >= was.size && st.size - was.size <= limit && sameTail(path, was)) {
      c = was;
      from = was.size;
    } else {
      c = { ino: st.ino, size: 0, rest: Buffer.alloc(0), entries: [], fp, skipped: false, tail: Buffer.alloc(0) };
    }
    let data;
    if (from === 0 && st.size > limit) {
      // Too big: the last `limit` bytes, from the start of their first whole line.
      const tail = bytes(path, st.size - limit, st.size);
      const nl = tail.indexOf(0x0a);
      data = nl === -1 ? Buffer.alloc(0) : tail.subarray(nl + 1);
      c.skipped = true;
      c.size = st.size - limit + tail.length;
      c.tail = tail.subarray(-TAIL);
    } else if (st.size > from) {
      const chunk = bytes(path, from, st.size);
      data = Buffer.concat([c.rest, chunk]);
      c.size = from + chunk.length;
      c.tail = Buffer.concat([c.tail, chunk]).subarray(-TAIL);
    } else {
      data = c.rest;
    }
    // Whole lines now; the unfinished last one waits for the rest of it.
    const lastNl = data.lastIndexOf(0x0a);
    const complete = lastNl === -1 ? Buffer.alloc(0) : data.subarray(0, lastNl);
    c.rest = lastNl === -1 ? data : data.subarray(lastNl + 1);
    if (complete.length) {
      // The task is the first user text; a file read from its end has lost it.
      const task = c.skipped || c.entries.some((e) => e.kind === 'task');
      const more = parseLines(complete.toString('utf8').split('\n'), { root, clean, task });
      c.entries = c.entries.concat(more);
    }
    cache.delete(path);
    cache.set(path, c);
    while (cache.size > size) cache.delete(cache.keys().next().value);
    return { entries: c.entries, skipped: c.skipped };
  }

  return { read };
}
