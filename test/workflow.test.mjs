import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runWorkflow, splitMeta } from './workflow-harness.mjs';
import { LEARNED_HEADING } from '../plugin/lib/engine/traits.mjs';
import { VERDICT_SCHEMA } from '../plugin/lib/engine/review-engine.mjs';
import { RELAY_MODEL } from '../plugin/lib/engine/state.mjs';
import { shortPlan } from '../plugin/lib/engine/plan-file.mjs';

const COMPLIANCE_TEXT = "Review this story's changes against the plan and the project's rules.";
const SECURITY_TEXT =
  "Review this story's changes: the working tree against main (`git status`, `git diff main`, untracked files included). Grade each finding blocker, major or minor.";

const ROLES = {
  architect: { agent: 'foreman:architect' },
  builders: {
    developer: { agent: 'foreman:builder', use: 'everything' },
    designer: { agent: 'foreman:ui', use: 'pages and components' },
  },
  tester: { agent: 'foreman:tester' },
  reviewers: [
    { name: 'compliance', agent: 'foreman:compliance-reviewer' },
    { name: 'security', agent: 'foreman:security-reviewer' },
  ],
};

const args = (over = {}) => ({
  story: { id: 'S-1', title: 'Add login', brief: 'stories/S-1.md', group: '2', groupName: 'Accounts' },
  rounds: 3,
  roles: ROLES,
  checks: [],
  resources: { db: 'adds or changes a database migration', cache: 'changes the cache layout' },
  holds: [],
  traits: {},
  ...over,
});

const PLAN = {
  ready: true,
  blocker: '',
  needs_owner: false,
  builder: 'developer',
  resources: [],
  design: 'Change login.js only.',
  test_plan: 'login.test.js proves it.',
  done_when: 'npm test passes',
};
const BUILT = { complete: true, summary: 'Built it.', files: ['login.js'], commands: [{ command: 'npm test', passed: true }], problem: '' };
const OK = { approved: true, findings: [], checked: 'ran npm test' };
const finding = (severity, rule = 'a rule') => ({ severity, rule, where: 'login.js:1', observed: 'seen', fix: 'do this' });
const REJECT = (severity = 'major') => ({ approved: false, findings: [finding(severity)], checked: 'read it' });
// A stage that finds a different rule each round: the same file, but never the same kind of bug twice.
const REJECT_BY_ROUND = (severity = 'major') => (c) => ({ approved: false, findings: [finding(severity, `a rule seen at ${c.label}`)], checked: 'read it' });

const passing = (over = {}) => ({
  'architect:': PLAN,
  'build:': BUILT,
  'fix:': BUILT,
  'test:': OK,
  'compliance:': OK,
  'security:': OK,
  ...over,
});

const labels = (calls) => calls.map((c) => c.label);
const call = (calls, label) => calls.find((c) => c.label === label);

describe('pipeline workflow: args', () => {
  it('throws a clear error when the story id, the brief, roles or rounds are missing', async () => {
    await expect(runWorkflow(undefined, {})).rejects.toThrow(/story/);
    await expect(runWorkflow(args({ story: { title: 'x', brief: 'b' } }), {})).rejects.toThrow(/story\.id/);
    await expect(runWorkflow(args({ story: { id: 'S-1', title: 'x' } }), {})).rejects.toThrow(/story\.brief/);
    await expect(runWorkflow(args({ roles: undefined }), {})).rejects.toThrow(/roles/);
    await expect(runWorkflow(args({ rounds: undefined }), {})).rejects.toThrow(/rounds/);
  });

  it('describes the new args in meta and keeps the four phases', async () => {
    const { meta } = await runWorkflow(args(), passing());
    expect(meta.name).toBe('pipeline');
    expect(meta.whenToUse).toMatch(/roles/);
    expect(meta.whenToUse).toMatch(/startAt/);
    expect(meta.whenToUse).toMatch(/history/);
    expect(meta.phases.map((p) => p.title)).toEqual(['Architect', 'Build', 'Test', 'Review']);
  });
});

describe('pipeline workflow: the design schema', () => {
  it("has a builder enum equal to the keys of args.roles.builders", async () => {
    const { calls } = await runWorkflow(args(), passing());
    const schema = call(calls, 'architect:S-1').schema;
    expect(schema.properties.builder.enum).toEqual(['developer', 'designer']);
  });

  it('asks for resources instead of migrations, listing each with its describe text', async () => {
    const { calls } = await runWorkflow(args(), passing());
    const schema = call(calls, 'architect:S-1').schema;
    expect(schema.properties.migrations).toBeUndefined();
    expect(schema.required).not.toContain('migrations');
    expect(schema.required).toContain('resources');
    expect(schema.properties.resources.type).toBe('array');
    expect(schema.properties.resources.items.enum).toEqual(['db', 'cache']);
    expect(schema.properties.resources.description).toContain('db');
    expect(schema.properties.resources.description).toContain('adds or changes a database migration');
    expect(schema.properties.resources.description).toContain('changes the cache layout');
  });

  it('offers an optional owner_question for a choice only the owner can make', async () => {
    const { calls } = await runWorkflow(args(), passing());
    const schema = call(calls, 'architect:S-1').schema;
    const q = schema.properties.owner_question;
    expect(q).toMatchObject({ type: 'object', required: ['summary', 'options', 'recommend'] });
    expect(q.properties.options).toMatchObject({ type: 'array', minItems: 2, items: { type: 'object', required: ['label', 'hint'] } });
    expect(schema.required).not.toContain('owner_question');
  });

  it('lets owner_question carry an optional explanation in plain words', async () => {
    const { calls } = await runWorkflow(args(), passing());
    const q = call(calls, 'architect:S-1').schema.properties.owner_question;
    expect(q.properties.explain).toMatchObject({ type: 'object', required: ['purpose', 'happened', 'recommendation'] });
    expect(Object.keys(q.properties.explain.properties)).toEqual(['purpose', 'happened', 'damage', 'recommendation']);
    for (const part of Object.values(q.properties.explain.properties)) {
      expect(part.type).toBe('string');
      expect(part.description).toContain('280');
      expect(part.description).toMatch(/no file paths/);
    }
    expect(q.required).not.toContain('explain');
  });

  it('asks for every file the story will change, as a required list of strings', async () => {
    const { calls } = await runWorkflow(args(), passing());
    const schema = call(calls, 'architect:S-1').schema;
    expect(schema.properties.files).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(schema.properties.files.description).toMatch(/repository root/);
    expect(schema.required).toContain('files');
    expect(schema.required.indexOf('files')).toBe(schema.required.indexOf('resources') + 1);
    expect(Object.keys(schema.properties).indexOf('files')).toBe(Object.keys(schema.properties).indexOf('resources') + 1);
  });

  it('allows no resources when none are configured', async () => {
    const { calls } = await runWorkflow(args({ resources: {} }), passing());
    const schema = call(calls, 'architect:S-1').schema;
    expect(schema.properties.resources).toEqual({ type: 'array', maxItems: 0, items: { type: 'string' } });
  });
});

describe('pipeline workflow: outcomes', () => {
  it('defers a story whose plan needs a resource this slot does not hold', async () => {
    const plan = { ...PLAN, resources: ['db', 'cache'] };
    const { result, calls, logs } = await runWorkflow(args({ holds: ['cache'] }), passing({ 'architect:': plan }));
    expect(result).toMatchObject({ status: 'deferred', id: 'S-1', plan, needs: ['db'], rounds: 0, findings: [] });
    expect(labels(calls)).toEqual(['architect:S-1']);
    expect(logs.join('\n')).toMatch(/S-1 needs db/);
  });

  it('builds a story whose resources are all held', async () => {
    const plan = { ...PLAN, resources: ['db'] };
    const { result } = await runWorkflow(args({ holds: ['db'] }), passing({ 'architect:': plan }));
    expect(result.status).toBe('passed');
  });

  it('defers a story whose plan names files this slot has not claimed', async () => {
    const plan = { ...PLAN, files: ['src/a.mjs', 'src/b.mjs'] };
    const { result, calls, logs } = await runWorkflow(args(), passing({ 'architect:': plan }));
    expect(result).toEqual({ status: 'deferred', id: 'S-1', plan, needs: [], files: ['src/a.mjs', 'src/b.mjs'], rounds: 0, findings: [], history: [] });
    expect(labels(calls)).toEqual(['architect:S-1']);
    expect(logs.join('\n')).toMatch(/S-1 names 2 files/);
  });

  it('builds once the slot holds the files (filesHeld)', async () => {
    const plan = { ...PLAN, files: ['src/a.mjs'] };
    const { result, calls } = await runWorkflow(args({ filesHeld: true }), passing({ 'architect:': plan }));
    expect(result.status).toBe('passed');
    expect(labels(calls)).toContain('build:S-1');
  });

  it('never defers on files for an empty list or a plan without files', async () => {
    expect((await runWorkflow(args(), passing({ 'architect:': { ...PLAN, files: [] } }))).result.status).toBe('passed');
    expect((await runWorkflow(args(), passing())).result.status).toBe('passed');
    expect((await runWorkflow(args({ filesHeld: 'true' }), passing())).result.status).toBe('passed');
  });

  it('defers with both needs and files when neither is held', async () => {
    const plan = { ...PLAN, resources: ['db'], files: ['db/001.sql'] };
    const { result, calls } = await runWorkflow(args(), passing({ 'architect:': plan }));
    expect(result).toMatchObject({ status: 'deferred', needs: ['db'], files: ['db/001.sql'] });
    expect(labels(calls)).toEqual(['architect:S-1']);
    // With the resource held but the files not, it still waits for the files.
    const held = await runWorkflow(args({ holds: ['db'] }), passing({ 'architect:': plan }));
    expect(held.result).toMatchObject({ status: 'deferred', needs: [], files: ['db/001.sql'] });
  });

  it('defers a fix round too, before any fix call, when the files are not held', async () => {
    const findings = [{ stage: 'ci', severity: 'blocker', rule: 'CI must pass', where: 'src/a.mjs:1', observed: 'red', fix: 'fix it' }];
    const plan = { ...PLAN, files: ['src/a.mjs'] };
    const { result, calls } = await runWorkflow(args({ plan, startAt: 'fix', findings }), passing());
    expect(result).toMatchObject({ status: 'deferred', files: ['src/a.mjs'], needs: [] });
    expect(calls).toEqual([]);
    const held = await runWorkflow(args({ plan, startAt: 'fix', findings, filesHeld: true }), passing());
    expect(labels(held.calls)[0]).toBe('fix:S-1#0');
  });

  it('names filesHeld and the deferred files in meta.whenToUse', async () => {
    const { meta } = await runWorkflow(args(), passing());
    expect(meta.whenToUse).toContain('filesHeld');
    expect(meta.whenToUse).toMatch(/deferred[^.]*files/);
  });

  it('returns blocked with needs_owner when the story is not ready', async () => {
    const plan = { ...PLAN, ready: false, blocker: 'S-0 first', needs_owner: true };
    const { result, calls } = await runWorkflow(args(), passing({ 'architect:': plan }));
    expect(result).toEqual({ status: 'blocked', id: 'S-1', reason: 'S-0 first', needs_owner: true, rounds: 0, findings: [], history: [] });
    expect(calls).toHaveLength(1);
  });

  it("passes the architect's owner_question on with a blocked result", async () => {
    const owner_question = {
      summary: 'Which store keeps the sessions?',
      options: [
        { label: 'The database', hint: 'Keeps them with the rest of the data.' },
        { label: 'The cache', hint: 'Faster, but lost on restart.' },
      ],
      recommend: 'The database',
      explain: { purpose: 'Lets Acme shoppers stay signed in.', happened: 'The plan does not say where sign-ins are kept.', recommendation: 'The database: it keeps them across a restart.' },
    };
    const plan = { ...PLAN, ready: false, blocker: 'The plan names no session store.', needs_owner: true, owner_question };
    const { result, calls } = await runWorkflow(args(), passing({ 'architect:': plan }));
    expect(result).toEqual({ status: 'blocked', id: 'S-1', reason: 'The plan names no session store.', needs_owner: true, owner_question, rounds: 0, findings: [], history: [] });
    expect(calls).toHaveLength(1);
  });

  it('fails when the architect chooses a builder that is not configured', async () => {
    const { result, calls } = await runWorkflow(args(), passing({ 'architect:': { ...PLAN, builder: 'wizard' } }));
    expect(result).toMatchObject({ status: 'failed', id: 'S-1', reason: 'The architect chose an unknown builder: wizard' });
    expect(calls).toHaveLength(1);
  });

  it('stops at round 1 and runs every configured reviewer in parallel', async () => {
    const reviewers = [
      { name: 'compliance', agent: 'a:compliance' },
      { name: 'security', agent: 'a:security' },
      { name: 'accessibility', agent: 'a:a11y' },
    ];
    let running = 0;
    let most = 0;
    const slow = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return OK;
    };
    const { result, calls } = await runWorkflow(
      args({ roles: { ...ROLES, reviewers } }),
      passing({ 'compliance:': slow, 'security:': slow, 'accessibility:': slow }),
    );
    expect(result).toMatchObject({ status: 'passed', rounds: 1, builder: 'developer', summary: 'Built it.', files: ['login.js'] });
    expect(labels(calls)).toEqual(['architect:S-1', 'build:S-1', 'test:S-1#1', 'compliance:S-1#1', 'security:S-1#1', 'accessibility:S-1#1']);
    expect(calls.slice(3).map((c) => c.agentType)).toEqual(['a:compliance', 'a:security', 'a:a11y']);
    expect(calls.slice(3).every((c) => c.phase === 'Review')).toBe(true);
    expect(most).toBe(3);
  });

  it('returns the plan with a pass, so a later fix round can reuse it', async () => {
    const { result } = await runWorkflow(args(), passing());
    expect(result).toMatchObject({ status: 'passed', plan: PLAN });
  });

  it('passes after the tester when there are no reviewers', async () => {
    const { result, calls } = await runWorkflow(args({ roles: { ...ROLES, reviewers: [] } }), passing());
    expect(result).toMatchObject({ status: 'passed', rounds: 1 });
    expect(labels(calls)).toEqual(['architect:S-1', 'build:S-1', 'test:S-1#1']);
  });

  it('takes each agentType from roles', async () => {
    const { calls } = await runWorkflow(args(), passing({ 'architect:': { ...PLAN, builder: 'designer' }, 'test:S-1#1': REJECT() }));
    const types = Object.fromEntries(calls.map((c) => [c.label, c.agentType]));
    expect(types).toMatchObject({
      'architect:S-1': 'foreman:architect',
      'build:S-1': 'foreman:ui',
      'test:S-1#1': 'foreman:tester',
      'fix:S-1#1': 'foreman:ui',
      'compliance:S-1#2': 'foreman:compliance-reviewer',
      'security:S-1#2': 'foreman:security-reviewer',
    });
  });

  it("uses a reviewer's own prompt, and today's texts as the defaults", async () => {
    const reviewers = [
      { name: 'compliance', agent: 'r:c' },
      { name: 'security', agent: 'r:s' },
      { name: 'style', agent: 'r:style' },
      { name: 'perf', agent: 'r:perf', prompt: 'Look for slow queries.' },
    ];
    const { calls } = await runWorkflow(
      args({ roles: { ...ROLES, reviewers } }),
      passing({ 'style:': OK, 'perf:': OK }),
    );
    expect(call(calls, 'compliance:S-1#1').prompt.endsWith(`\n\n${COMPLIANCE_TEXT}`)).toBe(true);
    expect(call(calls, 'security:S-1#1').prompt.endsWith(`\n\n${SECURITY_TEXT}`)).toBe(true);
    expect(call(calls, 'style:S-1#1').prompt.endsWith(`\n\n${COMPLIANCE_TEXT}`)).toBe(true);
    expect(call(calls, 'perf:S-1#1').prompt.endsWith('\n\nLook for slow queries.')).toBe(true);
    expect(call(calls, 'perf:S-1#1').prompt).not.toContain(COMPLIANCE_TEXT);
  });

  it("skips the reviewers in a round the tester rejects", async () => {
    const { result, calls, logs } = await runWorkflow(args(), passing({ 'test:S-1#1': REJECT() }));
    expect(result).toMatchObject({ status: 'passed', rounds: 2 });
    expect(labels(calls)).toEqual([
      'architect:S-1',
      'build:S-1',
      'test:S-1#1',
      'fix:S-1#1',
      'test:S-1#2',
      'compliance:S-1#2',
      'security:S-1#2',
    ]);
    expect(logs).toContain('S-1 round 1: sent back with 1 finding(s)');
  });

  it('fails after args.rounds rejections, keeping only the non-minor findings', async () => {
    const tester = { approved: true, findings: [finding('minor', 'a nit')], checked: 'c' };
    const { result, calls } = await runWorkflow(
      args({ rounds: 2 }),
      passing({ 'test:': tester, 'security:S-1#1': REJECT_BY_ROUND('blocker'), 'security:': REJECT('blocker') }),
    );
    expect(result).toMatchObject({ status: 'failed', id: 'S-1', reason: 'Still rejected after 2 build rounds.', rounds: 2, builder: 'developer' });
    expect(result.plan).toEqual(PLAN);
    expect(result.findings).toEqual([{ ...finding('blocker'), stage: 'security' }]);
    expect(labels(calls).filter((l) => l.startsWith('fix:'))).toEqual(['fix:S-1#1']);
    expect(labels(calls).filter((l) => l.startsWith('test:'))).toEqual(['test:S-1#1', 'test:S-1#2']);
  });

  it('treats a reviewer that returns nothing as a blocker named after the reviewer', async () => {
    const reviewers = [{ name: 'docs', agent: 'r:docs' }];
    const { result } = await runWorkflow(args({ rounds: 1, roles: { ...ROLES, reviewers } }), passing({ 'docs:': undefined }));
    expect(result.status).toBe('failed');
    expect(result.findings).toEqual([expect.objectContaining({ stage: 'docs', severity: 'blocker', rule: 'stage did not report' })]);
  });
});

describe('pipeline workflow: role models', () => {
  const MODELS = {
    ...ROLES,
    architect: { agent: 'foreman:architect', model: 'opus' },
    builders: { ...ROLES.builders, developer: { agent: 'foreman:builder', use: 'everything', model: 'sonnet' } },
    tester: { agent: 'foreman:tester', model: 'haiku' },
  };
  const modelOf = (calls) => Object.fromEntries(calls.map((c) => [c.label, c.hasModel ? c.model : 'none']));

  it("passes each role's model to agent(), fix rounds included, and none for a role without one", async () => {
    const { calls } = await runWorkflow(args({ roles: MODELS }), passing({ 'test:S-1#1': REJECT() }));
    expect(modelOf(calls)).toEqual({
      'architect:S-1': 'opus',
      'build:S-1': 'sonnet',
      'test:S-1#1': 'haiku',
      'fix:S-1#1': 'sonnet',
      'test:S-1#2': 'haiku',
      'compliance:S-1#2': 'none',
      'security:S-1#2': 'none',
    });
  });

  it("passes a reviewer's own model", async () => {
    const reviewers = [{ name: 'compliance', agent: 'r:c', model: 'fable' }, { name: 'security', agent: 'r:s' }];
    const { calls } = await runWorkflow(args({ roles: { ...ROLES, reviewers } }), passing());
    expect(call(calls, 'compliance:S-1#1')).toMatchObject({ hasModel: true, model: 'fable' });
    expect(call(calls, 'security:S-1#1').hasModel).toBe(false);
  });

  it('passes no model key at all when no role has one', async () => {
    const { calls } = await runWorkflow(args(), passing({ 'test:S-1#1': REJECT() }));
    expect(calls.length).toBe(7);
    for (const c of calls) expect(c.hasModel, c.label).toBe(false);
  });

  it("gives startAt fix the builder's model", async () => {
    const findings = [{ stage: 'ci', severity: 'blocker', rule: 'CI must pass', where: 'a.js:1', observed: 'red', fix: 'fix it' }];
    const { calls } = await runWorkflow(args({ roles: MODELS, plan: PLAN, startAt: 'fix', findings }), passing());
    expect(call(calls, 'fix:S-1#0')).toMatchObject({ hasModel: true, model: 'sonnet' });
    expect(call(calls, 'test:S-1#1').model).toBe('haiku');
  });

  it("uses the chosen builder's model, not another builder's", async () => {
    const roles = { ...MODELS, builders: { ...MODELS.builders, designer: { agent: 'foreman:ui', use: 'pages', model: 'opus' } } };
    const { calls } = await runWorkflow(args({ roles }), passing({ 'architect:': { ...PLAN, builder: 'designer' } }));
    expect(call(calls, 'build:S-1').model).toBe('opus');
  });

  it('describes the model in meta.whenToUse', async () => {
    const { meta } = await runWorkflow(args(), passing());
    expect(meta.whenToUse).toMatch(/model\?/);
    expect(meta.whenToUse).toMatch(/session's model/);
  });
});

describe('pipeline workflow: history', () => {
  it('returns every sent-back round in history', async () => {
    const { result } = await runWorkflow(args(), passing({ 'test:S-1#1': REJECT('blocker') }));
    expect(result).toMatchObject({ status: 'passed', rounds: 2 });
    expect(result.history).toEqual([{ round: 1, findings: [{ ...finding('blocker'), stage: 'tester' }] }]);
  });

  it('keeps minor findings out of history', async () => {
    const tester = { approved: false, findings: [finding('major', 'big'), finding('minor', 'nit')], checked: 'c' };
    const { result } = await runWorkflow(args(), passing({ 'test:S-1#1': tester }));
    expect(result.history[0].findings).toEqual([{ ...finding('major', 'big'), stage: 'tester' }]);
  });

  it('a story that passes at round 1 has an empty history', async () => {
    const { result } = await runWorkflow(args(), passing());
    expect(result.history).toEqual([]);
  });

  it("a failed story's history holds every round but the last", async () => {
    const { result } = await runWorkflow(args({ rounds: 3 }), passing({ 'security:': REJECT_BY_ROUND('blocker') }));
    expect(result.status).toBe('failed');
    expect(result.history.map((h) => h.round)).toEqual([1, 2]);
    expect(result.history[0].findings).toEqual([{ ...finding('blocker', 'a rule seen at security:S-1#1'), stage: 'security' }]);
    expect(result.findings).toEqual([{ ...finding('blocker', 'a rule seen at security:S-1#3'), stage: 'security' }]);
  });

  it('an incomplete build is a history entry', async () => {
    const { result } = await runWorkflow(args(), passing({ 'build:': { ...BUILT, complete: false, problem: 'p' } }));
    expect(result.status).toBe('passed');
    expect(result.history[0].findings[0]).toMatchObject({ stage: 'build', severity: 'blocker', observed: 'p' });
  });

  it('early returns carry an empty history', async () => {
    const blocked = await runWorkflow(args(), passing({ 'architect:': { ...PLAN, ready: false, blocker: 'S-0 first' } }));
    const deferred = await runWorkflow(args(), passing({ 'architect:': { ...PLAN, resources: ['db'] } }));
    const unknown = await runWorkflow(args(), passing({ 'architect:': { ...PLAN, builder: 'wizard' } }));
    const nothing = await runWorkflow(args(), passing({ 'architect:': undefined }));
    expect(blocked.result).toMatchObject({ status: 'blocked', history: [] });
    expect(deferred.result).toMatchObject({ status: 'deferred', history: [] });
    expect(unknown.result).toMatchObject({ status: 'failed', history: [] });
    expect(nothing.result).toMatchObject({ status: 'failed', history: [] });
  });

  it('startAt fix numbers rounds like the fix labels', async () => {
    const findings = [{ stage: 'ci', severity: 'blocker', rule: 'CI must pass', where: 'a.js:1', observed: 'red', fix: 'make it green' }];
    const { result, calls } = await runWorkflow(args({ rounds: 2, plan: PLAN, startAt: 'fix', findings }), passing({ 'test:S-1#1': REJECT() }));
    expect(result).toMatchObject({ status: 'passed', rounds: 2 });
    expect(result.history).toEqual([{ round: 1, findings: [{ ...finding('major'), stage: 'tester' }] }]);
    expect(labels(calls)).toContain('fix:S-1#1');
  });
});

describe('pipeline workflow: startAt fix', () => {
  const findings = [{ stage: 'ci', severity: 'blocker', rule: 'CI must pass', where: 'test/login.test.js:4', observed: 'expected 1, got 2', fix: 'Fix the login count.' }];

  it('skips the architect and starts with a fix call carrying the findings', async () => {
    const { result, calls, phases } = await runWorkflow(args({ plan: PLAN, startAt: 'fix', findings }), passing());
    expect(result).toMatchObject({ status: 'passed', rounds: 1 });
    expect(labels(calls)).toEqual(['fix:S-1#0', 'test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']);
    expect(phases).not.toContain('Architect');
    const fix = calls[0];
    expect(fix.agentType).toBe('foreman:builder');
    expect(fix.phase).toBe('Build');
    expect(fix.prompt).toContain('This story was built and sent back.');
    expect(fix.prompt).toContain('- [ci · blocker] CI must pass — test/login.test.js:4\n  Observed: expected 1, got 2\n  Fix: Fix the login count.');
  });

  it('still has args.rounds rounds of testing after the first fix', async () => {
    const { result, calls } = await runWorkflow(
      args({ rounds: 2, plan: PLAN, startAt: 'fix', findings }),
      passing({ 'test:': REJECT() }),
    );
    expect(result).toMatchObject({ status: 'failed', rounds: 2 });
    expect(labels(calls)).toEqual(['fix:S-1#0', 'test:S-1#1', 'fix:S-1#1', 'test:S-1#2']);
  });

  describe('a conflict with main at release', () => {
    const conflict = [{ stage: 'merge', severity: 'blocker', rule: 'merge main', where: 'src/acme.js', observed: 'conflict', fix: "merge origin/main into this branch and resolve the conflicts in src/acme.js, keeping both sides' intent" }];

    it('continues when the builder resolves it, re-checked by the tester and every reviewer', async () => {
      const { result, calls } = await runWorkflow(args({ plan: PLAN, startAt: 'fix', findings: conflict }), passing());
      expect(result.status).toBe('passed');
      expect(labels(calls)).toEqual(['fix:S-1#0', 'test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']);
      expect(calls[0].prompt).toContain("- [merge · blocker] merge main — src/acme.js\n  Observed: conflict\n  Fix: merge origin/main into this branch and resolve the conflicts in src/acme.js, keeping both sides' intent");
    });

    it('stops as failed when the builder cannot resolve it', async () => {
      const unresolved = { ...BUILT, complete: false, problem: 'could not resolve the conflict in src/acme.js' };
      const { result } = await runWorkflow(
        args({ plan: PLAN, startAt: 'fix', findings: conflict }),
        passing({ 'fix:': unresolved, 'build:': unresolved }),
      );
      expect(result.status).toBe('failed');
    });
  });

  it('needs a plan and findings', async () => {
    await expect(runWorkflow(args({ startAt: 'fix', findings }), {})).rejects.toThrow(/plan/);
    await expect(runWorkflow(args({ startAt: 'fix', plan: PLAN }), {})).rejects.toThrow(/findings/);
  });
});

describe('pipeline workflow: resume after a stop', () => {
  const minor = { ...finding('minor', 'naming'), where: 'login.js:2' };
  const resume = (verdicts = {}) => ({ build: { summary: 'Built it before.', files: ['login.js'] }, verdicts });

  it('with the tester carried, runs only the reviewers', async () => {
    const { result, calls, phases } = await runWorkflow(args({ plan: PLAN, resume: resume({ tester: { findings: [minor] } }) }), passing());
    expect(labels(calls)).toEqual(['compliance:S-1#1', 'security:S-1#1']);
    expect(phases).not.toContain('Architect');
    expect(phases).not.toContain('Build');
    expect(calls[0].prompt).toContain('## What the builder says it did\nBuilt it before.\nFiles: login.js');
    expect(result).toMatchObject({ status: 'passed', rounds: 1, summary: 'Built it before.', files: ['login.js'] });
    expect(Object.hasOwn(result, 'plan')).toBe(false);
    expect(result.findings).toEqual([{ ...minor, stage: 'tester' }]);
  });

  it('with the tester and security carried, runs only compliance, keeping reviewer order', async () => {
    const sec = { ...minor, rule: 'secret' };
    const { result, calls } = await runWorkflow(
      args({ plan: PLAN, resume: resume({ tester: { findings: [] }, security: { findings: [sec] } }) }),
      passing({ 'compliance:': { approved: true, findings: [finding('minor', 'tidy')], checked: 'read' } }),
    );
    expect(labels(calls)).toEqual(['compliance:S-1#1']);
    expect(result.status).toBe('passed');
    expect(result.findings.map((f) => [f.stage, f.rule])).toEqual([['compliance', 'tidy'], ['security', 'secret']]);
  });

  it('with everything carried, calls no agent and passes', async () => {
    const { result, calls } = await runWorkflow(args({ plan: PLAN, resume: resume({ tester: { findings: [minor] }, compliance: { findings: [] }, security: { findings: [] } }) }), {});
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ status: 'passed', rounds: 1, findings: [{ ...minor, stage: 'tester' }], history: [] });
  });

  it('does not trust a carried verdict with a major finding: the tester runs', async () => {
    const { calls } = await runWorkflow(args({ plan: PLAN, resume: resume({ tester: { findings: [finding('major')] } }) }), passing());
    expect(labels(calls)).toEqual(['test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']);
  });

  it('carries no reviewer verdict without the tester: the tester and every reviewer run', async () => {
    const { calls } = await runWorkflow(args({ plan: PLAN, resume: resume({ security: { findings: [] } }) }), passing());
    expect(labels(calls)).toEqual(['test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']);
  });

  it('runs later rounds as normal after a carried tester and a rejection', async () => {
    const { result, calls } = await runWorkflow(args({ plan: PLAN, resume: resume({ tester: { findings: [] } }) }), passing({ 'security:S-1#1': REJECT() }));
    expect(labels(calls)).toEqual(['compliance:S-1#1', 'security:S-1#1', 'fix:S-1#1', 'test:S-1#2', 'compliance:S-1#2', 'security:S-1#2']);
    expect(result).toMatchObject({ status: 'passed', rounds: 2 });
    expect(result.history).toEqual([{ round: 1, findings: [{ ...finding('major'), stage: 'security' }] }]);
  });

  it('needs a plan, no startAt and a build with a summary and files', async () => {
    await expect(runWorkflow(args({ resume: resume() }), {})).rejects.toThrow(/needs args\.plan when resume is set/);
    await expect(runWorkflow(args({ plan: PLAN, startAt: 'fix', findings: [finding('major')], resume: resume() }), {})).rejects.toThrow(/needs args\.resume without startAt/);
    await expect(runWorkflow(args({ plan: PLAN, resume: { verdicts: {} } }), {})).rejects.toThrow(/needs args\.resume\.build as \{summary, files\}/);
    await expect(runWorkflow(args({ plan: PLAN, resume: { build: { summary: 1, files: [] } } }), {})).rejects.toThrow(/needs args\.resume\.build/);
    await expect(runWorkflow(args({ plan: PLAN, resume: { build: { summary: 's', files: 'a' } } }), {})).rejects.toThrow(/needs args\.resume\.build/);
    await expect(runWorkflow(args({ plan: PLAN, resume: null }), {})).rejects.toThrow(/needs args\.resume to be an object/);
  });

  it('says so in meta.whenToUse', async () => {
    const { meta } = await runWorkflow(args(), passing());
    expect(meta.whenToUse).toMatch(/resume/);
  });

  it('still defers a resume whose files the slot has not claimed', async () => {
    const plan = { ...PLAN, files: ['login.js'] };
    const { result, calls } = await runWorkflow(args({ plan, resume: resume({ tester: { findings: [] } }) }), passing());
    expect(result).toMatchObject({ status: 'deferred', files: ['login.js'], needs: [] });
    expect(calls).toEqual([]);
    const held = await runWorkflow(args({ plan, filesHeld: true, resume: resume({ tester: { findings: [] } }) }), passing());
    expect(labels(held.calls)).toEqual(['compliance:S-1#1', 'security:S-1#1']);
  });
});

describe('pipeline workflow: the plan by file', () => {
  const DESIGN_PATH = '/state/plans/S-1.md';
  const fileArgs = (over = {}) => args({ plan: shortPlan(PLAN), designFile: DESIGN_PATH, ...over });
  const findings = [{ stage: 'ci', severity: 'blocker', rule: 'CI must pass', where: 'login.js:4', observed: 'red', fix: 'Fix it.' }];
  const shape = (r) => ({ status: r.result.status, rounds: r.result.rounds, calls: r.calls.map((c) => [c.label, c.agentType, c.phase]) });
  const noAgent = () => {
    throw new Error('an agent ran');
  };
  const NONE = { 'architect:': noAgent, 'build:': noAgent, 'fix:': noAgent, 'test:': noAgent, 'compliance:': noAgent, 'security:': noAgent };

  describe('a string or {file} as args', () => {
    it('is refused in one line naming the fix, before any agent runs', async () => {
      for (const bad of ['not json', JSON.stringify(args())]) {
        const err = await runWorkflow(bad, NONE).catch((e) => e);
        expect(err.message).toMatch(/is a string/);
        expect(err.message).toContain('foreman workflow-args');
        expect(err.message).not.toContain('\n');
      }
    });

    it('refuses {file} as a script that cannot read files, in one line', async () => {
      const err = await runWorkflow({ file: '/tmp/a.json' }, NONE).catch((e) => e);
      expect(err.message).toMatch(/cannot read files/);
      expect(err.message).toContain('foreman workflow-args');
      expect(err.message).not.toContain('\n');
    });

    it('leaves an object with a story and a file key alone', async () => {
      const { result } = await runWorkflow(args({ file: 'x' }), passing());
      expect(result.status).toBe('passed');
    });
  });

  describe('a plan with a designFile', () => {
    it('makes the same calls and gets the same result as the inline plan', async () => {
      for (const extra of [{}, { startAt: 'fix', findings }]) {
        const inline = await runWorkflow(args({ plan: PLAN, ...extra }), passing());
        const byFile = await runWorkflow(fileArgs(extra), passing());
        expect(shape(byFile)).toEqual(shape(inline));
        expect(byFile.phases).toEqual(inline.phases);
      }
    });

    it('tells the build, fix, test and review agents to read the file and keeps done-when', async () => {
      const { calls } = await runWorkflow(fileArgs({ rounds: 2 }), passing({ 'test:S-1#1': REJECT() }));
      expect(labels(calls)).toEqual(['build:S-1', 'test:S-1#1', 'fix:S-1#1', 'test:S-1#2', 'compliance:S-1#2', 'security:S-1#2']);
      for (const c of calls) {
        expect(c.prompt, c.label).toContain(`Read ${DESIGN_PATH} whole`);
        expect(c.prompt, c.label).toContain('## Done when\nnpm test passes');
        expect(c.prompt, c.label).not.toContain('## Design\n');
        expect(c.prompt, c.label).not.toContain('Change login.js only.');
      }
    });

    it('relays the same brief to a reviewer with an engine', async () => {
      const roles = { ...ROLES, reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer', engine: { name: 'antigravity', model: 'm' } }] };
      const relay = { approved: true, findings: [], checked: 'c', engine: 'antigravity' };
      const { calls } = await runWorkflow(fileArgs({ roles }), passing({ 'compliance:': relay }));
      const relayed = calls.find((c) => c.agentType === 'foreman:review-relay');
      expect(relayed.prompt).toContain(`Read ${DESIGN_PATH} whole`);
      expect(relayed.prompt).not.toContain('Change login.js only.');
    });

    it('keeps the inline prompt byte for byte without a designFile', async () => {
      const { calls } = await runWorkflow(args({ plan: PLAN }), passing());
      expect(call(calls, 'build:S-1').prompt).toContain('## Design\nChange login.js only.\n\n## Test plan\nlogin.test.js proves it.\n\n## Done when\nnpm test passes');
      expect(call(calls, 'build:S-1').prompt).not.toContain('Read ');
    });

    it('never runs the architect', async () => {
      const { phases, calls } = await runWorkflow(fileArgs(), { ...passing(), 'architect:': noAgent });
      expect(phases).not.toContain('Architect');
      expect(labels(calls)).not.toContain('architect:S-1');
    });

    it('still defers on the short plan\'s resources and files', async () => {
      const plan = shortPlan({ ...PLAN, resources: ['db'], files: ['src/a.mjs'] });
      const { result, calls } = await runWorkflow(args({ plan, designFile: DESIGN_PATH }), passing());
      expect(result).toMatchObject({ status: 'deferred', needs: ['db'], files: ['src/a.mjs'] });
      expect(calls).toEqual([]);
    });
  });

  describe('the result carries the plan only when the architect ran in that launch', () => {
    it('gives none for a plan given in args', async () => {
      const done = await runWorkflow(fileArgs(), passing());
      expect(done.result.status).toBe('passed');
      expect(Object.hasOwn(done.result, 'plan')).toBe(false);
      const failed = await runWorkflow(fileArgs({ rounds: 2 }), passing({ 'test:': REJECT_BY_ROUND() }));
      expect(failed.result.status).toBe('failed');
      expect(Object.hasOwn(failed.result, 'plan')).toBe(false);
      const deferred = await runWorkflow(fileArgs({ plan: shortPlan({ ...PLAN, files: ['a.js'] }) }), passing());
      expect(deferred.result.status).toBe('deferred');
      expect(Object.hasOwn(deferred.result, 'plan')).toBe(false);
      const fix = await runWorkflow(fileArgs({ startAt: 'fix', findings }), passing());
      expect(fix.result.status).toBe('passed');
      expect(Object.hasOwn(fix.result, 'plan')).toBe(false);
      const inline = await runWorkflow(args({ plan: PLAN }), passing());
      expect(Object.hasOwn(inline.result, 'plan')).toBe(false);
    });

    it('gives the full plan after the architect ran', async () => {
      expect((await runWorkflow(args(), passing())).result.plan).toEqual(PLAN);
      expect((await runWorkflow(args({ rounds: 1 }), passing({ 'test:': REJECT() }))).result.plan).toEqual(PLAN);
      expect((await runWorkflow(args(), passing({ 'architect:': { ...PLAN, files: ['a.js'] } }))).result.plan).toEqual({ ...PLAN, files: ['a.js'] });
    });
  });

  describe('the args', () => {
    it('refuse a designFile without a plan', async () => {
      await expect(runWorkflow(args({ designFile: DESIGN_PATH }), {})).rejects.toThrow(/plan/);
    });

    it('refuse a designFile that is not a path', async () => {
      await expect(runWorkflow(fileArgs({ designFile: 5 }), {})).rejects.toThrow(/designFile/);
      await expect(runWorkflow(fileArgs({ designFile: '' }), {})).rejects.toThrow(/designFile/);
    });

    it('are described in meta.whenToUse', async () => {
      const { meta } = await runWorkflow(args(), passing());
      expect(meta.whenToUse).toMatch(/designFile/);
      expect(meta.whenToUse).toMatch(/string/);
    });
  });
});

// The sentence that opens every Checks section.
const CHECKS_INTRO =
  "## Checks\n`foreman checks` runs these and records every run. Run them only through it, with the flags your instructions give (for a long suite, `--start` and then `foreman checks --wait <id>`). Foreman denies a check's command run by hand; targeted runs of single tests stay free.\n";

describe('pipeline workflow: checks and traits', () => {
  const checks = [
    { run: 'npm test', when: 'always' },
    { run: 'npm run lint', when: 'src/**/*.ts' },
  ];
  const CHECKS = `${CHECKS_INTRO}- \`npm test\` (every time)\n- \`npm run lint\` (when files matching src/**/*.ts changed)`;
  const traits = {
    architect: 'Architect trait.',
    developer: 'Developer trait.',
    tester: 'Tester trait.',
    security: 'Security trait.',
  };

  it('appends the checks to every prompt and each role its own traits, at the end', async () => {
    const { calls } = await runWorkflow(args({ checks, traits }), passing({ 'test:S-1#1': REJECT() }));
    const ends = (label, tail) => expect(call(calls, label).prompt.endsWith(tail), label).toBe(true);
    const traitsOf = (text) => `\n\n## Project traits\n${text}`;

    ends('architect:S-1', `\n\n${CHECKS}${traitsOf('Architect trait.')}`);
    ends('build:S-1', `\n\n${CHECKS}${traitsOf('Developer trait.')}`);
    ends('fix:S-1#1', `\n\n${CHECKS}${traitsOf('Developer trait.')}`);
    ends('test:S-1#1', `\n\n${CHECKS}${traitsOf('Tester trait.')}`);
    ends('security:S-1#2', `\n\n${CHECKS}${traitsOf('Security trait.')}`);
    ends('compliance:S-1#2', `\n\n${CHECKS}`);

    for (const c of calls) {
      const own = Object.entries(traits).filter(([, text]) => c.prompt.includes(text));
      expect(own.length, c.label).toBeLessThanOrEqual(1);
      expect(c.prompt.split('## Checks').length, c.label).toBe(2);
    }
    expect(call(calls, 'compliance:S-1#2').prompt).not.toContain('## Project traits');
  });

  it('tells every prompt to run the checks only through foreman checks, and lists each one with its condition', async () => {
    const { calls } = await runWorkflow(args({ checks, traits }), passing());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.prompt, c.label).toContain('Run them only through it');
      expect(c.prompt, c.label).toContain("Foreman denies a check's command run by hand");
      const items = c.prompt.split('\n').filter((l) => /^- `(npm test|npm run lint)`/.test(l));
      expect(items.length, c.label).toBe(2);
      for (const line of items) expect(line, c.label).toMatch(/\(every time\)$|\(when files matching .+ changed\)$/);
    }
  });

  it('adds no Checks or Project traits section when there are none', async () => {
    const { calls } = await runWorkflow(args(), passing());
    for (const c of calls) {
      expect(c.prompt).not.toContain('## Checks');
      expect(c.prompt).not.toContain('## Project traits');
    }
  });

  it("lists every builder and its use in the architect's prompt only", async () => {
    const { calls } = await runWorkflow(args(), passing());
    expect(call(calls, 'architect:S-1').prompt).toContain('\n\n## Builders\n- developer: everything\n- designer: pages and components');
    for (const c of calls.slice(1)) expect(c.prompt).not.toContain('## Builders');
  });
});

describe('pipeline workflow: quick checks and fullChecks', () => {
  const checks = [
    { run: 'npm test', when: 'always', quick: 'npm test -- --changed' },
    { run: 'npm run lint', when: 'src/**/*.ts' },
    { run: 'npm run e2e', when: 'e2e/**', quick: 'npm run e2e -- --smoke' },
  ];
  const FULL_NOTE =
    '\n\nThis project runs the full checks in the build: run `foreman checks --changed` (for a long suite `foreman checks --changed --start`, then `foreman checks --wait <id>`) instead of `--quick`, while you build and before you hand over.';
  const withFull = (over = {}) => ({ ...ROLES, builders: { ...ROLES.builders, developer: { ...ROLES.builders.developer, fullChecks: true, ...over } } });

  it('lists a check with quick, and keeps the exact line of one without', async () => {
    const { calls } = await runWorkflow(args({ checks }), passing());
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.prompt, c.label).toContain('\n- `npm test` (every time), quick: `npm test -- --changed`\n- `npm run lint` (when files matching src/**/*.ts changed)\n- `npm run e2e` (when files matching e2e/** changed), quick: `npm run e2e -- --smoke`');
    }
  });

  it('puts the note in the build and fix prompts of a builder with fullChecks, before the checks, traits and skills', async () => {
    const traits = { developer: 'Developer trait.' };
    const { calls } = await runWorkflow(args({ roles: withFull(), checks, traits }), passing({ 'test:S-1#1': REJECT() }));
    for (const label of ['build:S-1', 'fix:S-1#1']) {
      const p = call(calls, label).prompt;
      expect(p, label).toContain(FULL_NOTE);
      expect(p.indexOf(FULL_NOTE), label).toBeLessThan(p.indexOf('## Checks'));
      expect(p.split(FULL_NOTE), label).toHaveLength(2);
      expect(p.endsWith('\n\n## Project traits\nDeveloper trait.'), label).toBe(true);
      expect(p.indexOf('## Checks'), label).toBeLessThan(p.indexOf('## Project traits'));
    }
    expect(call(calls, 'build:S-1').prompt).toContain(`${FULL_NOTE}\n\n## Checks\n`);
  });

  it('puts the note before the learned skills too, and without any checks', async () => {
    const skills = { developer: [{ id: 'k1', name: 'Skill', use: 'when x', path: '.claude/skills/k1' }] };
    const { calls } = await runWorkflow(args({ roles: withFull(), skills }), passing());
    const p = call(calls, 'build:S-1').prompt;
    expect(p.indexOf(FULL_NOTE)).toBeGreaterThan(-1);
    expect(p.indexOf(FULL_NOTE)).toBeLessThan(p.indexOf('## Learned skills'));
  });

  it('gives it to no other role', async () => {
    const { calls } = await runWorkflow(args({ roles: withFull(), checks }), passing());
    for (const c of calls) {
      if (c.label === 'build:S-1') continue;
      expect(c.prompt, c.label).not.toContain('instead of `--quick`');
    }
  });

  it('gives it to no builder without fullChecks true', async () => {
    for (const roles of [ROLES, withFull({ fullChecks: false })]) {
      const { calls } = await runWorkflow(args({ roles, checks }), passing());
      for (const c of calls) expect(c.prompt, c.label).not.toContain('instead of `--quick`');
    }
  });

  it('gives it only to the builder the architect chose', async () => {
    const roles = withFull();
    const { calls } = await runWorkflow(args({ roles, checks }), passing({ 'architect:': { ...PLAN, builder: 'designer' } }));
    expect(call(calls, 'build:S-1').prompt).not.toContain('instead of `--quick`');
  });

  it('names fullChecks and quick in meta.whenToUse', async () => {
    const { meta } = await runWorkflow(args(), passing());
    expect(meta.whenToUse).toContain('builders: {<name>: {agent, use, model?, fullChecks?}}');
    expect(meta.whenToUse).toContain('checks: [{run, when, quick?}]');
    expect(meta.whenToUse).toMatch(/fullChecks true[^.]*full checks/);
  });
});

describe('pipeline workflow: learned traits', () => {
  const checks = [{ run: 'npm test', when: 'always' }];
  const CHECKS = `${CHECKS_INTRO}- \`npm test\` (every time)`;
  const LEARNED = 'x\n\n### Learned by Foreman (CLAUDE.md and the traits above win)\n\n[L-1] r';
  const NOTE = 'put its [L-n] in the rule';

  it('asks the tester and every reviewer to name a bad [L-n], with checks and traits still last', async () => {
    const { calls } = await runWorkflow(args({ checks, traits: { developer: LEARNED } }), passing());
    const ends = (label, tail) => expect(call(calls, label).prompt.endsWith(tail), label).toBe(true);
    for (const label of ['test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']) {
      expect(call(calls, label).prompt, label).toContain(NOTE);
      ends(label, `\n\n${CHECKS}`);
      expect(call(calls, label).prompt.indexOf(NOTE), label).toBeLessThan(call(calls, label).prompt.indexOf(CHECKS));
    }
    ends('build:S-1', `\n\n${CHECKS}\n\n## Project traits\n${LEARNED}`);
    expect(call(calls, 'build:S-1').prompt).not.toContain(NOTE);
    expect(call(calls, 'architect:S-1').prompt).not.toContain(NOTE);
  });

  it('adds the note to no prompt when no role has learned traits', async () => {
    const { calls } = await runWorkflow(args({ checks, traits: { developer: 'Developer trait.', tester: 'Tester trait.' } }), passing());
    for (const c of calls) expect(c.prompt, c.label).not.toContain('[L-n]');
  });

  it('writes the same heading as traits.mjs', () => {
    const text = readFileSync(new URL('../plugin/workflows/pipeline.js', import.meta.url), 'utf8');
    expect(text).toContain(`const LEARNED_HEADING = '${LEARNED_HEADING}'`);
  });
});

describe('pipeline workflow: learned skills', () => {
  const checks = [{ run: 'npm test', when: 'always' }];
  const CHECKS = `${CHECKS_INTRO}- \`npm test\` (every time)`;
  const SKILL = { id: 'L-1', name: 'foreman-learned-acme-routes', use: 'Use when adding an Acme route', path: '.claude/skills/foreman-learned-acme-routes/SKILL.md' };
  const SECTION =
    "\n\n## Learned skills\nSkills Foreman learned by itself. Before doing the kind of work a skill's use-when names, read its SKILL.md and follow it unless CLAUDE.md or the Project traits say otherwise.\n" +
    '- foreman-learned-acme-routes [L-1]: Use when adding an Acme route (`.claude/skills/foreman-learned-acme-routes/SKILL.md`)';
  const NOTE = 'put its [L-n] in the rule';

  it("ends the developer's build and fix prompts with checks, then traits, then the skills", async () => {
    const { calls } = await runWorkflow(args({ checks, traits: { developer: 'Developer trait.' }, skills: { developer: [SKILL] } }), passing({ 'test:S-1#1': REJECT() }));
    for (const label of ['build:S-1', 'fix:S-1#1']) {
      expect(call(calls, label).prompt.endsWith(`\n\n${CHECKS}\n\n## Project traits\nDeveloper trait.${SECTION}`), label).toBe(true);
    }
  });

  it('gives the section to no other role, and the tester and reviewers the [L-n] note', async () => {
    const { calls } = await runWorkflow(args({ checks, skills: { developer: [SKILL] } }), passing());
    for (const label of ['architect:S-1', 'test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']) expect(call(calls, label).prompt, label).not.toContain('## Learned skills');
    for (const label of ['test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']) expect(call(calls, label).prompt, label).toContain(NOTE);
    expect(call(calls, 'build:S-1').prompt.endsWith(`\n\n${CHECKS}${SECTION}`)).toBe(true);
  });

  it('adds no section to any prompt when there are no skills', async () => {
    for (const skills of [undefined, {}]) {
      const { calls } = await runWorkflow(args({ checks, skills }), passing());
      for (const c of calls) {
        expect(c.prompt, c.label).not.toContain('## Learned skills');
        expect(c.prompt, c.label).not.toContain('[L-n]');
      }
    }
  });

  it('names skills in meta.whenToUse', () => {
    const { meta } = splitMeta(readFileSync(new URL('../plugin/workflows/pipeline.js', import.meta.url), 'utf8'));
    expect(meta.whenToUse).toContain('skills?: {<role>: [{id, name, use, path}]}');
  });
});

describe('pipeline workflow: the header', () => {
  it('names the group with its label, defaulting to Group', async () => {
    const { calls } = await runWorkflow(args(), passing());
    expect(calls[0].prompt.startsWith('Story S-1 · Add login\nGroup 2 — Accounts\nStory note: stories/S-1.md\n\n')).toBe(true);
  });

  it('names the base with the diff every stage reviews, when args.base is set', async () => {
    const { calls } = await runWorkflow(args({ base: 'up/trunk' }), passing());
    const base = 'Base: up/trunk. The change is the working tree against where this branch left it: `git status` and `git diff --merge-base up/trunk`.';
    for (const c of calls) expect(c.prompt.startsWith(`Story S-1 · Add login\nGroup 2 — Accounts\nStory note: stories/S-1.md\n${base}\n\n`), c.label).toBe(true);
    expect(call(calls, 'security:S-1#1').prompt.endsWith(
      "\n\nReview this story's changes: the working tree against where this branch left up/trunk (`git status`, `git diff --merge-base up/trunk`, untracked files included). Grade each finding blocker, major or minor.",
    )).toBe(true);
    expect(calls.some((c) => c.prompt.includes('git diff main'))).toBe(false);
  });

  it('leaves the group line out when there is no group', async () => {
    const story = { id: 'S-1', title: 'Add login', brief: 'stories/S-1.md', group: '', groupName: '' };
    const { calls } = await runWorkflow(args({ story }), passing());
    expect(calls[0].prompt.startsWith('Story S-1 · Add login\nStory note: stories/S-1.md\n\n')).toBe(true);
  });
});

describe('workflow harness', () => {
  it('splits the meta block at its balanced closing brace', () => {
    const { meta, body } = splitMeta("export const meta = { a: '}', b: { c: `{` } }\nreturn 1\n");
    expect(meta).toEqual({ a: '}', b: { c: '{' } });
    expect(body.trim()).toBe('return 1');
  });
});

describe('pipeline workflow: review engines', () => {
  const ENGINE = { name: 'antigravity', model: 'claude-opus-4-6-thinking' };
  const reviewers = [
    { name: 'compliance', agent: 'r:c', engine: ENGINE, model: 'opus' },
    { name: 'security', agent: 'r:s' },
  ];
  const RELAYED = { engine: 'antigravity', reason: '', ...OK };
  const UNAVAILABLE = { engine: 'unavailable', reason: 'agy not on PATH', approved: false, findings: [], checked: '' };
  const relayCalls = (calls) => calls.filter((c) => c.agentType === 'foreman:review-relay');
  const reviewerCalls = (calls, agent) => calls.filter((c) => c.agentType === agent);

  it('sends a reviewer with an engine to the relay, with the review text, its name and its length', async () => {
    const { result, calls } = await runWorkflow(args({ roles: { ...ROLES, reviewers } }), passing({ 'compliance:': (c) => (c.agentType === 'foreman:review-relay' ? RELAYED : REJECT()) }));
    expect(result.status).toBe('passed');
    const relays = relayCalls(calls);
    expect(relays).toHaveLength(1);
    const relay = relays[0];
    expect(relay).toMatchObject({ label: 'compliance:S-1#1', phase: 'Review', hasModel: true, model: 'sonnet' });
    expect(relay.schema.required).toEqual(expect.arrayContaining(['approved', 'findings', 'checked', 'engine']));
    expect(relay.schema.properties.engine).toEqual({ type: 'string', enum: ['antigravity', 'unavailable'] });
    expect(relay.schema.properties.reason).toEqual({ type: 'string' });
    // The review text is the prompt the Claude reviewer would get, between the markers.
    const review = /<<<REVIEW\n([\s\S]*)\n>>>REVIEW/.exec(relay.prompt)?.[1];
    expect(review).toBeDefined();
    expect(review.endsWith(`\n\n${COMPLIANCE_TEXT}`)).toBe(true);
    expect(review).toContain('Story S-1 · Add login');
    expect(relay.prompt).toContain('--reviewer compliance');
    expect(relay.prompt).toContain(`--chars ${review.length}`);
    expect(relay.prompt).toMatch(/Do not review/);
    // The Claude reviewer never ran; security, without an engine, ran as before.
    expect(reviewerCalls(calls, 'r:c')).toHaveLength(0);
    expect(reviewerCalls(calls, 'r:s')).toHaveLength(1);
    expect(call(calls, 'security:S-1#1').hasModel).toBe(false);
  });

  it('takes the relayed verdict as the reviewer’s, findings and all', async () => {
    const relayed = { engine: 'antigravity', reason: '', ...REJECT('blocker') };
    const { result, calls } = await runWorkflow(args({ roles: { ...ROLES, reviewers }, rounds: 1 }), passing({ 'compliance:': relayed }));
    expect(result.status).toBe('failed');
    expect(result.findings).toEqual([{ ...finding('blocker'), stage: 'compliance' }]);
    expect(reviewerCalls(calls, 'r:c')).toHaveLength(0);
  });

  it('runs the Claude reviewer when the engine is unavailable, on the reviewer’s own model, and says why', async () => {
    let own = 0;
    const { result, calls, logs } = await runWorkflow(
      args({ roles: { ...ROLES, reviewers } }),
      passing({ 'compliance:': (c) => (c.agentType === 'foreman:review-relay' ? UNAVAILABLE : own++ === 0 ? REJECT('major') : OK) }),
    );
    expect(result.status).toBe('passed');
    expect(relayCalls(calls)).toHaveLength(2); // once per round
    const mine = reviewerCalls(calls, 'r:c');
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ label: 'compliance:S-1#1', phase: 'Review', hasModel: true, model: 'opus' });
    expect(mine[0].prompt.endsWith(`\n\n${COMPLIANCE_TEXT}`)).toBe(true);
    expect(logs.some((l) => l.includes('compliance') && l.includes('agy not on PATH'))).toBe(true);
  });

  it('treats a relay that returns nothing as unavailable, so the Claude reviewer still runs', async () => {
    const { result, calls } = await runWorkflow(
      args({ roles: { ...ROLES, reviewers } }),
      passing({ 'compliance:': (c) => (c.agentType === 'foreman:review-relay' ? undefined : OK) }),
    );
    expect(result.status).toBe('passed');
    expect(reviewerCalls(calls, 'r:c')).toHaveLength(1);
  });

  it('keeps the pipeline’s verdict schema and relay model in step with the engine module', () => {
    const text = readFileSync(new URL('../plugin/workflows/pipeline.js', import.meta.url), 'utf8');
    const verdict = /const VERDICT = (\{[\s\S]*?\n\})\n/.exec(text)?.[1];
    expect(verdict).toBeDefined();
    expect(new Function(`return (${verdict})`)()).toEqual(VERDICT_SCHEMA);
    expect(text).toContain(`const RELAY_MODEL = '${RELAY_MODEL}'`);
  });

  it('describes engines in meta', async () => {
    const { meta } = await runWorkflow(args(), passing());
    expect(meta.whenToUse).toMatch(/engine/);
  });
});

describe('pipeline workflow: the same kind of bug again', () => {
  const verdict = (...findings) => ({ approved: false, findings, checked: 'read it' });
  const f = (severity, rule, where, extra = {}) => ({ severity, rule, where, observed: `seen: ${rule}`, fix: `fix: ${rule}`, ...extra });
  const RAW = 'heredoc bounds read from raw text';
  const stamped = (stage, item) => ({ stage, ...item });
  const FORMS = [
    ['security', f('major', RAW, 'src/heredocs.mjs:40')],
    ['compliance', f('major', 'a comment hides the heredoc end', 'src/heredocs.mjs:55', { repeats: 'E1' })],
  ];
  const strip = ({ repeats, ...rest }) => rest;

  it('goes back to the architect after the second same-kind finding, not after the third round', async () => {
    const { result, calls, logs } = await runWorkflow(
      args({ rounds: 3 }),
      passing({ 'security:S-1#1': verdict(FORMS[0][1]), 'compliance:S-1#2': verdict(FORMS[1][1]) }),
    );
    expect(result).toMatchObject({ status: 'rethink', id: 'S-1', round: 2, builder: 'developer', reason: 'Round 2 found the same kind of bug again.' });
    expect(Object.hasOwn(result, 'plan')).toBe(false);
    expect(labels(calls)).toContain('fix:S-1#1');
    expect(labels(calls)).not.toContain('fix:S-1#2');
    expect(labels(calls)).not.toContain('test:S-1#3');
    expect(result.kind).toEqual([stamped('security', FORMS[0][1]), strip(stamped('compliance', FORMS[1][1]))]);
    expect(result.kind.every((k) => !Object.hasOwn(k, 'repeats'))).toBe(true);
    expect(result.findings).toEqual([stamped('compliance', FORMS[1][1])]);
    expect(result.history).toEqual([{ round: 1, findings: [stamped('security', FORMS[0][1])] }]);
    expect(logs.join('\n')).toMatch(/S-1 round 2: the same kind of bug came back; back to the architect to change the approach/);
  });

  it('matches the same file and rule written two ways, with no repeats mark', async () => {
    const { result, calls } = await runWorkflow(
      args({ rounds: 3 }),
      passing({
        'security:S-1#1': verdict(f('major', 'Heredoc bounds read from raw text.', 'src/heredocs.mjs:40')),
        'security:S-1#2': verdict(f('blocker', 'heredoc  bounds read from raw text', './src/heredocs.mjs:90-95')),
      }),
    );
    expect(result).toMatchObject({ status: 'rethink', round: 2 });
    expect(labels(calls)).not.toContain('fix:S-1#2');
    expect(result.kind.map((k) => k.where)).toEqual(['src/heredocs.mjs:40', './src/heredocs.mjs:90-95']);
  });

  describe('across attempts', () => {
    const FILE = 'src/heredocs.mjs';
    const A = 'lines joined by a backslash hide the end';
    const B = 'a comment hides the heredoc end';
    // Two rules, each found three times in other wording and at other lines, by two failed attempts.
    const earlier = [
      { stage: 'security', severity: 'major', rule: A, where: `${FILE}:12`, observed: 'o1', fix: 'f1', round: 1, at: '2026-11-01T10:00:00.000Z' },
      { stage: 'compliance', severity: 'major', rule: `${A}.`, where: `./${FILE}:13`, observed: 'o2', fix: 'f2' },
      { stage: 'security', severity: 'blocker', rule: B, where: `${FILE}:20`, observed: 'o3', fix: 'f3' },
      { stage: 'compliance', severity: 'major', rule: B.toUpperCase(), where: `${FILE}:21-25`, observed: 'o4', fix: 'f4' },
      { stage: 'security', severity: 'major', rule: `${A}  `, where: `${FILE}:30`, observed: 'o5', fix: 'f5' },
      { stage: 'security', severity: 'major', rule: `"${B}"`, where: `${FILE}:41`, observed: 'o6', fix: 'f6' },
    ];
    const unrelated = { stage: 'security', severity: 'major', rule: 'the flag parser accepts anything', where: 'src/cli.mjs:9', observed: 'o7', fix: 'f7' };
    // Another case of rule A, which it says is also another case of E3 (rule B).
    const newOne = f('major', A, `${FILE}:60`, { repeats: 'E3' });
    const go = (over = {}) => runWorkflow(args({ rounds: 3, earlier: [...earlier, unrelated], ...over }), passing({ 'security:S-1#1': verdict(newOne) }));

    it('goes back at round 1 with no fix call; the kind holds the whole kind and not the unrelated finding', async () => {
      const { result, calls } = await go({ plan: PLAN });
      expect(result).toMatchObject({ status: 'rethink', round: 1 });
      expect(labels(calls).some((l) => l.startsWith('fix:'))).toBe(false);
      const rules = result.kind.map((k) => k.rule);
      expect(rules).toEqual([...earlier.map((e) => e.rule), newOne.rule]);
      expect(result.kind.map((k) => k.observed)).not.toContain('o7');
      expect(result.kind[0]).toMatchObject({ round: 1, at: '2026-11-01T10:00:00.000Z' });
    });

    it('lists the earlier findings in the round 1 tester and reviewer prompts, with the repeats sentence', async () => {
      const { calls } = await go({ plan: PLAN });
      for (const label of ['test:S-1#1', 'compliance:S-1#1', 'security:S-1#1']) {
        const p = call(calls, label).prompt;
        expect(p, label).toContain('## Earlier findings');
        expect(p, label).toContain('- [E1] [security · major] lines joined by a backslash hide the end — src/heredocs.mjs:12\n  Observed: o1');
        expect(p, label).toContain('- [E7] [security · major] the flag parser accepts anything — src/cli.mjs:9');
        expect(p, label).toContain('set its `repeats` to that id, such as "E2". Leave `repeats` out otherwise.');
      }
    });

    it('gives the architect of the next launch every finding of the kind, asks for an approach and returns the plan', async () => {
      const first = await go({ plan: PLAN });
      const PLANNED = { ...PLAN, builder: 'developer', design: 'Fail closed.', approach: 'Fail closed on anything not proven to be a heredoc.' };
      const rethink = { round: 1, findings: first.result.kind };
      const { result, calls } = await runWorkflow(args({ rounds: 3, rethink, checks: [{ run: 'npm test', when: 'always' }], traits: { architect: 'Architect trait.' } }), passing({ 'architect:': PLANNED }));
      expect(result).toMatchObject({ status: 'passed', plan: PLANNED });
      const architect = call(calls, 'architect:S-1');
      expect(architect.prompt).toContain('## Change the approach\nRound 1 found the same kind of bug again');
      for (const k of first.result.kind) {
        expect(architect.prompt).toContain(`- [${k.stage} · ${k.severity}] ${k.rule} — ${k.where}\n  Observed: ${k.observed}`);
      }
      expect(architect.prompt).not.toContain('the flag parser accepts anything');
      expect(architect.prompt).not.toContain('## Earlier findings');
      expect(architect.prompt.indexOf('## Change the approach')).toBeLessThan(architect.prompt.indexOf('## Builders'));
      expect(architect.prompt.endsWith('\n\n## Project traits\nArchitect trait.')).toBe(true);
      expect(architect.prompt).toContain('\n\n## Checks\n');
      expect(architect.schema.required).toContain('approach');
      expect(architect.schema.properties.approach.type).toBe('string');
      expect(call(calls, 'build:S-1').prompt).toContain('## Approach\nFail closed on anything not proven to be a heredoc.\n\n## Design');
    });
  });

  describe('findings of different kinds', () => {
    it('still get fix rounds and fail after the rounds', async () => {
      const { result, calls, logs } = await runWorkflow(
        args({ rounds: 3 }),
        passing({
          'security:S-1#1': verdict(f('major', 'rule one', 'src/a.mjs:1')),
          'security:S-1#2': verdict(f('major', 'rule one', 'src/b.mjs:1')),
          'security:S-1#3': verdict(f('major', 'rule two', 'src/b.mjs:2')),
        }),
      );
      expect(result).toMatchObject({ status: 'failed', rounds: 3 });
      expect(labels(calls).filter((l) => l.startsWith('fix:'))).toEqual(['fix:S-1#1', 'fix:S-1#2']);
      expect(logs.join('\n')).not.toMatch(/same kind/);
    });

    const again = async (round1, round2, over = {}) => {
      const script = { 'security:S-1#1': round1, 'security:S-1#2': round2, ...over };
      return runWorkflow(args({ rounds: 2 }), passing(script));
    };

    it('do not match when two reviewers in one round hold the same file and rule', async () => {
      const same = f('major', RAW, 'src/heredocs.mjs:1');
      const { result, calls } = await runWorkflow(args({ rounds: 2 }), passing({ 'compliance:S-1#1': verdict(same), 'security:S-1#1': verdict(same) }));
      expect(result).toMatchObject({ status: 'passed', rounds: 2 });
      expect(labels(calls)).toContain('fix:S-1#1');
      expect(result.history).toHaveLength(1);
      expect(result.history[0].findings).toHaveLength(2);
    });

    it('do not match a stage that did not report, twice', async () => {
      const { result } = await runWorkflow(args({ rounds: 2 }), passing({ 'security:': undefined }));
      expect(result).toMatchObject({ status: 'failed' });
      expect(result.findings[0].rule).toBe('stage did not report');
    });

    it('do not match an incomplete build, twice', async () => {
      const { result } = await runWorkflow(args({ rounds: 2 }), passing({ 'build:': { ...BUILT, complete: false, problem: 'p' }, 'fix:': { ...BUILT, complete: false, problem: 'p' } }));
      expect(result).toMatchObject({ status: 'failed' });
      expect(result.findings[0].stage).toBe('build');
    });

    it('do not match a repeats mark for an id that does not exist', async () => {
      const { result } = await again(verdict(f('major', 'one', 'src/a.mjs:1')), verdict(f('major', 'two', 'src/b.mjs:1', { repeats: 'E99' })));
      expect(result.status).toBe('failed');
    });

    it('ignore a minor finding with a repeats mark', async () => {
      const { result } = await again(verdict(f('major', 'one', 'src/a.mjs:1')), { approved: true, findings: [f('minor', 'one', 'src/a.mjs:1', { repeats: 'E1' })], checked: 'c' });
      expect(result).toMatchObject({ status: 'passed', rounds: 2 });
    });

    it('do not match a finding without a file, or with an empty rule', async () => {
      const a = await again(verdict(f('major', 'one', '-')), verdict(f('major', 'one', '-')));
      expect(a.result.status).toBe('failed');
      const b = await again(verdict(f('major', '', 'src/a.mjs:1')), verdict(f('major', '...', 'src/a.mjs:2')));
      expect(b.result.status).toBe('failed');
    });

    it('do not match a build or merge finding passed in as earlier', async () => {
      const earlier = [{ stage: 'merge', severity: 'blocker', rule: 'merge main', where: 'src/a.mjs', observed: 'o', fix: 'f' }];
      const { result } = await runWorkflow(args({ rounds: 2, earlier }), passing({ 'security:S-1#1': verdict(f('blocker', 'merge main', 'src/a.mjs:3')), 'security:S-1#2': OK }));
      expect(result.status).toBe('passed');
    });
  });

  describe('never a second rethink', () => {
    const FOREVER = passing({ 'security:': verdict(f('major', RAW, 'src/heredocs.mjs:1')) });
    it('a launch with rethink fails after the rounds instead', async () => {
      const rethink = { round: 1, findings: [stamped('security', f('major', RAW, 'src/heredocs.mjs:1'))] };
      const { result } = await runWorkflow(args({ rounds: 3, rethink }), passing({ ...FOREVER, 'architect:': { ...PLAN, approach: 'Fail closed.' } }));
      expect(result).toMatchObject({ status: 'failed', rounds: 3 });
    });

    it('a plan that carries an approach fails after the rounds instead', async () => {
      const { result } = await runWorkflow(args({ rounds: 3, plan: { ...PLAN, approach: 'Fail closed.' } }), FOREVER);
      expect(result).toMatchObject({ status: 'failed', rounds: 3 });
    });

    it('startAt fix fails after the rounds instead', async () => {
      const findings = [stamped('ci', f('blocker', 'CI must pass', 'src/heredocs.mjs:1'))];
      const { result } = await runWorkflow(args({ rounds: 3, plan: PLAN, startAt: 'fix', findings }), FOREVER);
      expect(result).toMatchObject({ status: 'failed', rounds: 3 });
    });

    it('without any of them the same input does go back', async () => {
      const { result } = await runWorkflow(args({ rounds: 3 }), FOREVER);
      expect(result).toMatchObject({ status: 'rethink', round: 2 });
    });
  });

  describe('the history in the prompts', () => {
    const earlier = [{ stage: 'security', severity: 'major', rule: 'one rule', where: 'src/a.mjs:1', observed: 'oo', fix: 'ff' }];

    it('gives a retried story the architect with every earlier finding', async () => {
      const { calls } = await runWorkflow(args({ earlier }), passing());
      const p = call(calls, 'architect:S-1').prompt;
      expect(p).toContain('## Earlier findings\nThis story was built before and sent back.');
      expect(p).toContain('- [security · major] one rule — src/a.mjs:1\n  Observed: oo\n  Fix: ff');
      expect(p).not.toContain('## Change the approach');
      expect(call(calls, 'architect:S-1').schema.properties.approach).toBeUndefined();
    });

    it('lists round 1 findings for the round 2 reviewers as E1', async () => {
      const { calls } = await runWorkflow(args(), passing({ 'test:S-1#1': verdict(f('major', 'some rule', 'src/a.mjs:1')) }));
      expect(call(calls, 'test:S-1#1').prompt).not.toContain('## Earlier findings');
      expect(call(calls, 'compliance:S-1#2').prompt).toContain('## Earlier findings');
      expect(call(calls, 'compliance:S-1#2').prompt).toContain('- [E1] [tester · major] some rule — src/a.mjs:1\n  Observed: seen: some rule');
    });

    it('leaves every prompt as it was with no earlier findings', async () => {
      const { calls } = await runWorkflow(args(), passing());
      for (const c of calls) expect(c.prompt, c.label).not.toContain('Earlier findings');
      expect(call(calls, 'architect:S-1').prompt).not.toContain('Change the approach');
    });

    it('puts the section after the Files line and before the reviewer text', async () => {
      const { calls } = await runWorkflow(args({ earlier, plan: PLAN }), passing());
      const p = call(calls, 'compliance:S-1#1').prompt;
      expect(p.indexOf('Files: login.js')).toBeLessThan(p.indexOf('## Earlier findings'));
      expect(p.endsWith(`\n\n${COMPLIANCE_TEXT}`)).toBe(true);
    });

    it('dedupes earlier and rethink findings and strips repeats from them', async () => {
      const dup = { ...earlier[0], repeats: 'E4' };
      const { calls } = await runWorkflow(args({ earlier, rethink: { round: 1, findings: [dup] } }), passing());
      const p = call(calls, 'test:S-1#1').prompt;
      expect(p.match(/\[E\d+\]/g)).toEqual(['[E1]']);
    });
  });

  describe('args', () => {
    it('refuses an earlier that is not a list of objects', async () => {
      await expect(runWorkflow(args({ earlier: 'x' }), {})).rejects.toThrow(/earlier/);
      await expect(runWorkflow(args({ earlier: [1] }), {})).rejects.toThrow(/earlier/);
      await expect(runWorkflow(args({ earlier: {} }), {})).rejects.toThrow(/earlier/);
    });

    it('refuses a rethink with no round of at least 1 or with no findings', async () => {
      const one = [{ stage: 'security', severity: 'major', rule: 'r', where: 'a:1', observed: 'o', fix: 'f' }];
      await expect(runWorkflow(args({ rethink: { round: 0, findings: one } }), {})).rejects.toThrow(/rethink/);
      await expect(runWorkflow(args({ rethink: { round: 1, findings: [] } }), {})).rejects.toThrow(/rethink/);
      await expect(runWorkflow(args({ rethink: { round: 1, findings: ['x'] } }), {})).rejects.toThrow(/rethink/);
      await expect(runWorkflow(args({ rethink: 'x' }), {})).rejects.toThrow(/rethink/);
    });

    it('refuses a rethink together with a plan, startAt or resume', async () => {
      const rethink = { round: 1, findings: [{ stage: 'security', severity: 'major', rule: 'r', where: 'a:1', observed: 'o', fix: 'f' }] };
      const findings = [{ stage: 'ci', severity: 'blocker', rule: 'r', where: 'a:1', observed: 'o', fix: 'f' }];
      await expect(runWorkflow(args({ rethink, plan: PLAN }), {})).rejects.toThrow(/rethink without plan, startAt or resume/);
      await expect(runWorkflow(args({ rethink, plan: PLAN, startAt: 'fix', findings }), {})).rejects.toThrow(/rethink/);
      await expect(runWorkflow(args({ rethink, plan: PLAN, resume: { build: { summary: 's', files: [] } } }), {})).rejects.toThrow(/rethink/);
    });

    it('describes the new args, the status and the fields in meta', async () => {
      const { meta } = await runWorkflow(args(), passing());
      expect(meta.whenToUse).toMatch(/rethink/);
      expect(meta.whenToUse).toMatch(/earlier/);
      expect(meta.whenToUse).toMatch(/repeats/);
      expect(meta.whenToUse).toMatch(/approach/);
    });

    it('asks reviewers for an optional repeats string', async () => {
      const { calls } = await runWorkflow(args(), passing());
      const item = call(calls, 'test:S-1#1').schema.properties.findings.items;
      expect(item.properties.repeats.type).toBe('string');
      expect(item.required).not.toContain('repeats');
    });
  });
});

describe('pipeline workflow: a story that cannot hold as written', () => {
  const STORY = { ...BUILT, complete: false, blocked_by: 'story', done_when_line: 1, problem: 'Done-when 1 says the old code has a hole; src/a.mjs:10 already refuses it.' };
  const { done_when_line, ...STORY_NO_LINE } = STORY;
  const NEW_LINE = 'Done-when 1 rewritten: the guard is tested against real bash';
  const REPLANNED = { ...PLAN, done_when: NEW_LINE, approach: 'Done-when 1 claimed a hole the code does not have; it now asks for a test.' };
  const FOUND = { stage: 'build', severity: 'blocker', rule: 'the story cannot hold as written', where: '-', observed: STORY.problem, fix: 'Correct the plan or the Done-when line the builder names, or ask the owner what the story should prove.' };

  it('goes back to the architect with no fix round', async () => {
    const { result, calls, logs } = await runWorkflow(args(), passing({ 'build:': STORY }));
    expect(result).toMatchObject({ status: 'rethink', id: 'S-1', round: 1, builder: 'developer', cause: 'story', line: 1 });
    expect(Object.hasOwn(result, 'plan')).toBe(false);
    expect(labels(calls)).toEqual(['architect:S-1', 'build:S-1']);
    expect(result.kind).toEqual([FOUND]);
    expect(result.findings).toEqual([FOUND]);
    expect(result.history).toEqual([]);
    expect(result.reason).toContain('Done-when 1');
    expect(logs.join('\n')).toMatch(/back to the architect to correct it/);
  });

  it('carries no line when the builder names none', async () => {
    const { result } = await runWorkflow(args(), passing({ 'build:': STORY_NO_LINE }));
    expect(result).toMatchObject({ status: 'rethink', cause: 'story' });
    expect(Object.hasOwn(result, 'line')).toBe(false);
    expect(result.reason).toContain('the story cannot hold as written');
  });

  it('ignores a line that is not a whole number of at least 1', async () => {
    for (const bad of [0, 1.5, '1']) {
      const { result } = await runWorkflow(args(), passing({ 'build:': { ...STORY, done_when_line: bad } }));
      expect(result, String(bad)).toMatchObject({ status: 'rethink', cause: 'story' });
      expect(Object.hasOwn(result, 'line')).toBe(false);
    }
  });

  it('says so when the builder gave no evidence', async () => {
    const { result } = await runWorkflow(args(), passing({ 'build:': { ...STORY, problem: '' } }));
    expect(result.kind[0].observed).toBe('The builder gave no evidence.');
  });

  it('goes back from a fix round too, with the earlier rounds in history', async () => {
    const { result, calls } = await runWorkflow(args(), passing({ 'test:S-1#1': { approved: false, findings: [finding('major')], checked: 'c' }, 'fix:': STORY }));
    expect(result).toMatchObject({ status: 'rethink', round: 2, cause: 'story' });
    expect(result.history).toHaveLength(1);
    expect(result.history[0].round).toBe(1);
    expect(labels(calls)).not.toContain('test:S-1#2');
  });

  it('gives the next launch an architect told to correct the story, and builds against the new Done-when', async () => {
    const first = await runWorkflow(args(), passing({ 'build:': STORY }));
    const rethink = { round: 1, findings: first.result.kind, cause: 'story' };
    const { result, calls } = await runWorkflow(args({ rethink }), passing({ 'architect:': REPLANNED }));
    const architect = call(calls, 'architect:S-1');
    expect(architect.prompt).toContain('## Correct the story');
    expect(architect.prompt).toContain(STORY.problem);
    expect(architect.prompt).not.toContain('## Change the approach');
    expect(architect.prompt.indexOf('## Correct the story')).toBeLessThan(architect.prompt.indexOf('## Builders'));
    expect(architect.schema.required).toContain('approach');
    expect(architect.schema.properties.approach.description).toMatch(/Done-when line/);
    expect(result).toMatchObject({ status: 'passed' });
    expect(result.plan.done_when).toBe(NEW_LINE);
    expect(call(calls, 'build:S-1').prompt).toContain(`## Done when\n${NEW_LINE}`);
    expect(call(calls, 'build:S-1').prompt).not.toContain('npm test passes');
    expect(call(calls, 'test:S-1#1').prompt).toContain(NEW_LINE);
  });

  it('keeps the same-kind architect prompt when the rethink has no cause', async () => {
    const { calls } = await runWorkflow(args({ rethink: { round: 1, findings: [FOUND] } }), passing({ 'architect:': REPLANNED }));
    const p = call(calls, 'architect:S-1').prompt;
    expect(p).toContain('## Change the approach');
    expect(p).not.toContain('## Correct the story');
  });

  it('ends at once as failed on a second story block, with no fix round', async () => {
    const rethink = { round: 1, findings: [FOUND], cause: 'story' };
    const { result, calls, logs } = await runWorkflow(args({ rethink }), passing({ 'architect:': REPLANNED, 'build:': STORY, 'fix:': STORY }));
    expect(result).toMatchObject({ status: 'failed', rounds: 1, cause: 'story', line: 1, builder: 'developer' });
    expect(labels(calls)).toEqual(['architect:S-1', 'build:S-1']);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].observed).toBe(STORY.problem);
    expect(result.findings[0].rule).toBe('the story cannot hold as written');
    expect(result.history).toEqual([]);
    expect(result.reason).toContain('Done-when 1');
    expect(result.reason).toContain('after the architect corrected');
    expect(result.plan.done_when).toBe(REPLANNED.done_when);
    expect(logs.join('\n')).toMatch(/ending without more build rounds/);
  });

  it('carries no line and says so when the builder names none', async () => {
    const rethink = { round: 1, findings: [FOUND], cause: 'story' };
    const { result } = await runWorkflow(args({ rethink }), passing({ 'architect:': REPLANNED, 'build:': STORY_NO_LINE }));
    expect(result).toMatchObject({ status: 'failed', cause: 'story' });
    expect(Object.hasOwn(result, 'line')).toBe(false);
    expect(result.reason).toContain('the story cannot hold after the architect corrected it');
    const empty = await runWorkflow(args({ rethink }), passing({ 'architect:': REPLANNED, 'build:': { ...STORY_NO_LINE, problem: '' } }));
    expect(empty.result.findings[0].observed).toBe('The builder gave no evidence.');
  });

  it('ends at once when the plan already carries an approach, or on startAt fix', async () => {
    const a = await runWorkflow(args({ plan: { ...PLAN, approach: 'x' } }), passing({ 'build:': STORY }));
    expect(a.result).toMatchObject({ status: 'failed', rounds: 1, cause: 'story' });
    expect(labels(a.calls)).toEqual(['build:S-1']);
    expect(a.result.reason).toContain('after the architect corrected');
    expect(Object.hasOwn(a.result, 'plan')).toBe(false);
    const findings = [{ stage: 'ci', severity: 'blocker', rule: 'CI must pass', where: 'a:1', observed: 'o', fix: 'f' }];
    const b = await runWorkflow(args({ plan: PLAN, startAt: 'fix', findings }), passing({ 'fix:': STORY }));
    expect(b.result).toMatchObject({ status: 'failed', rounds: 1, cause: 'story' });
    expect(labels(b.calls)).toEqual(['fix:S-1#0']);
    expect(b.result.reason).toContain('in a fix round after review');
    expect(b.result.reason).not.toContain('architect corrected');
  });

  it('ends at once from a later round too, keeping the earlier rounds in history', async () => {
    const rethink = { round: 1, findings: [FOUND], cause: 'story' };
    const { result, calls } = await runWorkflow(
      args({ rethink }),
      passing({ 'architect:': REPLANNED, 'test:S-1#1': { approved: false, findings: [finding('major')], checked: 'c' }, 'fix:': STORY }),
    );
    expect(result).toMatchObject({ status: 'failed', rounds: 2, cause: 'story' });
    expect(result.history).toHaveLength(1);
    expect(result.history[0].round).toBe(1);
    expect(labels(calls)).not.toContain('test:S-1#2');
  });

  it('a rethink launch for the same kind of bug ends at once on a story block too', async () => {
    const { result, calls } = await runWorkflow(args({ rethink: { round: 1, findings: [FOUND] } }), passing({ 'architect:': REPLANNED, 'build:': STORY }));
    expect(result).toMatchObject({ status: 'failed', rounds: 1 });
    expect(labels(calls).filter((l) => l.startsWith('fix:'))).toEqual([]);
  });

  it('still gives fix rounds for blocked_by code and no blocked_by in a launch that cannot rethink', async () => {
    const rethink = { round: 1, findings: [FOUND], cause: 'story' };
    const code = { ...BUILT, complete: false, blocked_by: 'code', problem: 'p' };
    const { blocked_by, ...none } = code;
    for (const b of [code, none]) {
      const { result, calls } = await runWorkflow(args({ rethink }), passing({ 'architect:': REPLANNED, 'build:': b, 'fix:': b }));
      expect(result).toMatchObject({ status: 'failed', rounds: 3, reason: 'Still rejected after 3 build rounds.' });
      expect(labels(calls).filter((l) => l.startsWith('fix:'))).toEqual(['fix:S-1#1', 'fix:S-1#2']);
      expect(Object.hasOwn(result, 'cause')).toBe(false);
    }
  });

  it('gives a fix round for blocked_by code and for no blocked_by, alike', async () => {
    const code = await runWorkflow(args(), passing({ 'build:': { ...BUILT, complete: false, blocked_by: 'code', problem: 'p' } }));
    expect(labels(code.calls)).toContain('fix:S-1#1');
    expect(code.result).toMatchObject({ status: 'passed', rounds: 2 });
    expect(code.result.history[0].findings[0].rule).toBe('the build is not complete');
    const none = await runWorkflow(args(), passing({ 'build:': { ...BUILT, complete: false, problem: 'p' } }));
    expect(labels(none.calls)).toEqual(labels(code.calls));
    expect(none.result).toEqual(code.result);
  });

  it('ignores blocked_by story on a complete build', async () => {
    const { result } = await runWorkflow(args(), passing({ 'build:': { ...BUILT, blocked_by: 'story' } }));
    expect(result).toMatchObject({ status: 'passed', rounds: 1 });
  });

  it('refuses a rethink cause that is not story', async () => {
    const findings = [FOUND];
    await expect(runWorkflow(args({ rethink: { round: 1, findings, cause: 'other' } }), {})).rejects.toThrow(/rethink\.cause/);
    const { result } = await runWorkflow(args({ rethink: { round: 1, findings, cause: 'story' } }), passing({ 'architect:': REPLANNED }));
    expect(result.status).toBe('passed');
  });

  it('describes the result in meta', async () => {
    const { meta } = await runWorkflow(args(), passing());
    expect(meta.whenToUse).toMatch(/blocked_by/);
    expect(meta.whenToUse).toMatch(/Correct the story/);
    expect(meta.whenToUse).toMatch(/status: "failed", cause: "story"/);
  });

  it('asks the builder for an optional blocked_by and done_when_line', async () => {
    const { calls } = await runWorkflow(args(), passing());
    const schema = call(calls, 'build:S-1').schema;
    expect(schema.properties.blocked_by.enum).toEqual(['code', 'story']);
    expect(schema.properties.done_when_line.type).toBe('integer');
    expect(schema.required).not.toContain('blocked_by');
    expect(schema.required).not.toContain('done_when_line');
  });
});
