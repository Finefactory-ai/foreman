import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { ACTION_HELP, helpBody, settingHelp } from './help.mjs';
import { OPTIONS } from '../engine/answers.mjs';
import { FOLLOW_UP_OPTIONS, TRAIT_OPTIONS } from '../cli/commands/learn.mjs';
import { ACTIONS } from '../engine/scheduler.mjs';
import { OWNER_ACTIONS } from '../console/commands.mjs';
import { buildWaiting } from '../console/waiting.mjs';
import { BUNDLE_ACTIONS } from '../console/bundles.mjs';
import { REGISTRY } from '../settings/registry.mjs';

const BODY = helpBody();
// Every file of the story skill: SKILL.md and the rare paths next to it.
const SKILL_DIR = new URL('../../skills/story/', import.meta.url);
const SKILL = readdirSync(SKILL_DIR).filter((name) => name.endsWith('.md')).sort().map((name) => readFileSync(new URL(name, SKILL_DIR), 'utf8')).join('\n\n');
const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>'), PAGE.lastIndexOf('</script>'));

// The page's own waitingHelp, with the helpFor it calls, lifted and run on their own.
const lift = (name, args) => SCRIPT.match(new RegExp(`function ${name}\\(${args}\\) \\{[\\s\\S]*?\\n {2}\\}\\n`))[0];
const waitingHelp = (...args) => new Function(`${lift('helpFor', 'help, kind, key, own')}\n${lift('waitingHelp', 'help, it, action')}; return waitingHelp;`)()(...args);

const APPLIES_TEXT = {
  'next-story': 'Takes effect from the next story a slot picks.',
  'next-run': 'Takes effect when the run next starts.',
  restart: 'Takes effect once the run or dashboard restarts.',
};

function wellFormed(where, h) {
  expect(h, where).toBeTruthy();
  expect(typeof h.hint, where).toBe('string');
  expect(h.hint.length, where).toBeGreaterThan(0);
  expect(h.hint.length, `${where}: ${h.hint}`).toBeLessThanOrEqual(100);
  expect(h.hint, where).not.toContain('\n');
  expect(h.hint.endsWith('.'), `${where}: ${h.hint}`).toBe(true);
  expect(typeof h.more, where).toBe('string');
  expect(h.more.trim().length, where).toBeGreaterThan(0);
}

describe('the help texts', () => {
  it('has a well-formed hint and fuller text for every entry', () => {
    const groups = ['decision', 'waiting', 'learned', 'control', 'slot', 'form', 'settings'];
    for (const g of groups) {
      expect(Object.keys(BODY[g] ?? {}).length, g).toBeGreaterThan(0);
      for (const [key, h] of Object.entries(BODY[g])) wellFormed(`${g}.${key}`, h);
    }
  });

  it('Ignore does not promise the proposal stays closed', () => {
    // 'Ignore' also answers a depends_on proposal, which records nothing and can come back.
    expect(BODY.decision.Ignore.hint).toBe('Changes nothing; the proposal is closed.');
    expect(BODY.decision.Ignore.hint).not.toContain('again');
    expect(BODY.decision.Ignore.more).toContain('An ignored trait or follow-up is not proposed again unless you run `foreman learn reopen <id>`.');
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(ACTION_HELP)).toBe(true);
    expect(Object.isFrozen(ACTION_HELP.decision)).toBe(true);
    expect(Object.isFrozen(ACTION_HELP.slot.skip)).toBe(true);
  });

  it('says a skip lasts through standby and Build next undoes it', () => {
    expect(ACTION_HELP.slot.skip.more).toContain('standby');
    expect(ACTION_HELP.slot.skip.more).toContain('Build next');
  });

  it('covers every decision option the run and `foreman learn` ask with', () => {
    const fromSkill = [...SKILL.matchAll(/--option "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(fromSkill).size).toBeGreaterThanOrEqual(5);
    const labels = new Set([...Object.values(OPTIONS).flat(), ...TRAIT_OPTIONS, ...FOLLOW_UP_OPTIONS, ...fromSkill]);
    for (const label of ["Retry with a note to the architect", "I'll take it", 'Drop', 'Apply', 'Ignore', 'Add as a trait', 'Create a follow-up story', 'Undo', 'Keep']) expect(labels.has(label), label).toBe(true);
    for (const label of labels) expect(Object.hasOwn(BODY.decision, label), label).toBe(true);
  });

  it('covers every slot action, and parking after the current story', () => {
    for (const id of [...ACTIONS, 'park-after']) expect(Object.hasOwn(BODY.slot, id), id).toBe(true);
  });

  it('covers every owner control but the slot actions', () => {
    for (const action of OWNER_ACTIONS.filter((a) => a !== 'slot')) expect(Object.hasOwn(BODY.control, action), action).toBe(true);
    expect(BODY.control.fixed).toEqual(BODY.waiting.fixed);
  });

  it('covers every action the Waiting on you tab can show', () => {
    const decision = (over) => ({ id: 'd-1', story: 'ACME-1', kind: 'decision', title: 'Q', options: [], body: '', createdAt: '2026-10-15T09:00:00.000Z', answer: null, appliedAt: null, ...over });
    const slot = (id, state, parkedFor = null) => ({ id, state, parkedFor, reason: '', since: null, story: { id: 'ACME-1' } });
    const items = buildWaiting({
      decisions: { source: 'files', items: [
        decision({ id: 'd-1', options: ['Retry with a note to the architect', "I'll take it", 'Drop'] }),
        decision({ id: 'd-2', options: [] }),
        decision({ id: 'd-3', options: ['Something new'], body: 'Pick the shop name.\nIt shows on the receipts.', hints: ['Names the shop on the receipts.'] }),
      ] },
      stories: [{ id: 'ACME-3', title: 'Add the key (owner task)', status: 'todo', ownerTask: true, dependsOn: [], ref: '' }],
      idPattern: '[A-Z]+-\\d+',
      slots: [slot('w1', 'building'), slot('w2', 'idle'), slot('w3', 'held'), slot('w4', 'down'), slot('w5', 'parked', 'crash'), slot('w6', 'parked', 'dirty'), slot('w7', 'parked', 'owner')],
      halt: { reason: 'smoke failed', held: [] },
      parks: [{ id: 'ACME-5', title: 'Checkout', reason: 'waiting for QA', parkedAt: '2026-10-15T09:00:00.000Z' }],
      root: '/tmp/acme',
    });
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of ['halt', 'decision', 'owner-task', 'release', 'slot']) expect(kinds.has(k), k).toBe(true);
    let count = 0;
    for (const it of items) {
      for (const action of it.actions) {
        const h = waitingHelp(BODY, it, action);
        expect(h?.hint, `${it.id} ${action.id}`).toBeTruthy();
        count += 1;
      }
    }
    expect(count).toBeGreaterThanOrEqual(15);
    // each action maps to its own entry, not just to some hint
    const item = (id) => items.find((i) => i.id === id);
    const act = (it, pick) => it.actions.find(pick);
    const d2 = item('d-2');
    expect(waitingHelp(BODY, d2, act(d2, (a) => a.id === 'answer'))).toEqual(BODY.waiting.answer);
    const d1 = item('d-1');
    expect(waitingHelp(BODY, d1, act(d1, (a) => a.label === 'Drop'))).toEqual(BODY.decision.Drop);
    expect(waitingHelp(BODY, d1, act(d1, (a) => a.label === "I'll take it"))).toEqual(BODY.decision["I'll take it"]);
    const halt = item('halt');
    expect(waitingHelp(BODY, halt, act(halt, (a) => a.id === 'fixed'))).toEqual(BODY.waiting.fixed);
    const task = item('task:ACME-3');
    expect(waitingHelp(BODY, task, act(task, (a) => a.id === 'done'))).toEqual(BODY.waiting.done);
    const release = item('release:ACME-5');
    expect(waitingHelp(BODY, release, act(release, (a) => a.id === 'check'))).toEqual(BODY.waiting.check);
    let slotCount = 0;
    for (const it of items.filter((i) => i.kind === 'slot')) {
      for (const action of it.actions) {
        expect(waitingHelp(BODY, it, action), `${it.id} ${action.id}`).toEqual(BODY.slot[action.id]);
        slotCount += 1;
      }
    }
    expect(slotCount).toBeGreaterThanOrEqual(5);
    // an unknown option falls back to the option's own hint
    const odd = items.find((i) => i.id === 'd-3');
    expect(waitingHelp(BODY, odd, odd.actions[0])).toEqual({ hint: 'Names the shop on the receipts.', more: 'Names the shop on the receipts.' });
    // the card passes its view action, which has no hint: the item's own action gives it
    expect(waitingHelp(BODY, odd, { id: odd.actions[0].id, label: odd.actions[0].label })).toEqual({ hint: 'Names the shop on the receipts.', more: 'Names the shop on the receipts.' });
  });

  it('covers the learned FYI actions, and the page finds them for a learned item', () => {
    expect(Object.keys(BODY.learned).sort()).toEqual(['keep', 'ok', 'undo']);
    for (const id of ['undo', 'keep', 'ok']) wellFormed(`learned.${id}`, BODY.learned[id]);
    expect(BODY.learned.undo.more).toMatch(/at once/);
    expect(BODY.learned.undo.more).toMatch(/next story/);
    const [learned, rolled] = buildWaiting({ decisions: { source: 'files', items: [
      { id: 'd-5', story: 'ACME-1', kind: 'decision', title: 'Foreman learned L-1 for developer', options: OPTIONS.learned, body: '', createdAt: '2026-10-15T09:00:00.000Z', answer: null, appliedAt: null },
      { id: 'd-6', story: 'ACME-1', kind: 'decision', title: 'Foreman rolled back L-1 for developer', options: OPTIONS.rolledBack, body: '', createdAt: '2026-10-15T09:00:01.000Z', answer: null, appliedAt: null },
    ] } });
    for (const action of learned.actions) expect(waitingHelp(BODY, learned, action)).toEqual(BODY.learned[action.id]);
    expect(waitingHelp(BODY, rolled, rolled.actions[0])).toEqual(BODY.learned.ok);
  });

  it('every bundle action has help within the limits', () => {
    expect(BUNDLE_ACTIONS.length).toBeGreaterThan(0);
    for (const id of BUNDLE_ACTIONS) wellFormed(`waiting.${id}`, BODY.waiting[id]);
    expect(BODY.waiting['ignore-all'].more).toContain('An ignored trait or follow-up is not proposed again unless you run `foreman learn reopen <id>`.');
    expect(BODY.waiting['create-all'].hint).toBe('Creates one follow-up story per shipped story listed, or adds each listed trait.');
  });

  it('an unknown option with a body and no hint has no help', () => {
    const [it] = buildWaiting({ decisions: { source: 'files', items: [{ id: 'd-4', story: 'ACME-1', kind: 'decision', title: 'Q', options: ['Something new'], body: 'Pick the shop name.', createdAt: '2026-10-15T09:00:00.000Z', answer: null, appliedAt: null }] } });
    expect(waitingHelp(BODY, it, it.actions[0])).toBeNull();
  });

  it('covers every setting, in the registry\'s own words', () => {
    for (const e of REGISTRY) {
      const h = BODY.settings[e.name];
      expect(h, e.name).toBeTruthy();
      expect(h.hint).toBe(e.description);
      expect(h.more).toContain(e.description);
      expect(h.more).toContain(APPLIES_TEXT[e.applies]);
      if (e.when) expect(h.more).toContain(`Shown only when ${e.whenText}.`);
    }
  });

  it('picks up a setting added to the registry', () => {
    const fake = [...REGISTRY, { name: 'acme.colour', label: 'Colour', description: 'The colour of the Acme shop.', applies: 'next-run', when: () => true, whenText: 'the shop is Acme' }];
    const got = settingHelp(fake);
    expect(got['acme.colour']).toEqual({
      hint: 'The colour of the Acme shop.',
      more: 'The colour of the Acme shop. Takes effect when the run next starts. Shown only when the shop is Acme.',
    });
    expect(Object.keys(got)).toHaveLength(REGISTRY.length + 1);
  });

  it('covers the form buttons', () => {
    for (const key of ['save-answer', 'mark-done', 'change-answer', 'keep-answer', 'save-local', 'save-team', 'reset-local', 'reset-team']) {
      expect(Object.hasOwn(BODY.form, key), key).toBe(true);
    }
  });

  it('helps the Retry on a failed answer, and the retry-answer control', () => {
    const failed = { id: 'run:answer:d-1', kind: 'run', title: 'Could not apply your answer to "Q"', actions: [{ id: 'retry', label: 'Retry' }] };
    expect(waitingHelp(BODY, failed, failed.actions[0])).toEqual(BODY.waiting.retry);
    wellFormed('waiting.retry', BODY.waiting.retry);
    wellFormed('control.retry-answer', BODY.control['retry-answer']);
    // another run item's action has none
    expect(waitingHelp(BODY, { id: 'run:strays', kind: 'run', actions: [{ id: 'end', label: 'End them' }] }, { id: 'end', label: 'End them' })).toBeNull();
  });
});
