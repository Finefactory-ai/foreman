import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addItem, currentItems, itemText, keepItem, readLedger, refuseItem, undoItem, updateItem } from './learning-store.mjs';
import { rolledBack } from './learning-eval.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-learning-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = new Date('2026-10-24T09:00:00Z');
const at = { now };
const sha = (text) => createHash('sha256').update(text).digest('hex');
const read = (rel) => readFileSync(join(dir, rel), 'utf8');
const bytes = (rel) => readFileSync(join(dir, rel));
const ledgerText = () => readFileSync(join(dir, 'learning.jsonl'), 'utf8');
const lines = () => readLedger(dir);
const last = () => lines().at(-1);
const items = () => currentItems(lines());
const ROLE = 'learned/traits/developer.md';
const V1 = 'Acme: every route has a test that fails if it breaks';
const V2 = 'Acme: every route and every error path has a test that fails if it breaks';
const trait = (text = V1, extra = {}) => addItem(dir, { kind: 'trait', roles: ['developer'], text, source: { key: 'untested-routes', stories: ['S-1', 'S-2'] }, reason: 'two stories shipped untested routes', metrics: null, ...extra }, at);
const skill = (slug = 'acme-routes', text = '---\nname: foreman-learned-acme-routes\ndescription: Use when adding a route\n---\n\n# Steps\n') => addItem(dir, { kind: 'skill', roles: ['developer', 'tester'], slug, text, source: null, reason: 'routes keep breaking' }, at);
// Every file under learned/, relative and sorted.
const learnedFiles = () => {
  const out = [];
  const walk = (rel) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('learned');
  return out.sort();
};
const snapshotOf = () => {
  const out = {};
  for (const f of learnedFiles()) out[f] = read(f);
  return { files: out, ledger: existsSync(join(dir, 'learning.jsonl')) ? ledgerText() : null };
};

describe('addItem', () => {
  it('adds a trait: the role file, the v1 snapshot and one add line', () => {
    const r = trait();
    expect(r).toMatchObject({ ok: true, id: 'L-1' });
    expect(read(ROLE)).toBe(`[L-1] ${V1}\n`);
    expect(read('learned/.history/L-1/v1.md')).toBe(V1);
    const ls = lines();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ at: now.toISOString(), id: 'L-1', v: 1, action: 'add', kind: 'trait', roles: ['developer'], path: ROLE, before: null, by: 'foreman', source: { key: 'untested-routes', stories: ['S-1', 'S-2'] } });
    expect(ls[0].after).toEqual({ snapshot: 'learned/.history/L-1/v1.md', sha256: sha(read('learned/.history/L-1/v1.md')) });
    expect(r.line).toEqual(ls[0]);
  });

  it('adds a skill as its own SKILL.md', () => {
    const r = skill();
    expect(r.ok).toBe(true);
    expect(read('learned/skills/foreman-learned-acme-routes/SKILL.md')).toContain('Use when adding a route');
    expect(last()).toMatchObject({ kind: 'skill', roles: ['developer', 'tester'], path: 'learned/skills/foreman-learned-acme-routes/SKILL.md' });
  });

  it('refuses a second trait on a role whose sibling snapshot was changed, with add wording, and writes nothing', () => {
    trait();
    const refusal = { action: 'refused', id: null, kind: 'trait', roles: ['developer'], before: null, after: null, reason: 'the snapshot of L-1 v1 is missing or changed; nothing was added' };
    writeFileSync(join(dir, 'learned/.history/L-1/v1.md'), 'something else');
    let before = snapshotOf();
    let r = trait('Acme: say what failed in plain words');
    expect(r.ok).toBe(false);
    expect(r.line).toEqual(last());
    expect(last()).toMatchObject(refusal);
    expect(Object.keys(last())).not.toContain('text');
    expect(snapshotOf().files).toEqual(before.files);
    expect(ledgerText()).not.toContain('say what failed');
    rmSync(join(dir, 'learned/.history/L-1/v1.md'));
    before = snapshotOf();
    r = trait('Acme: say what failed in plain words');
    expect(r.ok).toBe(false);
    expect(last()).toMatchObject(refusal);
    expect(snapshotOf().files).toEqual(before.files);
    expect(ledgerText()).not.toContain('say what failed');
  });
});

describe('updateItem', () => {
  it('writes v2 beside v1 and re-renders the role file', () => {
    trait();
    const r = updateItem(dir, 'L-1', { text: V2, source: null, reason: 'errors too' }, at);
    expect(r).toMatchObject({ ok: true, id: 'L-1' });
    expect(read('learned/.history/L-1/v1.md')).toBe(V1);
    expect(read('learned/.history/L-1/v2.md')).toBe(V2);
    expect(read(ROLE)).toBe(`[L-1] ${V2}\n`);
    const add = lines()[0];
    expect(last()).toMatchObject({ action: 'update', id: 'L-1', v: 2, before: add.after, after: { snapshot: 'learned/.history/L-1/v2.md', sha256: sha(V2) } });
  });

  it('refuses an update when a sibling snapshot was changed, with update wording', () => {
    trait();
    trait('Acme: say what failed in plain words');
    writeFileSync(join(dir, 'learned/.history/L-1/v1.md'), 'something else');
    const before = snapshotOf();
    const r = updateItem(dir, 'L-2', { text: V2 }, at);
    expect(r.ok).toBe(false);
    expect(r.line).toEqual(last());
    expect(last()).toMatchObject({ action: 'refused', id: 'L-2', before: null, after: null, reason: 'the snapshot of L-1 v1 is missing or changed; nothing was updated' });
    expect(snapshotOf().files).toEqual(before.files);
    expect(existsSync(join(dir, 'learned/.history/L-2/v2.md'))).toBe(false);
    expect(items().get('L-2').v).toBe(1);
    expect(ledgerText()).not.toContain(V2);
  });
});

describe('undoItem', () => {
  it('undoing an update restores v1 byte for byte', () => {
    trait();
    const v1Bytes = bytes(ROLE);
    updateItem(dir, 'L-1', { text: V2 }, at);
    const r = undoItem(dir, 'L-1', at);
    expect(r.ok).toBe(true);
    expect(bytes(ROLE).equals(v1Bytes)).toBe(true);
    const [add, update, undo] = lines();
    expect(undo).toMatchObject({ action: 'undo', id: 'L-1', v: 1, by: 'owner', before: update.after, after: add.after });
    expect(undo.after.sha256).toBe(add.after.sha256);
    expect(items().get('L-1')).toMatchObject({ v: 1, status: 'evaluating' });
  });

  it('undoing an add of a lone trait deletes the role file', () => {
    trait();
    const r = undoItem(dir, 'L-1', at);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, ROLE))).toBe(false);
    expect(last()).toMatchObject({ action: 'undo', v: 0, after: null });
    expect(items().get('L-1').status).toBe('removed');
  });

  it('undoing one of two traits on a role leaves the other', () => {
    trait();
    trait('Acme: say what failed in plain words');
    undoItem(dir, 'L-1', at);
    expect(read(ROLE)).toBe('[L-2] Acme: say what failed in plain words\n');
  });

  it('undoing an add of a skill removes SKILL.md and its folder', () => {
    skill();
    const r = undoItem(dir, 'L-1', at);
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'learned/skills/foreman-learned-acme-routes'))).toBe(false);
    expect(last()).toMatchObject({ v: 0, after: null });
    expect(items().get('L-1').status).toBe('removed');
  });

  it('undoing an add of a skill whose folder was deleted by hand removes it', () => {
    skill();
    rmSync(join(dir, 'learned/skills/foreman-learned-acme-routes'), { recursive: true });
    const r = undoItem(dir, 'L-1', at);
    expect(r).toMatchObject({ ok: true, error: null });
    expect(last()).toMatchObject({ action: 'undo', id: 'L-1', v: 0, after: null });
    expect(items().get('L-1').status).toBe('removed');
    expect(existsSync(join(dir, 'learned/.history/L-1/v1.md'))).toBe(true);
    // The parents left empty go too, as in a normal undo.
    expect(existsSync(join(dir, 'learned/skills'))).toBe(false);
  });

  it('undoing a lone trait after learned/traits was deleted by hand removes it', () => {
    trait();
    rmSync(join(dir, 'learned/traits'), { recursive: true });
    const r = undoItem(dir, 'L-1', at);
    expect(r).toMatchObject({ ok: true, error: null });
    expect(last()).toMatchObject({ action: 'undo', id: 'L-1', v: 0, after: null });
    expect(existsSync(join(dir, ROLE))).toBe(false);
    expect(items().get('L-1').status).toBe('removed');
  });

  it('rollback is the same, by foreman', () => {
    trait();
    const r = undoItem(dir, 'L-1', { now, by: 'foreman', action: 'rollback', reason: 'stories got worse' });
    expect(r.ok).toBe(true);
    expect(last()).toMatchObject({ action: 'rollback', by: 'foreman', reason: 'stories got worse', v: 0 });
  });

  it('rollback writes the metrics it is given on the line', () => {
    trait();
    const metrics = { decision: 'rollback', window: { runs: 5, rounds: 1.6 }, baseline: { runs: 10, rounds: 1 } };
    const r = undoItem(dir, 'L-1', { now, by: 'foreman', action: 'rollback', reason: 'Stories got worse: rounds 1.0 → 1.6', metrics });
    expect(r.ok).toBe(true);
    expect(last()).toMatchObject({ action: 'rollback', by: 'foreman', v: 0, metrics });
  });

  it('without metrics the line still has metrics: null', () => {
    trait();
    undoItem(dir, 'L-1', at);
    expect(last().metrics).toBeNull();
  });

  it('refuses a stale v and changes nothing', () => {
    trait();
    updateItem(dir, 'L-1', { text: V2 }, at);
    const before = snapshotOf();
    const r = undoItem(dir, 'L-1', { now, by: 'foreman', action: 'rollback', v: 1 });
    expect(r).toEqual({ ok: false, line: null, error: 'L-1 changed since it was evaluated; nothing done' });
    expect(snapshotOf()).toEqual(before);
    expect(undoItem(dir, 'L-1', { now, by: 'foreman', action: 'rollback', v: 2 }).ok).toBe(true);
  });

  it('refuses to undo a removed item and changes nothing', () => {
    trait();
    undoItem(dir, 'L-1', at);
    const before = snapshotOf();
    const r = undoItem(dir, 'L-1', at);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('L-1 is not in force; nothing to undo');
    expect(snapshotOf()).toEqual(before);
  });

  it('refuses an unknown id', () => {
    expect(undoItem(dir, 'L-9', at)).toMatchObject({ ok: false, error: 'L-9 is not in force; nothing to undo' });
    expect(existsSync(join(dir, 'learning.jsonl'))).toBe(false);
  });

  it('fails closed when the snapshot to restore was changed or is missing', () => {
    trait();
    updateItem(dir, 'L-1', { text: V2 }, at);
    writeFileSync(join(dir, 'learned/.history/L-1/v1.md'), 'something else');
    let before = snapshotOf();
    expect(undoItem(dir, 'L-1', at)).toMatchObject({ ok: false, error: 'the snapshot of L-1 v1 is missing or changed; nothing was undone' });
    expect(snapshotOf()).toEqual(before);
    rmSync(join(dir, 'learned/.history/L-1/v1.md'));
    before = snapshotOf();
    expect(undoItem(dir, 'L-1', at).ok).toBe(false);
    expect(snapshotOf()).toEqual(before);
  });
});

describe('keepItem', () => {
  it('keeps the version in force, by owner', () => {
    trait();
    const r = keepItem(dir, 'L-1', { now, reason: 'looks right' });
    expect(r.ok).toBe(true);
    expect(last()).toMatchObject({ action: 'keep', id: 'L-1', v: 1, by: 'owner', after: lines()[0].after });
    expect(items().get('L-1')).toMatchObject({ status: 'kept', v: 1 });
  });

  it('keeps by foreman with the metrics it is given; without them metrics is null', () => {
    trait();
    const metrics = { decision: 'keep', window: { runs: 5, rounds: 1 }, baseline: { runs: 10, rounds: 1.2 } };
    expect(keepItem(dir, 'L-1', { now, by: 'foreman', reason: 'Proven over 5 stories: rounds 1.2 → 1.0', metrics, v: 1 }).ok).toBe(true);
    expect(last()).toMatchObject({ action: 'keep', by: 'foreman', v: 1, metrics, reason: 'Proven over 5 stories: rounds 1.2 → 1.0' });
    keepItem(dir, 'L-1', at);
    expect(last().metrics).toBeNull();
  });

  it('refuses a stale v and changes nothing', () => {
    trait();
    updateItem(dir, 'L-1', { text: V2 }, at);
    const before = snapshotOf();
    expect(keepItem(dir, 'L-1', { now, by: 'foreman', v: 1 })).toEqual({ ok: false, line: null, error: 'L-1 changed since it was evaluated; nothing done' });
    expect(snapshotOf()).toEqual(before);
  });

  it('refuses a removed item', () => {
    trait();
    undoItem(dir, 'L-1', at);
    expect(keepItem(dir, 'L-1', at)).toMatchObject({ ok: false });
    expect(lines()).toHaveLength(2);
  });
});

describe('readLedger', () => {
  it('skips a torn last line, and the next line goes on its own line', () => {
    trait();
    appendFileSync(join(dir, 'learning.jsonl'), '{"at":"2026-10-2');
    expect(readLedger(dir)).toHaveLength(1);
    const r = trait('Acme: say what failed in plain words');
    expect(r.id).toBe('L-2');
    const all = readLedger(dir);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ id: 'L-2', action: 'add' });
  });

  it('skips lines that are not objects or have an unknown action', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'learning.jsonl'), '42\n{"action":"explode","id":"L-1"}\n[]\n');
    expect(readLedger(dir)).toEqual([]);
  });

  it('is empty with no ledger', () => {
    expect(readLedger(dir)).toEqual([]);
    expect(currentItems([]).size).toBe(0);
  });
});

describe('refusals', () => {
  const TOKEN = `ghp_${'a'.repeat(36)}`;

  it('refuses a text that looks like it holds a secret, and never writes it', () => {
    const r = trait(`Acme: use ${TOKEN} to push`);
    expect(r.ok).toBe(false);
    expect(learnedFiles()).toEqual([]);
    expect(last()).toMatchObject({ action: 'refused', id: null, reason: 'looks like it holds a secret', before: null, after: null });
    expect(ledgerText()).not.toContain(TOKEN);
    expect(r.line).toEqual(last());
  });

  it('refuses an update that looks like it holds a secret', () => {
    trait();
    const roleBefore = read(ROLE);
    const r = updateItem(dir, 'L-1', { text: `Acme: use ${TOKEN}` }, at);
    expect(r.ok).toBe(false);
    expect(read(ROLE)).toBe(roleBefore);
    expect(existsSync(join(dir, 'learned/.history/L-1/v2.md'))).toBe(false);
    expect(last()).toMatchObject({ action: 'refused', id: 'L-1', reason: 'looks like it holds a secret' });
    expect(ledgerText()).not.toContain(TOKEN);
    expect(items().get('L-1').v).toBe(1);
  });

  // A token at the start of a line or after a tab: JSON would turn the break into `\n` or `\t`
  // and hide it from the \b in the patterns, so each raw string must be checked.
  const AKIA = `AKIA${'A'.repeat(16)}`;
  it.each([
    ['a trait with the token on its own line', () => trait(`Acme:\n${TOKEN}`), TOKEN],
    ['a trait with the token after a tab', () => trait(`Acme:\t${TOKEN}`), TOKEN],
    ['a trait with an AWS key on its own line', () => trait(`Acme:\n${AKIA}`), AKIA],
    ['a skill with the token on its own line', () => skill('acme-routes', `---\nname: foreman-learned-acme-routes\ndescription: Use when pushing\n---\n\n${TOKEN}\n`), TOKEN],
    ['a reason with the token on its own line', () => trait(V1, { reason: `seen:\n${TOKEN}` }), TOKEN],
    ['a source story with the token on its own line', () => trait(V1, { source: { key: 'k', stories: [`\n${TOKEN}`] } }), TOKEN],
    ['metrics holding the token on its own line', () => trait(V1, { metrics: { note: `\n${TOKEN}` } }), TOKEN],
  ])('refuses %s', (_, act, secret) => {
    const r = act();
    expect(r.ok).toBe(false);
    expect(learnedFiles()).toEqual([]);
    expect(last()).toMatchObject({ action: 'refused', reason: 'looks like it holds a secret' });
    expect(ledgerText()).not.toContain(secret);
  });

  it('refuses an update with the token on its own line', () => {
    trait();
    const before = snapshotOf();
    const r = updateItem(dir, 'L-1', { text: `Acme:\n${TOKEN}` }, at);
    expect(r.ok).toBe(false);
    expect(snapshotOf().files).toEqual(before.files);
    expect(last()).toMatchObject({ action: 'refused', id: 'L-1', reason: 'looks like it holds a secret' });
    expect(ledgerText()).not.toContain(TOKEN);
  });

  it.each([
    ['a trait with two roles', { kind: 'trait', roles: ['developer', 'tester'], text: V1 }],
    ['a role that climbs out', { kind: 'trait', roles: ['../x'], text: V1 }],
    ['a skill with no role', { kind: 'skill', roles: [], slug: 'acme', text: 'x' }],
    ['a bad slug', { kind: 'skill', roles: ['developer'], slug: 'Bad Slug', text: 'x' }],
    ['a slug over 40 characters', { kind: 'skill', roles: ['developer'], slug: 'a'.repeat(41), text: 'x' }],
    ['an unknown kind', { kind: 'rule', roles: ['developer'], text: V1 }],
    ['an empty text', { kind: 'trait', roles: ['developer'], text: '  ' }],
  ])('refuses %s and writes no file', (_, input) => {
    const r = addItem(dir, input, at);
    expect(r.ok).toBe(false);
    expect(learnedFiles()).toEqual([]);
    expect(last()).toMatchObject({ action: 'refused', id: null, before: null, after: null });
    expect(r.line.reason).toBeTruthy();
  });

  it('refuses a slug another in-force skill uses', () => {
    skill();
    const before = learnedFiles();
    const r = skill('acme-routes', 'another');
    expect(r.ok).toBe(false);
    expect(learnedFiles()).toEqual(before);
    expect(last()).toMatchObject({ action: 'refused', id: null });
  });

  it('refuses an update of an unknown or removed item', () => {
    expect(updateItem(dir, 'L-3', { text: V2 }, at).ok).toBe(false);
    trait();
    undoItem(dir, 'L-1', at);
    const r = updateItem(dir, 'L-1', { text: V2 }, at);
    expect(r.ok).toBe(false);
    expect(learnedFiles().filter((f) => !f.startsWith('learned/.history/'))).toEqual([]);
    expect(last()).toMatchObject({ action: 'refused', id: 'L-1' });
  });
  it('refuses an id that is not a learned item id and never writes it', () => {
    const r = updateItem(dir, TOKEN, { text: 'x' }, at);
    expect(r.ok).toBe(false);
    expect(r.line).toEqual(last());
    expect(last()).toMatchObject({ action: 'refused', id: null, reason: 'the id is not a learned item id' });
    expect(ledgerText()).not.toContain(TOKEN);
    expect(updateItem(dir, 'nope', { text: 'x' }, at).line).toMatchObject({ action: 'refused', id: null, reason: 'the id is not a learned item id' });
    expect(updateItem(dir, 'L-3', { text: 'x' }, at).line.reason).toBe('L-3 is not in force; nothing to update');
  });
});

describe('undo and keep withhold secrets', () => {
  const TOKEN = `ghp_${'a'.repeat(36)}`;
  const WITHHELD = 'withheld: it looked like it held a secret';

  it('a Foreman rollback with a secret reason and metrics still happens and never writes the secret', () => {
    trait();
    const r = undoItem(dir, 'L-1', { ...at, by: 'foreman', action: 'rollback', reason: `seen:\n${TOKEN}`, metrics: { decision: 'rollback', note: `\n${TOKEN}` } });
    expect(r.ok).toBe(true);
    expect(items().get('L-1').v).toBe(0);
    expect(existsSync(join(dir, ROLE))).toBe(false);
    expect(last()).toMatchObject({ action: 'rollback', reason: WITHHELD, metrics: { decision: 'rollback' } });
    expect(last().metrics).toEqual({ decision: 'rollback' });
    expect(r.line).toEqual(last());
    expect(ledgerText()).not.toContain(TOKEN);
  });

  it('a retire whose metrics hold a secret stays a retire', () => {
    trait();
    const r = undoItem(dir, 'L-1', { ...at, by: 'foreman', action: 'rollback', reason: 'No effect: the problem came back on S-1, S-2', metrics: { decision: 'retire', cited: [TOKEN] } });
    expect(r.ok).toBe(true);
    expect(last().metrics).toEqual({ decision: 'retire' });
    expect(last().reason).toBe('No effect: the problem came back on S-1, S-2');
    expect(rolledBack(readLedger(dir))).toEqual([]);
    expect(ledgerText()).not.toContain(TOKEN);
  });

  it('an owner undo with a secret reason is withheld too', () => {
    trait();
    expect(undoItem(dir, 'L-1', { ...at, reason: `\t${TOKEN}` }).ok).toBe(true);
    expect(last()).toMatchObject({ action: 'undo', by: 'owner', reason: WITHHELD, metrics: null });
    expect(ledgerText()).not.toContain(TOKEN);
  });

  it('a keep with a token in its reason still keeps, with the reason withheld', () => {
    trait();
    const r = keepItem(dir, 'L-1', { ...at, by: 'foreman', reason: `Proven:\n${TOKEN}`, v: 1 });
    expect(r.ok).toBe(true);
    expect(items().get('L-1').status).toBe('kept');
    expect(last()).toMatchObject({ action: 'keep', by: 'foreman', v: 1, reason: WITHHELD, metrics: null });
    expect(ledgerText()).not.toContain(TOKEN);
  });

  it('a keep whose metrics hold a secret keeps only the decision', () => {
    trait();
    expect(keepItem(dir, 'L-1', { ...at, by: 'foreman', reason: 'Proven over 5 stories', metrics: { decision: 'keep', [TOKEN]: 1 }, v: 1 }).ok).toBe(true);
    expect(last()).toMatchObject({ reason: 'Proven over 5 stories', metrics: { decision: 'keep' } });
    expect(last().metrics).toEqual({ decision: 'keep' });
    expect(ledgerText()).not.toContain(TOKEN);
  });

  it.each([
    ['no decision', { note: `\n${TOKEN}` }],
    ['a decision that is not one of keep, rollback or retire', { decision: 'other', note: `\n${TOKEN}` }],
    ['the secret in the decision itself', { decision: `\n${TOKEN}` }],
  ])('metrics with %s and a secret are written as null', (_, metrics) => {
    trait();
    trait('Acme: say what failed in plain words');
    expect(undoItem(dir, 'L-1', { ...at, by: 'foreman', action: 'rollback', reason: 'x', metrics }).ok).toBe(true);
    expect(last().metrics).toBeNull();
    expect(keepItem(dir, 'L-2', { ...at, by: 'foreman', reason: 'x', metrics, v: 1 }).ok).toBe(true);
    expect(last().metrics).toBeNull();
    expect(ledgerText()).not.toContain(TOKEN);
  });

  it('a clean reason and metrics pass through unchanged', () => {
    trait();
    trait('Acme: say what failed in plain words');
    const reason = 'Proven over 5 stories';
    const metrics = { decision: 'keep', window: { runs: 5 } };
    keepItem(dir, 'L-1', { ...at, by: 'foreman', reason, metrics, v: 1 });
    expect(last()).toMatchObject({ action: 'keep', reason, metrics });
    expect(last().metrics).toEqual(metrics);
    undoItem(dir, 'L-2', { ...at, by: 'foreman', action: 'rollback', reason, metrics });
    expect(last()).toMatchObject({ action: 'rollback', reason, metrics });
    expect(last().metrics).toEqual(metrics);
  });
});

describe('the lock', () => {
  it('throws when another live process holds it, and changes nothing', () => {
    trait();
    writeFileSync(join(dir, 'learning.lock'), JSON.stringify({ pid: process.pid, at: now.toISOString() }));
    const before = snapshotOf();
    expect(() => undoItem(dir, 'L-1', at)).toThrow('another Foreman process is changing learned items; try again');
    expect(() => trait('Acme: more')).toThrow('another Foreman process');
    expect(snapshotOf()).toEqual(before);
    expect(existsSync(join(dir, 'learning.lock'))).toBe(true);
  });

  it('breaks a lock whose process is gone', () => {
    writeFileSync(join(dir, 'learning.lock'), JSON.stringify({ pid: 999999999, at: now.toISOString() }));
    expect(trait().ok).toBe(true);
    expect(existsSync(join(dir, 'learning.lock'))).toBe(false);
  });
});

describe('itemText and currentItems', () => {
  it('reads the text in force, and a later update after an undo gets a fresh version', () => {
    trait();
    updateItem(dir, 'L-1', { text: V2 }, at);
    undoItem(dir, 'L-1', at);
    expect(itemText(dir, items().get('L-1'))).toBe(V1);
    updateItem(dir, 'L-1', { text: 'Acme: v3' }, at);
    expect(read('learned/.history/L-1/v2.md')).toBe(V2);
    expect(items().get('L-1')).toMatchObject({ v: 3 });
    expect(itemText(dir, items().get('L-1'))).toBe('Acme: v3');
  });

  it('throws on a path outside learned/', () => {
    expect(() => itemText(dir, { snapshot: '../outside.md' })).toThrow();
  });
});

describe('refuseItem', () => {
  it('appends a refused line with no id, no version and no text, and changes no item', () => {
    trait();
    const before = items();
    const r = refuseItem(dir, { kind: 'trait', roles: ['developer'], source: { key: 'f-0123456789ab', stories: ['S-1', 'S-2'], extra: 'dropped' }, reason: `developer already has 1 learned traits (the most is 1)${' x'.repeat(200)}` }, { now, by: 'foreman' });
    expect(r.ok).toBe(false);
    expect(r.line).toEqual(last());
    expect(last()).toMatchObject({ at: now.toISOString(), action: 'refused', id: null, v: 0, kind: 'trait', roles: ['developer'], path: null, before: null, after: null, source: { key: 'f-0123456789ab', stories: ['S-1', 'S-2'] }, by: 'foreman', metrics: null });
    expect(last().reason.startsWith('developer already has 1 learned traits (the most is 1)')).toBe(true);
    expect(last().reason).toHaveLength(300);
    expect(Object.keys(last())).not.toContain('text');
    expect(items()).toEqual(before);
    expect(existsSync(join(dir, 'learning.lock'))).toBe(false);
  });
});
