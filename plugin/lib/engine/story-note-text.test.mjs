import { describe, expect, it } from 'vitest';
import { clean, footer, machineText, renderNote, sessionEnding } from './story-note-text.mjs';
import { answerNote, decisionNote, designData } from './story-notes-queue.mjs';

const config = { roles: { builders: { developer: { agent: 'foreman:builder', use: 'everything' }, plain: { agent: 'foreman:plain' } } } };

// The comment as a person reads it on the story: "Foreman: <title>", the summary, the body.
const comment = (note) => [`Foreman: ${note.title}`, note.summary, note.body, footer('2026-10-31T14:05:00Z', 'w2')].filter(Boolean).join('\n\n');

const PLAN = {
  ready: true,
  blocker: '',
  needs_owner: false,
  builder: 'developer',
  resources: ['schema'],
  files: ['plugin/lib/acme/orders.mjs', 'plugin/lib/acme/orders.test.mjs'],
  design: 'Add an order queue to the Acme shop.\n\nIt keeps the oldest order first.\n\nIt never drops an order.',
  test_plan: 'Each order leaves the queue in the order it came in.',
  done_when: 'npm test passes for the order queue.',
};

const DECISION = {
  id: 'd-20261031140500-ab12',
  story: 'ACME-1',
  kind: 'decision',
  title: 'Which database should Acme use?',
  summary: 'Acme needs a place to keep orders.',
  options: ['Postgres', 'SQLite'],
  hints: ['A server to run and back up.', 'One file, nothing to run.'],
  recommend: 'SQLite',
  urgent: true,
  body: 'LONG BODY THAT MUST STAY OFF THE STORY',
  explain: { purpose: 'x', happened: 'y', recommendation: 'z' },
};

const finding = (over = {}) => ({ stage: 'test', severity: 'blocker', rule: 'the retry never stops', where: 'plugin/lib/engine/retry.mjs:42', observed: 'the loop has no limit', fix: 'cap it at three', ...over });

describe('a decision and its answer', () => {
  it('says the title, the summary and each option with its hint, the recommended one marked, and never the body', () => {
    const note = renderNote(decisionNote(DECISION), { config });
    expect(note.title).toBe('the owner was asked: Which database should Acme use?');
    const all = comment(note);
    expect(all).toContain('Acme needs a place to keep orders.');
    expect(all).toContain('It is urgent.');
    expect(all).toContain('The options:');
    expect(all).toContain('- Postgres: A server to run and back up.');
    expect(all).toContain('- SQLite (recommended): One file, nothing to run.');
    expect(all).not.toContain('LONG BODY');
    expect(all).not.toContain('explain');
  });

  it('words a task as something the owner was asked to do, and leaves out what it has not got', () => {
    const note = renderNote(decisionNote({ ...DECISION, kind: 'task', urgent: false, options: [], hints: [], recommend: undefined, summary: undefined }), { config });
    expect(note.title).toBe('the owner was asked to do: Which database should Acme use?');
    expect(note.body).toBe('');
    expect(note.summary).toBe('');
  });

  it('quotes the option and the note unchanged', () => {
    const answered = { ...DECISION, answer: { option: 'SQLite', note: 'Use the cheaper one; it is "enough" for now.', at: '2026-10-31T14:06:00Z' } };
    const note = renderNote(answerNote(answered), { config });
    expect(note.title).toBe('the owner answered: Which database should Acme use?');
    expect(note.summary).toBe('They chose "SQLite".');
    expect(note.body).toBe('Their note: "Use the cheaper one; it is "enough" for now."');
  });

  it('quotes a free-text answer as their answer', () => {
    const note = renderNote(answerNote({ ...DECISION, options: [], answer: { option: null, note: 'Use Postgres 16.' } }), { config });
    expect(note.summary).toBe('Their answer: "Use Postgres 16."');
    expect(note.body).toBe('');
  });
});

describe('the design', () => {
  it('names the builder and its use text, and carries the design, the test plan, the done-when and the files as prose', () => {
    const note = renderNote({ kind: 'design', data: designData(PLAN) }, { config });
    expect(note.title).toBe('design');
    expect(note.summary).toBe('The architect chose the developer builder, whose work is: everything.');
    expect(note.body).toContain('## The design\n\nAdd an order queue to the Acme shop.\n\nIt keeps the oldest order first.\n\nIt never drops an order.');
    expect(note.body).toContain('## How it will be tested\n\nEach order leaves the queue in the order it came in.');
    expect(note.body).toContain('## Done when\n\nnpm test passes for the order queue.');
    expect(note.body).toContain('## Files it expects to change\n\n- plugin/lib/acme/orders.mjs\n- plugin/lib/acme/orders.test.mjs');
    expect(note.body).toContain('## What it needs for itself\n\n- schema');
    expect(note.body).not.toContain('Why it cannot be built yet');
  });

  it('stops at "builder." when the builder has no use text, and leaves out resources it does not need', () => {
    const note = renderNote({ kind: 'design', data: designData({ ...PLAN, builder: 'plain', resources: [] }) }, { config });
    expect(note.summary).toBe('The architect chose the plain builder.');
    expect(note.body).not.toContain('What it needs for itself');
  });

  it('says a story it waits for, in words', () => {
    const note = renderNote({ kind: 'design', data: designData({ ...PLAN, ready: false, needs_owner: false, blocker: 'ACME-1, ACME-2 must land first' }) }, { config });
    expect(note.body).toContain('## Why it cannot be built yet\n\nIt waits for ACME-1, ACME-2 to land first.');
    expect(note.body).not.toContain('must land first');
  });

  it('keeps what follows the ids of a blocker, and a blocker with no ids as written', () => {
    const waits = renderNote({ kind: 'design', data: designData({ ...PLAN, ready: false, blocker: 'ACME-3: needs the orders table' }) }, { config });
    expect(waits.body).toContain('It waits for ACME-3 to land first. Needs the orders table.');
    const plain = renderNote({ kind: 'design', data: designData({ ...PLAN, ready: false, blocker: 'The payment key is missing' }) }, { config });
    expect(plain.body).toContain('The payment key is missing.');
  });

  it('puts an owner question, its options and the recommended one in words', () => {
    const q = { summary: 'Which payment provider?', options: [{ label: 'Stripe', hint: 'Cards in minutes.' }, { label: 'Adyen', hint: 'Cheaper at scale.' }], recommend: 'Stripe' };
    const note = renderNote({ kind: 'design', data: designData({ ...PLAN, ready: false, needs_owner: true, blocker: 'needs a choice', owner_question: q }) }, { config });
    expect(note.body).toContain('It asks the owner: Which payment provider?');
    expect(note.body).toContain('- Stripe (recommended): Cards in minutes.');
    expect(note.body).toContain('- Adyen: Cheaper at scale.');
    expect(machineText(comment(note))).toBeNull();
  });

  it('a revised design lists only what changed', () => {
    const before = designData(PLAN);
    const next = designData({
      ...PLAN,
      builder: 'plain',
      files: [...PLAN.files, 'plugin/lib/acme/audit.mjs'],
      design: 'Add an order queue to the Acme shop.\n\nIt keeps the oldest order first.\n\nIt drops an order only when the owner says so.',
    });
    const note = renderNote({ kind: 'design', data: next }, { config, previousDesign: before });
    expect(note.title).toBe('design (revised)');
    expect(note.body).toContain('The builder is now plain (it was developer).');
    expect(note.body).toContain('It will now also change plugin/lib/acme/audit.mjs.');
    expect(note.body).toContain('## Added to the design\n\n- It drops an order only when the owner says so.');
    expect(note.body).toContain('## Taken out of the design\n\n- It never drops an order.');
    expect(note.body).not.toContain('It keeps the oldest order first');
    expect(note.body).not.toContain('Add an order queue');
    expect(note.body).not.toContain('## How it will be tested');
  });

  it('a revised design names files taken out, resources and readiness, and has nothing for the same design', () => {
    const before = designData(PLAN);
    const note = renderNote({ kind: 'design', data: designData({ ...PLAN, files: [PLAN.files[0]], resources: [], ready: false, blocker: 'ACME-9 must land first' }) }, { config, previousDesign: before });
    expect(note.body).toContain('It will no longer change plugin/lib/acme/orders.test.mjs.');
    expect(note.body).toContain('It no longer needs schema for itself.');
    expect(note.body).toContain('It can no longer be built: It waits for ACME-9 to land first.');
    expect(renderNote({ kind: 'design', data: designData(PLAN) }, { config, previousDesign: before })).toBeNull();
  });

  it('caps the changed lines at 30 and counts the rest', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n');
    const note = renderNote({ kind: 'design', data: designData({ ...PLAN, design: many(35) }) }, { config, previousDesign: designData({ ...PLAN, design: 'Other.' }) });
    expect(note.body).toContain('- Line 30\n- …and 5 more lines');
    expect(note.body).not.toContain('Line 31');
  });
});

describe('a round', () => {
  const stages = ['test', 'security'];

  it('writes a finding as one sentence, in full detail', () => {
    const note = renderNote({ kind: 'round', data: { round: 1, approved: false, findings: [finding()], stages: ['test'] } }, { config, detail: 'full' });
    expect(note.title).toBe('round 1 sent back');
    expect(note.body).toContain('- (blocker) The tester found that the retry never stops (plugin/lib/engine/retry.mjs, line 42): the loop has no limit. Fix: cap it at three.');
  });

  it('counts the findings and lists none, in summary detail', () => {
    const findings = [finding(), finding({ where: 'plugin/a.mjs:1' }), finding({ severity: 'major', stage: 'security' })];
    const note = renderNote({ kind: 'round', data: { round: 2, approved: false, findings, stages } }, { config, detail: 'summary' });
    expect(note.summary).toBe('The tester and the security reviewer sent it back with 3 findings: 2 blockers and 1 major.');
    expect(note.body).toBe('');
    expect(comment(note)).not.toContain('retry never stops');
  });

  it('words where and who: no place, a stage that is not a reviewer, a reviewer already named so', () => {
    const f = (over) => renderNote({ kind: 'round', data: { round: 1, approved: false, findings: [finding(over)], stages } }, { config, detail: 'full' }).body;
    expect(f({ where: '-' })).toContain('found that the retry never stops: the loop has no limit.');
    expect(f({ where: '' })).not.toContain('()');
    expect(f({ where: 'README.md' })).toContain('(README.md)');
    expect(f({ stage: 'security' })).toContain('The security reviewer found');
    expect(f({ stage: 'code-reviewer' })).toContain('The code-reviewer found');
    expect(f({ stage: 'checks' })).toContain('The checks found');
    expect(f({ observed: 'It loops.', fix: 'Stop it.' })).toContain(': It loops. Fix: Stop it.');
  });

  it('an approved round names who approved, and counts or lists the minor findings', () => {
    const minor = [finding({ severity: 'minor', stage: 'security', where: 'plugin/b.mjs:3', rule: 'a name is unclear', observed: 'x is a poor name', fix: 'rename it' })];
    const data = { round: 2, approved: true, findings: minor, stages };
    const summary = renderNote({ kind: 'round', data }, { config, detail: 'summary' });
    expect(summary.title).toBe('round 2 approved');
    expect(summary.summary).toBe('The tester and the security reviewer approved the change. 1 minor finding is left for later.');
    const full = renderNote({ kind: 'round', data }, { config, detail: 'full' });
    expect(full.summary).toBe('The tester and the security reviewer approved the change.');
    expect(full.body).toContain('Minor findings left for later:\n\n- (minor) The security reviewer found that a name is unclear (plugin/b.mjs, line 3): x is a poor name. Fix: rename it.');
    expect(renderNote({ kind: 'round', data: { ...data, findings: [] } }, { config, detail: 'summary' }).summary).toBe('The tester and the security reviewer approved the change.');
  });
});

describe('a round with an engine reviewer still to answer', () => {
  const round = (over, detail = 'summary') => renderNote({ kind: 'round', data: { round: 2, approved: true, findings: [], stages: ['test', 'compliance'], waiting: ['security'], ...over } }, { config, detail });

  it('an approved round with an engine reviewer still to answer says so, not "approved" in the title', () => {
    const note = round({});
    expect(note.title).toBe('round 2: the tester and the compliance reviewer approved');
    expect(note.title).not.toMatch(/round 2 approved/);
    expect(note.summary).toBe('The tester and the compliance reviewer approved the change. The security reviewer reviews it outside this session; its verdict is still to come.');
    expect(round({ waiting: ['security', 'style'] }).summary.endsWith('The security reviewer and the style reviewer review it outside this session; their verdicts are still to come.')).toBe(true);
    const minor = [finding({ severity: 'minor' })];
    expect(round({ findings: minor }).summary.endsWith(' 1 minor finding is left for later.')).toBe(true);
    expect(round({ findings: minor }, 'full').summary).not.toContain('left for later');
    expect(machineText(comment(note))).toBeNull();
  });

  it('keeps today\'s wording with no one waiting', () => {
    expect(round({ waiting: [] }).title).toBe('round 2 approved');
    expect(round({ waiting: undefined }).summary).toBe('The tester and the compliance reviewer approved the change.');
    expect(round({ approved: false, findings: [finding()] }).title).toBe('round 2 sent back');
  });
});

describe('a session ending', () => {
  const ending = (over) => sessionEnding({ stop: 'watchdog', watchdog: 'too-long', next: 'resume', kept: [], session: '2026-10-31T13:00:00Z', ...over });
  const words = (over) => comment(renderNote({ kind: 'session', data: ending(over) }, { config }));

  it('says what the watchdog saw and what is kept for the resume', () => {
    const all = words({ kept: ['architect:ACME-1', 'build:ACME-1', 'test:ACME-1#1'] });
    expect(all).toContain('Foreman: the session stopped');
    expect(all).toContain('no progress for too long (no stage change and no agent starting or finishing)');
    expect(all).toContain('It will resume, keeping the design, the build and the tester\'s approval in round 1.');
  });

  it('words the other watchdog reasons, a fix build, and another reviewer', () => {
    expect(words({ watchdog: 'quiet' })).toContain('it was quiet for too long');
    expect(words({ watchdog: 'ceiling' })).toContain('it hit the hard limit');
    expect(words({ kept: ['fix:ACME-1#2', 'compliance:ACME-1#2'] })).toContain('keeping the build and the compliance review in round 2.');
    expect(words({})).toContain('It will resume.');
  });

  it('a crash that parks the slot carries the reason', () => {
    const data = sessionEnding({ stop: null, cause: null, next: 'parked', reason: 'The session crashed twice on ACME-1.' });
    expect(data).toMatchObject({ why: 'crash', next: 'parked' });
    const all = comment(renderNote({ kind: 'session', data }, { config }));
    expect(all).toContain('It ended without reporting a result.');
    expect(all).toContain('The slot is parked: The session crashed twice on ACME-1.');
  });

  it('words a sign-in, an empty API balance, a usage limit with its reset, a rate limit and an outage', () => {
    const cause = (c, over = {}) => comment(renderNote({ kind: 'session', data: sessionEnding({ stop: null, cause: c, next: 'resume', ...over }) }, { config }));
    expect(cause('signin')).toContain('The Claude sign-in stopped working.');
    expect(cause('api-credit')).toContain('The Console API key ran out of credit.');
    expect(cause('credit', { resetAt: '5pm' })).toContain('The usage limit was reached, and it resets 5pm.');
    expect(cause('rate-limit')).toContain('The Claude API was rate limited.');
    expect(cause('outage')).toContain('The Claude API was down or overloaded.');
    expect(comment(renderNote({ kind: 'session', data: sessionEnding({ cause: 'credit', next: 'held' }) }, { config }))).toContain('Its commit is kept and it waits for the Claude API.');
  });

  it('gives nothing for a story that had ended, or when nothing went wrong', () => {
    expect(sessionEnding({ stop: 'watchdog', watchdog: 'ended-quiet', next: 'resume' })).toBeNull();
    expect(sessionEnding({ stop: 'watchdog', watchdog: 'ended-alive', next: 'resume' })).toBeNull();
    expect(sessionEnding({ next: 'idle' })).toBeNull();
    expect(sessionEnding({ next: 'held' })).toBeNull();
    expect(sessionEnding({})).toBeNull();
  });
});

describe('a release stop and a follow-up', () => {
  const release = (data) => comment(renderNote({ kind: 'release', data }, { config }));

  it('says a conflict, and a failed migration, with the reason and the pull request', () => {
    const conflict = release({ code: 6, stage: 'merge', reason: 'It conflicts in plugin/a.mjs.', pr: 'https://github.com/acme/app/pull/12' });
    expect(conflict).toContain('Foreman: the release stopped');
    expect(conflict).toContain('The branch conflicts with the base branch.');
    expect(conflict).toContain('The reason given: It conflicts in plugin/a.mjs.');
    expect(conflict).toContain('The pull request: https://github.com/acme/app/pull/12');
    const migration = release({ code: 4, stage: 'resources', reason: 'The migration failed.', pr: null });
    expect(migration).toContain('releases are frozen until the owner clears the halt');
    expect(migration).not.toContain('The pull request');
  });

  it('words the other codes, and a failed step by its name', () => {
    expect(release({ code: 2, stage: 'ci', reason: '', pr: null })).toContain('CI or the checks on the merged code failed, so nothing was merged.');
    expect(release({ code: 5, stage: 'deploy', reason: '', pr: null })).toContain('after the point of no return');
    expect(release({ code: 10, stage: 'x', reason: '', pr: null })).toContain('allow metadata deletes');
    expect(release({ code: 1, stage: 'push', reason: 'rejected', pr: null })).toContain('The release step push failed.');
  });

  it('names the follow-up by its key and title', () => {
    const note = renderNote({ kind: 'follow-up', data: { id: 'ACME-7', title: 'Rename the order queue' } }, { config });
    expect(note.title).toBe('follow-up created');
    expect(note.summary).toBe('Foreman created ACME-7 (Rename the order queue) for the minor findings this story left.');
  });

  it('knows no other kind', () => {
    expect(renderNote({ kind: 'weather', data: {} }, { config })).toBeNull();
  });
});

describe('clean', () => {
  it('blanks keys, tokens and Bearer values, and every known secret value', () => {
    const out = clean('key sk_live_abcdef123456, GH_TOKEN=x, Authorization: Bearer abc, and topsecretvalue1 inside', { values: ['topsecretvalue1'] });
    expect(out).not.toContain('sk_live_abcdef123456');
    expect(out).not.toContain('GH_TOKEN=x');
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('topsecretvalue1');
    expect(clean('long-secret-value-12345 and long-secret-value', { values: ['long-secret-value', 'long-secret-value-12345'] })).toBe('••• and •••');
    expect(clean('token abcd1234efgh', { env: { ACME_PRIVATE: 'abcd1234efgh' }, values: ['abcd1234efgh'] })).toBe('token •••');
  });

  it('drops the roots and turns the home folder into ~', () => {
    expect(clean('see /work/acme/.foreman/worktrees/w2/plugin/a.mjs and /work/acme/b.mjs', { roots: ['/work/acme', '/work/acme/.foreman/worktrees/w2'] })).toBe('see plugin/a.mjs and b.mjs');
    expect(clean('in /home/pat/x and /home/pat', { home: '/home/pat' })).toBe('in ~/x and ~');
    expect(clean('/home/patrick/x', { home: '/home/pat' })).toBe('/home/patrick/x');
  });

  it('removes a FACTORY_RESULT line and keeps the rest', () => {
    expect(clean('Done.\nFACTORY_RESULT: shipped ACME-1\nBye.')).toBe('Done.\nBye.');
  });
});

describe('footer', () => {
  it('gives the time in UTC and the slot', () => {
    expect(footer('2026-10-31T14:05:59Z', 'w2')).toBe('At 2026-10-31 14:05 UTC, slot w2.');
    expect(footer(new Date('2026-10-31T14:05:00Z'))).toBe('At 2026-10-31 14:05 UTC.');
  });
});

describe('machineText', () => {
  it('flags a JSON object, a plan field name and a FACTORY_RESULT line', () => {
    expect(machineText('{"builder":"x"}')).toMatch(/JSON/);
    expect(machineText('It chose [1, 2, {"a": [3]}] for now')).toMatch(/JSON/);
    expect(machineText('see test_plan here')).toMatch(/test_plan/);
    expect(machineText('builder: developer')).toMatch(/plan field/);
    expect(machineText('Done.\nFACTORY_RESULT: shipped S-1')).toMatch(/FACTORY_RESULT/);
  });

  it('lets prose through, brackets and braces in it included', () => {
    expect(machineText('See [the PR](https://github.com/acme/app/pull/1) and {not json} and the builder chose well.')).toBeNull();
  });

  it('finds none in any note written from the fixtures', () => {
    const notes = [
      renderNote(decisionNote(DECISION), { config }),
      renderNote(answerNote({ ...DECISION, answer: { option: 'SQLite', note: 'Cheaper.' } }), { config }),
      renderNote({ kind: 'design', data: designData(PLAN) }, { config }),
      renderNote({ kind: 'design', data: designData({ ...PLAN, builder: 'plain', design: 'A different design.' }) }, { config, previousDesign: designData(PLAN) }),
      renderNote({ kind: 'round', data: { round: 1, approved: false, findings: [finding()], stages: ['test'] } }, { config, detail: 'full' }),
      renderNote({ kind: 'round', data: { round: 2, approved: true, findings: [], stages: ['test'] } }, { config, detail: 'summary' }),
      renderNote({ kind: 'session', data: sessionEnding({ stop: 'watchdog', watchdog: 'too-long', next: 'resume', kept: ['architect:ACME-1'] }) }, { config }),
      renderNote({ kind: 'release', data: { code: 6, stage: 'merge', reason: 'It conflicts.', pr: 'https://github.com/acme/app/pull/12' } }, { config }),
      renderNote({ kind: 'follow-up', data: { id: 'ACME-7', title: 'Rename it' } }, { config }),
    ];
    for (const note of notes) expect(machineText(comment(note)), comment(note)).toBeNull();
  });
});
