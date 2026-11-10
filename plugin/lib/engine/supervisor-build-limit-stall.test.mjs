// `foreman run 1` end to end with the build limit, which measures the time since the story's
// last progress, not the session's age: a story that stops making progress. The case of one that
// keeps making it is in supervisor-build-limit.test.mjs (and one whose agent only takes tool steps
// in supervisor-build-limit-steps.test.mjs); the fixture, with the fake session, is
// test/build-limit-fixture.mjs.
//
// stall: the first session leaves transcripts of a ready architect, a complete build, an
// approved tester and a compliance reviewer that never answered, then makes no progress. The
// watchdog stops it at the build limit (12 s), keeps the finished stages in the checkpoint and
// records the redone work; the next session's `foreman workflow-args` carries the plan and the
// resume, and its result spends the checkpoint.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortPlan } from './plan-file.mjs';
import { PLAN, repos, runFactory, SESSION, setUp, withBuildLimitRepos } from '../../../test/build-limit-fixture.mjs';

withBuildLimitRepos();

describe('the build limit with a story that stops making progress', () => {
  it('stops it, keeps its finished stages, and the next session resumes from them', async () => {
    setUp({ buildMinutes: 0.2 });
    const out = join(repos.base, 'args.json');
    const { code, state, events, runs, sessions } = await runFactory({
      FAKE_MODE: 'stall',
      FAKE_ARGS_OUT: out,
      // A note another process queued while the second session ran (the dashboard, a command), which no
      // session ending posts: only the supervisor's tick does.
      FAKE_ANSWERED_ITEM: JSON.stringify({ id: 'd-20261101100000-abcd', story: 'ACME-1', kind: 'decision', title: 'Which thing?', options: ['Yes', 'No'], urgent: false, body: '', createdAt: '2026-11-01T10:00:00.000Z', answer: { option: 'Yes', note: '', at: '2026-11-01T10:01:00.000Z' }, appliedAt: null }),
      FAKE_QUEUE_NOTE: JSON.stringify({ story: 'ACME-1', kind: 'follow-up', data: { id: 'ACME-9', title: 'Tidy ACME-1' }, at: '2026-11-01T10:00:00.000Z', slot: null }),
    });
    expect(code).toBe(0);
    const kept = ['architect:ACME-1', 'build:ACME-1', 'test:ACME-1#1'];
    expect(events.filter((e) => e.text.startsWith('ACME-1: no progress for'))).toMatchObject([
      { kind: 'warn' },
    ]);
    expect(events.filter((e) => e.text.startsWith('ACME-1: no progress for'))[0].text).toMatch(
      /^ACME-1: no progress for 0\.2 minutes \(no stage change, no agent starting or finishing and no agent step; (last stage change or agent start or finish|nothing since the session started) \d+ s ago\); stopping the session to resume it\.$/,
    );
    expect(events.filter((e) => e.text === `ACME-1: kept its finished stages (${kept.join(', ')}) for the resume.`)).toHaveLength(1);
    expect(sessions).toEqual(['ACME-1', 'ACME-1']);

    // The first record says why it stopped and what will be done again: the compliance review.
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ result: 'crashed', watchdog: { why: 'too-long', kept, redoneTokens: 700, redoneMinutes: 15 } });
    expect(runs[1].result).toBe('blocked');
    expect(Object.hasOwn(runs[1], 'watchdog')).toBe(false);

    // The next session was given the plan and the finished build and tester, not the architect.
    const wa = JSON.parse(readFileSync(out, 'utf8'));
    expect(wa.status, wa.stderr).toBe(0);
    const args = JSON.parse(wa.stdout);
    expect(args.plan).toEqual(shortPlan(PLAN));
    expect(readFileSync(args.designFile, 'utf8')).toContain(PLAN.design);
    // The saved plan is the architect's, stamped with the base it was written against.
    expect(JSON.parse(readFileSync(join(state, 'plans', 'ACME-1.json'), 'utf8'))).toMatchObject(PLAN);
    expect(args.resume).toEqual({ build: { summary: 'Built it.', files: ['src/acme.mjs'] }, verdicts: { tester: { findings: [] } } });
    expect(wa.stderr).toContain(`resuming ACME-1 from its last finished stages: ${kept.join(', ')}`);

    // The story itself says the session stopped and what was kept, once, in words.
    const stopped = JSON.parse(readFileSync(join(state, 'stories', 'ACME-1.json'), 'utf8')).notes.map((n) => n.text).filter((t) => t.startsWith('The session stopped'));
    expect(stopped).toEqual([
      "The session stopped: The watchdog stopped it because there was no progress for too long (no stage change and no agent starting or finishing). It will resume, keeping the design, the build and the tester's approval in round 1.",
    ]);

    const queued = JSON.parse(readFileSync(join(state, 'stories', 'ACME-1.json'), 'utf8')).notes.map((n) => n.text).filter((t) => t.startsWith('Follow-up created'));
    expect(queued).toEqual(['Follow-up created: Foreman created ACME-9 (Tidy ACME-1) for the minor findings this story left.']);

    // An answer found while the supervisor applies the owner's answers is written on its story once.
    const answered = JSON.parse(readFileSync(join(state, 'stories', 'ACME-1.json'), 'utf8')).notes.map((n) => n.text).filter((t) => t.startsWith('The owner answered'));
    expect(answered).toEqual(['The owner answered: Which thing?: They chose "Yes".']);

    // Its result spent the checkpoint, and the session files are gone.
    expect(existsSync(join(state, 'checkpoints', 'ACME-1.json'))).toBe(false);
    expect(existsSync(join(repos.base, 'claude', 'projects', '-acme', SESSION))).toBe(false);
  }, 150_000);
});
