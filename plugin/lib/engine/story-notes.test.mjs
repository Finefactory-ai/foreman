import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDefaults } from '../config/defaults.mjs';
import { markedSession } from '../../../test/session-fixture.mjs';
import { flushStoryNotes, noteOnStory, noteSessionProgress, roundsOf } from './story-notes.mjs';
import { answerNote, decisionNote, designData, lockNotes, noteKey, pendingNotes, queueStoryNote, readPosted, writePosted } from './story-notes-queue.mjs';
import { machineText } from './story-note-text.mjs';

let root;
let dir;
const AT = new Date('2026-10-31T14:05:00Z');
const base = { version: 1, project: { name: 'Acme' }, stories: { adapter: 'markdown', dir: 'stories' }, roles: { reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer' }] } };
const config = (features = {}) => withDefaults({ ...base, features });
const env = () => ({ FOREMAN_PROJECT_DIR: root, FOREMAN_STATE_DIR: dir, HOME: join(root, 'home') });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-story-notes-'));
  dir = join(root, '.foreman');
  mkdirSync(join(root, 'stories'));
  writeFileSync(join(root, 'stories', 'ACME-1.md'), '---\nid: ACME-1\ntitle: Orders\nstatus: todo\n---\n\n## Progress notes\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A story source that records each note() call; `answer` says what it returns.
function fakeSource(answer = () => true) {
  const calls = [];
  return {
    calls,
    note: (id, note) => {
      calls.push({ id, ...note });
      return answer(id, note);
    },
  };
}

const DECISION = { id: 'd-20261031140500-ab12', story: 'ACME-1', kind: 'decision', title: 'Which database?', summary: 'Acme needs one.', options: ['Postgres', 'SQLite'], hints: ['a', 'b'], recommend: 'SQLite' };
const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: ['src/orders.mjs'], design: 'Add the order queue.', test_plan: 'orders.test.mjs', done_when: 'npm test' };
const flush = (source, extra = {}) => flushStoryNotes({ dir, config: config(), root, env: env(), now: () => AT, source, ...extra });
const queue = (story, kind, data, at = AT, slot = 'w2') => queueStoryNote(dir, { story, kind, data, at, slot });
const overlayNotes = () => JSON.parse(readFileSync(join(dir, 'stories', 'ACME-1.json'), 'utf8')).notes.map((n) => n.text);

describe('flushStoryNotes', () => {
  it('posts the queued notes in order, each ending with the footer', () => {
    const source = fakeSource();
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    queue('ACME-1', 'answer', answerNote({ ...DECISION, answer: { option: 'SQLite', note: '' } }).data);
    const result = flush(source);
    expect(Object.values(result)).toEqual(['posted', 'posted']);
    expect(source.calls.map((c) => c.title)).toEqual(['the owner was asked: Which database?', 'the owner answered: Which database?']);
    for (const call of source.calls) expect(call.text.endsWith('At 2026-10-31 14:05 UTC, slot w2.')).toBe(true);
    expect(pendingNotes(dir)).toEqual([]);
  });

  it('posts the same decision once, across one flush and across two (the ledger)', () => {
    const source = fakeSource();
    const data = decisionNote(DECISION).data;
    queue('ACME-1', 'decision', data);
    queue('ACME-1', 'decision', data);
    expect(Object.values(flush(source)).sort()).toEqual(['posted', 'repeat']);
    expect(source.calls).toHaveLength(1);
    expect(queue('ACME-1', 'decision', data)).toBeNull();
    expect(pendingNotes(dir)).toEqual([]);
    expect(readPosted(dir, 'ACME-1').keys).toEqual([noteKey('decision', data)]);
    // A decision that differs is another note.
    queue('ACME-1', 'decision', { ...data, title: 'Which cache?' });
    flush(source);
    expect(source.calls).toHaveLength(2);
  });

  it('keeps the queue in the order notes were queued, even with a frozen or an older clock', () => {
    const later = new Date('2026-11-01T00:00:00Z');
    const source = fakeSource();
    queue('ACME-1', 'follow-up', { id: 'ACME-1' }, later);
    queue('ACME-1', 'follow-up', { id: 'ACME-2' }, later);
    queue('ACME-1', 'follow-up', { id: 'ACME-3' }, AT);
    queue('ACME-1', 'follow-up', { id: 'ACME-4' }, AT);
    const names = pendingNotes(dir).map((p) => p.file.split('/').at(-1));
    expect(names).toEqual([...names].sort());
    flush(source);
    expect(source.calls.map((c) => c.summary.match(/ACME-\d/)[0])).toEqual(['ACME-1', 'ACME-2', 'ACME-3', 'ACME-4']);
  });

  it('posts nothing with jiraComments off, empties the queue and leaves the ledger alone', () => {
    const source = fakeSource();
    writePosted(dir, 'ACME-1', { keys: ['kept'], design: null });
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    const result = flush(source, { config: config({ jiraComments: false }) });
    expect(Object.values(result)).toEqual(['off']);
    expect(source.calls).toEqual([]);
    expect(pendingNotes(dir)).toEqual([]);
    expect(readPosted(dir, 'ACME-1')).toEqual({ keys: ['kept'], design: null });
  });

  describe('with the Salesforce story source', () => {
    const sfConfig = (features) => withDefaults({ ...base, stories: { adapter: 'salesforce', org: 'acme-qa', where: 'IsClosed = false' }, features });

    it('drops the notes with salesforceComments off, even with jiraComments on', () => {
      const source = fakeSource();
      queue('ACME-1', 'decision', decisionNote(DECISION).data);
      const result = flush(source, { config: sfConfig({ jiraComments: true, salesforceComments: false }) });
      expect(Object.values(result)).toEqual(['off']);
      expect(source.calls).toEqual([]);
      expect(pendingNotes(dir)).toEqual([]);
    });

    it('posts them with salesforceComments on, even with jiraComments off', () => {
      const source = fakeSource();
      queue('ACME-1', 'decision', decisionNote(DECISION).data);
      const result = flush(source, { config: sfConfig({ jiraComments: false, salesforceComments: true }) });
      expect(Object.values(result)).toEqual(['posted']);
      expect(source.calls).toHaveLength(1);
    });

    it('queues nothing from noteOnStory when salesforceComments is off', () => {
      expect(noteOnStory({ root, config: sfConfig({ salesforceComments: false }), env: env(), now: () => AT, source: fakeSource(), slot: 'w2' }, 'ACME-1', 'follow-up', { id: 'ACME-7', title: 'x' })).toBe('off');
      expect(existsSync(join(dir, 'story-notes'))).toBe(false);
    });
  });

  it('drops a note the source does not know, and says so', () => {
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    expect(Object.values(flush(fakeSource(() => false)))).toEqual(['unknown']);
    expect(pendingNotes(dir)).toEqual([]);
    expect(readPosted(dir, 'ACME-1').keys).toEqual([]);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('Story notes: dropped a note for ACME-1: the story source does not know it.');
  });

  it('drops a note for a source with no note()', () => {
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    expect(Object.values(flush({}))).toEqual(['unknown']);
    expect(pendingNotes(dir)).toEqual([]);
  });

  it('keeps the entry and stops when the source throws, then posts it on the next flush, in order', () => {
    let fail = true;
    const source = fakeSource(() => {
      if (fail) throw new Error('Jira said no');
      return true;
    });
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    queue('ACME-1', 'follow-up', { id: 'ACME-7', title: 'Rename it' });
    expect(Object.values(flush(source))).toEqual(['failed']);
    expect(source.calls).toHaveLength(1);
    expect(pendingNotes(dir)).toHaveLength(2);
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toContain('could not post a note on ACME-1 (Jira said no); it stays queued');
    fail = false;
    expect(Object.values(flush(source))).toEqual(['posted', 'posted']);
    expect(source.calls.slice(1).map((c) => c.title)).toEqual(['the owner was asked: Which database?', 'follow-up created']);
  });

  it('leaves the entries alone while another process holds the lock, and breaks a lock older than 5 minutes', () => {
    const source = fakeSource();
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    const release = lockNotes(dir);
    expect(flush(source)).toEqual({});
    expect(source.calls).toEqual([]);
    expect(pendingNotes(dir)).toHaveLength(1);
    const lock = join(dir, 'story-notes', '.lock');
    const old = new Date(Date.now() - 6 * 60_000);
    utimesSync(lock, old, old);
    expect(Object.values(flush(source))).toEqual(['posted']);
    expect(existsSync(lock)).toBe(false);
    release();
  });

  it('keeps a lock younger than 5 minutes', () => {
    const release = lockNotes(dir);
    const lock = join(dir, 'story-notes', '.lock');
    const young = new Date(Date.now() - 4 * 60_000);
    utimesSync(lock, young, young);
    expect(lockNotes(dir)).toBeNull();
    expect(statSync(lock).isFile()).toBe(true);
    release();
    expect(lockNotes(dir)).toBeTypeOf('function');
  });

  it('posts a design once, and a changed one as "design (revised)", keeping the new one in the ledger', () => {
    const source = fakeSource();
    queue('ACME-1', 'design', designData(PLAN));
    expect(Object.values(flush(source))).toEqual(['posted']);
    expect(queue('ACME-1', 'design', designData(PLAN))).toBeNull();
    const changed = { ...PLAN, design: 'Add the order queue.\nKeep it sorted.' };
    queue('ACME-1', 'design', designData(changed));
    expect(Object.values(flush(source))).toEqual(['revised']);
    expect(source.calls.map((c) => c.title)).toEqual(['design', 'design (revised)']);
    expect(source.calls[1].text).toContain('- Keep it sorted.');
    expect(source.calls[1].text).not.toContain('## How it will be tested');
    expect(readPosted(dir, 'ACME-1').design).toEqual(designData(changed));
    // Back to the first design is a change again.
    queue('ACME-1', 'design', designData(PLAN));
    expect(Object.values(flush(source))).toEqual(['revised']);
  });

  it('uses the full detail for rounds only when asked', () => {
    const round = { round: 1, approved: false, findings: [{ stage: 'test', severity: 'blocker', rule: 'the retry never stops', where: 'a.mjs:4', observed: 'no limit', fix: 'cap it' }], stages: ['test'], key: 'k1' };
    const summary = fakeSource();
    queue('ACME-1', 'round', round);
    flush(summary);
    expect(summary.calls[0].summary).toBe('The tester sent it back with 1 finding: 1 blocker.');
    expect(summary.calls[0].text).not.toContain('retry never stops');
    const full = fakeSource();
    queue('ACME-1', 'round', { ...round, key: 'k2' });
    flush(full, { config: config({ jiraCommentDetail: 'full' }) });
    expect(full.calls[0].text).toContain('The tester found that the retry never stops (a.mjs, line 4): no limit. Fix: cap it.');
  });

  it('sends no secret, no home path and no project path', () => {
    const source = fakeSource();
    writeFileSync(join(root, '.env.foreman'), 'ACME_PRIVATE=hunter2-hunter2\n');
    queue('ACME-1', 'answer', { id: 'd-1', title: 'Which?', option: null, note: `use ${root}/src/a.mjs and ${join(root, 'home')}/x with sk_live_abcdef123456 and hunter2-hunter2` });
    flush(source);
    const sent = JSON.stringify(source.calls);
    for (const leak of [root, join(root, 'home'), 'sk_live_abcdef123456', 'hunter2-hunter2']) expect(sent).not.toContain(leak);
    expect(source.calls[0].summary).toContain('src/a.mjs');
  });

  it('never throws, whatever the folder or the source', () => {
    expect(flushStoryNotes({})).toEqual({});
    writeFileSync(join(root, 'blocker'), 'x');
    expect(flushStoryNotes({ dir: join(root, 'blocker', 'nested'), config: config() })).toEqual({});
  });

  it('writes a note in markdown mode as one progress line', () => {
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    flush(undefined);
    expect(overlayNotes()).toEqual(['The owner was asked: Which database?: Acme needs one.']);
  });
});

describe('flushStoryNotes with nothing to do', () => {
  it('takes no lock and makes no folder when nothing is queued', () => {
    const source = fakeSource();
    expect(flush(source)).toEqual({});
    expect(existsSync(join(dir, 'story-notes'))).toBe(false);
    expect(source.calls).toEqual([]);
  });

  it('cleans the reason when the story source cannot be opened', () => {
    writeFileSync(join(root, '.env.foreman'), 'ACME_PRIVATE=hunter2-hunter2\n');
    queue('ACME-1', 'decision', decisionNote(DECISION).data);
    const result = flush(undefined, { config: { ...config(), stories: { adapter: `${root}/acme-stories hunter2-hunter2` } } });
    expect(result).toEqual({});
    expect(pendingNotes(dir)).toHaveLength(1);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('Story notes: could not open the story source (');
    expect(events).toContain('the notes stay queued');
    expect(events).not.toContain(root);
    expect(events).not.toContain('hunter2-hunter2');
  });
});

describe('noteOnStory', () => {
  const ctx = (source, extra = {}) => ({ root, config: config(), env: env(), now: () => AT, source, slot: 'w2', ...extra });

  it('queues and posts, and tells what became of its own note', () => {
    const source = fakeSource();
    expect(noteOnStory(ctx(source), 'ACME-1', 'follow-up', { id: 'ACME-7', title: 'Rename it' })).toBe('posted');
    expect(noteOnStory(ctx(source), 'ACME-1', 'follow-up', { id: 'ACME-7', title: 'Rename it' })).toBe('repeat');
    expect(noteOnStory(ctx(fakeSource(() => false)), 'ACME-1', 'follow-up', { id: 'ACME-8', title: 'x' })).toBe('unknown');
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0].text.endsWith('slot w2.')).toBe(true);
  });

  it('queues nothing when comments are off', () => {
    expect(noteOnStory(ctx(fakeSource(), { config: config({ jiraComments: false }) }), 'ACME-1', 'follow-up', { id: 'ACME-7', title: 'x' })).toBe('off');
    expect(existsSync(join(dir, 'story-notes'))).toBe(false);
  });

  it('says queued while another process flushes, and failed when the source throws', () => {
    const release = lockNotes(dir);
    expect(noteOnStory(ctx(fakeSource()), 'ACME-1', 'follow-up', { id: 'ACME-7', title: 'x' })).toBe('queued');
    release();
    const boom = fakeSource(() => {
      throw new Error('down');
    });
    expect(noteOnStory(ctx(boom), 'ACME-1', 'follow-up', { id: 'ACME-9', title: 'x' })).toBe('failed');
  });
});

describe('roundsOf', () => {
  const entry = (role, name, round, output, at) => ({ label: `${name}:ACME-1#${round}`, role, name, round, at: `2026-10-29T10:${String(at).padStart(2, '0')}:00.000Z`, endAt: null, output });
  const ok = { approved: true, findings: [] };
  const block = { approved: false, findings: [{ severity: 'blocker', rule: 'r', where: 'a:1', observed: 'o', fix: 'f' }] };
  const reviewers = [{ name: 'compliance', agent: 'x' }, { name: 'security', agent: 'y' }];

  it('a rejecting tester completes its round with no reviewers, and tags each finding with its stage', () => {
    const [r] = roundsOf([entry('tester', 'test', 1, block, 1)], reviewers);
    expect(r).toMatchObject({ round: 1, complete: true, approved: false, stages: ['test'], findings: [{ stage: 'test', severity: 'blocker' }] });
  });

  it('an approving tester waits for every reviewer without an engine', () => {
    const tester = entry('tester', 'test', 2, ok, 1);
    expect(roundsOf([tester], reviewers)[0].complete).toBe(false);
    expect(roundsOf([tester, entry('reviewer', 'compliance', 2, ok, 2)], reviewers)[0].complete).toBe(false);
    const done = roundsOf([tester, entry('reviewer', 'compliance', 2, ok, 2), entry('reviewer', 'security', 2, ok, 3)], reviewers)[0];
    expect(done).toMatchObject({ complete: true, approved: true, stages: ['test', 'compliance', 'security'] });
    expect(roundsOf([tester, entry('reviewer', 'compliance', 2, ok, 2)], [reviewers[0], { name: 'security', agent: 'y', engine: 'antigravity' }])[0].complete).toBe(true);
  });

  it('a reviewer that rejects makes the round rejected', () => {
    const [r] = roundsOf([entry('tester', 'test', 1, ok, 1), entry('reviewer', 'compliance', 1, block, 2), entry('reviewer', 'security', 1, ok, 3)], reviewers);
    expect(r).toMatchObject({ complete: true, approved: false, findings: [{ stage: 'compliance' }] });
  });

  it('minor findings approve; an answer without findings counts for nothing', () => {
    const minor = { approved: true, findings: [{ severity: 'minor', rule: 'r', where: '-', observed: 'o', fix: 'f' }] };
    expect(roundsOf([entry('tester', 'test', 1, minor, 1)], [])[0]).toMatchObject({ complete: true, approved: true });
    expect(roundsOf([entry('tester', 'test', 1, null, 1)], [])[0].complete).toBe(false);
    expect(roundsOf([entry('tester', 'test', 1, ok, 1), entry('reviewer', 'compliance', 1, null, 2)], reviewers.slice(0, 1))[0].complete).toBe(false);
  });

  it('joins a reviewer to the latest round with its number, and gives each round its own key', () => {
    const rounds = roundsOf([entry('tester', 'test', 1, block, 1), entry('tester', 'test', 2, ok, 3), entry('reviewer', 'compliance', 2, ok, 4)], reviewers.slice(0, 1));
    expect(rounds.map((r) => [r.round, r.complete])).toEqual([[1, true], [2, true]]);
    expect(rounds[0].key).not.toBe(rounds[1].key);
    expect(roundsOf([entry('tester', 'test', 1, block, 1)], [])[0].key).toBe(rounds[0].key);
    expect(roundsOf([entry('reviewer', 'compliance', 1, ok, 1)], reviewers)).toEqual([]);
  });

  describe('with a reviewer that has an engine', () => {
    const rs = [{ name: 'compliance', agent: 'x' }, { name: 'security', agent: 'y', engine: 'antigravity' }];
    const t = entry('tester', 'test', 2, ok, 1);
    const c = entry('reviewer', 'compliance', 2, ok, 2);

    it('keys a round by its tester alone, so a reviewer arriving later keeps the key', () => {
      const early = roundsOf([t, c], rs);
      const late = roundsOf([t, c, entry('reviewer', 'security', 2, block, 3)], rs);
      expect(late).toHaveLength(1);
      expect(late[0].key).toBe(early[0].key);
      expect(roundsOf([{ ...t, at: '2026-10-29T10:09:00.000Z' }, c], rs)[0].key).not.toBe(early[0].key);
    });

    it('lists the engine reviewers still to answer on an approved round', () => {
      expect(roundsOf([t, c], rs)[0].waiting).toEqual(['security']);
      expect(roundsOf([t, c, entry('reviewer', 'security', 2, ok, 3)], rs)[0].waiting).toEqual([]);
      expect(roundsOf([entry('tester', 'test', 2, block, 1)], rs)[0].waiting).toEqual([]);
      expect(roundsOf([t, c], reviewers)[0].waiting).toEqual([]);
    });
  });
});

describe('noteSessionProgress', () => {
  const BUILT = { complete: true, summary: 'Built it.', files: ['src/orders.mjs'], commands: [], problem: '' };
  const BLOCK = { approved: false, findings: [{ severity: 'blocker', rule: 'the queue drops orders', where: 'src/orders.mjs:9', observed: 'the oldest order is lost', fix: 'keep it' }], checked: 'ran it' };
  const OK = { approved: true, findings: [], checked: 'ran it' };
  const agents = (upto = 6) =>
    [
      { label: 'architect:ACME-1', phase: 'Architect', agentType: 'foreman:architect', output: PLAN },
      { label: 'build:ACME-1', phase: 'Build', agentType: 'foreman:builder', output: BUILT },
      { label: 'test:ACME-1#1', phase: 'Test', agentType: 'foreman:tester', output: BLOCK },
      { label: 'fix:ACME-1#1', phase: 'Build', agentType: 'foreman:builder', output: BUILT },
      { label: 'test:ACME-1#2', phase: 'Test', agentType: 'foreman:tester', output: OK },
      { label: 'compliance:ACME-1#2', phase: 'Review', agentType: 'foreman:compliance-reviewer', output: OK },
    ].slice(0, upto);
  const run = (extra = {}) => noteSessionProgress({ root, config: config(), env: env(), slot: 'w1', ...extra });
  const titles = () => overlayNotes().map((t) => t.split(':')[0]);

  it('posts the design, then each round once, and nothing new when run again', () => {
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: agents() });
    run();
    expect(overlayNotes().reverse()).toEqual([
      'Design: The architect chose the developer builder, whose work is: everything.',
      'Round 1 sent back: The tester sent it back with 1 finding: 1 blocker.',
      'Round 2 approved: The tester and the compliance reviewer approved the change.',
    ]);
    run();
    expect(overlayNotes()).toHaveLength(3);
  });

  it('does not post round 2 while its reviewer is missing, then does when it arrives', () => {
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: agents(5) });
    run();
    expect(titles().reverse()).toEqual(['Design', 'Round 1 sent back']);
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: agents(6) });
    run();
    expect(titles().reverse()).toEqual(['Design', 'Round 1 sent back', 'Round 2 approved']);
  });

  const engine = withDefaults({ ...base, roles: { reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer', engine: 'antigravity' }] } });

  it('does not wait for a reviewer that is configured with an engine, and says its verdict is still to come', () => {
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: agents(5) });
    run({ config: engine });
    expect(overlayNotes().reverse()).toEqual([
      'Design: The architect chose the developer builder, whose work is: everything.',
      'Round 1 sent back: The tester sent it back with 1 finding: 1 blocker.',
      'Round 2: the tester approved: The tester approved the change. The compliance reviewer reviews it outside this session; its verdict is still to come.',
    ]);
    for (const line of overlayNotes()) expect(machineText(line), line).toBeNull();
  });

  it("does not post a round again when the engine reviewer's own agent answers late", () => {
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: agents(5) });
    run({ config: engine });
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: [...agents(5), { label: 'compliance:ACME-1#2', phase: 'Review', agentType: 'foreman:compliance-reviewer', output: BLOCK }] });
    run({ config: engine });
    expect(overlayNotes()).toHaveLength(3);
    expect(pendingNotes(dir)).toEqual([]);
  });

  it('posts nothing with comments off, with no mark, and for another story', () => {
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: agents() });
    run({ config: config({ jiraComments: false }) });
    run({ slot: 'w2' });
    expect(existsSync(join(dir, 'stories', 'ACME-1.json'))).toBe(false);
    expect(readdirSync(dir)).not.toContain('story-notes');
  });

  it('writes notes a person can read', () => {
    markedSession(dir, { slot: 'w1', story: 'ACME-1', agents: agents() });
    run();
    for (const line of overlayNotes()) expect(machineText(line), line).toBeNull();
  });
});
