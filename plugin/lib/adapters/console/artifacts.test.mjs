import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleContract } from './contract.mjs';
import { pendingNotes } from '../../engine/story-notes-queue.mjs';
import { cleanControl, create, findReply, parseReply } from './artifacts.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-artifacts-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CC = 'https://pages.example/artifact/cc';
const DP = 'https://pages.example/artifact/dp';
const options = { adapter: 'artifacts', commandCenterUrl: CC, decisionsUrl: DP };
const config = { slots: 3, stories: { adapter: 'markdown', idPattern: 'P\\d+[a-z]?-\\d+' } };
const now = () => new Date('2026-10-15T09:08:07Z');

// What `claude -p --output-format json` prints: maybe a warning line, then one JSON line.
const stdoutOf = (text) => `warning: something\n${JSON.stringify({ type: 'result', result: text })}\n`;

// A fake claude: records each call, confirms every outbox step it was shown, and answers
// with `reply` (an object, merged over a good reply) or `text` (sent as is).
function fakeClaude({ reply = {}, text = null, status = 0, decisions = null } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const prompt = args[args.indexOf('-p') + 1];
    const out = prompt.match(/out_dir "([^"]+)"/)?.[1];
    if (decisions && out) {
      for (const [collection, docs] of Object.entries(decisions)) {
        mkdirSync(join(out, collection), { recursive: true });
        for (const [id, doc] of Object.entries(docs)) writeFileSync(join(out, collection, `${id}.json`), JSON.stringify(doc));
      }
    }
    const outbox = [...prompt.matchAll(/\(outbox ([^)]+)\)/g)].map((m) => m[1]);
    const body = text ?? JSON.stringify({ set: 7, problem: '', control: {}, outbox, ...reply });
    return { status, stdout: stdoutOf(body), stderr: '' };
  };
  return { run, calls };
}

const make = (fake = fakeClaude(), extra = {}) => create({ ...options, ...extra }, { stateDir: dir, now, config, spawnSync: fake.run });

consoleContract({ name: 'artifacts', make: () => make() });

describe('the reply parser', () => {
  const good = { set: 12, problem: '', control: { paused: true } };
  const line = JSON.stringify(good);

  it('reads a plain one-line reply', () => {
    expect(parseReply(stdoutOf(line))).toEqual(good);
  });
  it('reads a reply wrapped in a json code fence', () => {
    expect(parseReply(stdoutOf(`\`\`\`json\n${line}\n\`\`\``))).toEqual(good);
  });
  it('reads a reply inside prose', () => {
    expect(parseReply(stdoutOf(`All three steps worked. Here is the result: ${line} Let me know if you need more.`))).toEqual(good);
  });
  it('reads a reply spread over several lines', () => {
    expect(parseReply(stdoutOf(`Done.\n\n\`\`\`\n${JSON.stringify(good, null, 2)}\n\`\`\`\n`))).toEqual(good);
  });
  it('takes the last object with a set key, not a nested one or an earlier one', () => {
    const text = `First try: {"set": 1, "problem": "", "control": {}}\nThen: {"set": 2, "problem": "", "control": {"set": "x"}}`;
    expect(parseReply(stdoutOf(text))).toEqual({ set: 2, problem: '', control: { set: 'x' } });
  });
  it('keeps braces inside strings', () => {
    expect(findReply('{"set": null, "problem": "refused: {weird} }", "control": {}}')).toEqual({ set: null, problem: 'refused: {weird} }', control: {} });
  });
  it('returns null when there is no such object', () => {
    expect(parseReply(stdoutOf('I could not do that.'))).toBe(null);
    expect(parseReply(stdoutOf('{"control": {}}'))).toBe(null);
    expect(parseReply(stdoutOf('{"set": 3, "problem": '))).toBe(null);
    expect(parseReply('')).toBe(null);
    expect(parseReply('not json at all\n')).toBe(null);
  });

  // A real sync.log keeps the first 300 characters of each answer it could not read
  // (read, never edited, for this fixture). Every line holding a whole reply must parse now.
  it('parses every recorded reply that holds a complete object', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const lines = readFileSync(join(here, '../../../../test/fixtures/sync-replies.txt'), 'utf8').split('\n').filter(Boolean);
    const answers = lines.map((l) => l.replace(/^\S+ no readable answer: /, ''));
    const parsed = answers.map((a) => parseReply(stdoutOf(a))).filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(parsed).toHaveLength(4);
    expect(parsed.map((r) => r.set)).toEqual([33, 252, 266, 902]);
    expect(parsed[3].control).toMatchObject({ workers: 2, fixedAt: '2026-10-15T11:20:13.356Z' });
  });
});

describe('cleanControl', () => {
  const opts = { slots: 3, idPattern: 'P\\d+[a-z]?-\\d+' };

  it('keeps the fields the factory understands', () => {
    const c = cleanControl(
      {
        paused: true,
        nextStory: 'P7-01',
        requestedAt: 'R',
        workers: 2,
        workersAt: 'WA',
        fixedAt: 'F',
        resumeAt: 'Q',
        slots: { w1: { action: 'resume', at: 'A' } },
        handBack: { id: 'P7-02', at: 'H' },
        extra: 'ignored',
      },
      opts,
    );
    expect(c).toEqual({
      paused: true,
      nextStory: 'P7-01',
      requestedAt: 'R',
      workers: 2,
      workersAt: 'WA',
      fixedAt: 'F',
      resumeAt: 'Q',
      slots: { w1: { action: 'resume', at: 'A' } },
      handBack: { id: 'P7-02', at: 'H' },
    });
  });

  it('drops unknown slots, unknown actions, bad worker counts and bad ids', () => {
    const c = cleanControl({ workers: 7, slots: { w9: { action: 'resume', at: 'A' }, w2: { action: 'explode', at: 'B' }, w3: { action: 'skip' } }, handBack: { id: 'drop table', at: 'H' } }, opts);
    expect(c.workers).toBe(null);
    expect(c.slots).toEqual({});
    expect(c.handBack).toBe(null);
  });

  it('copes with nothing at all', () => {
    expect(cleanControl(undefined, opts)).toMatchObject({ paused: false, nextStory: null, workers: null, slots: {}, fixedAt: null, handBack: null });
  });

  it('follows the configured slot count', () => {
    const raw = { workers: 5, slots: { w5: { action: 'park', at: 'A' } } };
    expect(cleanControl(raw, { ...opts, slots: 8 })).toMatchObject({ workers: 5, slots: { w5: { action: 'park', at: 'A' } } });
    expect(cleanControl(raw, { ...opts, slots: 3 })).toMatchObject({ workers: null, slots: {} });
  });

  it("checks a hand-back id against the story source's pattern, whole", () => {
    const back = (id) => cleanControl({ handBack: { id, at: 'H' } }, { slots: 3, idPattern: '[A-Z]+-\\d+' }).handBack;
    expect(back('ABC-12')).toEqual({ id: 'ABC-12', at: 'H' });
    expect(back('P7-02')).toBe(null);
    expect(back('xABC-12')).toBe(null);
    expect(back('ABC-12; rm')).toBe(null);
  });
});

describe('artifacts console', () => {
  it('refuses unknown options, missing urls and a missing state folder', () => {
    expect(() => create({ ...options, port: 1 }, { stateDir: dir })).toThrow(/port/);
    expect(() => create({ adapter: 'artifacts', decisionsUrl: DP }, { stateDir: dir })).toThrow(/commandCenterUrl/);
    expect(() => create({ adapter: 'artifacts', commandCenterUrl: CC }, { stateDir: dir })).toThrow(/decisionsUrl/);
    expect(() => create(options, {})).toThrow(/stateDir/);
    expect(() => create({ ...options, everySeconds: 'often' }, { stateDir: dir })).toThrow(/everySeconds/);
  });

  it('a push is one headless claude call in safe mode, with ArtifactData and the VS Code entrypoint', async () => {
    const fake = fakeClaude();
    await make(fake, { model: 'sonnet' }).publish({ loop: { state: 'running' }, slots: [] });
    expect(fake.calls).toHaveLength(1);
    const { cmd, args, opts } = fake.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--safe-mode', '--output-format', 'json', 'ArtifactData']));
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(opts.env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-vscode');
    const prompt = args[1];
    expect(prompt).toContain(CC);
    expect(prompt).toContain(DP);
    expect(JSON.parse(readFileSync(join(dir, 'sync', 'status.json'), 'utf8'))).toEqual({ loop: { state: 'running' }, slots: [] });
  });

  it("writes the page's controls, cleaned, to control.json", async () => {
    const fake = fakeClaude({ reply: { control: { paused: true, workers: 9, handBack: { id: 'P3-04', at: 'H' }, junk: 1 } } });
    const con = make(fake);
    await con.publish({ slots: [] });
    expect(await con.controls()).toMatchObject({ paused: true, workers: null, handBack: { id: 'P3-04', at: 'H' } });
    expect((await con.controls()).junk).toBeUndefined();
  });

  it('a refused write rejects with the reason and leaves the controls alone', async () => {
    const fake = fakeClaude({ reply: { set: null, problem: 'Permission for this tool use was denied.' } });
    await expect(make(fake).publish({ slots: [] })).rejects.toThrow(/Permission for this tool use was denied/);
    expect(existsSync(join(dir, 'control.json'))).toBe(false);
    expect(readFileSync(join(dir, 'sync.log'), 'utf8')).toMatch(/write refused/);
  });

  it('an unreadable reply or a failed call rejects and is logged', async () => {
    await expect(make(fakeClaude({ text: 'Sorry, I could not.' })).publish({ slots: [] })).rejects.toThrow(/no readable answer/);
    await expect(make(fakeClaude({ status: 1 })).publish({ slots: [] })).rejects.toThrow(/exit 1/);
    expect(readFileSync(join(dir, 'sync.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('copies the decisions page on the first push, then every ten minutes', async () => {
    const fake = fakeClaude({ decisions: { items: { 'd-a': { kind: 'task', title: 'Add the key', story: 'P1-01', input: 'optional', order: 1 } }, answers: {} } });
    const con = make(fake);
    await con.publish({ slots: [] });
    expect(fake.calls[0].args[1]).toContain('collection "answers"');
    expect(readdirSync(join(dir, 'sync', 'decisions', 'items'))).toEqual(['d-a.json']);
    expect(JSON.parse(readFileSync(join(dir, 'sync', 'decisions', 'checked.json'), 'utf8')).at).toBeTruthy();
    await con.publish({ slots: [] });
    expect(fake.calls[1].args[1]).not.toContain('collection "answers"');
  });

  it('decisions.add also queues one decision note for the story', async () => {
    const con = make();
    const id = await con.decisions.add({ story: 'P1-01', kind: 'decision', title: 'Pick one', options: ['A', 'B'], body: 'why', summary: 'Pick one.', hints: ['Only A.', 'Only B.'], recommend: 'A' });
    const notes = pendingNotes(dir);
    expect(notes).toHaveLength(1);
    expect(notes[0].entry).toMatchObject({ story: 'P1-01', kind: 'decision', data: { id, title: 'Pick one', summary: 'Pick one.', options: ['A', 'B'], hints: ['Only A.', 'Only B.'], recommend: 'A' } });
    expect(JSON.stringify(notes[0].entry)).not.toContain('why');
  });

  it("decide answer is the page's job", async () => {
    await expect(make().decisions.answer('d-a', { option: 'A' })).rejects.toThrow(/answer on the decisions page/i);
  });
});

describe('the outbox', () => {
  const outbox = () => (existsSync(join(dir, 'sync', 'outbox')) ? readdirSync(join(dir, 'sync', 'outbox')).sort() : []);
  const ops = () => outbox().map((f) => JSON.parse(readFileSync(join(dir, 'sync', 'outbox', f), 'utf8')));

  it('decisions.add and applied queue operations, in order', async () => {
    const con = make();
    const id = await con.decisions.add({ story: 'P1-01', kind: 'decision', title: 'Pick one', options: ['A', 'B'], urgent: true, body: 'why' });
    await con.decisions.applied('d-older');
    expect(outbox().every((f) => /^\d{17}-[0-9a-f]+\.json$/.test(f))).toBe(true);
    expect(ops().map((o) => o.type)).toEqual(['add', 'applied']);
    expect(ops()[0].item).toMatchObject({ id, story: 'P1-01', kind: 'decision', title: 'Pick one', options: ['A', 'B'], urgent: true });
    expect(ops()[1]).toMatchObject({ type: 'applied', id: 'd-older' });
  });

  it('the copy ignores summary, hints, recommend and explain', async () => {
    const con = make();
    const explain = { purpose: 'Sells the shoes.', happened: 'Two ways to pay.', recommendation: 'A: it is cheaper.' };
    await expect(con.decisions.add({ story: 'P1-01', kind: 'decision', title: 'Pick one', options: ['A', 'B'], body: 'why', summary: 'Pick one.', hints: ['Only one.'], recommend: 'C', explain })).resolves.toMatch(/^d-/);
    const { item } = ops()[0];
    for (const key of ['summary', 'hints', 'recommend', 'explain']) expect(item, key).not.toHaveProperty(key);
  });

  it('refuses a bad item and a bad id', async () => {
    const con = make();
    await expect(con.decisions.add({ story: 'P1-01', kind: 'wish', title: 'x' })).rejects.toThrow(/kind/);
    await expect(con.decisions.add({ story: 'P1-01', kind: 'task' })).rejects.toThrow(/title/);
    await expect(con.decisions.applied('a" and drop')).rejects.toThrow(/no decision/i);
  });

  it('the next push carries them as numbered ArtifactData steps', async () => {
    const fake = fakeClaude();
    const con = make(fake);
    const id = await con.decisions.add({ story: 'P1-01', kind: 'task', title: 'Add the key' });
    await con.decisions.applied('d-older');
    const [addOp, appliedOp] = outbox().map((f) => f.slice(0, -5));
    await con.publish({ slots: [] });
    const prompt = fake.calls[0].args[1];
    expect(prompt).toMatch(new RegExp(`\\n4\\. \\(outbox ${addOp}\\) On url ${DP}: action "set", collection "items", doc_id "${id}"`));
    expect(prompt).toMatch(new RegExp(`\\n5\\. \\(outbox ${appliedOp}\\) On url ${DP}: action "update", collection "answers", doc_id "d-older"`));
    expect(prompt).toContain('"outbox"');
    // The item's data goes by file, in the page's shape.
    const file = prompt.match(/doc_id "d-[^"]+", file_path "([^"]+)"/)[1];
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ kind: 'task', title: 'Add the key', story: 'P1-01', options: [], input: 'optional' });
    // Both confirmed: the outbox is empty.
    expect(outbox()).toEqual([]);
  });

  it('only the operations the reply confirms leave the outbox', async () => {
    const con = make();
    await con.decisions.add({ story: 'P1-01', kind: 'task', title: 'Add the key' });
    await con.decisions.applied('d-older');
    const [addOp, appliedOp] = outbox().map((f) => f.slice(0, -5));
    await create(options, { stateDir: dir, now, config, spawnSync: fakeClaude({ reply: { outbox: [appliedOp, 'made-up'] } }).run }).publish({ slots: [] });
    expect(outbox()).toEqual([`${addOp}.json`]);
  });

  it('a refused status write still clears the operations it confirmed', async () => {
    const con = make();
    await con.decisions.applied('d-older');
    const fake = fakeClaude({ reply: { set: null, problem: 'denied' } });
    await expect(create(options, { stateDir: dir, now, config, spawnSync: fake.run }).publish({ slots: [] })).rejects.toThrow(/denied/);
    expect(outbox()).toEqual([]);
  });

  it('confirmed operations show in the local copy at once', async () => {
    const con = make();
    const id = await con.decisions.add({ story: 'P1-01', kind: 'task', title: 'Add the key' });
    await con.publish({ slots: [] });
    expect((await con.decisions.pending()).map((i) => i.id)).toEqual([id]);
    await con.decisions.applied(id);
    await con.publish({ slots: [] });
    expect(await con.decisions.pending()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'sync', 'decisions', 'answers', `${id}.json`), 'utf8')).applied).toBe('2026-10-15T09:08:07.000Z');
  });
});

describe('pending, from the copy of the decisions page', () => {
  function copy(items, answers) {
    for (const [collection, docs] of Object.entries({ items, answers })) {
      mkdirSync(join(dir, 'sync', 'decisions', collection), { recursive: true });
      for (const [id, doc] of Object.entries(docs)) writeFileSync(join(dir, 'sync', 'decisions', collection, `${id}.json`), JSON.stringify(doc));
    }
  }

  it("maps the page's items into the files console's shape, leaving out the applied", async () => {
    copy(
      {
        'd-done': { kind: 'decision', title: 'Old', story: 'P1-01', options: ['A'], input: 'optional', order: 1 },
        'd-answered': { kind: 'decision', title: 'Which card flow?', story: 'P2-03', options: ['A', 'B'], input: 'optional', order: 3, ask: 'Card flow', blocks: 'P2' },
        'd-open': { kind: 'task', title: 'Add the key', story: 'P2-04', input: 'required', order: 2, urgent: true },
      },
      {
        'd-done': { item: 'd-done', choice: 'A', text: '', at: '2026-10-13T18:00:00Z', applied: '2026-10-13T19:00:00Z' },
        'd-answered': { item: 'd-answered', choice: 'B', text: 'with a note', at: '2026-10-14T10:00:00Z', applied: null },
      },
    );
    const items = await make().decisions.pending();
    expect(items.map((i) => i.id)).toEqual(['d-open', 'd-answered']);
    expect(items[1]).toEqual({
      id: 'd-answered',
      story: 'P2-03',
      kind: 'decision',
      title: 'Which card flow?',
      options: ['A', 'B'],
      urgent: false,
      body: 'Card flow',
      createdAt: null,
      answer: { option: 'B', note: 'with a note', at: '2026-10-14T10:00:00Z' },
      appliedAt: null,
    });
    expect(items[0]).toMatchObject({ id: 'd-open', kind: 'task', options: [], urgent: true, answer: null });
  });

  it('list gives every item, applied ones too', async () => {
    copy({ 'd-done': { kind: 'decision', title: 'Old', story: 'P1-01', options: ['A'] } }, { 'd-done': { item: 'd-done', choice: 'A', at: 'T', applied: 'U' } });
    expect(await make().decisions.list()).toMatchObject([{ id: 'd-done', appliedAt: 'U', answer: { option: 'A', note: '', at: 'T' } }]);
  });

  it('is empty before the first copy', async () => {
    expect(await make().decisions.pending()).toEqual([]);
  });
});
