import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { addItem, currentItems, keepItem, readLedger, undoItem, updateItem } from '../../engine/learning-store.mjs';
import { lessons } from '../../engine/lessons.mjs';
import { tickEnv } from '../../engine/tick-log.mjs';
import { useSubscription } from '../../engine/claude-fallback.mjs';
import { learnedSkillsByRole, syncLearnedSkills } from '../../engine/slot-prepare.mjs';
import { add as addDecision, list as listDecisions } from '../../console/decisions.mjs';
import { writeRun } from '../../engine/run-record.mjs';
import { buildWaiting, waitingCount } from '../../console/waiting.mjs';

let dir;
const state = () => join(dir, '.foreman');
const roleFile = () => join(state(), 'learned', 'traits', 'developer.md');
const V1 = 'Acme: every route has a test that fails if it breaks';
const V2 = 'Acme: every route and every error path has a test that fails if it breaks';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-learning-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }] }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// `now` is the clock main is given; a fixed 09:00 unless the test passes one.
async function run(argv, extraEnv = {}, { now = () => new Date('2026-10-24T09:00:00Z') } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir, ...extraEnv },
    now,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const at = { now: new Date('2026-10-24T08:00:00Z') };
const seed = () => addItem(state(), { kind: 'trait', roles: ['developer'], text: V1, source: { key: 'untested-routes', stories: ['S-1', 'S-2'] }, reason: 'two stories shipped untested routes' }, at);

describe('foreman learning', () => {
  it('undo restores the first version', async () => {
    seed();
    const v1 = readFileSync(roleFile());
    updateItem(state(), 'L-1', { text: V2, reason: 'error paths too' }, at);
    const { code, out } = await run(['learning', 'undo', 'L-1']);
    expect(code).toBe(0);
    expect(out).toContain('Undid L-1: back to v1.');
    expect(readFileSync(roleFile()).equals(v1)).toBe(true);
    const lines = readFileSync(join(state(), 'learning.jsonl'), 'utf8').trim().split('\n');
    expect(JSON.parse(lines.at(-1))).toMatchObject({ action: 'undo', id: 'L-1', v: 1, by: 'owner' });
  });

  it('undo of the only version removes it', async () => {
    seed();
    const { code, out } = await run(['learning', 'undo', 'L-1']);
    expect(code).toBe(0);
    expect(out).toContain('Undid L-1: removed.');
  });

  it('list shows each item with its version and status', async () => {
    seed();
    const { code, out } = await run(['learning', 'list']);
    expect(code).toBe(0);
    expect(out).toContain('L-1  trait  developer  v1');
    expect(out).toContain('evaluating');
    expect(out).toContain('learned/traits/developer.md');
    expect(out).toContain('two stories shipped untested routes');
  });

  it('list says so when nothing was learned', async () => {
    const { code, out } = await run(['learning', 'list']);
    expect(code).toBe(0);
    expect(out).toBe('Foreman has not learned anything yet.\n');
  });

  it('show lists the history in order, then the current text', async () => {
    seed();
    updateItem(state(), 'L-1', { text: V2, reason: 'error paths too' }, at);
    await run(['learning', 'undo', 'L-1']);
    const { code, out } = await run(['learning', 'show', 'L-1']);
    expect(code).toBe(0);
    const add = out.indexOf('add');
    const update = out.indexOf('update');
    const undo = out.indexOf('undo');
    expect(add).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(add);
    expect(undo).toBeGreaterThan(update);
    expect(out).toContain('error paths too');
    expect(out.trimEnd().endsWith(V1)).toBe(true);
  });

  it('show says (removed) for a removed item', async () => {
    seed();
    await run(['learning', 'undo', 'L-1']);
    const { out } = await run(['learning', 'show', 'L-1']);
    expect(out).toContain('(removed)');
  });

  it('keep keeps the version in force', async () => {
    seed();
    const { code, out } = await run(['learning', 'keep', 'L-1']);
    expect(code).toBe(0);
    expect(out).toContain('Kept L-1 at v1.');
    expect(readLedger(state()).at(-1)).toMatchObject({ action: 'keep', by: 'owner', v: 1 });
  });

  it.each([['keep'], ['undo'], ['show']])('%s on an unknown id exits 1 with one plain line', async (sub) => {
    seed();
    const { code, err } = await run(['learning', sub, 'L-9']);
    expect(code).toBe(1);
    expect(err.trim().split('\n')).toHaveLength(1);
    expect(err).toContain('L-9');
    expect(err).not.toMatch(/\n\s+at /);
  });

  it('a held lock is one plain line, exit 1', async () => {
    seed();
    writeFileSync(join(state(), 'learning.lock'), JSON.stringify({ pid: process.pid, at: '2026-10-24T08:00:00Z' }));
    const { code, err } = await run(['learning', 'undo', 'L-1']);
    expect(code).toBe(1);
    expect(err).toBe('another Foreman process is changing learned items; try again\n');
  });

  it.each([
    [['learning', 'undo']],
    [['learning', 'undo', 'x']],
    [['learning', 'frob']],
    [['learning']],
    [['learning', 'show', 'L-1x']],
    [['learning', 'undo', 'L-1', '--told-at']],
    [['learning', 'undo', 'L-1', 'extra']],
    [['learning', 'keep', '--frob', 'L-1']],
    [['learning', 'keep', 'L-1', 'L-2']],
    [['learning', 'undo', '--told-at', '2026-10-24T08:00:00.000Z']],
  ])('%j prints usage and exits 64', async (argv) => {
    seed();
    const ledger = readFileSync(join(state(), 'learning.jsonl'), 'utf8');
    const { code, err } = await run(argv);
    expect(code).toBe(64);
    expect(err).toContain('usage: foreman learning');
    expect(err).toContain('foreman learning undo <id> [--told-at <time>]');
    expect(readFileSync(join(state(), 'learning.jsonl'), 'utf8')).toBe(ledger);
  });
});

// --told-at is how an answer to Foreman's own "learned" note acts: only when the note's time is
// the time of the item's latest add or update, by Foreman, and that version is still in force.
describe('foreman learning undo|keep --told-at', () => {
  const T1 = '2026-10-24T08:00:00.000Z';
  const T2 = '2026-10-24T08:30:00.000Z';
  const REFUSED = "The note is not about L-1's latest change by Foreman; nothing done\n";
  const ledgerText = () => readFileSync(join(state(), 'learning.jsonl'), 'utf8');
  // Runs argv and expects the refusal, with the ledger and the role file byte-for-byte unchanged.
  const refused = async (argv) => {
    const ledger = ledgerText();
    const role = existsSync(roleFile()) ? readFileSync(roleFile()) : null;
    const { code, out, err } = await run(argv);
    expect(code, argv.join(' ')).toBe(1);
    expect(err).toBe(REFUSED);
    expect(out).toBe('');
    expect(ledgerText()).toBe(ledger);
    expect(existsSync(roleFile()) ? readFileSync(roleFile()) : null).toEqual(role);
  };

  it('keep with the time of Foreman\'s add keeps it, as the owner', async () => {
    seed();
    const { code, out } = await run(['learning', 'keep', 'L-1', '--told-at', T1]);
    expect(code).toBe(0);
    expect(out).toContain('Kept L-1 at v1.');
    expect(readLedger(state()).at(-1)).toMatchObject({ action: 'keep', id: 'L-1', v: 1, by: 'owner' });
  });

  it('undo with the time of Foreman\'s add removes it, as the owner', async () => {
    seed();
    const { code } = await run(['learning', 'undo', 'L-1', '--told-at', T1]);
    expect(code).toBe(0);
    expect(readLedger(state()).at(-1)).toMatchObject({ action: 'undo', id: 'L-1', v: 0, by: 'owner' });
    expect(existsSync(roleFile())).toBe(false);
  });

  it.each([['undo'], ['keep']])('%s with any other time does nothing', async (sub) => {
    seed();
    await refused(['learning', sub, 'L-1', '--told-at', '2026-10-24T08:00:00.001Z']);
    await refused(['learning', sub, 'L-1', '--told-at', '']);
  });

  it.each([['undo'], ['keep']])('%s refuses when the latest change is the owner\'s', async (sub) => {
    addItem(state(), { kind: 'trait', roles: ['developer'], text: V1, reason: 'the owner wrote it' }, { now: new Date(T1), by: 'owner' });
    await refused(['learning', sub, 'L-1', '--told-at', T1]);
  });

  const v2 = () => updateItem(state(), 'L-1', { text: V2, reason: 'error paths too' }, { now: new Date(T2), by: 'foreman' });
  const eventLog = () => (existsSync(join(state(), 'events.jsonl')) ? readFileSync(join(state(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const roleBytes = () => readFileSync(roleFile());

  describe('once Foreman replaced the note\'s version', () => {
    it('keep with the v1 time is done: nothing written, said once, no decision added', async () => {
      seed();
      v2();
      const ledger = ledgerText();
      const role = roleBytes();
      const said = 'L-1 v1 was replaced by v2 since; its own note covers it.';
      const { code, out } = await run(['learning', 'keep', 'L-1', '--told-at', T1]);
      expect(code).toBe(0);
      expect(out).toContain(said);
      expect(ledgerText()).toBe(ledger);
      expect(roleBytes().equals(role)).toBe(true);
      expect(roleBytes().toString()).toContain(V2);
      expect(eventLog().at(-1)).toMatchObject({ kind: 'info', text: said });
      expect(listDecisions(state())).toEqual([]);
    });

    it('undo with the v1 time leaves v2, raises one Got-it note, and a retry raises no second', async () => {
      seed();
      v2();
      const ledger = ledgerText();
      const role = roleBytes();
      const { code, out } = await run(['learning', 'undo', 'L-1', '--told-at', T1]);
      expect(code).toBe(0);
      expect(ledgerText()).toBe(ledger);
      expect(roleBytes().equals(role)).toBe(true);
      expect(currentItems(readLedger(state())).get('L-1').v).toBe(2);
      const notes = listDecisions(state()).filter((d) => d.title === 'Foreman did not undo L-1 for developer');
      expect(notes).toHaveLength(1);
      const [note] = notes;
      expect(note).toMatchObject({ kind: 'decision', options: ['Got it'], story: 'S-2', urgent: false });
      expect(note.body).toContain('v1');
      expect(note.body).toContain('v2');
      expect(note.body).toContain('`foreman learning undo L-1`');
      for (const h of note.hints) expect(h.length).toBeLessThanOrEqual(100);
      const waiting = buildWaiting({ decisions: { source: 'files', items: listDecisions(state()) } });
      const shown = waiting.find((w) => w.id === note.id);
      expect(shown).toMatchObject({ group: 'fyi' });
      expect(shown.actions.map((a) => a.label)).toEqual(['Got it']);
      expect(waitingCount(waiting)).toBe(0);
      expect(out).toContain('Told the owner: d-');

      const again = await run(['learning', 'undo', 'L-1', '--told-at', T1]);
      expect(again.code).toBe(0);
      expect(listDecisions(state()).filter((d) => d.title === 'Foreman did not undo L-1 for developer')).toHaveLength(1);
      expect(ledgerText()).toBe(ledger);
    });

    it('undo with the v1 time takes the story from the v1 note when it is there', async () => {
      seed();
      addDecision(state(), { story: 'ACME-7', kind: 'decision', title: 'Foreman learned L-1 for developer', options: ['Undo the change', 'Keep the change'] }, new Date(T1));
      v2();
      const { code } = await run(['learning', 'undo', 'L-1', '--told-at', T1]);
      expect(code).toBe(0);
      expect(listDecisions(state()).find((d) => d.title === 'Foreman did not undo L-1 for developer').story).toBe('ACME-7');
    });

    it('undo when the owner cannot be told is retried: exit 1, one warn event, nothing changed', async () => {
      seed();
      v2();
      const ledger = ledgerText();
      writeFileSync(join(state(), 'decisions'), 'not a folder');
      const { code, err } = await run(['learning', 'undo', 'L-1', '--told-at', T1]);
      expect(code).toBe(1);
      const said = 'L-1 v1 was replaced by v2 since; nothing undone, but the owner was not told:';
      expect(err.startsWith(said)).toBe(true);
      const warn = eventLog().filter((e) => e.kind === 'warn');
      expect(warn.map((e) => e.text)).toEqual([err.trimEnd()]);
      expect(ledgerText()).toBe(ledger);
    });
  });

  it.each([['undo'], ['keep']])('%s with the v2 time still acts on v2', async (sub) => {
    seed();
    v2();
    const { code } = await run(['learning', sub, 'L-1', '--told-at', T2]);
    expect(code).toBe(0);
    expect(readLedger(state()).at(-1)).toMatchObject({ action: sub, id: 'L-1', v: sub === 'undo' ? 1 : 2, by: 'owner' });
  });

  it.each([['undo'], ['keep']])('%s with the v1 time acts on v1 once v2 was undone back to v1', async (sub) => {
    seed();
    v2();
    expect(undoItem(state(), 'L-1', { now: new Date('2026-10-24T08:45:00Z'), by: 'owner' }).ok).toBe(true);
    const { code } = await run(['learning', sub, 'L-1', '--told-at', T1]);
    expect(code).toBe(0);
    expect(readLedger(state()).at(-1)).toMatchObject({ action: sub, id: 'L-1', v: sub === 'undo' ? 0 : 1, by: 'owner' });
  });

  it.each([['undo'], ['keep']])('%s refuses an owner\'s add that Foreman replaced', async (sub) => {
    addItem(state(), { kind: 'trait', roles: ['developer'], text: V1, reason: 'the owner wrote it' }, { now: new Date(T1), by: 'owner' });
    v2();
    await refused(['learning', sub, 'L-1', '--told-at', T1]);
  });

  it.each([['undo'], ['keep']])('%s refuses the v2 time once v2 was undone back to v1', async (sub) => {
    seed();
    updateItem(state(), 'L-1', { text: V2, reason: 'error paths too' }, { now: new Date(T2), by: 'foreman' });
    expect(undoItem(state(), 'L-1', { now: new Date('2026-10-24T08:45:00Z'), by: 'owner' }).ok).toBe(true);
    await refused(['learning', sub, 'L-1', '--told-at', T2]);
  });

  const T3 = '2026-10-24T08:40:00.000Z';
  const V3 = 'Acme: every route, error path and timeout has a test that fails if it breaks';
  const v3 = () => updateItem(state(), 'L-1', { text: V3, reason: 'and timeouts' }, { now: new Date(T3), by: 'foreman' });
  const ownerUndo = (time) => expect(undoItem(state(), 'L-1', { now: new Date(time), by: 'owner' }).ok).toBe(true);
  const undo1 = () => ownerUndo('2026-10-24T08:45:00Z');
  const undo2 = () => ownerUndo('2026-10-24T08:50:00Z');

  describe('once the newer version was undone since', () => {
    it('keep with the v1 time names v2 once v3 was undone', async () => {
      seed();
      v2();
      v3();
      undo1();
      const ledger = ledgerText();
      const said = 'L-1 v1 was replaced by v2 since; its own note covers it.';
      const { code, out } = await run(['learning', 'keep', 'L-1', '--told-at', T1]);
      expect(code).toBe(0);
      expect(out).toContain(said);
      expect(out).not.toContain('v3');
      expect(ledgerText()).toBe(ledger);
      expect(eventLog().at(-1)).toMatchObject({ kind: 'info', text: said });
      expect(listDecisions(state())).toEqual([]);
    });

    it('undo with the v1 time points at v2 once v3 was undone', async () => {
      seed();
      v2();
      v3();
      undo1();
      const ledger = ledgerText();
      const { code, out } = await run(['learning', 'undo', 'L-1', '--told-at', T1]);
      expect(code).toBe(0);
      expect(ledgerText()).toBe(ledger);
      expect(currentItems(readLedger(state())).get('L-1').v).toBe(2);
      const notes = listDecisions(state()).filter((d) => d.title === 'Foreman did not undo L-1 for developer');
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toContain('answer Undo the change on the note about v2');
      expect(notes[0].body).not.toContain('v3');
      expect(notes[0].summary).toContain('replaced by v2');
      expect(out).toContain('L-1 v1 was replaced by v2 since; nothing undone');
    });

    it.each([['undo'], ['keep']])('%s refuses the v2 time once v3 and v2 were both undone', async (sub) => {
      seed();
      v2();
      v3();
      undo1();
      undo2();
      await refused(['learning', sub, 'L-1', '--told-at', T2]);
    });
  });

  describe('once Foreman replaced the note\'s version and the item was removed since', () => {
    it.each([['undo'], ['keep']])('%s with the v1 time says it is no longer in force', async (sub) => {
      seed();
      v2();
      undo1();
      undo2();
      expect(currentItems(readLedger(state())).get('L-1').v).toBe(0);
      const ledger = ledgerText();
      const roleThere = existsSync(roleFile());
      const said = `L-1 v1 is no longer in force: L-1 was removed since; nothing to ${sub}.`;
      const { code, out, err } = await run(['learning', sub, 'L-1', '--told-at', T1]);
      expect(code).toBe(0);
      expect(err).toBe('');
      expect(out).toBe(`${said}\n`);
      expect(out).not.toContain('replaced');
      expect(out).not.toContain('v2');
      expect(ledgerText()).toBe(ledger);
      expect(existsSync(roleFile())).toBe(roleThere);
      expect(listDecisions(state())).toEqual([]);
      expect(eventLog().at(-1)).toMatchObject({ kind: 'info', text: said });
    });
  });

  it('refuses an item that does not exist', async () => {
    seed();
    const ledger = ledgerText();
    const { code, err } = await run(['learning', 'undo', 'L-9', '--told-at', T1]);
    expect(ledgerText()).toBe(ledger);
    expect(code).toBe(1);
    expect(err).toBe("The note is not about L-9's latest change by Foreman; nothing done\n");
  });
});

// Undo and keep are the owner's. A story session is refused on the run's project before the
// handler runs: main.mjs refuses every run-guard.mjs GUARDED command there (FM-272).
describe('foreman learning undo|keep in a story session', () => {
  const REFUSAL = 'the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1)';
  const ledger = () => readFileSync(join(state(), 'learning.jsonl'));

  beforeEach(() => {
    // A run's project is a git repo; from a plain folder a session command acts on that folder.
    spawnSync('git', ['init', '-q'], { cwd: dir });
    seed();
    // A second version, so undo has something to pop.
    updateItem(state(), 'L-1', { text: V2, reason: 'error paths too' }, at);
  });

  it.each([['undo'], ['keep']])("%s refuses on the run's project in a story session and writes nothing", async (sub) => {
    const before = { ledger: ledger(), role: readFileSync(roleFile()) };
    const { code, out, err } = await run(['learning', sub, 'L-1'], { FOREMAN_RUN: '1' });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain(`foreman learning ${sub} would change`);
    expect(err).toContain(REFUSAL);
    expect(ledger().equals(before.ledger)).toBe(true);
    expect(readFileSync(roleFile()).equals(before.role)).toBe(true);
  });

  it("keep with --told-at (the answers' form) is refused in a story session too", async () => {
    const before = { ledger: ledger(), role: readFileSync(roleFile()) };
    const { code, out, err } = await run(['learning', 'keep', 'L-1', '--told-at', '2026-10-24T08:00:00.000Z'], { FOREMAN_RUN: '1' });
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('foreman learning keep would change');
    expect(err).toContain(REFUSAL);
    expect(ledger().equals(before.ledger)).toBe(true);
    expect(readFileSync(roleFile()).equals(before.role)).toBe(true);
  });
});

describe('foreman learning scan', () => {
  const STORIES = ['S-1', 'S-2', 'S-3', 'S-4', 'S-5'];
  const writeFindings = () => {
    mkdirSync(state(), { recursive: true });
    const lines = STORIES.map((story, i) => JSON.stringify({ at: `2026-10-2${i}T09:00:00.000Z`, story, result: 'shipped', builder: 'developer', stage: 'tester', severity: 'minor', rule: 'Acme docs stay current', where: 'README.md:1', observed: 'old', fix: 'update it' }));
    writeFileSync(join(state(), 'findings.jsonl'), `${lines.join('\n')}\n`);
  };
  const keyOfScan = async () => (await run(['learning', 'scan', '--dry-run'])).out.match(/key (f-[0-9a-f]{12})/)[1];

  it('--dry-run lists the lessons and writes nothing', async () => {
    writeFindings();
    const { code, out } = await run(['learning', 'scan', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('Lessons in the last 5 stories (window 60):');
    expect(out).toContain('1. findings · developer · 5 stories · Acme docs stay current');
    expect(out).toMatch(/\n {3}key f-[0-9a-f]{12}\n/);
    expect(out).toContain('   stories S-1, S-2, S-3, S-4, S-5');
    expect(out.endsWith('1 lesson(s); nothing written (dry run).\n')).toBe(true);
    expect(existsSync(join(state(), 'lessons.json'))).toBe(false);
  });

  it('writes lessons.json without --dry-run', async () => {
    writeFindings();
    const { code, out } = await run(['learning', 'scan']);
    expect(code).toBe(0);
    expect(out.endsWith('1 lesson(s); wrote lessons.json.\n')).toBe(true);
    const saved = JSON.parse(readFileSync(join(state(), 'lessons.json'), 'utf8'));
    expect(saved.at).toBe('2026-10-24T09:00:00.000Z');
    expect(saved.window).toEqual({ size: 60, stories: 5 });
    expect(saved.candidates[0].stories).toEqual(STORIES);
    expect(saved.covered).toEqual([]);
  });

  it('says so when there is no state', async () => {
    const { code, out } = await run(['learning', 'scan', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('No lessons in the last 0 stories.');
  });

  it.each([[['learning', 'scan', '--bogus']], [['learning', 'scan', 'extra']]])('%j prints usage and exits 64', async (argv) => {
    const { code, err } = await run(argv);
    expect(code).toBe(64);
    expect(err).toContain('usage: foreman learning');
    expect(err).toContain('foreman learning scan [--dry-run]');
  });

  it('leaves out a lesson learn.json ignored', async () => {
    writeFindings();
    const key = await keyOfScan();
    writeFileSync(join(state(), 'learn.json'), JSON.stringify({ ignored: [key] }));
    const { code, out } = await run(['learning', 'scan', '--dry-run']);
    expect(code).toBe(0);
    expect(out).not.toContain(key);
    expect(out).toContain('No lessons in the last 5 stories.');
  });

  it('says which learned item covers a lesson', async () => {
    writeFindings();
    const key = await keyOfScan();
    addItem(state(), { kind: 'trait', roles: ['developer'], text: 'Acme: keep the docs current', source: { key, stories: STORIES }, reason: 'docs drifted' }, at);
    const { code, out } = await run(['learning', 'scan', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('Covered by L-1 (counts toward its evaluation): Acme docs stay current · 5 stories');
    expect(out).toContain('0 lesson(s); nothing written (dry run).');
  });

  it('blanks a learning.redact value in a tool-error lesson it prints and writes', async () => {
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }], learning: { redact: ['AcmeInternalSecret'] } }));
    const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content: 'Exit code 1\nerror: login refused for AcmeInternalSecret' }] } });
    const use = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'login' } }] } });
    mkdirSync(join(state(), 'runs'), { recursive: true });
    mkdirSync(join(state(), 'logs'), { recursive: true });
    for (const [story, slot, hour] of [['S-1', 'w1', '09'], ['S-2', 'w2', '10']]) {
      writeFileSync(join(state(), 'runs', `${story}.json`), JSON.stringify({ story, slot, result: 'shipped', startedAt: `2026-10-23T${hour}:00:00.000Z`, endedAt: `2026-10-23T${hour}:30:00.000Z` }));
      writeFileSync(join(state(), 'logs', `${slot}-20261023-${hour}0000.log`), `${use}\n${result}\n`);
    }
    const { code, out } = await run(['learning', 'scan']);
    expect(code).toBe(0);
    expect(out).toContain('1. tool-error · all · 2 stories · Bash: error: login refused for •••');
    const saved = readFileSync(join(state(), 'lessons.json'), 'utf8');
    expect(saved).toContain('•••');
    expect(`${out}${saved}`.toLowerCase()).not.toContain('acmeinternalsecret');
  });

  describe('with secrets in a tool error', () => {
    const JWTS = ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY21lIn0.Sig0neAcme12', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY21lIn0.Sig7woAcme34'];
    const SBS = ['sb_secret_Acme1aaaaaaa', 'sb_secret_Acme2bbbbbbb'];
    const RAW = [...JWTS, ...SBS, 'AcmeFileValue123', 'zzz', 'ghsecretvalue1'];
    const ENV = { GH_TOKEN: 'ghsecretvalue1' };
    const LINE = '1. tool-error · all · 2 stories · Bash: curl: error: refused x_key=••• token ••• ••• ••• •••';
    const setup = () => {
      writeFileSync(join(dir, '.env.foreman'), 'ACME_SERVICE_KEY=AcmeFileValue123\n');
      mkdirSync(join(state(), 'runs'), { recursive: true });
      mkdirSync(join(state(), 'logs'), { recursive: true });
      [['S-1', 'w1', '09'], ['S-2', 'w2', '10']].forEach(([story, slot, hour], i) => {
        const content = `Exit code 1\ncurl: error: refused X_KEY=zzz token ${JWTS[i]} ${SBS[i]} AcmeFileValue123 ghsecretvalue1`;
        const use = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'curl' } }] } });
        const result = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true, content }] } });
        writeFileSync(join(state(), 'runs', `${story}.json`), JSON.stringify({ story, slot, result: 'shipped', startedAt: `2026-10-23T${hour}:00:00.000Z`, endedAt: `2026-10-23T${hour}:30:00.000Z` }));
        writeFileSync(join(state(), 'logs', `${slot}-20261023-${hour}0000.log`), `${use}\n${result}\n`);
      });
    };
    const clean = (text) => {
      for (const v of RAW) expect(text.toLowerCase()).not.toContain(v.toLowerCase());
    };

    it('blanks .env.foreman values, env secrets and looks-secret text in what it prints and writes', async () => {
      setup();
      const { code, out } = await run(['learning', 'scan'], ENV);
      expect(code).toBe(0);
      expect(out.split('\n').filter((l) => /^\d+\. tool-error/.test(l))).toEqual([LINE]);
      const saved = readFileSync(join(state(), 'lessons.json'), 'utf8');
      expect(saved).toContain('•••');
      clean(out);
      clean(saved);
      expect(out.match(/key (t-[0-9a-f]{12})/)[1]).toBe(JSON.parse(saved).candidates[0].key);
    });

    it('blanks the same with --dry-run and writes nothing', async () => {
      setup();
      const { code, out } = await run(['learning', 'scan', '--dry-run'], ENV);
      expect(code).toBe(0);
      expect(out).toContain(LINE);
      clean(out);
      expect(existsSync(join(state(), 'lessons.json'))).toBe(false);
    });
  });

  it('reads retry notes from the story overlays and skips a bad one', async () => {
    mkdirSync(join(state(), 'stories'), { recursive: true });
    writeFileSync(join(state(), 'stories', 'S-7.json'), JSON.stringify({ id: 'S-7', fields: {}, notes: [{ date: '2026-10-24', text: 'Note for the architect: use the Acme cache' }] }));
    writeFileSync(join(state(), 'stories', 'S-8.json'), '{ torn');
    mkdirSync(join(state(), 'runs'), { recursive: true });
    writeFileSync(join(state(), 'runs', 'S-7-20261024-080000.json'), JSON.stringify({ story: 'S-7', slot: 'w1', result: 'blocked', startedAt: '2026-10-24T08:00:00.000Z', endedAt: '2026-10-24T08:10:00.000Z' }));
    const { code, out } = await run(['learning', 'scan', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain('1. retry-note · architect · 1 story · Note for the architect: use the Acme cache');
  });
});

describe('foreman learning run', () => {
  const FINDINGS = ['S-1', 'S-2'].map((story, i) => ({ at: `2026-10-2${i + 2}T09:00:00.000Z`, story, result: 'shipped', builder: 'developer', stage: 'tester', severity: 'blocker', rule: 'Acme routes have a test that fails if they break', where: 'src/routes.mjs:3', observed: 'no test', fix: 'add a test' }));
  const TRAIT = { verdict: 'trait', reason: 'Two Acme stories shipped untested routes.', trait: { role: 'developer', text: 'Acme: give every new route a test that fails if it breaks.' }, conflicts: [] };
  let bin;
  let log;
  let replyFile;
  let key;

  // A fake `claude` on PATH: logs its argv to FAKE_LOG and prints an envelope whose result is
  // prose, then the reply in FAKE_REPLY.
  beforeEach(() => {
    mkdirSync(state(), { recursive: true });
    writeFileSync(join(state(), 'findings.jsonl'), `${FINDINGS.map((f) => JSON.stringify(f)).join('\n')}\n`);
    key = lessons({ findings: FINDINGS }).candidates[0].key;
    bin = join(dir, 'bin');
    mkdirSync(bin);
    log = join(dir, 'fake.log');
    replyFile = join(dir, 'reply.json');
    writeFileSync(replyFile, JSON.stringify(TRAIT));
    const script = [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "if (process.env.FAKE_KEYLOG) fs.appendFileSync(process.env.FAKE_KEYLOG, (process.env.ANTHROPIC_API_KEY ? 'key' : 'nokey') + '\\n');",
      "if (process.env.FAKE_FAIL) { process.stderr.write(fs.readFileSync(process.env.FAKE_FAIL, 'utf8')); process.exit(1); }",
      "const reply = fs.readFileSync(process.env.FAKE_REPLY, 'utf8');",
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'Here it is:\\n' + reply }) + '\\n');",
    ].join('\n');
    writeFileSync(join(bin, 'claude'), `${script}\n`, { mode: 0o755 });
  });

  const fakeEnv = () => ({ PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_REPLY: replyFile });
  const learn = (argv) => run(['learning', 'run', ...argv], fakeEnv());
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  // Every file under the state folder, with its contents.
  const snapshot = (base = state(), rel = '') => {
    const out = {};
    for (const name of readdirSync(join(base, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(join(base, path)).isDirectory()) Object.assign(out, snapshot(base, path));
      else out[path] = readFileSync(join(base, path), 'utf8');
    }
    return out;
  };

  it('--dry-run prints the checked lesson and writes nothing', async () => {
    const before = snapshot();
    const { code, out, err } = await learn([key, '--dry-run']);
    expect(err).toBe('');
    expect(code).toBe(0);
    const lines = out.split('\n');
    expect(lines[0]).toBe(`Lesson ${key} (findings · developer · 2 stories)`);
    expect(lines[1]).toBe('Learner: haiku $0.0100');
    expect(lines[2]).toBe('Checked lesson:');
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({ key, source: 'findings', stories: ['S-1', 'S-2'], verdict: 'trait', reason: TRAIT.reason, conflicts: [], trait: TRAIT.trait });
    expect(out.endsWith('Nothing written (dry run).\n')).toBe(true);
    expect(snapshot()).toEqual(before);
    for (const f of ['learner.jsonl', 'learning.jsonl', 'learned', 'lessons.json']) expect(existsSync(join(state(), f)), f).toBe(false);
    const argv = JSON.parse(calls()[0]);
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
  });

  it('runs the learner without the Console key once the run moved to the subscription', async () => {
    const keyLog = join(dir, 'key.log');
    const withKey = { ...fakeEnv(), FAKE_KEYLOG: keyLog, ANTHROPIC_API_KEY: 'sk-ant-acme-fake-0000000000000000000000' };
    expect((await run(['learning', 'run', key, '--dry-run'], withKey)).code).toBe(0);
    useSubscription(state(), new Date('2026-10-24T09:00:00.000Z'));
    expect((await run(['learning', 'run', key, '--dry-run'], withKey)).code).toBe(0);
    expect(readFileSync(keyLog, 'utf8').split('\n').filter(Boolean)).toEqual(['key', 'nokey']);
  });

  it('records the spend in learner.jsonl and writes no learned item', async () => {
    const { code, out } = await learn([key]);
    expect(code).toBe(0);
    expect(out.endsWith('Recorded $0.0100 of learning spend in learner.jsonl.\n')).toBe(true);
    const lines = readFileSync(join(state(), 'learner.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ at: '2026-10-24T09:00:00.000Z', key, model: 'haiku', costUsd: 0.01, verdict: 'trait', error: null });
    expect(existsSync(join(state(), 'learned'))).toBe(false);
    expect(existsSync(join(state(), 'learning.jsonl'))).toBe(false);
  });

  it('refuses when today’s budget is spent, without starting claude', async () => {
    writeFileSync(join(state(), 'learner.jsonl'), `${JSON.stringify({ at: '2026-10-24T01:00:00.000Z', key, model: 'haiku', costUsd: 2, verdict: 'none', error: null })}\n`);
    const { code, err } = await learn([key]);
    expect(code).toBe(1);
    expect(err).toContain('the learning budget for today is spent ($2.00 of $2.00)');
    expect(calls()).toEqual([]);
  });

  it('refuses a lesson that fails the check', async () => {
    writeFileSync(replyFile, JSON.stringify({ ...TRAIT, trait: { role: 'developer', text: `Acme ${'x'.repeat(396)}` } }));
    const { code, out, err } = await learn([key, '--dry-run']);
    expect(code).toBe(1);
    expect(err).toContain('Refused: a trait is at most 400 characters');
    expect(out).not.toContain('Checked lesson:');
  });

  it('records a failed call too', async () => {
    writeFileSync(replyFile, 'I have no lesson for you.');
    const { code, err } = await learn([key]);
    expect(code).toBe(1);
    expect(err).toContain('the learner gave no lesson JSON');
    expect(JSON.parse(readFileSync(join(state(), 'learner.jsonl'), 'utf8'))).toMatchObject({ key, costUsd: 0.01, error: 'the learner gave no lesson JSON' });
  });

  it('keeps a project file secret out of learner.jsonl and stderr', async () => {
    const secret = ['acme', 'plain', 'value42'].join('');
    writeFileSync(join(dir, '.env.foreman'), `ACME_DB_PASS=${secret}\n`);
    const failFile = join(dir, 'fail.txt');
    writeFileSync(failFile, `connect failed for ${secret}\n`);
    const { code, err } = await run(['learning', 'run', key], { ...fakeEnv(), FAKE_FAIL: failFile });
    expect(code).toBe(1);
    expect(err).toContain('connect failed for •••');
    expect(err).not.toContain(secret);
    const raw = readFileSync(join(state(), 'learner.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).error).toContain('•••');
    expect(raw).not.toContain(secret);
  });

  it('says so for a key that is not a lesson', async () => {
    const { code, err } = await learn(['f-ffffffffffff', '--dry-run']);
    expect(code).toBe(1);
    expect(err).toBe('No lesson f-ffffffffffff in the last 2 stories; `foreman learning scan` lists them.\n');
    expect(calls()).toEqual([]);
  });

  it('says which item already covers a lesson', async () => {
    addItem(state(), { kind: 'trait', roles: ['developer'], text: 'Acme: test routes', source: { key, stories: ['S-1', 'S-2'] }, reason: 'seed' }, at);
    const { code, err } = await learn([key, '--dry-run']);
    expect(code).toBe(1);
    expect(err).toBe(`${key} is already covered by L-1.\n`);
  });

  it.each([[['nope']], [[]], [['f-0123456789ab', 'extra']], [['f-0123456789ab', '--bogus']]])('learning run %j prints usage and exits 64', async (argv) => {
    const { code, err } = await learn(argv);
    expect(code).toBe(64);
    expect(err).toContain('foreman learning run <key> [--dry-run]');
  });
});

describe('foreman learning tick', { timeout: 20_000 }, () => {
  const FINDINGS = ['S-1', 'S-2'].map((story, i) => ({ at: `2026-10-2${i + 2}T09:00:00.000Z`, story, result: 'shipped', builder: 'developer', stage: 'tester', severity: 'blocker', rule: 'Acme routes have a test that fails if they break', where: 'src/routes.mjs:3', observed: 'no test', fix: 'add a test' }));
  const TEXT = 'Acme: give every new route a test that fails if it breaks.';
  const TRAIT = { verdict: 'trait', reason: 'Two Acme stories shipped untested routes.', trait: { role: 'developer', text: TEXT }, conflicts: [] };
  // Token-shaped fixtures are built at run time, so no file holds one whole.
  const GHP = `ghp_${'a1B2'.repeat(9)}`;
  const EARLIER = { now: new Date('2026-10-23T08:00:00Z') };
  let bin;
  let log;
  let replyFile;
  let key;

  const config = (learning) => writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }], ...(learning ? { learning } : {}) }));
  const reply = (value) => writeFileSync(replyFile, JSON.stringify(value));

  beforeEach(() => {
    mkdirSync(state(), { recursive: true });
    writeFileSync(join(state(), 'findings.jsonl'), `${FINDINGS.map((f) => JSON.stringify(f)).join('\n')}\n`);
    key = lessons({ findings: FINDINGS }).candidates[0].key;
    bin = join(dir, 'bin');
    mkdirSync(bin);
    log = join(dir, 'fake.log');
    replyFile = join(dir, 'reply.json');
    reply(TRAIT);
    const script = [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "if (process.env.FAKE_NODEOPTS) fs.appendFileSync(process.env.FAKE_NODEOPTS, JSON.stringify(process.env.NODE_OPTIONS ?? null) + '\\n');",
      "const reply = fs.readFileSync(process.env.FAKE_REPLY, 'utf8');",
      "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result: 'Here it is:\\n' + reply }) + '\\n');",
    ].join('\n');
    writeFileSync(join(bin, 'claude'), `${script}\n`, { mode: 0o755 });
  });

  const fakeEnv = () => ({ PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, FAKE_REPLY: replyFile });
  const tick = (argv = [], env = {}, opts = {}) => run(['learning', 'tick', ...argv], { ...fakeEnv(), ...env }, opts);
  const eventLines = () => (existsSync(join(state(), 'events.jsonl')) ? readFileSync(join(state(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  // A console that cannot add: a plain file where the decisions folder goes.
  const blockDecisions = () => writeFileSync(join(state(), 'decisions'), 'in the way\n');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ledgerLines = () => (existsSync(join(state(), 'learning.jsonl')) ? readFileSync(join(state(), 'learning.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const decisions = () => (existsSync(join(state(), 'decisions')) ? listDecisions(state()) : []);
  const learnerLines = () => (existsSync(join(state(), 'learner.jsonl')) ? readFileSync(join(state(), 'learner.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const snapshot = (base = state(), rel = '') => {
    const out = {};
    for (const name of readdirSync(join(base, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(join(base, path)).isDirectory()) Object.assign(out, snapshot(base, path));
      else out[path] = readFileSync(join(base, path), 'utf8');
    }
    return out;
  };

  describe('NODE_OPTIONS for the learner', () => {
    const seen = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

    it('starts the learner with the NODE_OPTIONS from before the report flags', async () => {
      const f = join(dir, 'nodeopts.log');
      const { code } = await tick([], { FAKE_NODEOPTS: f, NODE_OPTIONS: tickEnv({ NODE_OPTIONS: '--max-old-space-size=256' }, state()).NODE_OPTIONS });
      expect(code).toBe(0);
      expect(seen(f)).toEqual(['--max-old-space-size=256']);
    });
    it('starts the learner with no NODE_OPTIONS when the flags were all there was', async () => {
      const f = join(dir, 'nodeopts.log');
      const { code } = await tick([], { FAKE_NODEOPTS: f, NODE_OPTIONS: tickEnv({}, state()).NODE_OPTIONS });
      expect(code).toBe(0);
      expect(seen(f)).toEqual([null]);
    });
    it('leaves an owner NODE_OPTIONS alone', async () => {
      const f = join(dir, 'nodeopts.log');
      const owner = '--report-on-fatalerror --max-old-space-size=256';
      const { code } = await tick([], { FAKE_NODEOPTS: f, NODE_OPTIONS: owner });
      expect(code).toBe(0);
      expect(seen(f)).toEqual([owner]);
    });
  });

  it('turns a lesson into an [L-1] trait, an add line in the ledger and an FYI', async () => {
    const { code, out, err } = await tick();
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(calls()).toHaveLength(1);
    const argv = calls()[0];
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(readFileSync(roleFile(), 'utf8')).toBe(`[L-1] ${TEXT}\n`);
    const ledger = ledgerLines();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ action: 'add', id: 'L-1', kind: 'trait', roles: ['developer'], by: 'foreman', source: { key, stories: ['S-1', 'S-2'] } });
    const items = decisions();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'decision', title: 'Foreman learned L-1 for developer', options: ['Undo the change', 'Keep the change'], story: 'S-2', urgent: false });
    expect(items[0].summary).toBe(`developer: ${TEXT}`);
    expect(items[0].body).toContain(`[L-1] ${TEXT}`);
    expect(items[0].body).toContain('Used from the next story.');
    expect(items[0].hints).toHaveLength(2);
    for (const h of items[0].hints) expect(h.length).toBeLessThanOrEqual(100);
    const waiting = buildWaiting({ decisions: { source: 'files', items } });
    const note = waiting.find((i) => i.id === items[0].id);
    expect(note.group).toBe('fyi');
    expect(note.actions.map((a) => a.label)).toEqual(['Undo the change', 'Keep the change']);
    expect(waitingCount(waiting)).toBe(0);
    const events = readFileSync(join(state(), 'events.jsonl'), 'utf8');
    expect(events).toContain('Foreman learned L-1 for developer; Undo on Waiting on you.');
    const spend = learnerLines();
    expect(spend).toHaveLength(1);
    expect(spend[0]).toMatchObject({ key, stories: 2, model: 'haiku', costUsd: 0.01, verdict: 'trait', error: null });
    expect(out).toContain('Learned L-1 for developer:');
    expect(out).toContain('Told the owner: d-');
    expect(existsSync(join(state(), 'learning-tick.lock'))).toBe(false);
  });

  it('a trait the owner could not be told about is exit 1, with the reason on stderr and as a warn event', async () => {
    blockDecisions();
    const { code, err } = await tick();
    expect(code).toBe(1);
    expect(readFileSync(roleFile(), 'utf8')).toBe(`[L-1] ${TEXT}\n`);
    const said = 'Foreman learned L-1 for developer, but the owner was not told:';
    expect(err).toContain(said);
    const line = err.split('\n').find((l) => l.startsWith(said));
    expect(line.length).toBeGreaterThan(said.length + 1);
    const warn = eventLines().filter((e) => e.kind === 'warn');
    expect(warn.map((e) => e.text)).toEqual([line]);
  });

  it("gives the FYI the time of the ledger line it is about, and undo --told-at that time takes it out", async () => {
    let t = Date.parse('2026-10-24T09:00:00Z');
    const { code } = await tick([], {}, { now: () => new Date((t += 7)) });
    expect(code).toBe(0);
    const [added] = ledgerLines();
    expect(added).toMatchObject({ action: 'add', id: 'L-1', by: 'foreman' });
    const [fyi] = decisions();
    expect(fyi.title).toBe('Foreman learned L-1 for developer');
    expect(fyi.createdAt).toBe(added.at);
    const undone = await run(['learning', 'undo', 'L-1', '--told-at', fyi.createdAt]);
    expect(undone.code, undone.err).toBe(0);
    expect(ledgerLines().at(-1)).toMatchObject({ action: 'undo', id: 'L-1', v: 0, by: 'owner' });
    expect(existsSync(roleFile())).toBe(false);
  });

  it('a second tick with nothing new asks nothing and writes nothing', async () => {
    await tick();
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(out).toContain('No new lessons.');
    expect(calls()).toHaveLength(1);
    expect(ledgerLines()).toHaveLength(1);
  });

  it('does not ask again about a lesson already answered with the same stories', async () => {
    reply({ verdict: 'none', reason: 'A one-off.', conflicts: [] });
    const first = await tick();
    expect(first.out).toContain(`Nothing to learn from ${key}: A one-off.`);
    const again = await tick();
    expect(again.out).toContain('No new lessons.');
    expect(calls()).toHaveLength(1);
    expect(existsSync(join(state(), 'learning.jsonl'))).toBe(false);
  });

  it('writes nothing at all with learning.auto off', async () => {
    writeFileSync(join(state(), 'settings.json'), JSON.stringify({ 'learning.auto': false }));
    const before = snapshot();
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(out).toContain('Automatic learning is off (learning.auto); nothing written.');
    expect(calls()).toEqual([]);
    expect(snapshot()).toEqual(before);
    for (const f of ['learning-tick.lock', 'learner.jsonl', 'learning.jsonl', 'learned', 'decisions']) expect(existsSync(join(state(), f)), f).toBe(false);
  });

  it('holds back at the per-day cap without asking', async () => {
    config({ maxPerDay: 1 });
    addItem(state(), { kind: 'trait', roles: ['tester'], text: 'Acme: tester checks 404s', source: { key: 'f-000000000001', stories: ['S-0'] }, reason: 'seed' }, at);
    keepItem(state(), 'L-1', at);
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(out).toContain('Held back: Foreman already made 1 learned changes today (the most is 1).');
    expect(calls()).toEqual([]);
    expect(ledgerLines().map((l) => l.action)).toEqual(['add', 'keep']);
  });

  it('holds back at the evaluation cap without asking', async () => {
    addItem(state(), { kind: 'trait', roles: ['tester'], text: 'Acme: tester checks 404s', source: { key: 'f-000000000001', stories: ['S-0'] }, reason: 'seed' }, EARLIER);
    addItem(state(), { kind: 'trait', roles: ['architect'], text: 'Acme: architect names the files', source: { key: 'f-000000000002', stories: ['S-0'] }, reason: 'seed' }, EARLIER);
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(out).toContain('Held back: 2 learned items are already on trial (the most is 2).');
    expect(calls()).toEqual([]);
    expect(ledgerLines()).toHaveLength(2);
  });

  it('records a refusal at the per-role cap, without the text', async () => {
    config({ maxPerRole: 1 });
    addItem(state(), { kind: 'trait', roles: ['developer'], text: 'Acme: developer seed', source: { key: 'f-000000000001', stories: ['S-0'] }, reason: 'seed' }, EARLIER);
    keepItem(state(), 'L-1', EARLIER);
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(calls()).toHaveLength(1);
    expect(out).toContain(`Refused ${key}: developer already has 1 learned traits (the most is 1)`);
    const ledger = ledgerLines();
    expect(ledger.map((l) => l.action)).toEqual(['add', 'keep', 'refused']);
    expect(ledger[2]).toMatchObject({ id: null, v: 0, reason: 'developer already has 1 learned traits (the most is 1)', source: { key, stories: ['S-1', 'S-2'] }, by: 'foreman' });
    expect(JSON.stringify(ledger[2])).not.toContain(TEXT);
    expect(decisions()).toEqual([]);
  });

  it('exits at once while another tick holds the lock, leaving the lock alone', async () => {
    const lock = join(state(), 'learning-tick.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: '2026-10-24T08:59:00.000Z' }));
    const held = readFileSync(lock);
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(out).toContain('A learning tick is already running.');
    expect(calls()).toEqual([]);
    expect(readFileSync(lock).equals(held)).toBe(true);
  });

  it('breaks a lock a dead process left, runs, and removes its own lock', async () => {
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const lock = join(state(), 'learning-tick.lock');
    writeFileSync(lock, JSON.stringify({ pid: dead, at: '2026-10-24T08:00:00.000Z' }));
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(out).toContain('Learned L-1 for developer:');
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses inside a story session and writes nothing', async () => {
    // A run's project is a git repo; from a plain folder a session command acts on that folder.
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const before = snapshot();
    const { code, err } = await tick([], { FOREMAN_RUN: '1' });
    expect(code).toBe(1);
    expect(err).toContain('foreman learning tick does not run inside a Foreman story session (FOREMAN_RUN=1)');
    expect(calls()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('merges into a trait in force as a new version, and says it changed it', async () => {
    addItem(state(), { kind: 'trait', roles: ['developer'], text: 'Acme: test routes', source: { key: 'f-000000000001', stories: ['S-0'] }, reason: 'seed' }, EARLIER);
    const merged = 'Acme: give every new route and its error path a test that fails if it breaks.';
    reply({ verdict: 'merge', reason: 'The routes rule needs the error path too.', merge: { id: 'L-1', trait: merged }, conflicts: [] });
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(ledgerLines().at(-1)).toMatchObject({ action: 'update', id: 'L-1', v: 2, by: 'foreman', source: { key, stories: ['S-1', 'S-2'] } });
    expect(readFileSync(roleFile(), 'utf8')).toBe(`[L-1] ${merged}\n`);
    const items = decisions();
    expect(items.map((i) => i.title)).toEqual(['Foreman changed L-1 for developer']);
    expect(out).toContain('Learned L-1 for developer:');
  });

  describe('learned skills', () => {
    const SOQL = ['S-1', 'S-2'].map((story, i) => ({
      at: `2026-10-2${i + 2}T09:00:00.000Z`,
      story,
      result: 'shipped',
      builder: 'developer',
      stage: 'tester',
      severity: 'blocker',
      rule: 'SOQL cannot filter on a long text area field',
      where: 'force-app/main/default/classes/AcmeAccountTest.cls:12',
      observed: 'WHERE Description = :x does not compile: Account.Description is a long text area',
      fix: 'filter on a filterable field, or check the text in Apex',
    }));
    const SLUG = 'soql-long-text-filters';
    const NAME = `foreman-learned-${SLUG}`;
    const DESCRIPTION = 'Use when writing SOQL that filters records: long text area fields such as Account.Description cannot go in WHERE; use with platform-soql-query.';
    const STEPS = [
      'Before adding a WHERE clause, check each field type in the object definition.',
      'Leave long text area fields such as Account.Description out of WHERE.',
      'Filter on a filterable field, or query the records and check the text in Apex.',
    ];
    const EXAMPLE = [
      'The tester found: WHERE Description = :x does not compile: Account.Description is a long text area.',
      '',
      '```diff',
      "-  [SELECT Id FROM Account WHERE Description = :x]",
      "+  [SELECT Id, Description FROM Account WHERE Name = :name]",
      '```',
    ].join('\n');
    const skillReply = (skill = {}) => ({ verdict: 'skill', reason: 'Two Acme stories filtered SOQL on a long text area field.', skill: { slug: SLUG, description: DESCRIPTION, roles: ['developer'], steps: STEPS, example: EXAMPLE, ...skill }, conflicts: [] });
    const lock = (skills) => writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ version: 1, skills: Object.fromEntries(skills.map((n) => [n, { source: 'acme/skills' }])) }));
    const skillFile = (slug = SLUG) => join(state(), 'learned', 'skills', `foreman-learned-${slug}`, 'SKILL.md');
    const models = () => calls().map((argv) => argv[argv.indexOf('--model') + 1]);
    const seedSkill = (slug, roles = ['developer']) =>
      addItem(state(), { kind: 'skill', roles, slug, text: `---\nname: foreman-learned-${slug}\ndescription: "Use when Acme ${slug}"\n---\n\n## Steps\n\n1. Acme.\n\n## Example\n\nAcme.\n`, source: { key: 'f-000000000001', stories: ['S-0'] }, reason: 'seed' }, EARLIER);

    beforeEach(() => {
      writeFileSync(join(state(), 'findings.jsonl'), `${SOQL.map((f) => JSON.stringify(f)).join('\n')}\n`);
      key = lessons({ findings: SOQL }).candidates[0].key;
      lock(['platform-soql-query']);
      reply(skillReply());
    });

    it('turns the SOQL long-text-area findings into a learned skill the next slot copies in and lists for the developer', async () => {
      const { code, out, err } = await tick();
      expect(err).toBe('');
      expect(code).toBe(0);
      expect(models()).toEqual(['haiku', 'sonnet']);
      const text = readFileSync(skillFile(), 'utf8');
      expect(text.startsWith(`---\nname: ${NAME}\ndescription: "Use when writing SOQL`)).toBe(true);
      expect(text).toContain('\n## Steps\n\n1. ');
      expect(text).toContain('\n## Example\n');
      expect(Buffer.byteLength(text)).toBeLessThan(6144);
      const ledger = ledgerLines();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ action: 'add', id: 'L-1', kind: 'skill', roles: ['developer'], by: 'foreman', source: { key, stories: ['S-1', 'S-2'] } });
      const items = decisions();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'decision', title: 'Foreman learned L-1 for developer', options: ['Undo the change', 'Keep the change'], urgent: false });
      expect(items[0].summary.startsWith('developer: Use when writing SOQL')).toBe(true);
      expect(items[0].body).toContain(`[L-1] ${NAME}: Use when writing SOQL`);
      for (const h of items[0].hints) expect(h.length).toBeLessThanOrEqual(100);
      const waiting = buildWaiting({ decisions: { source: 'files', items } });
      expect(waiting.find((i) => i.id === items[0].id).group).toBe('fyi');
      expect(out).toContain(`Learned L-1 for developer: ${NAME}. Told the owner: d-`);

      const slot = mkdtempSync(join(tmpdir(), 'foreman-cli-learning-slot-'));
      try {
        expect(spawnSync('git', ['init', '-q'], { cwd: slot }).status).toBe(0);
        const synced = syncLearnedSkills({ path: slot, stateDir: state(), config: { version: 1 } });
        expect(synced.copied).toEqual([NAME]);
        expect(readFileSync(join(slot, '.claude', 'skills', NAME, 'SKILL.md'), 'utf8')).toBe(text);
        const listed = learnedSkillsByRole({ stateDir: state(), config: { version: 1 }, roles: ['developer'], dir: slot });
        expect(listed.byRole.developer[0]).toMatchObject({ id: 'L-1', name: NAME, path: `.claude/skills/${NAME}/SKILL.md` });
        expect(listed.byRole.developer[0].use.startsWith('Use when writing SOQL')).toBe(true);
      } finally {
        rmSync(slot, { recursive: true, force: true });
      }
    });

    it('refuses a skill that takes a pack skill name', async () => {
      lock(['acme-soql-rules']);
      reply(skillReply({ slug: 'acme-soql-rules' }));
      const { code, out } = await tick();
      expect(code).toBe(0);
      expect(out).toContain(`Refused ${key}: the slug acme-soql-rules clashes with a pack skill`);
      expect(ledgerLines().at(-1)).toMatchObject({ action: 'refused', kind: 'skill', id: null });
      expect(existsSync(join(state(), 'learned'))).toBe(false);
      expect(decisions()).toEqual([]);
    });

    it('the 11th skill waits, without the skill model', async () => {
      for (let i = 1; i <= 10; i++) {
        seedSkill(`acme-s${i}`);
        keepItem(state(), `L-${i}`, EARLIER);
      }
      const { code, out } = await tick();
      expect(code).toBe(0);
      expect(calls()).toHaveLength(1);
      const reason = 'Foreman already has 10 learned skills (the most is 10)';
      expect(out).toContain(`Waiting ${key}: ${reason}`);
      expect(ledgerLines().at(-1)).toMatchObject({ action: 'refused', kind: 'skill', reason });
      const folders = readdirSync(join(state(), 'learned', 'skills')).filter((f) => f.startsWith('foreman-learned-'));
      expect(folders).toHaveLength(10);
      expect(folders).not.toContain(NAME);
      expect(decisions()).toEqual([]);
    });

    it('still writes a merge into a learned skill at learning.maxSkills, with the skill model', async () => {
      for (let i = 1; i <= 10; i++) {
        seedSkill(`acme-s${i}`);
        keepItem(state(), `L-${i}`, EARLIER);
      }
      reply({ verdict: 'merge', reason: 'The SOQL skill needs the long text area rule.', merge: { id: 'L-1', skill: { description: DESCRIPTION, steps: STEPS, example: EXAMPLE } }, conflicts: [] });
      const { code, out } = await tick();
      expect(code).toBe(0);
      expect(calls()).toHaveLength(2);
      expect(models()).toEqual(['haiku', 'sonnet']);
      expect(ledgerLines().at(-1)).toMatchObject({ action: 'update', id: 'L-1', v: 2, kind: 'skill', by: 'foreman' });
      expect(currentItems(readLedger(state())).get('L-1').status).toBe('evaluating');
      expect(readFileSync(skillFile('acme-s1'), 'utf8')).toContain(`description: ${JSON.stringify(DESCRIPTION)}`);
      expect(decisions().map((i) => i.title)).toEqual(['Foreman changed L-1 for developer']);
      expect(out).toContain('Learned L-1 for developer: foreman-learned-acme-s1.');
      expect(out).not.toContain('Waiting ');
    });

    it('refuses a skill over 6 KB and writes nothing under learned/', async () => {
      reply(skillReply({ example: `${EXAMPLE}\n\n${'Acme long text. '.repeat(400)}` }));
      const { code, out } = await tick();
      expect(code).toBe(0);
      expect(out).toContain(`Refused ${key}: a learned skill is at most 6 KB`);
      expect(ledgerLines().at(-1)).toMatchObject({ action: 'refused', kind: 'skill' });
      expect(existsSync(join(state(), 'learned'))).toBe(false);
      expect(decisions()).toEqual([]);
    });

    it('merges into a learned skill as a new version on trial, and says it changed it', async () => {
      seedSkill('acme-soql');
      keepItem(state(), 'L-1', EARLIER);
      reply({ verdict: 'merge', reason: 'The SOQL skill needs the long text area rule.', merge: { id: 'L-1', skill: { description: DESCRIPTION, steps: STEPS, example: EXAMPLE } }, conflicts: [] });
      const { code, out } = await tick();
      expect(code).toBe(0);
      expect(calls()).toHaveLength(2);
      expect(models()).toEqual(['haiku', 'sonnet']);
      expect(ledgerLines().at(-1)).toMatchObject({ action: 'update', id: 'L-1', v: 2, kind: 'skill', by: 'foreman' });
      expect(currentItems(readLedger(state())).get('L-1').status).toBe('evaluating');
      expect(readFileSync(skillFile('acme-soql'), 'utf8')).toContain(`description: ${JSON.stringify(DESCRIPTION)}`);
      expect(decisions().map((i) => i.title)).toEqual(['Foreman changed L-1 for developer']);
      expect(out).toContain('Learned L-1 for developer: foreman-learned-acme-soql.');
    });

    describe('the pack skills a learned skill names', () => {
      const COMMIT = 'c0ffee'.repeat(7).slice(0, 40);
      const pinned = () => writeFileSync(join(dir, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { 'platform-soql-query': { source: 'acme/skills', ref: 'v1.2.0', commit: COMMIT }, 'platform-apex': { source: 'acme/skills', ref: 'v1.2.0', commit: COMMIT } } }));

      it('records the tag and commit of each one on the add line', async () => {
        pinned();
        const { code } = await tick();
        expect(code).toBe(0);
        const line = ledgerLines().at(-1);
        expect(line).toMatchObject({ action: 'add', id: 'L-1', kind: 'skill' });
        expect(line.metrics).toEqual({ packs: { 'platform-soql-query': { ref: 'v1.2.0', commit: COMMIT } } });
      });

      it('records null metrics for a skill that names no pack skill', async () => {
        pinned();
        reply(skillReply({ description: 'Use when writing SOQL that filters records on Acme long text area fields.' }));
        const { code } = await tick();
        expect(code).toBe(0);
        expect(ledgerLines().at(-1)).toMatchObject({ action: 'add', id: 'L-1', metrics: null });
      });

      it('records them on a merge line too', async () => {
        pinned();
        seedSkill('acme-soql');
        keepItem(state(), 'L-1', EARLIER);
        reply({ verdict: 'merge', reason: 'The SOQL skill needs the long text area rule.', merge: { id: 'L-1', skill: { description: DESCRIPTION, steps: STEPS, example: EXAMPLE } }, conflicts: [] });
        const { code } = await tick();
        expect(code).toBe(0);
        const line = ledgerLines().at(-1);
        expect(line).toMatchObject({ action: 'update', id: 'L-1', v: 2 });
        expect(line.metrics).toEqual({ packs: { 'platform-soql-query': { ref: 'v1.2.0', commit: COMMIT } } });
      });
    });

    it('names every role in the FYI, and undo removes the skill', async () => {
      reply(skillReply({ roles: ['developer', 'tester'] }));
      const { code } = await tick();
      expect(code).toBe(0);
      expect(decisions().map((i) => i.title)).toEqual(['Foreman learned L-1 for developer, tester']);
      expect(existsSync(join(state(), 'learned', 'skills', NAME))).toBe(true);
      const undone = await run(['learning', 'undo', 'L-1']);
      expect(undone.code).toBe(0);
      expect(existsSync(join(state(), 'learned', 'skills', NAME))).toBe(false);
    });
  });

  it('refuses a reply with a token in it, keeping the token out of the ledger', async () => {
    reply({ ...TRAIT, trait: { role: 'developer', text: `Acme: use ${GHP} for the API` } });
    const { code, out } = await tick();
    expect(code).toBe(0);
    expect(out).toContain(`Refused ${key}: looks like it holds a secret`);
    const ledger = ledgerLines();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ action: 'refused', reason: 'looks like it holds a secret' });
    expect(readFileSync(join(state(), 'learning.jsonl'), 'utf8')).not.toContain(GHP);
    expect(existsSync(join(state(), 'learned'))).toBe(false);
  });

  describe('evaluating what is on trial', () => {
    const OLD_FYI = { story: 'S-2', kind: 'decision', title: 'Foreman learned L-1 for developer', options: ['Undo the change', 'Keep the change'] };
    const ms = (iso) => Date.parse(iso);
    const record = (story, start, minutes, extra = {}) => ({
      story, slot: 'w1', result: 'shipped', costUsd: 0.1, turns: 10, minutes, rounds: 1, serious: 0, learned: [], stages: {}, agents: null,
      startedAt: new Date(start).toISOString(), endedAt: new Date(start + minutes * 60000).toISOString(), ...extra,
    });
    // 10 baseline runs (rounds 1) days before the seed at 08:00, and window runs from 08:05, each 5 minutes.
    const baseline = () => { for (let i = 0; i < 10; i++) writeRun(state(), record(`S-${101 + i}`, ms('2026-10-20T00:00:00Z') + i * 3600000, 30)); };
    const windowStart = (i) => ms('2026-10-24T08:05:00Z') + i * 10 * 60000;
    const later = (rounds, learned = ['L-1']) => rounds.forEach((r, i) => writeRun(state(), record(`S-${201 + i}`, windowStart(i), 5, { rounds: r, learned })));
    const noFindings = () => writeFileSync(join(state(), 'findings.jsonl'), '');
    const fyiOf = (title) => decisions().find((d) => d.title === title);

    it('DONE WHEN: rolls L-1 back when mean rounds rise from 1.0 to 1.6, with its reason and metrics, and tells the owner', async () => {
      noFindings();
      seed();
      const old = addDecision(state(), OLD_FYI, at.now);
      baseline();
      later([1, 2, 2, 2, 1]);
      const { code, out, err } = await tick();
      expect(err).toBe('');
      expect(code).toBe(0);
      const last = ledgerLines().at(-1);
      expect(last).toMatchObject({ action: 'rollback', by: 'foreman', id: 'L-1', v: 0 });
      expect(last.reason).toContain('rounds 1.0 → 1.6');
      expect(last.metrics).toMatchObject({ decision: 'rollback', window: { rounds: 1.6, runs: 5 }, baseline: { rounds: 1, runs: 10 } });
      expect(existsSync(roleFile())).toBe(false);
      const fyi = fyiOf('Foreman rolled back L-1 for developer');
      expect(fyi).toMatchObject({ kind: 'decision', options: ['Got it'], story: 'S-205', urgent: false, appliedAt: null });
      expect(fyi.summary).toBe('Rolled back L-1: Stories got worse: rounds 1.0 → 1.6');
      expect(fyi.body).toContain('Stories got worse: rounds 1.0 → 1.6');
      expect(fyi.body).toContain('S-201, S-202, S-203, S-204, S-205');
      expect(fyi.body).toContain('removed');
      expect(fyi.body).toContain('foreman learning show L-1');
      expect(fyi.hints).toHaveLength(1);
      const waiting = buildWaiting({ decisions: { source: 'files', items: decisions().filter((d) => !d.appliedAt) } });
      const note = waiting.find((i) => i.id === fyi.id);
      expect(note.group).toBe('fyi');
      expect(note.actions.map((a) => a.label)).toEqual(['Got it']);
      expect(waitingCount(waiting)).toBe(0);
      expect(decisions().find((d) => d.id === old).appliedAt).not.toBeNull();
      expect(readFileSync(join(state(), 'events.jsonl'), 'utf8')).toContain('Rolled back L-1: Stories got worse: rounds 1.0 → 1.6');
      expect(out).toContain('Rolled back L-1: Stories got worse: rounds 1.0 → 1.6');
      expect(calls()).toEqual([]);
    });

    it('a rollback the owner could not be told about is exit 1, with the reason as a warn event', async () => {
      noFindings();
      seed();
      baseline();
      later([1, 2, 2, 2, 1]);
      blockDecisions();
      const { code, err } = await tick();
      expect(code).toBe(1);
      expect(ledgerLines().at(-1)).toMatchObject({ action: 'rollback', by: 'foreman', id: 'L-1', v: 0 });
      const said = 'Rolled back L-1: Stories got worse: rounds 1.0 → 1.6';
      const warn = eventLines().filter((e) => e.kind === 'warn').map((e) => e.text);
      expect(warn).toHaveLength(1);
      expect(warn[0].startsWith(`${said}, but the owner was not told: `)).toBe(true);
      expect(warn[0].length).toBeGreaterThan(`${said}, but the owner was not told: `.length);
      expect(err).toContain(warn[0]);
    });

    it('keeps a proven item by itself and leaves the owner\'s learned FYI open', async () => {
      noFindings();
      seed();
      const old = addDecision(state(), OLD_FYI, at.now);
      baseline();
      later([1, 1, 1, 1, 1]);
      const { code, out } = await tick();
      expect(code).toBe(0);
      const last = ledgerLines().at(-1);
      expect(last).toMatchObject({ action: 'keep', by: 'foreman', id: 'L-1', v: 1, metrics: { decision: 'keep', window: { runs: 5 } } });
      expect(last.reason).toMatch(/^Proven over 5 stories/);
      expect(currentItems(readLedger(state())).get('L-1').status).toBe('kept');
      expect(decisions().find((d) => d.id === old).appliedAt).toBeNull();
      expect(decisions()).toHaveLength(1);
      expect(readFileSync(join(state(), 'events.jsonl'), 'utf8')).toContain('Kept L-1: Proven over 5 stories');
      expect(out).toContain('Kept L-1: Proven over 5 stories');
    });

    it('retires an item whose problem came back, and says so', async () => {
      addItem(state(), { kind: 'trait', roles: ['developer'], text: V1, source: { key, stories: ['S-1', 'S-2'] }, reason: 'seed' }, at);
      baseline();
      later([1, 1, 1, 1, 1]);
      const back = [0, 2].map((i) => ({ ...FINDINGS[0], story: `S-${201 + i}`, at: new Date(windowStart(i) + 60000).toISOString() }));
      writeFileSync(join(state(), 'findings.jsonl'), `${[...FINDINGS, ...back].map((f) => JSON.stringify(f)).join('\n')}\n`);
      const { code } = await tick();
      expect(code).toBe(0);
      const line = ledgerLines().find((l) => l.action === 'rollback');
      expect(line).toMatchObject({ id: 'L-1', by: 'foreman', v: 0, metrics: { decision: 'retire' } });
      expect(line.reason).toBe('No effect: the problem came back on S-201, S-203');
      expect(fyiOf('Foreman retired L-1 for developer')).toMatchObject({ options: ['Got it'] });
      expect(fyiOf('Foreman retired L-1 for developer').summary).toBe('Retired L-1: No effect: the problem came back on S-201, S-203');
    });

    it('does not send a rolled-back lesson to the learner again, even with a new story', async () => {
      addItem(state(), { kind: 'trait', roles: ['developer'], text: V1, source: { key, stories: ['S-1', 'S-2'] }, reason: 'seed' }, at);
      baseline();
      later([1, 2, 2, 2, 1]);
      const first = await tick();
      expect(first.code).toBe(0);
      expect(ledgerLines().at(-1)).toMatchObject({ action: 'rollback', id: 'L-1' });
      expect(first.out).toContain('No new lessons.');
      const more = { ...FINDINGS[0], story: 'S-3', at: '2026-10-24T08:59:00.000Z' };
      writeFileSync(join(state(), 'findings.jsonl'), `${[...FINDINGS, more].map((f) => JSON.stringify(f)).join('\n')}\n`);
      const second = await tick();
      expect(second.code).toBe(0);
      expect(second.out).toContain('No new lessons.');
      expect(calls()).toEqual([]);
    });

    it('evaluates nothing with learning.auto off', async () => {
      seed();
      baseline();
      later([1, 2, 2, 2, 1]);
      writeFileSync(join(state(), 'settings.json'), JSON.stringify({ 'learning.auto': false }));
      const before = snapshot();
      const { code } = await tick();
      expect(code).toBe(0);
      expect(snapshot()).toEqual(before);
    });

    it('evaluates nothing inside a story session', async () => {
      seed();
      baseline();
      later([1, 2, 2, 2, 1]);
      const before = snapshot();
      const { code } = await tick([], { FOREMAN_RUN: '1' });
      expect(code).toBe(1);
      expect(snapshot()).toEqual(before);
    });

    it('a rollback frees a trial slot for a fresh lesson in the same tick', async () => {
      seed();
      addItem(state(), { kind: 'trait', roles: ['tester'], text: 'Acme: tester checks 404s', source: { key: 'f-000000000001', stories: ['S-0'] }, reason: 'seed' }, at);
      baseline();
      later([1, 2, 2, 2, 1]);
      const { code, out } = await tick();
      expect(code).toBe(0);
      expect(out).toContain('Rolled back L-1');
      expect(calls()).toHaveLength(1);
      expect(ledgerLines().map((l) => [l.action, l.id])).toEqual([['add', 'L-1'], ['add', 'L-2'], ['rollback', 'L-1'], ['add', 'L-3']]);
    });
  });

  it('prints usage and exits 64 for an extra argument', async () => {
    const { code, err } = await tick(['extra']);
    expect(code).toBe(64);
    expect(err).toContain('foreman learning tick');
  });
});
