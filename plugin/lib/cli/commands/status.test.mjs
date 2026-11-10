import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withDefaults } from '../../config/defaults.mjs';
import { addItem, keepItem } from '../../engine/learning-store.mjs';
import { readSlot, setSlot } from '../../engine/state.mjs';
import { buildWaiting } from '../../console/waiting.mjs';
import { main } from '../main.mjs';
import { describeStatus } from './status.mjs';

const ID = '[A-Z]+-\\d+';
const ROOT = join(tmpdir(), 'acme');
const s = (id, over = {}) => ({
  id, title: `Story ${id}`, ref: join(ROOT, 'stories', `${id}.md`), status: 'todo', group: '', groupName: '', order: 0,
  dependsOn: [], blockedBy: '', ownerTask: false, resources: [], ...over,
});
const decision = (over = {}) => ({
  id: 'd-20261015090000-abcd', story: 'ACME-1', kind: 'decision', title: 'Which login?', options: [], urgent: false,
  body: '', createdAt: '2026-10-15T09:00:00.000Z', answer: null, appliedAt: null, ...over,
});
const build = (over = {}) => buildWaiting({ decisions: null, stories: [], idPattern: ID, slots: [], halt: null, parks: [], root: ROOT, ...over });
const snap = (loop) => ({ loop, workers: 1, slots: [], recent: [], totals: null });
const linesOf = (text) => text.split('\n');

// Today's FM spikes and what waits on them, with Acme ids: 14 open stories, 6 owner tasks that
// can start now and 9 that wait on open stories (a copy of lib/console/waiting.test.mjs).
function fmStories() {
  const n = (k) => `ACME-${k}`;
  const story = (k, deps = [], over = {}) => s(n(k), { dependsOn: deps.map(n), ...over });
  const owner = (k, deps = [], over = {}) => story(k, deps, { ownerTask: true, ...over });
  return [
    ...[21, 23, 24, 27, 28, 29, 30, 36, 39, 58].map((k) => story(k, [], { status: 'done' })),
    story(31, [12, 30]),
    story(32, [29, 18]),
    story(33, [23, 29, 14]),
    story(34, [33]),
    story(35, [34]),
    story(37, [28, 36, 13]),
    story(38, [37]),
    story(42, [34]),
    story(43, [35, 42]),
    story(45, [21, 33, 15]),
    story(46, [24, 45]),
    story(53, [35, 38, 17]),
    story(54, [53]),
    story(57, [27, 32]),
    ...[12, 13, 14, 15, 17, 18].map((k) => owner(k, [], k === 14 ? { title: 'Spike: one story by hand on the direct path' } : {})),
    owner(40, [30, 31, 32, 35, 38, 39]),
    owner(41, [40]),
    owner(44, [43, 41]),
    owner(47, [46]),
    owner(48, [44, 47]),
    owner(55, [54, 41]),
    owner(56, [55, 48]),
    owner(59, [57, 58, 56]),
    owner(60, [59]),
  ];
}

describe('describeStatus: a queued check', () => {
  it('says check queued on the slot line, and the first line does not say stuck', () => {
    const slot = { id: 'w3', state: 'building', story: { id: 'ACME-1', title: 'Title', stage: 'test' }, checkWait: { since: '2026-11-01T10:00:00.000Z', text: 'check queued: waiting for a free check slot' } };
    const out = describeStatus({ ...snap({ state: 'running' }), slots: [slot, { id: 'w4', state: 'idle' }] }, 4, { items: [] });
    const lines = linesOf(out);
    expect(lines[0]).not.toContain('running, but stuck');
    expect(lines).toContain('  w3  building  ACME-1 Title · test · check queued: waiting for a free check slot');
    expect(lines).toContain('  w4  idle');
  });
});

describe('describeStatus: the Waiting on you block', () => {
  it('the FM fixture: count, headline, the six spikes in rank order, later', () => {
    const loop = { state: 'stopped' };
    const items = build({ stories: fmStories(), loop });
    const out = describeStatus(snap(loop), 1, { items });
    const lines = linesOf(out);
    expect(lines).toContain('Waiting on you: 6 (9 later)');
    expect(lines).toContain('  Idle: the 14 stories left all wait on your tasks. Do Spike: one story by hand on the direct path first: it frees ACME-33 now and 9 stories in all.');
    expect(lines).toContain('  Later: 9 (first after ACME-40)');
    const at = lines.indexOf('  Your tasks (6):');
    expect(at).toBeGreaterThan(-1);
    const tasks = lines.slice(at + 1, at + 7);
    const order = ['ACME-14', 'ACME-13', 'ACME-18', 'ACME-12', 'ACME-15', 'ACME-17'];
    expect(tasks[0]).toBe('    Spike: one story by hand on the direct path · frees ACME-33');
    order.slice(1).forEach((id, i) => expect(tasks[i + 1]).toMatch(new RegExp(`^ {4}Story ${id} · `)));
    expect(tasks[order.indexOf('ACME-15')]).toMatch(/· frees nothing by itself$/);
    expect(out).not.toContain('(blocks');
    expect(out).not.toContain('Needs you now');
    expect(lines.filter((l) => l === '    Spike: one story by hand on the direct path · frees ACME-33')).toHaveLength(1);
    expect(lines).not.toContain('    Spike: one story by hand on the direct path');
    expect(out.split('Spike: one story by hand on the direct path').length - 1).toBe(2);

    const takes = new Map([['task:ACME-14', 'About 2 hours']]);
    const withTakes = linesOf(describeStatus(snap(loop), 1, { items, takes }));
    expect(withTakes[withTakes.indexOf('  Your tasks (6):') + 1]).toBe('    Spike: one story by hand on the direct path · frees ACME-33 · takes About 2 hours');
  });

  it('a halt and a follow-up bundle', () => {
    const options = ['Create a follow-up story', 'Ignore'];
    const items = build({
      halt: { reason: 'A release failed.', held: [] },
      decisions: {
        source: 'files',
        items: [
          decision({ id: 'd-20261015090000-0001', story: 'ACME-1', title: 'Follow up on ACME-1: 3 minor finding(s)?', options }),
          decision({ id: 'd-20261015090000-0002', story: 'ACME-2', title: 'Follow up on ACME-2: 2 minor finding(s)?', options }),
          decision({ id: 'd-20261015090000-0003', story: 'ACME-3', title: 'Which login?', options: ['Email', 'SSO'] }),
        ],
      },
    });
    const lines = linesOf(describeStatus(snap({ state: 'running' }), 1, { items }));
    expect(lines).toContain('Waiting on you: 3');
    expect(lines).toContain('  Halted: a release failed. Nothing ships until you fix it.');
    const now = lines.indexOf('  Needs you now (2):');
    expect(now).toBeGreaterThan(-1);
    expect(lines.slice(now + 1, now + 3)).toEqual(['    The run is halted', '      A release failed.']);
    const quick = lines.indexOf('  Quick decisions (1):');
    expect(quick).toBeGreaterThan(now);
    expect(lines[quick + 1]).toBe('    2 follow-ups from recent runs: 5 minor findings · foreman decide answer --bundle follow-ups "Create a follow-up story"');
  });

  it('a trait bundle line', () => {
    const items = build({ decisions: { source: 'files', items: [decision({ title: 'Add a trait for builder: keep it short?', options: ['Add as a trait', 'Ignore'] })] } });
    const lines = linesOf(describeStatus(snap({ state: 'stopped' }), 1, { items }));
    expect(lines).toContain('  Quick decisions (1):');
    expect(lines).toContain('    1 trait proposal · foreman decide answer --bundle traits "Add as a trait"');
  });

  it('a Jira pause: paused headline and an FYI line', () => {
    const REASON = 'Jira not reachable since 17:07: fetch failed; picking paused, stories in progress carry on';
    const at = (h, m, day = 24) => new Date(2026, 9, day, h, m);
    const paused = (reason = REASON, since = at(17, 7)) => ({ state: 'paused', reason, since: since.toISOString() });
    const loop = paused();
    const items = build({ loop, now: at(17, 30) });
    const lines = linesOf(describeStatus(snap(loop), 1, { items }));
    expect(lines).toContain('Waiting on you: 0');
    expect(lines.some((l) => l.startsWith('  Paused: Jira not reachable since 17:07.'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  FYI: Picking paused since 17:07'))).toBe(true);
  });

  it('a self-pause: paused headline and a Needs you now line', () => {
    const R = 'Three stories in a row did not ship: ACME-1, ACME-2 and ACME-3.';
    const loop = { state: 'paused', reason: R };
    const items = build({ autoPause: { at: '2026-10-25T09:00:00.000Z', reason: R }, loop });
    const out = describeStatus(snap(loop), 1, { items });
    const lines = linesOf(out);
    expect(out).toContain(`Foreman: paused: ${R}`);
    expect(lines).toContain('Waiting on you: 1');
    const now = lines.indexOf('  Needs you now (1):');
    expect(now).toBeGreaterThan(-1);
    expect(lines.slice(now + 1, now + 3)).toEqual(['    Foreman paused itself', `      ${R}`]);
  });

  it('a self-pause that tries again by itself says when, in the headline and the Needs you now line', () => {
    const R = 'The account is out of credit or hit its usage limit.';
    const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const loop = { state: 'paused', reason: R };
    const items = build({ autoPause: { at: '2026-10-25T09:00:00.000Z', reason: R, retryAt }, loop });
    const lines = linesOf(describeStatus(snap(loop), 1, { items }));
    expect(lines.some((l) => /^ {2}Paused: .*\. Foreman tries again at (\d\d:\d\d|\d{4}-\d\d-\d\d \d\d:\d\d) by itself; Resume starts it sooner\.$/.test(l))).toBe(true);
    const now = lines.indexOf('  Needs you now (1):');
    expect(lines[now + 2]).toMatch(/^ {6}.*Foreman tries again at .* by itself\.$/);
  });

  it('the Claude API wait is an FYI line with the retry time', () => {
    const loop = { state: 'running', reason: '' };
    const apiWait = { since: new Date().toISOString(), until: new Date(Date.now() + 60 * 60_000).toISOString(), step: 2 };
    const items = build({ loop, apiWait });
    const lines = linesOf(describeStatus(snap(loop), 1, { items }));
    expect(lines.filter((l) => /^ {2}FYI: The Claude API is limited or down \(wait 2\); Foreman tries again at /.test(l))).toHaveLength(1);
    expect(lines).toContain('Waiting on you: 0');
  });

  it('the environment wait is an FYI line with the retry time', () => {
    const loop = { state: 'running', reason: '' };
    const envWait = { since: new Date().toISOString(), until: new Date(Date.now() + 60 * 60_000).toISOString(), step: 1 };
    const items = build({ loop, envWait });
    const lines = linesOf(describeStatus(snap(loop), 1, { items }));
    expect(lines.filter((l) => /^ {2}FYI: Three endings in a row were the environment, not the stories \(wait 1\); Foreman tries again at /.test(l))).toHaveLength(1);
    expect(lines).toContain('Waiting on you: 0');
  });

  it('on standby: the loop line and the Standby headline', () => {
    const loop = { state: 'standby', reason: 'Nothing to build; picks up new stories automatically.' };
    const items = build({ stories: [s('ACME-1', { ownerTask: true }), s('ACME-2', { dependsOn: ['ACME-1'] })], loop });
    const lines = linesOf(describeStatus(snap(loop), 1, { items }));
    expect(lines[0]).toBe('Foreman: standby');
    expect(lines).toContain('  Standby: nothing to build. 1 story waits on your tasks. Picks up new stories automatically.');
    const paused = linesOf(describeStatus({ ...snap(loop), control: { paused: true } }, 1, { items }));
    expect(paused[0]).toBe('Foreman: standby, pause requested');
  });

  it('a stuck run: running, but stuck, and a Needs you now line', () => {
    const loop = { state: 'running', reason: '' };
    const stuck = { kind: 'error', since: '2026-10-25T09:00:00.000Z', reason: 'R' };
    const items = build({ loop, stuck, now: new Date('2026-10-25T09:12:00.000Z') });
    const out = describeStatus({ ...snap(loop), stuck }, 1, { items });
    const lines = linesOf(out);
    expect(lines[0]).toBe('Foreman: running, but stuck: R');
    const now = lines.indexOf('  Needs you now (1):');
    expect(now).toBeGreaterThan(-1);
    expect(lines.slice(now + 1, now + 3)).toEqual(['    Not building for 12 minutes', '      R']);
  });

  it('a slow story: an FYI line, never stuck', () => {
    const loop = { state: 'running', reason: '' };
    const since = '2026-10-25T09:00:00.000Z';
    const slow = [{ slot: 'w3', id: 'ACME-1', since, stage: 'build', rounds: 1, steps: 129 }];
    const items = build({ loop, slow, now: new Date(Date.parse(since) + 105 * 60_000) });
    const out = describeStatus({ ...snap(loop), stuck: null, slow }, 1, { items });
    const lines = linesOf(out);
    expect(lines[0]).toBe('Foreman: running');
    expect(lines).toContain('  FYI: slow: ACME-1 in its fix round for 1 h 45 min (129 steps)');
    expect(out).not.toContain('stuck');
    expect(out).not.toContain('Needs you now');
  });

  it('a restart pending on new code: idle slots wait for it, and one line says why', () => {
    const loop = { state: 'running', reason: '' };
    const restartPending = { from: 'a1b2c3d', to: 'e4f5a6b', since: '2026-10-25T09:00:00.000Z' };
    const slots = [
      { id: 'w1', state: 'building', story: { id: 'ACME-1', title: 'Story ACME-1', stage: 'build' } },
      { id: 'w2', state: 'idle', story: null },
    ];
    const items = build({ loop, restartPending, slots });
    const sentence = '  New code (a1b2c3d → e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep running.';
    const out = describeStatus({ ...snap(loop), workers: 2, slots, restartPending }, 2, { items });
    const lines = linesOf(out);
    const w2 = lines.filter((l) => l.startsWith('  w2 '));
    expect(w2).toHaveLength(1);
    expect(w2[0]).toContain('waiting for restart');
    expect(w2[0]).not.toContain('idle');
    const w1 = lines.find((l) => l.startsWith('  w1 '));
    expect(w1).toContain('building');
    expect(w1).not.toContain('waiting for restart');
    const at = lines.indexOf(sentence);
    expect(at).toBeGreaterThan(lines.indexOf(w2[0]));
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith('Waiting on you:')));
    expect(out).not.toContain('FYI: New code');
    expect(out.split('New code (').length - 1).toBe(1);

    const plain = describeStatus({ ...snap(loop), workers: 2, slots }, 2, { items: build({ loop, slots }) });
    expect(linesOf(plain).find((l) => l.startsWith('  w2 '))).toContain('idle');
    expect(plain).not.toContain('New code');
  });

  it('the stories skipped this run: one line after the slots, with how to build one again', () => {
    const loop = { state: 'standby', reason: '' };
    const line = '  Skipped this run: ACME-1, ACME-2 (`foreman next <id>` builds one again)';
    const lines = linesOf(describeStatus({ ...snap(loop), skipped: ['ACME-1', 'ACME-2'] }, 1, { items: [] }));
    expect(lines).toContain(line);
    expect(lines.indexOf(line)).toBeLessThan(lines.findIndex((l) => l.startsWith('Waiting on you:')));
    for (const skipped of [[], undefined]) {
      const out = describeStatus({ ...snap(loop), skipped }, 1, { items: [] });
      expect(linesOf(out).some((l) => l.includes('Skipped this run'))).toBe(false);
    }
  });

  it('the queued work: a Queued: heading after the slots, one line of text each, and nothing when there is none', () => {
    const loop = { state: 'running', reason: '' };
    const queued = [
      { id: 'ACME-4', slot: null, from: 'w4', text: 'ACME-4 queued for w4, which is over the worker count; w1 takes it next' },
      { id: 'ACME-5', slot: 'w2', text: 'ACME-5 queued for w2' },
    ];
    const lines = linesOf(describeStatus({ ...snap(loop), queued }, 1, { items: [] }));
    const at = lines.indexOf('  Queued:');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 3)).toEqual(['    ACME-4 queued for w4, which is over the worker count; w1 takes it next', '    ACME-5 queued for w2']);
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith('Waiting on you:')));
    for (const none of [[], undefined]) {
      const out = describeStatus({ ...snap(loop), queued: none }, 1, { items: [] });
      expect(linesOf(out).some((l) => l.includes('Queued'))).toBe(false);
    }
  });

  it('the stories waiting on running stories: a heading after Queued, one line of text each, and nothing when there are none', () => {
    const loop = { state: 'running', reason: '' };
    const fileWaits = [{ id: 'ACME-2', text: 'ACME-2 waits for ACME-1: src/a.mjs' }];
    const lines = linesOf(describeStatus({ ...snap(loop), fileWaits }, 1, { items: [] }));
    const at = lines.indexOf('  Waiting on running stories:');
    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe('    ACME-2 waits for ACME-1: src/a.mjs');
    for (const none of [[], undefined]) {
      const out = describeStatus({ ...snap(loop), fileWaits: none }, 1, { items: [] });
      expect(linesOf(out).some((l) => l.includes('Waiting on running stories'))).toBe(false);
    }
  });

  it('running with nothing stuck, and a pause requested while stuck', () => {
    const loop = { state: 'running', reason: '' };
    expect(linesOf(describeStatus(snap(loop), 1, { items: [] }))[0]).toBe('Foreman: running');
    expect(linesOf(describeStatus({ ...snap(loop), stuck: null }, 1, { items: [] }))[0]).toBe('Foreman: running');
    expect(linesOf(describeStatus({ ...snap(loop), stuck: { reason: 'R' }, control: { paused: true } }, 1, { items: [] }))[0]).toBe('Foreman: running, pause requested');
  });

  it('nothing waiting', () => {
    const out = describeStatus(snap({ state: 'stopped' }), 1, { items: [] });
    expect(linesOf(out)).toContain('Waiting on you: 0');
    for (const heading of ['Needs you now', 'Your tasks', 'Quick decisions', 'Later', 'FYI']) expect(out).not.toContain(heading);
    expect(out.trimEnd().split('\n').at(-1)).toBe('Waiting on you: 0');
  });
});

describe('describeStatus: a story In Progress with nothing running it', () => {
  it('names it in the headline, even with nothing waiting and the run stopped', () => {
    const out = describeStatus(snap({ state: 'stopped' }), 1, { items: [], stranded: ['ACME-2'] });
    expect(linesOf(out)).toContain('  Idle: nothing left to build and nothing waits on you. ACME-2 is In Progress with nothing running it.');
    expect(out).not.toContain('Needs you now');
  });

  it('prints no headline for a stopped run with nothing waiting and nothing stranded', () => {
    const out = describeStatus(snap({ state: 'stopped' }), 1, { items: [], stranded: [] });
    expect(out).not.toContain('In Progress');
    expect(out.trimEnd().split('\n').at(-1)).toBe('Waiting on you: 0');
  });
});

describe('foreman status with a story left In Progress', () => {
  let dir;
  const config = { version: 1, project: { name: 'Acme' }, slots: 1, checks: [{ run: 'true', when: 'always' }], console: { adapter: 'files' } };
  const state = () => join(dir, '.foreman');
  const LINE = 'ACME-2 is In Progress with nothing running it.';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-status-'));
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(config));
    mkdirSync(join(dir, 'stories'));
    for (const id of ['ACME-1', 'ACME-2']) writeFileSync(join(dir, 'stories', `${id}.md`), `---\nid: ${id}\ntitle: Story ${id}\nstatus: todo\n---\n\n# ${id}\n\n## Progress notes\n`);
    mkdirSync(state(), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function foreman(argv) {
    let out = '';
    let err = '';
    const code = await main(argv, { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, now: () => new Date(2026, 9, 31, 7, 0), stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } } });
    return { code, out, err };
  }

  it('names a started story that no claim, slot or run holds, until the owner claims it', async () => {
    expect((await foreman(['story', 'start', 'ACME-2'])).code).toBe(0);
    // While its session's slot holds it, it is not stranded.
    expect(readSlot(state(), 'w1').story?.id).toBe('ACME-2');
    expect((await foreman(['status'])).out).not.toContain(LINE);
    // The session is gone and its slot was cleared, but the story stayed In Progress.
    setSlot(state(), 'w1', { state: 'idle', story: null });

    const r = await foreman(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`  Idle: nothing left to build and nothing waits on you. ${LINE}\n`);
    expect(r.out).not.toContain('ACME-1 is In Progress');
    // The dashboard's snapshot reads the same headline, once a decisions folder is there.
    mkdirSync(join(state(), 'decisions'), { recursive: true });
    expect(JSON.parse((await foreman(['status', '--json'])).out).waiting.headline.text).toBe(`Idle: nothing left to build and nothing waits on you. ${LINE}`);

    expect((await foreman(['lock', 'owner-claim', 'ACME-2'])).code).toBe(0);
    const claimed = await foreman(['status']);
    expect(claimed.code).toBe(0);
    expect(claimed.out).not.toContain('In Progress with nothing running');
  });
});

describe('describeStatus: draining after workers was lowered', () => {
  const draining = { running: 4, limit: 3, text: '4 running, limit 3: draining' };
  it('says how many run over the limit on the Workers line', () =>
    expect(linesOf(describeStatus({ ...snap({ state: 'running', reason: '' }), workers: 3, slots: [], draining }, 5))).toContain('Workers: 3 of 5 slots · 4 running, limit 3: draining'));
  it('reads as before with nothing draining', () => {
    const lines = linesOf(describeStatus({ ...snap({ state: 'running', reason: '' }), workers: 3, slots: [], draining: null }, 5));
    expect(lines).toContain('Workers: 3 of 5 slots');
    expect(lines.filter((l) => l.startsWith('Workers:'))).toEqual(['Workers: 3 of 5 slots']);
  });
});

describe('describeStatus: a slot held for the Claude API', () => {
  const RETRY = 'held until the API is back (retry at 14:05)';
  const story = { id: 'ACME-1', title: 'T', stage: 'release' };
  const w1 = (over) => linesOf(describeStatus({ ...snap({ state: 'running', reason: '' }), slots: [{ id: 'w1', story, ...over }] }, 1)).find((l) => l.startsWith('  w1'));
  it('shows the retry time in the state column, with no reason after the story', () => {
    const line = w1({ state: 'held', heldFor: 'api', reason: RETRY });
    expect(line).toContain(RETRY);
    expect(line).toContain('ACME-1 T · release');
    expect(line.endsWith(`(${RETRY})`)).toBe(false);
  });
  it('a slot held by a halt still reads held, with the reason in brackets', () => {
    const reason = 'This story stopped the release line; waiting for you to fix the cause.';
    const line = w1({ state: 'held', haltedBy: true, reason });
    expect(line).toMatch(/^ {2}w1 {2}held {6}ACME-1 T · release \(This story stopped/);
    expect(line.endsWith(`(${reason})`)).toBe(true);
  });
  it('a held slot with no heldFor keeps the reason in brackets', () => {
    expect(w1({ state: 'held', reason: 'Committed; releases are frozen by a halt.' })).toContain('(Committed; releases are frozen by a halt.)');
  });
});

describe('describeStatus: who stopped the run', () => {
  const stoppedBy = { via: 'unknown', run: true, story: 'ACME-9', text: "ACME-9's session at 04:01 UTC" };

  it('a stopped run names who stopped it', () => {
    const lines = linesOf(describeStatus({ ...snap({ state: 'stopped' }), stoppedBy }, 1, { items: [] }));
    expect(lines[0]).toBe("Foreman: stopped by ACME-9's session at 04:01 UTC");
    expect(lines[1]).toBe('Workers: 1 of 1 slot');
  });

  it('a running run with a stop asked for says who asked, on the second line', () => {
    const lines = linesOf(describeStatus({ ...snap({ state: 'running' }), stoppedBy }, 1, { items: [] }));
    expect(lines[0]).toBe('Foreman: running');
    expect(lines[1]).toBe("  Stop requested by ACME-9's session at 04:01 UTC: the run finishes the stories in progress, then stops.");
    expect(lines[2]).toBe('Workers: 1 of 1 slot');
  });

  it('a paused, stopped project still reads as paused', () => {
    const out = describeStatus({ ...snap({ state: 'stopped' }), stoppedBy, control: { paused: true } }, 1, { items: [] });
    expect(linesOf(out)[0]).toBe('Foreman: paused (no run active; the next run starts paused)');
  });

  it('with nobody named, nothing changes', () => {
    for (const state of ['stopped', 'running']) {
      expect(describeStatus({ ...snap({ state }), stoppedBy: null }, 1, { items: [] })).toBe(describeStatus(snap({ state }), 1, { items: [] }));
    }
    expect(linesOf(describeStatus(snap({ state: 'stopped' }), 1, { items: [] }))[0]).toBe('Foreman: stopped');
  });
});

describe('describeStatus: the Learning line', () => {
  const totals = { stories: 2, shipped: 1, costUsd: 3, minutes: 40 };

  it('says how many learned items are active and in evaluation, after This run and before Waiting on you', () => {
    const lines = linesOf(describeStatus({ ...snap({ state: 'stopped' }), totals }, 1, { items: [], learning: { active: 2, evaluating: 1 } }));
    const at = lines.indexOf('Learning: 2 active, 1 in evaluation');
    expect(at).toBeGreaterThan(-1);
    expect(lines[at - 1]).toMatch(/^This run: /);
    expect(lines[at + 1]).toBe('Waiting on you: 0');
  });

  it('has no Learning line without counts', () => {
    expect(describeStatus(snap({ state: 'stopped' }), 1, { items: [], learning: null })).not.toContain('Learning:');
    expect(describeStatus(snap({ state: 'stopped' }), 1, { items: [] })).not.toContain('Learning:');
  });
});

describe('foreman status with learned items', () => {
  let dir;
  const config = { version: 1, project: { name: 'Acme' }, slots: 1, checks: [{ run: 'true', when: 'always' }], console: { adapter: 'files' } };
  const state = () => join(dir, '.foreman');
  const at = { now: new Date('2026-10-25T06:00:00Z') };
  const trait = (role, text) => addItem(state(), { kind: 'trait', roles: [role], text, source: null, reason: 'two stories shipped untested routes' }, at);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-status-'));
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(config));
    mkdirSync(state(), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function status(argv = ['status']) {
    let out = '';
    let err = '';
    const code = await main(argv, { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, now: () => new Date(2026, 9, 25, 7, 0), stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } } });
    return { code, out, err };
  }

  it('prints the Learning line from the ledger, skipping a torn line', async () => {
    trait('developer', 'Acme: give every new route a test.');
    trait('tester', 'Acme: name each test after its route.');
    keepItem(state(), 'L-2', { ...at, by: 'owner' });
    appendFileSync(join(state(), 'learning.jsonl'), '{"torn":\n');
    const r = await status();
    expect(r.code).toBe(0);
    expect(r.out).toContain('\nLearning: 2 active, 1 in evaluation\nWaiting on you: 0\n');
  });

  it('prints no Learning line before anything is learned', async () => {
    const r = await status();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Learning:');
  });

  it('still answers when the ledger cannot be read at all', async () => {
    mkdirSync(join(state(), 'learning.jsonl'));
    const r = await status();
    expect(r.code).toBe(0);
    expect(r.out).toContain('Waiting on you: 0');
    expect(r.out).not.toContain('Learning:');
  });

  it('keeps --json as the snapshot, with no learning key', async () => {
    trait('developer', 'Acme: give every new route a test.');
    const r = await status(['status', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).not.toHaveProperty('learning');
  });
});

describe('foreman status while the run is on the last good config', () => {
  let dir;
  const since = new Date(2026, 9, 24, 23, 49);
  const config = { version: 1, project: { name: 'Acme' }, slots: 2, checks: [{ run: 'true', when: 'always' }], console: { adapter: 'files' } };
  const state = () => join(dir, '.foreman');
  const saveState = (extra) => writeFileSync(join(state(), 'state.json'), JSON.stringify({ loop: { state: 'running', reason: '', since: since.toISOString() }, workers: 1, ...extra }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-status-'));
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ ...config, bogusKey: true }));
    mkdirSync(state(), { recursive: true });
    writeFileSync(join(state(), 'config.last-good.json'), JSON.stringify(withDefaults(config)));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function status(argv = ['status']) {
    let out = '';
    let err = '';
    const code = await main(argv, { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, now: () => new Date(2026, 9, 25, 7, 0), stdout: { write: (t) => { out += t; } }, stderr: { write: (t) => { err += t; } } });
    return { code, out, err };
  }

  it('shows the run and the invalid config as one Needs-you item', async () => {
    saveState({ configProblem: { since: since.toISOString(), reason: 'bogusKey: unknown key' } });
    const r = await status();
    expect(r.code).toBe(0);
    expect(r.err).toContain('foreman.config.json is invalid (');
    expect(r.err).toContain('showing the run on the last good config');
    expect(r.out).toContain('  Needs you now (1):\n');
    expect(r.out).toContain('    foreman.config.json is invalid\n');
    expect(r.out).toContain('      config invalid since 23:49: bogusKey: unknown key; running on the last good config\n');
  });

  it('refuses an invalid config as before when the run is not on the last good one', async () => {
    saveState({});
    const r = await status();
    expect(r.code).toBe(1);
    expect(r.err).toContain('foreman.config.json bogusKey: unknown key');
  });
});
