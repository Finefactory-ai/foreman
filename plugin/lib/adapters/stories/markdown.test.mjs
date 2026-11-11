import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildOrder, needsExclusive, nextStory, progress, waitsOnStories } from '../../engine/pick.mjs';
import { storySourceContract } from './contract.mjs';
import { create, DEFAULT_ID_PATTERN, SHIPPED_TTL_MS, storiesDirOf } from './markdown.mjs';

// A notes vault: Stories/*.md with phase fields, owner tasks, and schema phases. The vault
// sits outside the project, so its notes are edited in place.
const ACME = {
  dir: 'Stories',
  idPattern: 'P\\d+[a-z]?-[A-Za-z0-9-]+',
  fields: { group: 'phase', groupName: 'phase_name', order: 'phase_order' },
  ownerTask: { id: 'OWNER', title: '\\(owner task\\)' },
  resourcesByGroup: { schema: ['2a', '2b', '6'] },
};

let vaultDir;
let projectDir;
const NOW = () => new Date(2026, 9, 15, 12, 0, 0);
const source = () => create({ ...ACME, dir: join(vaultDir, 'Stories') }, { root: projectDir, now: NOW });
const pickNext = (opts) => nextStory(source().list(), { idPattern: source().idPattern, ...opts });
const plan = () => buildOrder(source().list(), { idPattern: source().idPattern });
const prog = () => progress(source().list());
const waits = (text) => waitsOnStories(text, { idPattern: ACME.idPattern });

const story = (id, fields = {}) => {
  const f = { title: `Story ${id}`, phase: id.match(/^P([^-]+)-/)?.[1] ?? '1', phase_order: 1, status: 'todo', blocked_by: '', depends_on: null, ...fields };
  writeFileSync(
    join(vaultDir, 'Stories', `${id} ${f.title.replace(/[/:]/g, '')}.md`),
    `---\ntitle: "${f.title}"\ntype: story\nid: ${id}\nphase: "${f.phase}"\nphase_name: "Foundations"\n` +
      `phase_order: ${f.phase_order}\nstatus: ${f.status}\nblocked_by: ${f.blocked_by}\n` +
      (f.depends_on ? `depends_on: [${f.depends_on.join(', ')}]\n` : '') +
      `---\n\n# ${id}\n`,
  );
};

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'markdown-source-'));
  projectDir = mkdtempSync(join(tmpdir(), 'markdown-project-'));
  mkdirSync(join(vaultDir, 'Stories'));
});
afterEach(() => {
  rmSync(vaultDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('nextStory', () => {
  it('takes the earliest phase first, then the lowest number in it', () => {
    story('P4-10', { phase_order: 6 });
    story('P4-02', { phase_order: 6 });
    story('P10-01', { phase_order: 17 });
    story('P2a-03', { phase_order: 2 });
    expect(pickNext().id).toBe('P2a-03');
    story('P2a-03', { phase_order: 2, status: 'done' });
    expect(pickNext().id).toBe('P4-02');
  });

  it('skips done, retired and blocked stories and owner tasks', () => {
    story('P1-01', { status: 'done' });
    story('P1-02', { status: 'retired' });
    story('P1-03', { status: 'blocked', blocked_by: 'Waiting for the Stripe account' });
    story('P1-04', { title: 'Harvest v1 (owner task)' });
    story('P0-OWNER-2', { phase_order: 0 });
    story('P1-05');
    expect(pickNext().id).toBe('P1-05');
  });

  it('resumes a story left in progress before starting a new one', () => {
    story('P1-01');
    story('P3-04', { phase_order: 4, status: 'in-progress' });
    const next = pickNext();
    expect(next.id).toBe('P3-04');
    expect(next.status).toBe('in-progress');
  });

  it('takes a story back once every story it was blocked by is done', () => {
    story('P1-01', { status: 'done' });
    story('P1-02');
    story('P1-03', { status: 'blocked', blocked_by: 'P1-01, P1-02 must land first' });
    story('P1-04', { status: 'blocked', blocked_by: 'P1-01 must land first' });
    expect(pickNext({ skip: ['P1-02'] }).id).toBe('P1-04');
  });

  it('honours skip and an explicit id', () => {
    story('P1-01');
    story('P1-02');
    expect(pickNext({ skip: ['P1-01'] }).id).toBe('P1-02');
    expect(pickNext({ id: 'P1-02' }).id).toBe('P1-02');
    expect(pickNext({ id: 'P9-99' })).toBeNull();
  });

  it('returns null when nothing is left to build', () => {
    story('P1-01', { status: 'done' });
    expect(pickNext()).toBeNull();
  });

  it('waits for every story in depends_on, in any phase, before taking a story', () => {
    story('P4-13', { phase_order: 4, depends_on: ['P2b-01', 'P5-03'] });
    story('P4-14', { phase_order: 4 });
    story('P2b-01', { phase_order: 7 });
    story('P5-03', { phase_order: 8, status: 'done' });
    expect(pickNext().id).toBe('P4-14');
    story('P4-14', { phase_order: 4, status: 'done' });
    expect(pickNext().id).toBe('P2b-01');
    story('P2b-01', { phase_order: 7, status: 'done' });
    expect(pickNext().id).toBe('P4-13');
  });

  it('does not take a story that depends on an unfinished owner task', () => {
    story('P4-20', { title: 'Get the Turnstile keys (owner task)' });
    story('P4-11', { depends_on: ['P4-20'] });
    expect(pickNext()).toBeNull();
    story('P4-20', { title: 'Get the Turnstile keys (owner task)', status: 'done' });
    expect(pickNext().id).toBe('P4-11');
  });
});

describe('buildOrder', () => {
  it('lists the whole run in order and says why the rest cannot be reached', () => {
    story('P1-01', { depends_on: ['P1-03'] });
    story('P1-02');
    story('P1-03');
    story('P1-04', { title: 'Sign off (owner task)' });
    story('P1-05', { depends_on: ['P1-04'] });
    story('P1-06', { depends_on: ['P1-05'] });
    story('P1-07', { status: 'blocked', blocked_by: 'Waiting for your decision: prices' });
    story('P1-08', { depends_on: ['P1-07', 'P9-99'] });
    story('P1-09', { depends_on: ['P1-10'] });
    story('P1-10', { depends_on: ['P1-09'] });
    const { order, waiting } = plan();
    expect(order).toEqual(['P1-02', 'P1-03', 'P1-01']);
    expect(Object.fromEntries(waiting.map((w) => [w.id, w.on]))).toEqual({
      'P1-05': ['P1-04 (owner task)'],
      'P1-06': ['P1-05'],
      'P1-07': ['Waiting for your decision: prices'],
      'P1-08': ['P1-07', 'P9-99 (no such story)'],
      'P1-09': ['P1-10'],
      'P1-10': ['P1-09'],
    });
  });
});

describe('strict picking and the command centre', () => {
  it('with strict, an explicit id is given only when the factory could build it now', () => {
    story('P1-01');
    story('P1-02', { depends_on: ['P1-01'] });
    story('P1-03', { status: 'done' });
    story('P1-04', { title: 'Sign off (owner task)' });
    expect(pickNext({ id: 'P1-01', strict: true }).id).toBe('P1-01');
    expect(pickNext({ id: 'P1-02', strict: true })).toBeNull();
    expect(pickNext({ id: 'P1-03', strict: true })).toBeNull();
    expect(pickNext({ id: 'P1-04', strict: true })).toBeNull();
    expect(pickNext({ id: 'P1-02' }).id).toBe('P1-02');
  });

  it('lists what can be built right now, apart from the full run order', () => {
    story('P1-01');
    story('P1-02', { depends_on: ['P1-01'] });
    story('P1-03');
    const { buildableNow, order } = plan();
    expect(buildableNow.map((s) => s.id)).toEqual(['P1-01', 'P1-03']);
    expect(order).toEqual(['P1-01', 'P1-02', 'P1-03']);
  });

  it('counts progress by group, leaving retired stories out', () => {
    story('P1-01', { status: 'done' });
    story('P1-02');
    story('P1-03', { status: 'retired' });
    story('P2a-01', { phase_order: 2, status: 'blocked', blocked_by: 'x' });
    // An owner task filed under phase 0 but ordered with phase 1 still counts as phase 0.
    story('P0-OWNER-2', { phase: '0', phase_order: 1, status: 'done' });
    story('P0-01', { phase: '0', phase_order: 0, status: 'done' });
    const p = prog();
    expect(p).toMatchObject({ done: 3, todo: 1, blocked: 1, total: 5 });
    expect(p.byGroup.map((x) => [x.group, x.done, x.total])).toEqual([['0', 2, 2], ['1', 1, 2], ['2a', 0, 1]]);
  });
});

describe('waitsOnStories', () => {
  it('is true only when blocked_by starts with story ids', () => {
    expect(waits('P7-02, P6-05, P6-04 must land first')).toBe(true);
    expect(waits('P6-05 (tool registry) first')).toBe(true);
    expect(waits('Needs the Duffel test key (owner task)')).toBe(false);
    expect(waits('Waits on P7-02')).toBe(false);
    expect(waits('')).toBe(false);
  });
});

describe('exclude and schema stories', () => {
  beforeEach(() => {
    story('P6-01', { phase_order: 9 });
    story('P7-01', { phase_order: 10 });
    story('P7-02', { phase_order: 10 });
  });

  it('lists every story with its status', () => {
    expect(source().list().map((s) => [s.id, s.status])).toEqual(expect.arrayContaining([['P6-01', 'todo'], ['P7-01', 'todo']]));
  });

  it('skips stories the caller excludes', () => {
    expect(pickNext({ exclude: (s) => s.group === '6' }).id).toBe('P7-01');
  });

  it('combines skip and exclude', () => {
    expect(pickNext({ skip: ['P7-01'], exclude: (s) => s.group === '6' }).id).toBe('P7-02');
  });

  it('does not apply exclude to an explicit id', () => {
    expect(pickNext({ id: 'P6-01', exclude: (s) => s.group === '6' }).id).toBe('P6-01');
  });

  it('marks schema stories by resources or by the extra list', () => {
    const byId = Object.fromEntries(source().list().map((s) => [s.id, s]));
    expect(byId['P6-01'].resources).toEqual(['schema']);
    expect(byId['P7-01'].resources).toEqual([]);
    expect(needsExclusive(byId['P6-01'])).toBe(true);
    expect(needsExclusive(byId['P7-01'])).toBe(false);
    expect(needsExclusive(byId['P7-01'], ['P7-01'])).toBe(true);
  });
});

// Shaped like Stories/P1-09 in the real vault: frontmatter, headings, the italic hint under
// "## Progress notes", then dated bullets with a blank line after each.
const NOTE = `---
title: "Set up the software factory"
type: story
id: P1-09
phase: "1"
phase_name: "Foundations"
phase_order: 1
epic: "[[Phase 1 — Foundations]]"
status: todo
findings: []
estimate_days: 0.5
started:
completed:
blocked_by:
tags: [acme-app, story]
date: 2026-10-13
---

# P1-09 · Set up the software factory

**Phase:** [[Phase 1 — Foundations]] · **Estimate:** 0.5 days

## What

A production line for stories.

## Done when

A dry run goes through the pipeline.

## Progress notes

_Dated notes, newest first. If this story is blocked, say what is blocking it here and in \`blocked_by\` above._

- **2026-10-14** — Added the command centre.

- **2026-10-13** — Built the factory.
`;

describe('update (the note editing of the Obsidian vault)', () => {
  let file;
  beforeEach(() => {
    file = join(vaultDir, 'Stories', 'P1-09 Set up the software factory.md');
    writeFileSync(file, NOTE);
    writeFileSync(join(vaultDir, 'Stories', 'P1-10 Another story.md'), '---\ntitle: "Another"\nid: P1-10\nstatus: todo\n---\n\n# P1-10\n');
  });
  const read = () => readFileSync(file, 'utf8');
  const OWNER_TOOK = { status: 'blocked', fields: { blocked_by: 'Taken by the owner' }, note: 'The owner took this story over.' };

  it('sets frontmatter fields and adds a progress line as the newest note', () => {
    expect(source().update('P1-09', OWNER_TOOK)).toBe(true);
    const lines = read().split('\n');
    expect(lines).toContain('status: blocked');
    expect(lines).toContain('blocked_by: Taken by the owner');
    expect(lines).not.toContain('status: todo');
    expect(lines).not.toContain('blocked_by:');

    const heading = lines.indexOf('## Progress notes');
    const firstBullet = lines.slice(heading).find((l) => l.startsWith('- '));
    expect(firstBullet).toBe('- **2026-10-15** — The owner took this story over.');
    expect(read()).toContain('_\n\n- **2026-10-15** — The owner took this story over.\n\n- **2026-10-14** — Added the command centre.\n');
  });

  it('note adds one dated "Design: ..." line to the story file, and nothing else changes', () => {
    const before = read();
    expect(source().note('P1-09', { kind: 'design', title: 'design', summary: 'The architect chose the developer builder.', text: 'body' })).toBe(true);
    const added = read().split('\n').filter((l) => !before.split('\n').includes(l));
    expect(added).toEqual(['- **2026-10-15** — Design: The architect chose the developer builder.']);
    expect(source().note('P1-99', { title: 'design', summary: 'x' })).toBe(false);
  });

  it('file mode adds the missing status line on the first update', () => {
    const noStatus = join(vaultDir, 'Stories', 'P1-05 No status.md');
    writeFileSync(noStatus, '---\ntitle: "No status"\nid: P1-05\nphase: "1"\nphase_order: 1\n---\n\n# P1-05\n');
    expect(source().list().find((s) => s.id === 'P1-05').status).toBe('todo');
    expect(plan().order).toContain('P1-05');
    expect(pickNext({ skip: ['P1-09', 'P1-10'] })?.id).toBe('P1-05');
    expect(pickNext({ id: 'P1-05', strict: true })?.id).toBe('P1-05');
    expect(source().update('P1-05', { status: 'in-progress' })).toBe(true);
    const frontmatter = readFileSync(noStatus, 'utf8').split('\n---\n')[0];
    expect(frontmatter.split('\n').filter((l) => l === 'status: in-progress')).toHaveLength(1);
    expect(frontmatter).not.toMatch(/status: todo/);
    expect(source().list().find((s) => s.id === 'P1-05').status).toBe('in-progress');
  });

  it('file mode reads an empty status line as todo and fills it on the first update', () => {
    const emptyStatus = join(vaultDir, 'Stories', 'P1-06 Empty status.md');
    writeFileSync(emptyStatus, '---\ntitle: "Empty status"\nid: P1-06\nphase: "1"\nphase_order: 1\nstatus:\n---\n\n# P1-06\n');
    expect(source().track).toBe('file');
    expect(source().list().find((s) => s.id === 'P1-06').status).toBe('todo');
    const { order, waiting } = plan();
    expect(order).toContain('P1-06');
    expect(waiting.map((w) => w.id)).not.toContain('P1-06');
    expect(pickNext({ skip: ['P1-09', 'P1-10'] })?.id).toBe('P1-06');
    expect(source().update('P1-06', { status: 'in-progress' })).toBe(true);
    const frontmatter = readFileSync(emptyStatus, 'utf8').split('\n---\n')[0];
    const lines = frontmatter.split('\n');
    expect(lines.filter((l) => l === 'status: in-progress')).toHaveLength(1);
    expect(lines).not.toContain('status:');
    expect(frontmatter).not.toMatch(/status: todo/);
    expect(source().list().find((s) => s.id === 'P1-06').status).toBe('in-progress');
  });

  it('takes an event with a change and ignores an event on its own', () => {
    expect(source().update('P1-09', { ...OWNER_TOOK, event: 'blocked' })).toBe(true);
    expect(read()).toContain('status: blocked');
    const after = read();
    expect(source().update('P1-09', { event: 'review', note: 'Pull request ready for review: https://gh/pull/1' })).toBe(true);
    expect(read()).toBe(after);
    expect(source().update('P1-99', { event: 'review', note: 'x' })).toBe(false);
  });

  it('leaves every other line untouched', () => {
    source().update('P1-09', OWNER_TOOK);
    const changed = new Set(['status: blocked', 'blocked_by: Taken by the owner', '- **2026-10-15** — The owner took this story over.']);
    const before = NOTE.split('\n').filter((l) => l !== 'status: todo' && l !== 'blocked_by:');
    const after = read().split('\n').filter((l) => !changed.has(l));
    // The progress line brings one blank line with it; drop the first blank after the hint.
    const hint = after.findIndex((l) => l.startsWith('_Dated notes'));
    after.splice(hint + 1, 1);
    expect(after).toEqual(before);
  });

  it('adds a missing key before the closing ---, quoting values that need it', () => {
    source().update('P1-09', { fields: { held_by: 'w2: owner #1' } });
    const text = read();
    expect(text).toContain('date: 2026-10-13\nheld_by: "w2: owner #1"\n---\n');
    expect(text).not.toContain('2026-10-15');
  });

  it('accepts logical field names and maps them to the note keys', () => {
    source().update('P1-09', { fields: { blockedBy: 'Waiting', group: '2' } });
    const lines = read().split('\n');
    expect(lines).toContain('blocked_by: Waiting');
    expect(lines).toContain('phase: 2');
    expect(lines).not.toContain('blockedBy: Waiting');
  });

  it('changes nothing in other notes', () => {
    const other = join(vaultDir, 'Stories', 'P1-10 Another story.md');
    const before = readFileSync(other, 'utf8');
    source().update('P1-09', { status: 'done' });
    expect(readFileSync(other, 'utf8')).toBe(before);
  });

  it('returns false for an unknown id', () => {
    expect(source().update('P9-99', { status: 'done' })).toBe(false);
    expect(read()).toBe(NOTE);
  });

  it('adds a progress section when the note has none', () => {
    source().update('P1-10', { note: 'Hello.' });
    expect(readFileSync(join(vaultDir, 'Stories', 'P1-10 Another story.md'), 'utf8')).toMatch(/\n## Progress notes\n\n- \*\*2026-10-15\*\* — Hello\.\n$/);
  });
});

describe('story shape', () => {
  it('fills every field from a vault note', () => {
    story('P2a-01', { phase_order: 2, depends_on: ['P1-01', 'P1-02'], blocked_by: 'x' });
    const [s] = source().list();
    expect(s).toMatchObject({
      id: 'P2a-01', title: 'Story P2a-01', status: 'todo', group: '2a', groupName: 'Foundations', order: 2,
      dependsOn: ['P1-01', 'P1-02'], blockedBy: 'x', ownerTask: false, resources: ['schema'],
    });
    expect(s.ref).toBe(join(vaultDir, 'Stories', 'P2a-01 Story P2a-01.md'));
  });

  it('writes a list value as a frontmatter list', () => {
    story('P1-01');
    source().update('P1-01', { fields: { dependsOn: ['P1-02', 'P1-03'] } });
    expect(source().list()[0].dependsOn).toEqual(['P1-02', 'P1-03']);
    expect(readFileSync(source().list()[0].ref, 'utf8')).toContain('depends_on: [P1-02, P1-03]\n');
  });

  it('ignores a file without an id', () => {
    writeFileSync(join(vaultDir, 'Stories', 'README.md'), '# not a story\n');
    expect(source().list()).toEqual([]);
  });

  it('reads values in single or double quotes as YAML means them, and picks a single-quoted blocked story again', () => {
    // Seen on a real run: P7-07's blocked_by was written in single quotes and never seen as ids.
    story('P6-02', { status: 'done' });
    story('P7-07', { status: 'blocked', blocked_by: "'P6-02 must land first. The route''s tools are not built yet.'" });
    story('P7-08', { status: 'blocked', blocked_by: '"P6-02 must land first. It needs \\"the executor\\"."' });
    writeFileSync(join(vaultDir, 'Stories', 'quoted id.md'), "---\nid: 'P7-09'\ntitle: 'A ''quoted'' title'\nstatus: todo\nphase: '7'\nphase_order: 9\n---\n");
    const byId = (id) => source().list().find((s) => s.id === id);
    expect(byId('P7-07').blockedBy).toBe("P6-02 must land first. The route's tools are not built yet.");
    expect(byId('P7-08').blockedBy).toBe('P6-02 must land first. It needs "the executor".');
    expect(waits(byId('P7-07').blockedBy)).toBe(true);
    expect(byId('P7-09')).toMatchObject({ title: "A 'quoted' title", group: '7' });
    expect(pickNext().id).toBe('P7-07');
    expect(source().update('P7-09', { status: 'in-progress' })).toBe(true);
  });

  it('exposes follow_up_of as followUpOf, and an empty string when there is none', () => {
    writeFileSync(join(vaultDir, 'Stories', 'a.md'), '---\nid: P1-02\nstatus: todo\nfollow_up_of: P1-01\n---\n');
    story('P1-03');
    const byId = (id) => source().list().find((s) => s.id === id);
    expect(byId('P1-02').followUpOf).toBe('P1-01');
    expect(byId('P1-03').followUpOf).toBe('');
  });

  it('reads depends_on written without brackets', () => {
    writeFileSync(join(vaultDir, 'Stories', 'a.md'), '---\nid: P1-02\nstatus: todo\ndepends_on: P1-01, P1-03\n---\n');
    expect(source().list()[0].dependsOn).toEqual(['P1-01', 'P1-03']);
  });
});

describe('plain options', () => {
  let root;
  const plain = () => create({ dir: 'stories' }, { root, stateDir: join(root, '.foreman'), now: NOW });
  const put = (name, text) => writeFileSync(join(root, 'stories', name), text);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'markdown-plain-'));
    mkdirSync(join(root, 'stories'));
    put('S-1.md', '---\nid: S-1\ntitle: One\nstatus: todo\n---\n');
    put('S-2.md', '---\nid: S-2\ntitle: Two\nstatus: todo\ndepends_on: [S-1]\n---\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('picks S-1, waits S-2 on it, then picks S-2 once S-1 is done', () => {
    const pick = () => nextStory(plain().list(), { idPattern: plain().idPattern });
    expect(pick().id).toBe('S-1');
    expect(plain().list().find((s) => s.id === 'S-1')).toMatchObject({ group: '', groupName: '', order: 0 });
    expect(plain().update('S-1', { status: 'done' })).toBe(true);
    expect(pick().id).toBe('S-2');
  });

  it('a story with no status line, or an empty one, is todo and is planned and picked', () => {
    put('S-3.md', '---\nid: S-3\ntitle: Three\n---\n');
    put('S-4.md', '---\nid: S-4\ntitle: Four\nstatus:\n---\n');
    const list = plain().list();
    expect(list.find((s) => s.id === 'S-3').status).toBe('todo');
    expect(list.find((s) => s.id === 'S-4').status).toBe('todo');
    const plan = buildOrder(list, { idPattern: plain().idPattern });
    expect(plan.order).toEqual(expect.arrayContaining(['S-3', 'S-4']));
    expect(plan.waiting.map((w) => w.id)).not.toContain('S-3');
    expect(plan.waiting.map((w) => w.id)).not.toContain('S-4');
    expect(plain().update('S-1', { status: 'done' })).toBe(true);
    expect(plain().update('S-2', { status: 'done' })).toBe(true);
    expect(nextStory(plain().list(), { idPattern: plain().idPattern }).id).toBe('S-3');
  });

  it('ownerTask: {} turns owner-task detection off', () => {
    put('S-5.md', '---\nid: S-5\ntitle: Thing (owner task)\nstatus: todo\n---\n');
    const src = create({ dir: 'stories', ownerTask: {} }, { root, stateDir: join(root, '.foreman') });
    expect(src.list().find((s) => s.id === 'S-5').ownerTask).toBe(false);
  });

  it('uses the default field names and owner-task title', () => {
    put('S-3.md', '---\nid: S-3\ntitle: Do a thing (Owner Task)\nstatus: blocked\nblocked_by: S-1 first\ngroup: g\ngroup_name: G\norder: 4\n---\n');
    expect(plain().list().find((s) => s.id === 'S-3')).toMatchObject({ ownerTask: true, group: 'g', groupName: 'G', order: 4, blockedBy: 'S-1 first' });
  });

  it('marks resources by group', () => {
    put('S-4.md', '---\nid: S-4\nstatus: todo\ngroup: db\n---\n');
    const src = create({ dir: 'stories', resourcesByGroup: { database: ['db'] } }, { root, stateDir: join(root, '.foreman') });
    expect(src.list().find((s) => s.id === 'S-4').resources).toEqual(['database']);
    expect(src.list().find((s) => s.id === 'S-1').resources).toEqual([]);
  });
});

describe('create', () => {
  const X = { root: '/x', stateDir: '/x/.foreman' };
  it('rejects a missing dir', () => {
    expect(() => create({}, X)).toThrow('stories.dir is required');
  });
  it('rejects a bad idPattern', () => {
    expect(() => create({ dir: 's', idPattern: '(' }, X)).toThrow('stories.idPattern is not a valid regular expression');
  });
  it('rejects a bad ownerTask regex and unknown field names', () => {
    expect(() => create({ dir: 's', ownerTask: { id: '[' } }, X)).toThrow('stories.ownerTask.id');
    expect(() => create({ dir: 's', fields: { nope: 'x' } }, X)).toThrow('stories.fields.nope');
  });
  it('rejects empty ownerTask patterns; an empty ownerTask turns detection off', () => {
    expect(() => create({ dir: 's', ownerTask: { id: '' } }, X)).toThrow('stories.ownerTask.id');
    expect(() => create({ dir: 's', ownerTask: { title: '' } }, X)).toThrow('stories.ownerTask.title');
  });
  it('rejects unknown options, non-string groups and anchored idPatterns', () => {
    expect(() => create({ dir: 's', dri: 'x' }, X)).toThrow('stories.dri');
    expect(() => create({ dir: 's', groupSummary: '../e/{group}.md', adapter: 'markdown' }, X)).not.toThrow();
    for (const bad of [{}, '', 5]) expect(() => create({ dir: 's', groupSummary: bad }, X)).toThrow('stories.groupSummary');
    expect(() => create({ dir: 's', resourcesByGroup: { db: [2] } }, X)).toThrow('stories.resourcesByGroup.db');
    expect(() => create({ dir: 's', idPattern: '^S-\\d+' }, X)).toThrow('stories.idPattern');
    expect(() => create({ dir: 's', idPattern: 'S-\\d+$' }, X)).toThrow('stories.idPattern');
  });
  it('exposes the default idPattern', () => {
    expect(create({ dir: 's' }, X).idPattern).toBe(DEFAULT_ID_PATTERN);
  });
  it('takes an absolute dir', () => {
    expect(() => create({ dir: '/definitely/not/here' }, X)).not.toThrow();
  });
  it('rejects a dirEnv or dirEnvSuffix that is not a non-empty string, and a suffix without dirEnv', () => {
    for (const bad of ['', 5, {}]) expect(() => create({ dir: 's', dirEnv: bad }, X)).toThrow('stories.dirEnv');
    for (const bad of ['', 5]) expect(() => create({ dir: 's', dirEnv: 'V', dirEnvSuffix: bad }, X)).toThrow('stories.dirEnvSuffix');
    expect(() => create({ dir: 's', dirEnvSuffix: 'Stories' }, X)).toThrow('stories.dirEnvSuffix needs stories.dirEnv');
  });
});

describe('dirEnv: a folder the environment can move', () => {
  // ACME_VAULT_DIR names the vault root on another machine,
  // and the stories are in its Stories folder.
  const options = (extra) => ({ ...ACME, dir: '/nowhere/v3/Stories', dirEnv: 'ACME_VAULT_DIR', dirEnvSuffix: 'Stories', groupSummary: '../Epics/{group}.md', ...extra });
  const open = (env, extra) => create(options(extra), { root: projectDir, now: NOW, env });

  it('reads the folder the variable names, plus the suffix, when it is set', () => {
    story('P1-01');
    const src = open({ ACME_VAULT_DIR: vaultDir });
    expect(src.list().map((s) => s.ref)).toEqual([join(vaultDir, 'Stories', 'P1-01 Story P1-01.md')]);
    mkdirSync(join(vaultDir, 'Epics'));
    writeFileSync(join(vaultDir, 'Epics', '1.md'), '# Phase 1\n');
    expect(src.groupSummary('1').path).toBe(join(vaultDir, 'Epics', '1.md'));
    expect(src.track).toBe('file');
  });

  it('uses the variable as the folder itself without a suffix', () => {
    story('P1-01');
    expect(open({ ACME_VAULT_DIR: join(vaultDir, 'Stories') }, { dirEnvSuffix: undefined }).list()).toHaveLength(1);
  });

  it('keeps dir when the variable is unset or empty', () => {
    for (const env of [{}, { ACME_VAULT_DIR: '' }]) expect(() => open(env).list()).toThrow('/nowhere/v3/Stories');
  });

  it('reads process.env when no env is passed', () => {
    story('P1-01');
    process.env.FOREMAN_TEST_VAULT = vaultDir;
    try {
      expect(create(options({ dirEnv: 'FOREMAN_TEST_VAULT' }), { root: projectDir }).list()).toHaveLength(1);
    } finally {
      delete process.env.FOREMAN_TEST_VAULT;
    }
  });
});

// The contract, once with the vault options and a vault outside the project (file mode) and
// once with the plain defaults and stories inside the project (state mode).
const fixture = (options, { outside, id }) => () => {
  const root = mkdtempSync(join(tmpdir(), 'markdown-contract-'));
  const folder = outside ? join(mkdtempSync(join(tmpdir(), 'markdown-vault-')), 'Stories') : join(root, 'stories');
  mkdirSync(folder);
  const source = create({ ...options, dir: outside ? folder : 'stories' }, { root, stateDir: join(root, '.foreman') });
  const addStory = (fm, text = '') => {
    const head = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
    writeFileSync(join(folder, `${fm.id}.md`), `---\n${head}\n---\n\n${text}`);
  };
  return { source, addStory, id, ownerTaskTitle: 'Sign off (owner task)', dependsOnLine: (ids) => ({ depends_on: `[${ids.join(', ')}]` }) };
};
storySourceContract({ name: 'markdown file mode (vault options, vault outside the project)', make: fixture({ ...ACME, newId: 'P1-F{n}' }, { outside: true, id: (n) => `P1-0${n}` }), keepsFiles: false, creates: true, notes: true });
storySourceContract({ name: 'markdown state mode (plain options, stories in the project)', make: fixture({}, { outside: false, id: (n) => `S-${n}` }), keepsFiles: true, creates: true, notes: true });

// Stories inside the project's repo: status lives in an overlay in the state folder, and the
// story's own commit marks it done.
describe('track: state', () => {
  let root;
  let state;
  const file = (id = 'S-1') => join(root, 'stories', `${id}.md`);
  const S1 = '---\nid: S-1\ntitle: One\nstatus: todo\nblocked_by:\n---\n\n# S-1\n\n## Progress notes\n\n_Newest first._\n\n- **2026-10-01** — Written.\n';
  const src = (opts = {}, ctx = {}) => create({ dir: 'stories', ...opts }, { root, stateDir: state, now: NOW, ...ctx });
  const overlay = (id = 'S-1') => JSON.parse(readFileSync(join(state, 'stories', `${id}.json`), 'utf8'));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'markdown-state-'));
    state = join(root, '.foreman');
    mkdirSync(join(root, 'stories'));
    writeFileSync(file(), S1);
    writeFileSync(file('S-2'), '---\nid: S-2\ntitle: Two\nstatus: todo\ndepends_on: [S-1]\n---\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('update writes the overlay and leaves the story file byte-identical', () => {
    const before = readFileSync(file());
    expect(src().update('S-1', { status: 'blocked', fields: { blockedBy: 'needs a key', started: '2026-10-15' }, note: 'Blocked: needs a key' })).toBe(true);
    expect(readFileSync(file())).toEqual(before);
    expect(overlay()).toEqual({ id: 'S-1', status: 'blocked', blockedBy: 'needs a key', fields: { started: '2026-10-15' }, notes: [{ date: '2026-10-15', text: 'Blocked: needs a key' }] });
    src().update('S-1', { status: 'todo', note: 'Put back.' });
    expect(overlay()).toMatchObject({ status: 'todo', blockedBy: 'needs a key', notes: [{ text: 'Put back.' }, { text: 'Blocked: needs a key' }] });
    expect(readdir(join(state, 'stories'))).toEqual(['S-1.json']);
  });

  it('note adds one dated progress line, the title capitalised and the summary on one line, to the overlay only', () => {
    const before = readFileSync(file());
    const long = `${'word '.repeat(150)}end`;
    expect(src().note('S-1', { kind: 'design', title: 'design', summary: `The architect chose\nthe developer builder. ${long}`, text: 'ignored body' })).toBe(true);
    const [first] = overlay().notes;
    expect(overlay().notes).toHaveLength(1);
    expect(first.date).toBe('2026-10-15');
    expect(first.text.startsWith('Design: The architect chose the developer builder. word')).toBe(true);
    expect(first.text).not.toContain('\n');
    expect(first.text.length).toBeLessThanOrEqual(500);
    expect(first.text).not.toContain('ignored body');
    expect(readFileSync(file())).toEqual(before);
  });

  it('note returns false, and does not throw, when the stories folder is not there', () => {
    rmSync(join(root, 'stories'), { recursive: true });
    expect(src().note('S-1', { title: 'design', summary: 'x' })).toBe(false);
  });

  it('note returns false for an unknown id and writes nothing', () => {
    expect(src().note('S-9', { title: 'design', summary: 'x' })).toBe(false);
    expect(existsSync(join(state, 'stories'))).toBe(false);
  });

  it('takes the raw frontmatter key for blocked_by too', () => {
    src().update('S-1', { status: 'blocked', fields: { blocked_by: 'x' } });
    expect(overlay()).toMatchObject({ status: 'blocked', blockedBy: 'x', fields: {} });
  });

  it('update returns false for an unknown id and writes nothing', () => {
    expect(src().update('S-9', { status: 'done' })).toBe(false);
    expect(existsSync(join(state, 'stories'))).toBe(false);
  });

  it('list reflects the overlay status, blockedBy and fields', () => {
    src().update('S-1', { status: 'blocked', fields: { blockedBy: 'needs a key', group: 'g' } });
    expect(src().list().find((s) => s.id === 'S-1')).toMatchObject({ status: 'blocked', blockedBy: 'needs a key', group: 'g', ref: file() });
    expect(nextStory(src().list(), { idPattern: src().idPattern })).toBeNull();
  });

  it('a file saying done or retired beats the overlay', () => {
    src().update('S-1', { status: 'in-progress', fields: { blockedBy: 'x' } });
    writeFileSync(file(), S1.replace('status: todo', 'status: done'));
    expect(src().list().find((s) => s.id === 'S-1')).toMatchObject({ status: 'done', blockedBy: '' });
    writeFileSync(file(), S1.replace('status: todo', 'status: retired'));
    expect(src().list().find((s) => s.id === 'S-1').status).toBe('retired');
  });

  it('a story file with no status takes the overlay status and stays byte-identical', () => {
    const text = '---\nid: S-3\ntitle: Three\n---\n\n# S-3\n';
    writeFileSync(file('S-3'), text);
    const before = readFileSync(file('S-3'));
    expect(src().list().find((s) => s.id === 'S-3').status).toBe('todo');
    expect(src().update('S-3', { status: 'in-progress', note: 'Started.' })).toBe(true);
    expect(src().list().find((s) => s.id === 'S-3').status).toBe('in-progress');
    expect(readFileSync(file('S-3'))).toEqual(before);
    expect(readFileSync(src().brief('S-3').path, 'utf8')).toContain('status: in-progress');
  });

  it('brief returns the story file when there is no overlay', () => {
    expect(src().brief('S-1')).toEqual({ path: file() });
    src().update('S-1', { status: 'in-progress' });
    expect(src().brief('S-1')).toEqual({ path: file() });
  });

  it('brief writes a merged view with the overlay notes, newest first', () => {
    src().update('S-1', { status: 'in-progress', note: 'Started.' });
    src().update('S-1', { status: 'blocked', fields: { blockedBy: 'needs a key' }, note: 'Blocked: needs a key' });
    const before = readFileSync(file());
    const { path } = src().brief('S-1');
    expect(path).toBe(join(state, 'briefs', 'S-1.md'));
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('status: blocked\nblocked_by: needs a key\n');
    expect(text).toContain('_Newest first._\n\n- **2026-10-15** — Blocked: needs a key\n\n- **2026-10-15** — Started.\n\n- **2026-10-01** — Written.\n');
    expect(readFileSync(file())).toEqual(before);
  });

  it('needs a state folder', () => {
    expect(() => create({ dir: 'stories' }, { root })).toThrow(/state/);
    expect(() => create({ dir: 'stories', track: 'file' }, { root })).not.toThrow();
  });

  it('finalize in file mode changes nothing', () => {
    const before = readFileSync(file());
    expect(src({ track: 'file' }).finalize('S-1', { note: 'Works.', cwd: root })).toEqual({ path: null });
    expect(readFileSync(file())).toEqual(before);
  });
});

describe('track: the default and the option', () => {
  let root;
  let outside;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'markdown-track-'));
    outside = mkdtempSync(join(tmpdir(), 'markdown-outside-'));
    mkdirSync(join(root, 'stories'));
    writeFileSync(join(root, 'stories', 'S-1.md'), '---\nid: S-1\nstatus: todo\n---\n');
    writeFileSync(join(outside, 'S-1.md'), '---\nid: S-1\nstatus: todo\n---\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const ctx = () => ({ root, stateDir: join(root, '.foreman') });
  const statusIn = (f) => readFileSync(f, 'utf8').match(/status: (.*)/)[1];

  it('a folder inside the project is tracked in state', () => {
    expect(create({ dir: 'stories' }, ctx()).track).toBe('state');
    expect(create({ dir: join(root, 'stories') }, ctx()).track).toBe('state');
    create({ dir: 'stories' }, ctx()).update('S-1', { status: 'blocked' });
    expect(statusIn(join(root, 'stories', 'S-1.md'))).toBe('todo');
  });

  it('a folder outside the project is tracked in the files', () => {
    expect(create({ dir: outside }, ctx()).track).toBe('file');
    expect(create({ dir: '../x' }, ctx()).track).toBe('file');
    create({ dir: outside }, ctx()).update('S-1', { status: 'blocked' });
    expect(statusIn(join(outside, 'S-1.md'))).toBe('blocked');
  });

  it('an explicit track wins', () => {
    expect(create({ dir: 'stories', track: 'file' }, ctx()).track).toBe('file');
    expect(create({ dir: outside, track: 'state' }, ctx()).track).toBe('state');
    create({ dir: 'stories', track: 'file' }, ctx()).update('S-1', { status: 'blocked' });
    expect(statusIn(join(root, 'stories', 'S-1.md'))).toBe('blocked');
  });

  it('rejects an unknown track', () => {
    expect(() => create({ dir: 'stories', track: 'git' }, ctx())).toThrow('stories.track');
  });
});

// finalize edits the story file in the worktree the story is built in, so the story's commit
// carries `done` and the base branch reads done exactly when its pull request merges.
describe('finalize in a worktree', () => {
  let base;
  let main;
  let tree;
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const S1 = '---\nid: S-1\ntitle: One\nstatus: todo\ncompleted:\n---\n\n# S-1\n\n## Progress notes\n\n- **2026-10-01** — Written.\n';
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'markdown-finalize-')));
    main = join(base, 'main');
    tree = join(base, 'w1');
    mkdirSync(join(main, 'stories'), { recursive: true });
    writeFileSync(join(main, 'stories', 'S-1.md'), S1);
    writeFileSync(join(main, '.gitignore'), '.foreman/\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    git(main, 'worktree', 'add', '-q', '--detach', tree);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const src = () => create({ dir: 'stories' }, { root: main, stateDir: join(main, '.foreman'), now: NOW });

  it('marks the worktree copy done with the history, and leaves the main checkout alone', () => {
    src().update('S-1', { status: 'in-progress', fields: { started: '2026-10-14' }, note: 'Started.' });
    const { path } = src().finalize('S-1', { note: 'Login works; tested by hand.', cwd: join(tree, 'stories') });
    expect(path).toBe(join(tree, 'stories', 'S-1.md'));
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('status: done\ncompleted: 2026-10-15\n');
    expect(text).toContain('## Progress notes\n\n- **2026-10-15** — Login works; tested by hand.\n\n- **2026-10-15** — Started.\n\n- **2026-10-01** — Written.\n');
    expect(readFileSync(join(main, 'stories', 'S-1.md'), 'utf8')).toBe(S1);
    expect(git(main, 'status', '--porcelain')).toBe('');
  });

  it('run twice, it does not repeat the notes', () => {
    src().update('S-1', { note: 'Started.' });
    src().finalize('S-1', { note: 'Works.', cwd: tree });
    const once = readFileSync(join(tree, 'stories', 'S-1.md'), 'utf8');
    src().finalize('S-1', { note: 'Works.', cwd: tree });
    expect(readFileSync(join(tree, 'stories', 'S-1.md'), 'utf8')).toBe(once);
  });

  it('returns null for an unknown id', () => {
    expect(src().finalize('S-9', { note: 'x', cwd: tree })).toBeNull();
  });
});

// With pull requests merging into a stage branch (ctx.shippedOn), finalize never edits a story
// file that is on the base branch: it writes the story's shipped record, and list() reads the
// records on <remote>/<branch> and in dir.
describe('stage branches (ctx.shippedOn)', () => {
  let base;
  let main;
  let tree;
  let nowAt;
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const note = (n) => `---\nid: S-${n}\ntitle: ${n === 1 ? 'One' : 'Two'}\nstatus: todo\ncompleted:\n---\n\n# S-${n}\n\n## Progress notes\n\n- **2026-10-01** — Written.\n`;
  const S1 = note(1);
  const ON = { remote: 'origin', branch: 'qa' };
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'markdown-stages-unit-')));
    main = join(base, 'main');
    tree = join(base, 'w1');
    nowAt = NOW();
    mkdirSync(join(main, 'stories'), { recursive: true });
    writeFileSync(join(main, 'stories', 'S-1.md'), S1);
    writeFileSync(join(main, 'stories', 'S-2.md'), note(2));
    writeFileSync(join(main, '.gitignore'), '.foreman/\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '.');
    git(main, 'commit', '-qm', 'init');
    git(main, 'worktree', 'add', '-q', '--detach', tree);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const src = (extra = {}, options = {}) =>
    create({ dir: 'stories', ...options }, { root: main, stateDir: join(main, '.foreman'), now: () => nowAt, shippedOn: ON, ...extra });
  const record = (id) => join(tree, 'stories', '.shipped', `${id}.json`);
  const recordOf = (id) => JSON.parse(readFileSync(record(id), 'utf8'));
  // refs/remotes/origin/qa points at a commit whose tree holds these records.
  const putRecords = (ids) => {
    const side = join(base, 'side');
    git(main, 'worktree', 'add', '-q', '--detach', side);
    mkdirSync(join(side, 'stories', '.shipped'), { recursive: true });
    for (const id of ids) writeFileSync(join(side, 'stories', '.shipped', `${id}.json`), `${JSON.stringify({ id, status: 'done', completed: '2026-10-14', notes: [] })}\n`);
    git(side, 'add', '-A', '-f');
    git(side, 'commit', '-qm', 'records');
    git(main, 'update-ref', 'refs/remotes/origin/qa', git(side, 'rev-parse', 'HEAD'));
    git(main, 'worktree', 'remove', '--force', side);
  };
  const statuses = (source = src()) => Object.fromEntries(source.list().map((s) => [s.id, s.status]));

  describe('finalize', () => {
    it('leaves the story file alone and writes the shipped record', () => {
      src().update('S-1', { status: 'in-progress', note: 'Started.' });
      const { path } = src().finalize('S-1', { note: 'Login works.', cwd: tree });
      expect(path).toBe(record('S-1'));
      expect(readFileSync(join(tree, 'stories', 'S-1.md'), 'utf8')).toBe(S1);
      expect(recordOf('S-1')).toEqual({ id: 'S-1', status: 'done', completed: '2026-10-15', notes: [{ date: '2026-10-15', text: 'Login works.' }, { date: '2026-10-15', text: 'Started.' }] });
      expect(git(main, 'status', '--porcelain')).toBe('');
    });

    it('run twice with the same note it writes the same bytes; another note keeps both, newest first', () => {
      src().update('S-1', { note: 'Started.' });
      src().finalize('S-1', { note: 'Works.', cwd: tree });
      const once = readFileSync(record('S-1'), 'utf8');
      src().finalize('S-1', { note: 'Works.', cwd: tree });
      expect(readFileSync(record('S-1'), 'utf8')).toBe(once);
      src().finalize('S-1', { note: 'Fixed.', cwd: tree });
      expect(recordOf('S-1').notes.map((n) => n.text)).toEqual(['Fixed.', 'Works.', 'Started.']);
    });

    it('with no note the record holds the overlay notes only', () => {
      src().update('S-1', { note: 'Started.' });
      src().finalize('S-1', { cwd: tree });
      expect(recordOf('S-1').notes.map((n) => n.text)).toEqual(['Started.']);
    });

    it('writes a waiting note into the checkout, marked done, and its record too', () => {
      const made = src().create({ title: 'New', what: 'x', doneWhen: 'y' });
      const { path } = src().finalize(made.id, { note: 'Built.', cwd: tree });
      expect(path).toBe(record(made.id));
      const written = readFileSync(join(tree, 'stories', `${made.id}.md`), 'utf8');
      expect(written).toContain('\nstatus: done\n');
      expect(written).toContain('\ncompleted: 2026-10-15\n');
      expect(written).toContain('— Built.');
      expect(recordOf(made.id)).toMatchObject({ id: made.id, status: 'done' });
    });

    it('returns null for an unknown id', () => {
      expect(src().finalize('S-9', { note: 'x', cwd: tree })).toBeNull();
    });

    it('ignores shippedOn in file mode: nothing is written', () => {
      const file = src({}, { track: 'file' });
      expect(file.finalize('S-1', { note: 'x', cwd: tree })).toEqual({ path: null });
      expect(existsSync(join(tree, 'stories', '.shipped'))).toBe(false);
    });
  });

  describe('list', () => {
    it('reads a record on the remote stage branch as done', () => {
      putRecords(['S-1']);
      expect(statuses()).toEqual({ 'S-1': 'done', 'S-2': 'todo' });
    });

    it('a record beats an overlay saying in-progress or blocked', () => {
      putRecords(['S-1']);
      src().update('S-1', { status: 'in-progress' });
      expect(statuses()['S-1']).toBe('done');
      src().update('S-1', { status: 'blocked' });
      expect(statuses()['S-1']).toBe('done');
    });

    it('does not override ready-to-promote or a retired note', () => {
      putRecords(['S-1', 'S-2']);
      src().update('S-1', { status: 'ready-to-promote' });
      writeFileSync(join(main, 'stories', 'S-2.md'), note(2).replace('status: todo', 'status: retired'));
      expect(statuses()).toEqual({ 'S-1': 'ready-to-promote', 'S-2': 'retired' });
    });

    it('reads a record already in the checkout (promoted to base) as done', () => {
      mkdirSync(join(main, 'stories', '.shipped'));
      writeFileSync(join(main, 'stories', '.shipped', 'S-2.json'), '{}\n');
      expect(statuses()).toEqual({ 'S-1': 'todo', 'S-2': 'done' });
    });

    it('does not throw with no ref, or with a folder outside any git repo', () => {
      src().update('S-1', { status: 'in-progress' });
      expect(statuses()).toEqual({ 'S-1': 'in-progress', 'S-2': 'todo' });
      const loose = mkdtempSync(join(tmpdir(), 'markdown-loose-'));
      try {
        mkdirSync(join(loose, 'stories'));
        writeFileSync(join(loose, 'stories', 'S-1.md'), S1);
        const outside = create({ dir: 'stories', track: 'state' }, { root: loose, stateDir: join(loose, '.foreman'), now: NOW, shippedOn: ON });
        expect(Object.fromEntries(outside.list().map((s) => [s.id, s.status]))).toEqual({ 'S-1': 'todo' });
      } finally {
        rmSync(loose, { recursive: true, force: true });
      }
    });

    it('does not throw when <stories dir>/.shipped is a file, with or without shippedOn', () => {
      writeFileSync(join(main, 'stories', '.shipped'), 'stray\n');
      src().update('S-1', { status: 'in-progress' });
      expect(statuses()).toEqual({ 'S-1': 'in-progress', 'S-2': 'todo' });
      expect(statuses(src({ shippedOn: undefined }))).toEqual({ 'S-1': 'in-progress', 'S-2': 'todo' });
      putRecords(['S-2']);
      nowAt = new Date(nowAt.getTime() + SHIPPED_TTL_MS + 1);
      expect(statuses()['S-2']).toBe('done');
    });

    it('reads the remote ref again only after the cache time', () => {
      expect(statuses()).toEqual({ 'S-1': 'todo', 'S-2': 'todo' });
      putRecords(['S-1']);
      expect(statuses()['S-1']).toBe('todo');
      nowAt = new Date(nowAt.getTime() + SHIPPED_TTL_MS + 1);
      expect(statuses()['S-1']).toBe('done');
    });

    it('ignores records in file mode', () => {
      putRecords(['S-1']);
      expect(statuses(src({}, { track: 'file' }))['S-1']).toBe('todo');
    });

    it('without shippedOn a record on the ref means nothing', () => {
      putRecords(['S-1']);
      expect(statuses(src({ shippedOn: undefined }))['S-1']).toBe('todo');
    });
  });
});

function readdir(d) {
  return existsSync(d) ? readdirSync(d).sort() : [];
}

describe('groupSummary', () => {
  const OPTS = { groupSummary: '../Epics/{groupLabel} {group} — {groupName}.md', groupLabel: 'Phase' };
  const withSummary = (opts = OPTS) => create({ ...ACME, ...opts, dir: join(vaultDir, 'Stories') }, { root: projectDir, now: NOW });
  const epic = () => join(vaultDir, 'Epics', 'Phase 1 — Foundations.md');
  const writeEpic = (text) => {
    mkdirSync(join(vaultDir, 'Epics'), { recursive: true });
    writeFileSync(epic(), text);
  };

  it('resolves the placeholders to the epic note and says it is needed when the group is done', () => {
    story('P1-01', { status: 'done' });
    story('P1-02', { status: 'done' });
    story('P1-03', { status: 'retired' });
    writeEpic('# Phase 1\n');
    expect(withSummary().groupSummary('1')).toEqual({ path: epic(), needed: true });
  });

  it('is not needed when the note already says the group finished', () => {
    story('P1-01', { status: 'done' });
    writeEpic('# Phase 1\n\n## Phase 1 is finished\n');
    expect(withSummary().groupSummary('1').needed).toBe(false);
    writeEpic('Phase 1 finished on 2026-10-01\n');
    expect(withSummary().groupSummary('1').needed).toBe(false);
  });

  it('is not needed while a story is open', () => {
    story('P1-01', { status: 'done' });
    story('P1-02', { status: 'in-progress' });
    writeEpic('# Phase 1\n');
    expect(withSummary().groupSummary('1')).toEqual({ path: epic(), needed: false });
  });

  it('is not needed when the note is missing', () => {
    story('P1-01', { status: 'done' });
    expect(withSummary().groupSummary('1')).toEqual({ path: epic(), needed: false });
  });

  it('is null without the option, or for a group with no stories', () => {
    story('P1-01', { status: 'done' });
    expect(withSummary({}).groupSummary('1')).toBeNull();
    expect(withSummary().groupSummary('9')).toBeNull();
  });
});

// create(): a new story, such as a follow-up proposed from minor findings.
const FOLLOW = { title: 'Follow-ups from S-3', what: '- `a.js`: no test — fix: add one', doneWhen: 'Each listed finding is fixed.', origin: 'S-3' };

describe('create a story, file mode (a vault outside the project)', () => {
  const dir = () => join(vaultDir, 'Stories');
  const plain = (extra = {}) => create({ dir: dir(), ...extra }, { root: projectDir, now: NOW });
  const acme = (extra = {}) => create({ ...ACME, dir: dir(), newId: 'P{group}-F{n}', ...extra }, { root: projectDir, now: NOW });
  const put = (name, text) => writeFileSync(join(dir(), name), text);

  it('numbers new ids F-1, F-2 by default, after the highest F id already used', () => {
    put('S-3.md', '---\nid: S-3\ntitle: Three\nstatus: done\n---\n');
    expect(plain().create(FOLLOW).id).toBe('F-1');
    expect(plain().create(FOLLOW).id).toBe('F-2');
    put('F-7.md', '---\nid: F-7\ntitle: Old\nstatus: done\n---\n');
    expect(plain().create(FOLLOW).id).toBe('F-8');
  });

  it('writes the note straight into the folder, in the layout of the other notes', () => {
    put('S-3.md', '---\nid: S-3\ntitle: Three\nstatus: done\n---\n');
    const made = plain().create({ ...FOLLOW, dependsOn: ['S-1', 'S-2'] });
    expect(made).toEqual({ id: 'F-1', path: join(dir(), 'F-1.md') });
    expect(readFileSync(made.path, 'utf8')).toBe(
      '---\nid: F-1\ntitle: Follow-ups from S-3\nstatus: todo\ndepends_on: [S-1, S-2]\nfollow_up_of: S-3\n---\n\n' +
        '# F-1 · Follow-ups from S-3\n\n## What\n\n- `a.js`: no test — fix: add one\n\n## Done when\n\nEach listed finding is fixed.\n\n' +
        '## Progress notes\n\n_Newest first._\n',
    );
    expect(plain().list().find((s) => s.id === 'F-1')).toMatchObject({ status: 'todo', dependsOn: ['S-1', 'S-2'], ref: made.path });
  });

  it('fills {group} from the origin story, copies its group fields, and names the file the way the origin is named', () => {
    story('P2a-03', { phase: '2a', title: 'Keep an audit table', status: 'done' });
    story('P2a-F3', { phase: '2a', title: 'Older follow-ups', status: 'done' });
    story('P4-F9', { phase: '4', title: 'Other group', status: 'done' });
    const made = acme().create({ ...FOLLOW, title: 'Follow-ups from P2a-03', origin: 'P2a-03' });
    expect(made).toEqual({ id: 'P2a-F4', path: join(dir(), 'P2a-F4 Follow-ups from P2a-03.md') });
    const text = readFileSync(made.path, 'utf8');
    expect(text).toContain('id: P2a-F4\ntitle: Follow-ups from P2a-03\nstatus: todo\nphase: 2a\nphase_name: Foundations\nphase_order: 1\ndepends_on: []\nfollow_up_of: P2a-03\n');
    expect(acme().list().find((s) => s.id === 'P2a-F4')).toMatchObject({ group: '2a', groupName: 'Foundations', order: 1 });
  });

  it('refuses an id that does not match idPattern', () => {
    put('S-3.md', '---\nid: S-3\ntitle: Three\nstatus: done\n---\n');
    expect(() => plain({ newId: 'f{n}' }).create(FOLLOW)).toThrow(/idPattern/);
    expect(readdir(dir())).toEqual(['S-3.md']);
  });

  it('refuses {group} when the origin has none, an unknown origin, and an empty title', () => {
    put('S-3.md', '---\nid: S-3\ntitle: Three\nstatus: done\n---\n');
    expect(() => plain({ newId: 'S{group}-{n}' }).create(FOLLOW)).toThrow(/group/);
    expect(() => plain().create({ ...FOLLOW, origin: 'S-9' })).toThrow(/S-9/);
    expect(() => plain().create({ ...FOLLOW, title: '' })).toThrow(/title/);
  });

  it('checks the newId option', () => {
    for (const bad of ['', 5, 'F-', 'F-{n}-{n}', 'F-{x}{n}']) expect(() => plain({ newId: bad })).toThrow('stories.newId');
    expect(() => plain({ newId: 'P{group}-F{n}' })).not.toThrow();
  });
});

describe('create a story, state mode (stories in the repo)', () => {
  let base;
  let main;
  let tree;
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const S3 = '---\nid: S-3\ntitle: Three\nstatus: done\n---\n\n# S-3\n';
  const state = () => join(main, '.foreman');
  const pending = (id = 'F-1') => join(state(), 'stories', 'new', `${id}.md`);
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'markdown-create-')));
    main = join(base, 'main');
    tree = join(base, 'w1');
    mkdirSync(join(main, 'stories'), { recursive: true });
    writeFileSync(join(main, 'stories', 'S-3.md'), S3);
    writeFileSync(join(main, '.gitignore'), '.foreman/\n');
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'add', '.');
    git(main, 'commit', '-qm', 'init');
    git(main, 'worktree', 'add', '-q', '--detach', tree);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const src = () => create({ dir: 'stories' }, { root: main, stateDir: state(), now: NOW });

  it('never writes into the main checkout; the note waits in the state folder', () => {
    const made = src().create(FOLLOW);
    expect(made).toEqual({ id: 'F-1', path: pending() });
    expect(git(main, 'status', '--porcelain')).toBe('');
    expect(readdir(join(main, 'stories'))).toEqual(['S-3.md']);
    expect(readFileSync(pending(), 'utf8')).toContain('id: F-1\ntitle: Follow-ups from S-3\nstatus: todo\n');
  });

  it('list shows the waiting note, brief returns its path, and numbering counts it', () => {
    src().create(FOLLOW);
    expect(src().list().find((s) => s.id === 'F-1')).toMatchObject({ status: 'todo', ref: pending(), title: 'Follow-ups from S-3' });
    expect(src().brief('F-1')).toEqual({ path: pending() });
    expect(src().create(FOLLOW).id).toBe('F-2');
  });

  it('takes the overlay like any other story', () => {
    src().create(FOLLOW);
    src().update('F-1', { status: 'in-progress', note: 'Started.' });
    expect(src().list().find((s) => s.id === 'F-1').status).toBe('in-progress');
    expect(readFileSync(src().brief('F-1').path, 'utf8')).toContain('- **2026-10-15** — Started.');
    expect(readFileSync(pending(), 'utf8')).toContain('status: todo');
  });

  it('finalize in the worktree creates the story file there, marked done, so the PR adds it', () => {
    src().create(FOLLOW);
    src().update('F-1', { status: 'in-progress', note: 'Started.' });
    const { path } = src().finalize('F-1', { note: 'All fixed.', cwd: tree });
    expect(path).toBe(join(tree, 'stories', 'F-1.md'));
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('status: done\n');
    expect(text).toContain('completed: 2026-10-15\n');
    expect(text).toContain('## What\n\n- `a.js`: no test — fix: add one\n');
    expect(text).toContain('_Newest first._\n\n- **2026-10-15** — All fixed.\n\n- **2026-10-15** — Started.\n');
    expect(git(tree, 'status', '--porcelain')).toBe('?? stories/F-1.md');
    expect(git(main, 'status', '--porcelain')).toBe('');
    // Run again (a fix round), it edits the file it made and repeats nothing.
    src().finalize('F-1', { note: 'All fixed.', cwd: tree });
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('once the base branch has the file, the real file wins and the waiting copy goes', () => {
    src().create(FOLLOW);
    src().finalize('F-1', { note: 'All fixed.', cwd: tree });
    git(tree, 'add', '.');
    git(tree, 'commit', '-qm', 'F-1 Follow-ups from S-3');
    git(main, 'merge', '-q', '--ff-only', git(tree, 'rev-parse', 'HEAD'));
    const stories = src().list().filter((s) => s.id === 'F-1');
    expect(stories).toEqual([expect.objectContaining({ status: 'done', ref: join(main, 'stories', 'F-1.md') })]);
    expect(existsSync(pending())).toBe(false);
    expect(src().create(FOLLOW).id).toBe('F-2');
  });
});

describe('storiesDirOf', () => {
  const root = '/acme/project';
  it('is the dir under the project root', () => {
    expect(storiesDirOf({ dir: 'stories' }, { root, env: {} })).toBe(resolve(root, 'stories'));
  });
  it("is dirEnv's value joined with the suffix when the variable is set", () => {
    const options = { dir: 'stories', dirEnv: 'ACME_VAULT', dirEnvSuffix: 'Stories' };
    expect(storiesDirOf(options, { root, env: { ACME_VAULT: '/acme/vault' } })).toBe(resolve(root, '/acme/vault', 'Stories'));
  });
  it('falls back to dir when dirEnv is unset or empty', () => {
    const options = { dir: 'stories', dirEnv: 'ACME_VAULT' };
    expect(storiesDirOf(options, { root, env: {} })).toBe(resolve(root, 'stories'));
    expect(storiesDirOf(options, { root, env: { ACME_VAULT: '' } })).toBe(resolve(root, 'stories'));
  });
});
