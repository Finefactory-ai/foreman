import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cutEntries, fingerprint, markReport, pageOf, parseLines, transcriptReader } from './transcript.mjs';

const line = (o) => JSON.stringify(o);
const T = (n) => `2026-10-24T09:00:${String(n).padStart(2, '0')}.000Z`;
const user = (content, n = 0, extra = {}) => line({ type: 'user', timestamp: T(n), message: { role: 'user', content }, ...extra });
const asst = (content, n = 0) => line({ type: 'assistant', timestamp: T(n), message: { model: 'claude-sonnet-5-5', content } });
const text = (t) => ({ type: 'text', text: t });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content, is_error) => user([{ type: 'tool_result', tool_use_id: id, content, ...(is_error ? { is_error: true } : {}) }], 9);
const ident = (t) => t;
const opts = { root: '/acme', clean: ident };

const FIXTURE = [
  user('Build ACME-1', 1),
  line({ type: 'attachment', timestamp: T(2) }),
  '{"type":"api-request","big":"x"}',
  '{"type":"api-request-blob","big":"x"}',
  asst([{ type: 'thinking', thinking: 'hmm' }, text('I will run the tests.')], 3),
  asst([tool('t1', 'Bash', { command: 'npm test', description: 'Run the tests' })], 4),
  result('t1', [{ type: 'text', text: 'all passed' }, { type: 'image' }]),
  user('meta note', 5, { isMeta: true }),
  asst([tool('t2', 'Read', { file_path: '/acme/src/a.js' })], 6),
  result('t2', 'no such file', true),
  'plain stderr line',
  '{"type":"assistant","message":{"con',
  user('Please also add a test', 7),
];

describe('parseLines', () => {
  it('turns the lines into entries in order and skips what is not conversation', () => {
    const entries = parseLines(FIXTURE, opts);
    expect(entries.map((e) => e.kind)).toEqual(['task', 'text', 'tool', 'result', 'tool', 'result', 'user']);
    expect(entries[0]).toMatchObject({ kind: 'task', text: 'Build ACME-1', at: T(1) });
    expect(entries[1]).toMatchObject({ kind: 'text', text: 'I will run the tests.' });
    expect(entries[2]).toMatchObject({ kind: 'tool', id: 't1', name: 'Bash', says: 'Run the tests', raw: 'npm test' });
    expect(entries[3]).toMatchObject({ kind: 'result', for: 't1', error: false, text: 'all passed\n[image]' });
    expect(entries[4]).toMatchObject({ kind: 'tool', says: 'Reading src/a.js' });
    expect(JSON.parse(entries[4].raw)).toEqual({ file_path: '/acme/src/a.js' });
    expect(entries[5]).toMatchObject({ kind: 'result', for: 't2', error: true, text: 'no such file' });
    expect(entries[6]).toMatchObject({ kind: 'user', text: 'Please also add a test' });
    expect(JSON.stringify(entries)).not.toContain('hmm');
    expect(JSON.stringify(entries)).not.toContain('meta note');
  });

  it('treats a text block in a user array like a user string', () => {
    const entries = parseLines([user([{ type: 'text', text: 'the task' }]), user([{ type: 'text', text: 'more' }])], opts);
    expect(entries.map((e) => [e.kind, e.text])).toEqual([['task', 'the task'], ['user', 'more']]);
  });

  it('does not make a second task when a task was already seen', () => {
    expect(parseLines([user('later')], { ...opts, task: true })[0].kind).toBe('user');
  });

  it('keeps a missing timestamp as null', () => {
    expect(parseLines([line({ type: 'user', message: { content: 'x' } })], opts)[0].at).toBeNull();
  });

  it('redacts with clean before anything is cut, and the tool\'s words too', () => {
    const clean = (t) => t.split('acme-file-secret-123').join('•••').replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, '•••');
    const token = 'sk-ant-api03-ACMESECRETVALUE1';
    const padded = `${'a'.repeat(1990)}${token} ${'b'.repeat(100)}`;
    const entries = parseLines([user('task'), result('t1', padded), asst([tool('t3', 'Bash', { command: 'echo acme-file-secret-123', description: 'Echo acme-file-secret-123' })])], { root: '/acme', clean });
    const shown = cutEntries(entries);
    expect(shown[1].text).toHaveLength(2000);
    expect(shown[1].text).not.toContain('sk-ant');
    expect(shown[1].text).not.toContain('ACMESECRET');
    expect(shown[1].text).toContain('•••');
    expect(JSON.stringify(shown[2])).not.toContain('acme-file-secret-123');
    expect(shown[2].says).toContain('•••');
    expect(shown[2].raw).toBe('echo •••');
  });
});

describe('cutEntries', () => {
  it('cuts text at 4000, a result and a command at 2000, ending in … and saying the length', () => {
    const entries = parseLines([user('t'.repeat(5000)), asst([text('x'.repeat(5000))]), asst([tool('t1', 'Bash', { command: 'c'.repeat(3000) })]), result('t1', 'r'.repeat(5000)), user('u'.repeat(4001))], opts);
    const [task, txt, call, res, usr] = cutEntries(entries);
    expect(task.text).toHaveLength(4000);
    expect(task.text.endsWith('…')).toBe(true);
    expect(task.cut).toBe(5000);
    expect(txt.text).toHaveLength(4000);
    expect(call.raw).toHaveLength(2000);
    expect(call.cut).toBe(3000);
    expect(res.text).toHaveLength(2000);
    expect(res.cut).toBe(5000);
    expect(usr.cut).toBe(4001);
  });

  it('leaves a short text alone, with no cut field', () => {
    const [e] = cutEntries(parseLines([user('short')], opts));
    expect(e).toEqual({ kind: 'task', at: T(0), text: 'short' });
  });

  it('keeps a long text to 20000 in memory and reports its real length', () => {
    const [e] = parseLines([user('z'.repeat(50_000))], opts);
    expect(e.text).toHaveLength(20_000);
    expect(e.cut).toBe(50_000);
    expect(cutEntries([e])[0].cut).toBe(50_000);
  });
});

describe('markReport', () => {
  const entries = () => parseLines([user('task'), asst([text('first')]), asst([text('the final words '.repeat(500))]), result('t', 'x')], opts);

  it('marks the last text when the agent is not running, and keeps it to 20000', () => {
    const marked = markReport(entries(), false);
    expect(marked.map((e) => e.report === true)).toEqual([false, false, true, false]);
    const [, , rep] = cutEntries(marked);
    expect(rep.text.length).toBeGreaterThan(4000);
    expect(rep.cut).toBeUndefined();
  });

  it('marks a StructuredOutput call, with its input as the text', () => {
    const e = parseLines([user('task'), asst([text('before')]), asst([tool('s1', 'StructuredOutput', { complete: true, summary: 'Done' })])], opts);
    const marked = markReport(e, false);
    expect(marked[2]).toMatchObject({ kind: 'tool', report: true });
    expect(JSON.parse(marked[2].text)).toEqual({ complete: true, summary: 'Done' });
    expect(marked[1].report).toBeUndefined();
  });

  it('marks nothing while the agent runs, and does not change the entries it is given', () => {
    const e = entries();
    expect(markReport(e, true).some((x) => x.report)).toBe(false);
    markReport(e, false);
    expect(e.some((x) => x.report)).toBe(false);
  });

  it('marks nothing when there is no text', () => {
    expect(markReport(parseLines([user('task')], opts), false).some((x) => x.report)).toBe(false);
  });
});

describe('pageOf', () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ kind: 'text', text: `e${i}` }));

  it('gives the last 200 by default', () => {
    const p = pageOf(many, {});
    expect(p).toMatchObject({ total: 450, first: 250 });
    expect(p.entries).toHaveLength(200);
    expect(p.entries[0]).toMatchObject({ i: 250, text: 'e250' });
    expect(p.entries[199].i).toBe(449);
  });

  it('gives what comes after an index', () => {
    const p = pageOf(many, { after: 440 });
    expect(p.entries.map((e) => e.i)).toEqual([441, 442, 443, 444, 445, 446, 447, 448, 449]);
    expect(p.first).toBe(441);
    expect(pageOf(many, { after: 0 }).entries).toHaveLength(200);
    const none = pageOf(many, { after: 449 });
    expect(none).toEqual({ total: 450, first: 450, entries: [] });
    expect(pageOf(many, { after: 9999 })).toEqual({ total: 450, first: 450, entries: [] });
  });

  it('gives up to 200 before an index', () => {
    const p = pageOf(many, { before: 250 });
    expect(p.first).toBe(50);
    expect(p.entries.map((e) => e.i)).toEqual(Array.from({ length: 200 }, (_, i) => 50 + i));
    expect(pageOf(many, { before: 10 }).entries).toHaveLength(10);
    expect(pageOf(many, { before: 0 })).toEqual({ total: 450, first: 450, entries: [] });
  });

  it('handles an empty list and a short one', () => {
    expect(pageOf([], {})).toEqual({ total: 0, first: 0, entries: [] });
    expect(pageOf(many.slice(0, 3), {}).first).toBe(0);
  });

  it('takes another limit', () => {
    expect(pageOf(many, {}, 5).entries.map((e) => e.i)).toEqual([445, 446, 447, 448, 449]);
  });
});

describe('transcriptReader', () => {
  let dir;
  let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-transcript-'));
    file = join(dir, 'agent-a1.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const reader = (extra) => transcriptReader({ root: '/acme', ...extra });

  it('reads a file into entries', () => {
    writeFileSync(file, `${FIXTURE.join('\n')}\n`);
    const r = reader().read(file, ident, 'fp');
    expect(r.entries.map((e) => e.kind)).toEqual(['task', 'text', 'tool', 'result', 'tool', 'result', 'user']);
    expect(r.skipped).toBeFalsy();
  });

  it('reads only what was appended, and finishes a half-written last line', () => {
    const lines = [user('Task'), asst([text('one')]), asst([text('two')])];
    const whole = lines.join('\n');
    const cut = whole.length - 10;
    writeFileSync(file, whole.slice(0, cut));
    const rd = reader();
    const first = rd.read(file, ident, 'fp').entries;
    expect(first).toHaveLength(2);
    appendFileSync(file, `${whole.slice(cut)}\n${asst([text('three')])}\n`);
    const second = rd.read(file, ident, 'fp').entries;
    expect(second).toHaveLength(4);
    expect(second.slice(0, 2)).toEqual(first);
    expect(second.map((e) => e.text)).toEqual(['Task', 'one', 'two', 'three']);
    expect(second[0].kind).toBe('task');
  });

  it('does not make a second task out of an appended user line', () => {
    writeFileSync(file, `${user('Task')}\n`);
    const rd = reader();
    rd.read(file, ident, 'fp');
    appendFileSync(file, `${user('Later')}\n`);
    expect(rd.read(file, ident, 'fp').entries.map((e) => e.kind)).toEqual(['task', 'user']);
  });

  it('reads only the new bytes when a file grows', () => {
    writeFileSync(file, `${user('Task')}\n`);
    const reads = [];
    const rd = reader({ onRead: (from, to) => reads.push([from, to]) });
    rd.read(file, ident, 'fp');
    const size = reads[0][1];
    appendFileSync(file, `${asst([text('more')])}\n`);
    rd.read(file, ident, 'fp');
    expect(reads[1][0]).toBe(size);
  });

  it('reads the file again when it shrank, was replaced, or the redactor changed', () => {
    writeFileSync(file, `${user('Task')}\n${asst([text('secret-one')])}\n`);
    const clean = (secret) => (t) => t.split(secret).join('•••');
    const rd = reader();
    expect(rd.read(file, clean('secret-one'), 'fp1').entries[1].text).toBe('•••');
    // a different key list: the same file is parsed again with the new redactor
    expect(rd.read(file, clean('nothing'), 'fp2').entries[1].text).toBe('secret-one');
    // shorter file
    writeFileSync(file, `${user('New task')}\n`);
    expect(rd.read(file, ident, 'fp2').entries.map((e) => e.text)).toEqual(['New task']);
    // replaced by a new file of the same name
    rmSync(file);
    writeFileSync(file, `${user('Other')}\n${asst([text('x'.repeat(50))])}\n`);
    expect(rd.read(file, ident, 'fp2').entries.map((e) => e.text)).toEqual(['Other', 'x'.repeat(50)]);
  });

  it('reads the file again when it was rewritten in place with content that is not shorter', () => {
    // Same inode, same redactor, size not smaller: the file looks grown, but its start changed.
    // Linux hands a deleted file's inode to the next file at once, so a replaced transcript
    // looks the same way; this rewrite shows it on every system.
    writeFileSync(file, `${user('Task')}\n${asst([text('one')])}\n`);
    const rd = reader();
    expect(rd.read(file, ident, 'fp').entries.map((e) => e.text)).toEqual(['Task', 'one']);
    writeFileSync(file, `${user('Tusk')}\n${asst([text('two')])}\n`);
    expect(rd.read(file, ident, 'fp').entries.map((e) => e.text)).toEqual(['Tusk', 'two']);
    writeFileSync(file, `${user('Tusk')}\n${asst([text('two')])}\n${asst([text('three')])}\n`);
    expect(rd.read(file, ident, 'fp').entries.map((e) => e.text)).toEqual(['Tusk', 'two', 'three']);
  });

  it('keeps a multi-byte character that is split across two reads', () => {
    const l = asst([text('héllo wörld ✓')]);
    const buf = Buffer.from(`${user('Task')}\n${l}\n`);
    const at = buf.indexOf(Buffer.from('é')) + 1;
    writeFileSync(file, buf.subarray(0, at));
    const rd = reader();
    rd.read(file, ident, 'fp');
    appendFileSync(file, buf.subarray(at));
    expect(rd.read(file, ident, 'fp').entries[1].text).toBe('héllo wörld ✓');
  });

  it('refuses a symlink and anything that is not a regular file', () => {
    writeFileSync(file, `${user('Task')}\n`);
    const link = join(dir, 'link.jsonl');
    symlinkSync(file, link);
    const rd = reader();
    expect(() => rd.read(link, ident, 'fp')).toThrow();
    mkdirSync(join(dir, 'folder'));
    expect(() => rd.read(join(dir, 'folder'), ident, 'fp')).toThrow();
    expect(() => rd.read(join(dir, 'missing.jsonl'), ident, 'fp')).toThrow();
  });

  it('reads only the end of a file over the limit and says it skipped', () => {
    const lines = Array.from({ length: 20 }, (_, i) => asst([text(`line-${i}-${'p'.repeat(60)}`)]));
    writeFileSync(file, `${lines.join('\n')}\n`);
    const rd = reader({ limit: 1500 });
    const r = rd.read(file, ident, 'fp');
    expect(r.skipped).toBe(true);
    expect(r.entries.length).toBeLessThan(20);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.entries.at(-1).text.startsWith('line-19-')).toBe(true);
    for (const e of r.entries) expect(e.text).toMatch(/^line-\d+-p{60}$/);
    appendFileSync(file, `${asst([text('line-20')])}\n`);
    const again = rd.read(file, ident, 'fp');
    expect(again.skipped).toBe(true);
    expect(again.entries.at(-1).text).toBe('line-20');
  });

  it('keeps at most 8 files, dropping the one used longest ago', () => {
    const reads = [];
    const rd = reader({ onRead: (from) => reads.push(from) });
    const files = Array.from({ length: 9 }, (_, i) => {
      const f = join(dir, `agent-f${i}.jsonl`);
      writeFileSync(f, `${user(`Task ${i}`)}\n`);
      return f;
    });
    for (const f of files) rd.read(f, ident, 'fp');
    expect(reads).toHaveLength(9);
    reads.length = 0;
    rd.read(files[8], ident, 'fp');
    rd.read(files[1], ident, 'fp');
    expect(reads).toEqual([]);
    rd.read(files[0], ident, 'fp');
    expect(reads).toEqual([0]);
  });
});

describe('fingerprint', () => {
  it('changes with the secret list, whatever its order', () => {
    expect(fingerprint(['a', 'b'])).toBe(fingerprint(['b', 'a']));
    expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['a', 'c']));
    expect(fingerprint([])).toMatch(/^[0-9a-f]{64}$/);
  });
});
