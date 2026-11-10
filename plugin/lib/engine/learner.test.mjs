import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULTS, withDefaults } from '../config/defaults.mjs';
import { capProblem, checkContext, checkLesson, LEARNER_DENY, learnerCommand, learnerInput, learnerPrompt, learnerSpentToday, parseLearnerReply, readLearnerCalls, recordLearnerCall, runLearner } from './learner.mjs';
import { addItem, keepItem } from './learning-store.mjs';
import { useSubscription } from './claude-fallback.mjs';
import { learnedSkills } from './slot-prepare.mjs';

// Token-shaped fixtures are built at run time, so no file holds one whole.
const GHP = `ghp_${'a1B2'.repeat(9)}`;
const PRIVATE_KEY = ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' ');
const FILE_SECRET = ['acme', 'plain', 'value42'].join('');
const NOW = new Date('2026-10-24T12:00:00Z');
const TODAY = { now: new Date('2026-10-24T08:00:00Z') };
const YESTERDAY = { now: new Date('2026-10-23T08:00:00Z') };

let root;
let state;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-learner-'));
  state = join(root, '.foreman');
  mkdirSync(state, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const configWith = (learning = {}, raw = {}) => withDefaults({ version: 1, project: { name: 'Acme' }, ...raw, learning: { ...DEFAULTS.learning, ...learning } });
const ctxFor = (learning = {}, extra = {}) => checkContext({ root, stateDir: state, config: configWith(learning), env: {}, values: [], now: NOW, home: '/home/acme', ...extra });
const check = (reply, learning) => checkLesson(reply, ctxFor(learning));

const trait = (text, role = 'developer') => ({ verdict: 'trait', reason: 'Two Acme stories shipped routes without tests.', trait: { role, text }, conflicts: [] });
const SKILL = {
  slug: 'acme-routes',
  description: 'Use when adding an Acme route: give it a test that fails if the route breaks.',
  roles: ['developer'],
  steps: ['Add the route in src/routes.mjs.', 'Add a test that calls it and fails if it breaks.'],
  example: 'S-1 added /orders without a test; the fix added routes.test.mjs.',
};
const skill = (over = {}) => ({ verdict: 'skill', reason: 'Acme routes keep missing tests.', skill: { ...SKILL, ...over }, conflicts: [] });
const seedTrait = (text = 'Acme: every route has a test', role = 'developer', at = TODAY) => addItem(state, { kind: 'trait', roles: [role], text, source: { key: 'f-000000000001', stories: ['S-1'] }, reason: 'seed' }, at);
const seedSkill = (slug = 'acme-routes', at = TODAY) => addItem(state, { kind: 'skill', roles: ['developer'], slug, text: `---\nname: foreman-learned-${slug}\ndescription: "Use when seeding ${slug}"\n---\n\n# ${slug}\n`, reason: 'seed' }, at);

describe('checkLesson: what passes', () => {
  it('passes none', () => {
    const r = check({ verdict: 'none', reason: 'CLAUDE.md already says this.', conflicts: [] });
    expect(r).toEqual({ ok: true, lesson: { verdict: 'none', reason: 'CLAUDE.md already says this.', conflicts: [] } });
  });

  it('passes a trait of exactly 400 characters for developer', () => {
    const text = `Acme ${'x'.repeat(395)}`;
    expect(text).toHaveLength(400);
    const r = check(trait(text));
    expect(r.ok).toBe(true);
    expect(r.lesson).toEqual({ verdict: 'trait', reason: 'Two Acme stories shipped routes without tests.', conflicts: [], trait: { role: 'developer', text } });
  });

  it('passes a skill, rendered so slot-prepare reads its description back', () => {
    const r = check(skill());
    expect(r.ok).toBe(true);
    const s = r.lesson.skill;
    expect(s).toMatchObject({ slug: 'acme-routes', name: 'foreman-learned-acme-routes', description: SKILL.description, roles: ['developer'], steps: SKILL.steps, example: SKILL.example });
    expect(s.text.startsWith('---\nname: foreman-learned-acme-routes\ndescription: "Use when')).toBe(true);
    expect(s.text).toContain('# acme routes\n\n## Steps\n\n1. Add the route in src/routes.mjs.\n2. Add a test that calls it and fails if it breaks.\n\n## Example\n\nS-1 added /orders');
    addItem(state, { kind: 'skill', roles: s.roles, slug: s.slug, text: s.text, reason: 'test' }, TODAY);
    const { skills } = learnedSkills({ stateDir: state, config: configWith() });
    expect(skills.map((x) => x.use)).toEqual([SKILL.description]);
  });

  it('passes a merge into a trait in force', () => {
    seedTrait();
    const r = check({ verdict: 'merge', reason: 'Widen L-1 to error paths.', merge: { id: 'L-1', trait: 'Acme: every route and error path has a test' }, conflicts: [] });
    expect(r.ok).toBe(true);
    expect(r.lesson.merge).toEqual({ id: 'L-1', kind: 'trait', text: 'Acme: every route and error path has a test' });
  });

  it('passes a merge into a skill in force, keeping its slug and roles', () => {
    seedSkill();
    const r = check({ verdict: 'merge', reason: 'Add the error path.', merge: { id: 'L-1', skill: { description: 'Use when adding an Acme route or its error path.', steps: ['Test the route.', 'Test the error path.'], example: 'S-2 missed the 404 path.' } }, conflicts: [] });
    expect(r.ok).toBe(true);
    expect(r.lesson.merge).toMatchObject({ id: 'L-1', kind: 'skill', skill: { slug: 'acme-routes', name: 'foreman-learned-acme-routes', roles: ['developer'] } });
    expect(r.lesson.merge.skill.text.startsWith('---\nname: foreman-learned-acme-routes\n')).toBe(true);
  });

  it('a merge does not count its own target toward the trial cap', () => {
    seedTrait();
    seedTrait('Acme: tester checks 404s', 'tester');
    const r = check({ verdict: 'merge', reason: 'Widen L-1.', merge: { id: 'L-1', trait: 'Acme: every route and error path has a test' }, conflicts: [] }, { maxPerDay: 10 });
    expect(r.ok).toBe(true);
  });
});

describe('checkLesson: what is refused, with its reason', () => {
  const refused = (reply, reason, learning) => {
    const r = check(reply, learning);
    expect(r).toEqual({ ok: false, reason });
  };

  it('refuses a reply that is not an object', () => refused(['none'], 'the reply is not a JSON object'));
  it('refuses a trait of 401 characters', () => refused(trait(`Acme ${'x'.repeat(396)}`), 'a trait is at most 400 characters'));
  it('refuses a trait for an unknown role', () => refused(trait('Acme: test routes', 'gardener'), 'a trait needs one known role'));
  it('refuses a skill description without "Use when"', () => refused(skill({ description: 'When adding a route, test it.' }), 'a skill description must start with "Use when" and be at most 300 characters'));
  it('refuses a description over 300 characters', () => refused(skill({ description: `Use when ${'y'.repeat(292)}` }), 'a skill description must start with "Use when" and be at most 300 characters'));
  it('refuses a description on two lines', () => refused(skill({ description: 'Use when adding\na route.' }), 'a skill description must start with "Use when" and be at most 300 characters'));
  it('refuses a bad slug', () => refused(skill({ slug: 'Acme_Routes' }), 'a skill slug must be lowercase words joined by dashes, at most 40 characters'));
  it('refuses a slug over 40 characters', () => refused(skill({ slug: `acme-${'r'.repeat(36)}` }), 'a skill slug must be lowercase words joined by dashes, at most 40 characters'));
  it('refuses a slug that already carries foreman-learned-', () => {
    refused(skill({ slug: 'foreman-learned-acme' }), 'a skill slug must not start with foreman-learned- (Foreman adds it)');
    refused(skill({ slug: 'foreman-learned' }), 'a skill slug must not start with foreman-learned- (Foreman adds it)');
  });
  it('still gives the slug reason for an uppercase foreman-learned- slug', () => refused(skill({ slug: 'foreman-learned-Acme' }), 'a skill slug must be lowercase words joined by dashes, at most 40 characters'));
  it('passes a slug that only ends in foreman-learned', () => expect(check(skill({ slug: 'acme-foreman-learned' })).ok).toBe(true));

  it('refuses a slug that a skills-lock.json skill has', () => {
    write(join(root, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { 'acme-routes': { source: 'acme/skills', ref: 'v1' } } }));
    refused(skill(), 'the slug acme-routes clashes with a pack skill');
  });

  it('refuses a slug a project .claude/skills folder has', () => {
    mkdirSync(join(root, '.claude', 'skills', 'acme-routes'), { recursive: true });
    refused(skill(), 'the slug acme-routes clashes with a project skill');
  });

  it('refuses a slug a learned skill in force has', () => {
    seedSkill();
    refused(skill(), 'the slug acme-routes clashes with L-1', { maxEvaluating: 10, maxPerDay: 10 });
  });

  it('refuses a skill over 6 KB', () => refused(skill({ steps: Array.from({ length: 12 }, (_, i) => `Step ${i}: ${'z'.repeat(600)}`) }), 'a learned skill is at most 6 KB'));
  it('refuses a skill with no steps', () => refused(skill({ steps: [] }), 'a skill needs 1 to 12 steps'));
  it('refuses a skill with no example', () => refused(skill({ example: ' ' }), 'a skill needs an example'));
  it('refuses a skill with an unknown role', () => refused(skill({ roles: ['gardener'] }), 'a skill needs known roles'));

  it('refuses a token in the trait text before scrubbing would blank it', () => refused(trait(`Acme: use ${GHP} for the API`), 'looks like it holds a secret'));
  it('refuses a token in a key', () => refused({ ...trait('Acme'), [GHP]: 1 }, 'looks like it holds a secret'));
  it('refuses non-empty conflicts', () => refused({ ...trait('Acme: never mock the Acme API'), conflicts: ['CLAUDE.md says: mock every outside service in unit tests'] }, 'the learner found a conflict: CLAUDE.md says: mock every outside service in unit tests'));
  it('cuts a long conflict to 120 characters', () => {
    const r = check({ ...trait('Acme'), conflicts: [`CLAUDE.md ${'c'.repeat(200)}`] });
    expect(r.reason).toBe(`the learner found a conflict: CLAUDE.md ${'c'.repeat(110)}`);
  });
  it('refuses missing conflicts', () => {
    const { conflicts, ...rest } = trait('Acme: test routes');
    refused(rest, 'conflicts must be a list');
  });
  it('refuses an unknown verdict', () => refused({ ...trait('Acme'), verdict: 'rule' }, 'verdict must be none, trait, skill or merge'));
  it('refuses a missing reason', () => refused({ ...trait('Acme'), reason: '' }, 'reason must be a sentence of at most 300 characters'));
  it('refuses a merge of an id not in force', () => refused({ verdict: 'merge', reason: 'Widen it.', merge: { id: 'L-9', trait: 'Acme' }, conflicts: [] }, 'L-9 is not in force'));

  it('refuses a trait once the role has maxPerRole traits', () => {
    seedTrait();
    refused(trait('Acme: test error paths'), 'developer already has 1 learned traits (the most is 1)', { maxPerRole: 1 });
  });

  it('refuses a skill once maxSkills are in force', () => {
    seedSkill('acme-other');
    refused(skill(), 'Foreman already has 1 learned skills (the most is 1)', { maxSkills: 1 });
  });

  it('refuses once maxEvaluating items are on trial', () => {
    seedTrait('Acme: architect names the files', 'architect');
    seedTrait('Acme: tester checks 404s', 'tester');
    refused(trait('Acme: test routes'), '2 learned items are already on trial (the most is 2)', { maxPerDay: 10 });
  });

  it('a kept item is not on trial', () => {
    seedTrait('Acme: architect names the files', 'architect');
    seedTrait('Acme: tester checks 404s', 'tester');
    keepItem(state, 'L-1', TODAY);
    expect(check(trait('Acme: test routes'), { maxPerDay: 10 }).ok).toBe(true);
  });

  it('refuses once Foreman made maxPerDay changes today; yesterday does not count', () => {
    for (const role of ['architect', 'tester']) seedTrait(`Acme: ${role} yesterday`, role, YESTERDAY);
    for (const role of ['architect', 'tester', 'compliance']) seedTrait(`Acme: ${role} today`, role, TODAY);
    refused(trait('Acme: test routes'), 'Foreman already made 3 learned changes today (the most is 3)', { maxEvaluating: 10 });
    expect(check(trait('Acme: test routes'), { maxEvaluating: 10, maxPerDay: 4 }).ok).toBe(true);
  });

  it('refuses a trait that would take the role file past 3 KB', () => {
    seedTrait(`Acme ${'w'.repeat(2900)}`);
    refused(trait(`Acme ${'v'.repeat(200)}`), 'the learned traits for developer would pass 3 KB');
  });

  it('a merge measures the role file with the old entry replaced', () => {
    seedTrait(`Acme ${'w'.repeat(2900)}`);
    expect(check({ verdict: 'merge', reason: 'Shorter.', merge: { id: 'L-1', trait: `Acme ${'v'.repeat(300)}` }, conflicts: [] }).ok).toBe(true);
  });

  it.each([['maxPerDay'], ['maxEvaluating'], ['maxPerRole']])('refuses with a %s of 0', (cap) => {
    const r = check(trait('Acme: test routes'), { [cap]: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/the most is 0/);
  });
});

describe('checkLesson: scrubbing', () => {
  it('gives back an accepted trait with its email and home path scrubbed', () => {
    const ctx = ctxFor();
    const r = checkLesson(trait('Acme: ask ops@acme.example before editing /home/acme/proj/src/a.mjs or /home/acme/notes.md'), { ...ctx, scrubOpts: { ...ctx.scrubOpts, root: '/home/acme/proj' } });
    expect(r.ok).toBe(true);
    expect(r.lesson.trait.text).toBe('Acme: ask <email> before editing src/a.mjs or ~/notes.md');
  });

  // The session may still read project files the deny rules miss; what it puts in a reply is
  // scrubbed or refused here.
  it('blanks a project file secret the session read', () => {
    write(join(root, '.env.foreman'), `ACME_DB_PASS=${FILE_SECRET}\n`);
    const ctx = checkContext({ root, stateDir: state, config: configWith(), env: {}, now: NOW, home: '/home/acme' });
    const r = checkLesson(trait(`Acme: connect with ${FILE_SECRET}`), ctx);
    expect(r.ok).toBe(true);
    expect(r.lesson.trait.text).toBe('Acme: connect with •••');
  });

  it('refuses a private key the session read', () => {
    expect(check(trait(`Acme: use ${PRIVATE_KEY} for deploys`))).toEqual({ ok: false, reason: 'looks like it holds a secret' });
  });
});

describe('parseLearnerReply', () => {
  const envelope = (result, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, result, ...extra });
  const LESSON = { verdict: 'trait', reason: 'Acme.', trait: { role: 'developer', text: 'Acme: test routes' }, conflicts: [] };

  it('finds a fenced multi-line object between prose', () => {
    const r = parseLearnerReply(envelope(`Here is my lesson.\n\n\`\`\`json\n${JSON.stringify(LESSON, null, 2)}\n\`\`\`\n\nThat should help.`));
    expect(r.reply).toEqual(LESSON);
    expect(r.isError).toBe(false);
    expect(r.costUsd).toBe(0.0123);
  });

  it('skips a warning line before the envelope', () => {
    const r = parseLearnerReply(`warning: Acme proxy is slow\n${envelope(JSON.stringify(LESSON))}\n`);
    expect(r.reply).toEqual(LESSON);
  });

  it('reads an envelope printed over several lines', () => {
    const r = parseLearnerReply(JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.5, result: JSON.stringify(LESSON) }, null, 2));
    expect(r.reply).toEqual(LESSON);
    expect(r.costUsd).toBe(0.5);
  });

  it('is not thrown by a lone } inside a string', () => {
    const lesson = { ...LESSON, trait: { role: 'developer', text: 'Acme: close every } in templates' } };
    expect(parseLearnerReply(envelope(`Lesson: ${JSON.stringify(lesson)} done`)).reply).toEqual(lesson);
  });

  it('is not thrown by a { after an escaped quote inside a string', () => {
    const lesson = { ...LESSON, trait: { role: 'developer', text: 'Acme: write "{" to open a block' } };
    expect(JSON.stringify(lesson)).toContain('\\"{\\"');
    expect(parseLearnerReply(envelope(`Lesson: ${JSON.stringify(lesson)} done`)).reply).toEqual(lesson);
  });

  it('takes the last object that has a verdict', () => {
    const first = { ...LESSON, verdict: 'none' };
    const r = parseLearnerReply(envelope(`Draft ${JSON.stringify(first)} then final ${JSON.stringify(LESSON)} and {"note": 1}`));
    expect(r.reply).toEqual(LESSON);
  });

  it('gives reply null when no object has a verdict', () => {
    expect(parseLearnerReply(envelope('I found nothing {"note": 1}')).reply).toBe(null);
  });

  it('parses 100,000 unclosed braces quickly', () => {
    const text = '{'.repeat(100_000) + JSON.stringify(LESSON);
    const started = performance.now();
    const r = parseLearnerReply(envelope(text));
    const elapsed = performance.now() - started;
    expect(r.reply).toEqual(LESSON);
    expect(elapsed).toBeLessThan(1000);
  });

  it('finds a lesson inside an unclosed outer brace', () => {
    expect(parseLearnerReply(envelope(`Use { for blocks. ${JSON.stringify(LESSON)}`)).reply).toEqual(LESSON);
  });

  it('reads is_error and its cost', () => {
    const r = parseLearnerReply(envelope('', { is_error: true, subtype: 'error_max_budget_usd', total_cost_usd: 0.2 }));
    expect(r).toMatchObject({ reply: null, costUsd: 0.2, isError: true });
  });

  it('says when there is no envelope', () => {
    expect(parseLearnerReply('not json\n')).toMatchObject({ reply: null, costUsd: 0, isError: false, envelope: false, tokens: null });
  });

  it('reads the token counts from modelUsage, else usage, else none', () => {
    const modelUsage = { 'claude-haiku-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 } };
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    expect(parseLearnerReply(envelope(JSON.stringify(LESSON), { num_turns: 3, usage, modelUsage })).tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, turns: 3, models: ['claude-haiku-5'] });
    expect(parseLearnerReply(envelope(JSON.stringify(LESSON), { usage })).tokens).toMatchObject({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(parseLearnerReply(envelope(JSON.stringify(LESSON))).tokens).toBeNull();
  });
});

describe('learnerCommand and learnerPrompt', () => {
  it('builds the read-only claude command with --allowedTools last', () => {
    const { cmd, args } = learnerCommand({ prompt: 'P', model: 'haiku', maxUsd: 1.5 });
    expect(cmd).toBe('claude');
    expect(args).toEqual(['-p', 'P', '--safe-mode', '--model', 'haiku', '--tools', 'Read,Grep,Glob', '--permission-prompts', 'none', '--no-session-persistence', '--output-format', 'json', '--max-budget-usd', '1.50', '--disallowedTools', ...LEARNER_DENY, '--allowedTools', 'Read', 'Grep', 'Glob']);
  });

  it('denies reads of secret places outside the project', () => {
    const { args } = learnerCommand({ prompt: 'p', model: 'haiku', maxUsd: 1 });
    const rules = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--allowedTools'));
    expect(args).toContain('--disallowedTools');
    expect(rules).toEqual(LEARNER_DENY);
    for (const rule of ['Read(~/.ssh/**)', 'Read(//etc/**)', 'Read(**/.env*)']) expect(rules).toContain(rule);
    for (const rule of rules) expect(rule.startsWith('Read('), rule).toBe(true);
    expect(rules).not.toContain('Read(~/**)');
    expect(rules).not.toContain('Read(//**)');
    expect(args.slice(-4)).toEqual(['--allowedTools', 'Read', 'Grep', 'Glob']);
  });

  it('puts the input first, then the rules, the schema and the reply rule', () => {
    const p = learnerPrompt({ text: '## The lesson\n\nkey: f-1' }, 'decide');
    expect(p.startsWith('## The lesson\n\nkey: f-1')).toBe(true);
    for (const s of ['400 characters', '"Use when"', '300 characters', '6 KB', '"verdict"', 'conflicts lists every CLAUDE.md or trait rule the proposal contradicts', 'reply with one JSON object']) expect(p).toContain(s);
  });

  it('asks for the skill body only in skill mode', () => {
    expect(learnerPrompt({ text: 'x' }, 'decide')).toMatch(/may leave out the skill body/);
    expect(learnerPrompt({ text: 'x' }, 'skill')).toMatch(/must carry the skill/);
    expect(learnerPrompt({ text: 'x' }, 'skill')).not.toBe(learnerPrompt({ text: 'x' }, 'decide'));
  });
});

describe('runLearner', () => {
  const LESSON_TRAIT = { verdict: 'trait', reason: 'Acme.', trait: { role: 'developer', text: 'Acme: test routes' }, conflicts: [] };
  const LESSON_SKILL = { verdict: 'skill', reason: 'Acme.', skill: { slug: 'acme-routes' }, conflicts: [] };
  const out = (reply, cost = 0.01, extra = {}) => ({ status: 0, stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, result: `Lesson:\n${JSON.stringify(reply)}`, ...extra })}\n`, stderr: '' });
  const fake = (...replies) => {
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return replies[Math.min(calls.length, replies.length) - 1];
    };
    return { run, calls };
  };
  const input = { text: '## The lesson\n\nkey: f-0123456789ab', skillIds: [] };
  const go = (run, { spentUsd = 0, learning = {}, env = {} } = {}) => runLearner({ input, config: configWith(learning), spentUsd, run, env, root, now: NOW });
  const flag = (args, name) => args[args.indexOf(name) + 1];

  it('runs claude read-only with the trait model and the day budget', () => {
    const f = fake(out(LESSON_TRAIT));
    const r = go(f.run);
    expect(r.ok).toBe(true);
    expect(r.reply).toEqual(LESSON_TRAIT);
    expect(r.calls).toEqual([{ model: 'haiku', costUsd: 0.01, verdict: 'trait', error: null, tokens: null }]);
    const { cmd, args } = f.calls[0];
    expect(cmd).toBe('claude');
    expect(flag(args, '--tools')).toBe('Read,Grep,Glob');
    expect(args).toContain('--safe-mode');
    expect(flag(args, '--model')).toBe('haiku');
    expect(flag(args, '--output-format')).toBe('json');
    expect(flag(args, '--max-budget-usd')).toBe('2.00');
    expect(flag(args, '-p')).toBe(learnerPrompt(input, 'decide'));
    expect(args).toContain('--disallowedTools');
    const rest = args.filter((a, i) => i !== 1);
    expect(rest.join(' ')).not.toMatch(/Bash|Edit|Write/);
  });

  it('runs in the project, without the run variables, with a timeout', () => {
    const f = fake(out(LESSON_TRAIT));
    go(f.run, { env: { FOREMAN_RUN: '1', FOREMAN_STORY: 'S-1', FOREMAN_SLOT: 'w1', FOREMAN_SUPERVISOR_PID: '42', PATH: '/usr/bin', ACME_FLAG: 'on' } });
    const { opts } = f.calls[0];
    expect(opts.cwd).toBe(root);
    for (const name of ['FOREMAN_RUN', 'FOREMAN_STORY', 'FOREMAN_SLOT', 'FOREMAN_SUPERVISOR_PID']) expect(opts.env[name], name).toBeUndefined();
    expect(opts.env).toMatchObject({ PATH: '/usr/bin', ACME_FLAG: 'on' });
    expect(opts.timeout).toBe(300_000);
  });

  it('adds the session keys from .env.foreman', () => {
    write(join(root, '.env.foreman'), 'CLAUDE_CODE_OAUTH_TOKEN=acme-oauth-value\n');
    const f = fake(out(LESSON_TRAIT));
    go(f.run);
    expect(f.calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('acme-oauth-value');
  });

  it('leaves the Console key out once the run moved to the subscription', () => {
    const KEY = 'sk-ant-acme-fake-0000000000000000000000';
    write(join(root, '.env.foreman'), `ANTHROPIC_API_KEY=${KEY}\nCLAUDE_CODE_OAUTH_TOKEN=acme-oauth-fake\n`);
    const before = fake(out(LESSON_TRAIT));
    runLearner({ input, config: configWith(), run: before.run, env: {}, root, stateDir: state, now: NOW });
    expect(before.calls[0].opts.env.ANTHROPIC_API_KEY).toBe(KEY);
    useSubscription(state, NOW);
    const after = fake(out(LESSON_TRAIT));
    runLearner({ input, config: configWith(), run: after.run, env: { ANTHROPIC_API_KEY: KEY }, root, stateDir: state, now: NOW });
    const env = after.calls[0].opts.env;
    expect(Object.hasOwn(env, 'ANTHROPIC_API_KEY')).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('acme-oauth-fake');
  });

  it('asks the skill model for the skill after a skill verdict', () => {
    const full = { ...LESSON_SKILL, skill: SKILL };
    const f = fake(out(LESSON_SKILL, 0.01), out(full, 0.2));
    const r = go(f.run);
    expect(f.calls).toHaveLength(2);
    const args = f.calls[1].args;
    expect(flag(args, '--model')).toBe('sonnet');
    expect(flag(args, '-p')).toBe(learnerPrompt(input, 'skill'));
    expect(flag(args, '--max-budget-usd')).toBe('1.99');
    expect(f.calls[1].opts.timeout).toBe(600_000);
    expect(r).toMatchObject({ ok: true, reply: full });
    expect(r.calls.map((c) => [c.model, c.verdict])).toEqual([['haiku', 'skill'], ['sonnet', 'skill']]);
  });

  it('makes one call with skills: false, even after a skill verdict', () => {
    const f = fake(out(LESSON_SKILL), out({ ...LESSON_SKILL, skill: SKILL }));
    const r = runLearner({ input, config: configWith(), spentUsd: 0, run: f.run, env: {}, root, now: NOW, skills: false });
    expect(f.calls).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, reply: LESSON_SKILL });
    expect(r.calls.map((c) => c.model)).toEqual(['haiku']);
  });

  it('makes one call with newSkills: false after a skill verdict', () => {
    const f = fake(out(LESSON_SKILL), out({ ...LESSON_SKILL, skill: SKILL }));
    const r = runLearner({ input, config: configWith(), spentUsd: 0, run: f.run, env: {}, root, now: NOW, newSkills: false });
    expect(f.calls).toHaveLength(1);
    expect(r.ok).toBe(true);
    expect(r.reply.verdict).toBe('skill');
    expect(r.calls.map((c) => c.model)).toEqual(['haiku']);
  });

  it('still asks the skill model with newSkills: false after a merge into a learned skill', () => {
    const merge = { verdict: 'merge', reason: 'Acme.', merge: { id: 'L-2' }, conflicts: [] };
    const f = fake(out(merge), out(merge));
    const r = runLearner({ input: { ...input, skillIds: ['L-2'] }, config: configWith(), spentUsd: 0, run: f.run, env: {}, root, now: NOW, newSkills: false });
    expect(f.calls).toHaveLength(2);
    expect(r.calls.map((c) => c.model)).toEqual(['haiku', 'sonnet']);
  });

  it('asks the skill model after a merge into a learned skill', () => {
    const merge = { verdict: 'merge', reason: 'Acme.', merge: { id: 'L-2' }, conflicts: [] };
    const f = fake(out(merge), out(merge));
    const r = runLearner({ input: { ...input, skillIds: ['L-2'] }, config: configWith(), spentUsd: 0, run: f.run, env: {}, root, now: NOW });
    expect(f.calls).toHaveLength(2);
    expect(r.ok).toBe(true);
  });

  it('refuses a skill-mode reply that gives a trait', () => {
    const f = fake(out(LESSON_SKILL), out(LESSON_TRAIT, 0.2));
    const r = go(f.run);
    expect(f.calls).toHaveLength(2);
    expect(r).toMatchObject({ ok: false, reply: null, error: 'the skill session gave no skill' });
    expect(r.calls[0].error).toBeNull();
    expect(r.calls[1]).toEqual({ model: 'sonnet', costUsd: 0.2, verdict: 'trait', error: 'the skill session gave no skill', tokens: null });
  });

  it('refuses a skill-mode reply that gives none', () => {
    const f = fake(out(LESSON_SKILL), out({ verdict: 'none', reason: 'Acme.', conflicts: [] }));
    const r = go(f.run);
    expect(r).toMatchObject({ ok: false, reply: null, error: 'the skill session gave no skill' });
    expect(r.calls[1].error).toBe('the skill session gave no skill');
  });

  it('refuses a skill-mode merge into a trait item', () => {
    const intoSkill = { verdict: 'merge', reason: 'Acme.', merge: { id: 'L-2' }, conflicts: [] };
    const intoTrait = { verdict: 'merge', reason: 'Acme.', merge: { id: 'L-5', trait: 'Acme: test routes' }, conflicts: [] };
    const f = fake(out(intoSkill), out(intoTrait));
    const r = runLearner({ input: { ...input, skillIds: ['L-2'] }, config: configWith(), spentUsd: 0, run: f.run, env: {}, root, now: NOW });
    expect(f.calls).toHaveLength(2);
    expect(r).toMatchObject({ ok: false, reply: null, error: 'the skill session gave no skill' });
  });

  it('makes one call when the skill model is the trait model and the skill came with it', () => {
    const f = fake(out({ ...LESSON_SKILL, skill: SKILL }));
    const r = go(f.run, { learning: { skillModel: 'haiku' } });
    expect(f.calls).toHaveLength(1);
    expect(r.ok).toBe(true);
  });

  it('never calls once the day budget is spent', () => {
    const f = fake(out(LESSON_TRAIT));
    const r = go(f.run, { spentUsd: 2 });
    expect(f.calls).toHaveLength(0);
    expect(r).toEqual({ ok: false, reply: null, calls: [], error: 'the learning budget for today is spent ($2.00 of $2.00)' });
  });

  it('never calls with a budget of 0', () => {
    const f = fake(out(LESSON_TRAIT));
    const r = go(f.run, { learning: { maxUsdPerDay: 0 } });
    expect(f.calls).toHaveLength(0);
    expect(r.error).toBe('the learning budget for today is spent ($0.00 of $0.00)');
  });

  it('passes what is left of the day budget', () => {
    const f = fake(out(LESSON_TRAIT));
    go(f.run, { spentUsd: 1.5 });
    expect(flag(f.calls[0].args, '--max-budget-usd')).toBe('0.50');
  });

  it('does not make the second call when the first spent the rest', () => {
    const f = fake(out(LESSON_SKILL, 2), out({ ...LESSON_SKILL, skill: SKILL }));
    const r = go(f.run);
    expect(f.calls).toHaveLength(1);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('the learning budget for today is spent ($2.00 of $2.00)');
    expect(r.calls).toEqual([{ model: 'haiku', costUsd: 2, verdict: 'skill', error: null, tokens: null }]);
  });

  it('says the session failed on is_error', () => {
    const f = fake({ status: 1, stdout: JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.3, result: '' }), stderr: '' });
    const r = go(f.run);
    expect(r).toMatchObject({ ok: false, error: 'the learner session failed: error_max_budget_usd' });
    expect(r.calls).toEqual([{ model: 'haiku', costUsd: 0.3, verdict: null, error: 'the learner session failed: error_max_budget_usd', tokens: null }]);
  });

  it('gives the first line of the result when is_error has no subtype', () => {
    const f = fake({ status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `API Error: 401 for ${GHP}\nmore` }), stderr: '' });
    const r = go(f.run);
    expect(r.error).toBe('the learner session failed: API Error: 401 for •••');
  });

  it('says claude is not installed on exit 127', () => {
    const r = go(fake({ status: 127, stdout: '', stderr: 'spawnSync claude ENOENT' }).run);
    expect(r).toMatchObject({ ok: false, error: 'claude is not installed or not on PATH' });
  });

  it('redacts a token in stderr', () => {
    const r = go(fake({ status: 1, stdout: '', stderr: `starting\nlogin failed for ${GHP}` }).run);
    expect(r.error).toBe('the learner session failed: login failed for •••');
    expect(r.error).not.toContain(GHP);
  });

  it('scrubs a project file secret from an is_error result', () => {
    write(join(root, '.env.foreman'), `ACME_DB_PASS=${FILE_SECRET}\n`);
    const f = fake({ status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: `Error: denied for ${FILE_SECRET}\nmore` }), stderr: '' });
    const r = go(f.run);
    expect(r.error).toBe('the learner session failed: Error: denied for •••');
    expect(r.calls[0].error).toBe('the learner session failed: Error: denied for •••');
  });

  it('scrubs a learning.redact entry and a file secret from stderr', () => {
    write(join(root, '.env.foreman'), `ACME_DB_PASS=${FILE_SECRET}\n`);
    const f = fake({ status: 1, stdout: '', stderr: `starting\nconnect to acme-internal-host failed for ${FILE_SECRET}` });
    const r = go(f.run, { learning: { redact: ['acme-internal-host'] } });
    expect(r.error).toBe('the learner session failed: connect to ••• failed for •••');
  });

  it('scrubs before cutting to 200 characters', () => {
    write(join(root, '.env.foreman'), `ACME_DB_PASS=${FILE_SECRET}\n`);
    const r = go(fake({ status: 1, stdout: '', stderr: `${'x'.repeat(190)}${FILE_SECRET}` }).run);
    expect(r.error.startsWith('the learner session failed: ')).toBe(true);
    expect(r.error).not.toContain('acmep');
    expect(r.error.slice(r.error.indexOf('failed: ') + 'failed: '.length).length).toBeLessThanOrEqual(200);
  });

  it('says so when the reply holds no lesson JSON', () => {
    const r = go(fake(out({ note: 'nothing' })).run);
    expect(r).toMatchObject({ ok: false, error: 'the learner gave no lesson JSON' });
    expect(r.calls[0].error).toBe('the learner gave no lesson JSON');
  });
});

describe('learnerInput', () => {
  // A parent repo's GIT_DIR (a hook, a busy shell) must not leak into the temp repo.
  const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(k)));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnv() });
  const commit = (message, files) => {
    for (const [file, text] of Object.entries(files)) write(join(root, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  const candidate = (over = {}) => ({
    key: 'f-0123456789ab',
    source: 'findings',
    role: 'developer',
    cluster: 'Acme routes have tests',
    stories: ['S-1', 'S-2'],
    evidence: [
      { story: 'S-1', stage: 'tester', severity: 'blocker', rule: 'Acme routes have tests', where: 'src/routes.mjs:12', observed: 'no test', fix: 'add one' },
      { story: 'S-2', stage: 'tester', severity: 'major', rule: 'Acme routes have tests', where: 'src/routes.mjs (the handler)', observed: 'no test', fix: 'add one' },
      { story: 'S-2', where: '../outside.mjs' },
      { story: 'S-2', where: '/etc/acme.conf' },
    ],
    ...over,
  });
  const section = (text, name) => text.split(`## ${name}\n`)[1].split('\n## ')[0];

  beforeEach(() => {
    execFileSync('git', ['init', '-q', '-b', 'main', root], { env: gitEnv() });
    git('config', 'user.name', 'Acme');
    git('config', 'user.email', 'dev@acme.example');
    git('config', 'commit.gpgsign', 'false');
    commit('Start', { 'README.md': '# Acme\n', '.gitignore': '.foreman/\n' });
  });

  const build = (c = candidate(), extra = {}) => learnerInput(c, { root, stateDir: state, config: configWith(), env: {}, values: [], home: '/home/acme', ...extra });

  it('includes only the fix diff of the where files from the lesson stories', () => {
    commit('S-1 Fix route', { 'src/routes.mjs': 'export const orders = () => "acme orders";\n' });
    commit('S-2 Other', { 'docs/other.md': 'unrelated acme note\n' });
    commit('S-10 Later', { 'src/routes.mjs': 'export const orders = () => "acme orders v10";\n' });
    const diffs = section(build().text, 'Fix diffs');
    expect(diffs).toMatch(/commit [0-9a-f]+ S-1 Fix route/);
    expect(diffs).toContain('+export const orders = () => "acme orders";');
    expect(diffs).not.toContain('S-2 Other');
    expect(diffs).not.toContain('unrelated acme note');
    expect(diffs).not.toContain('S-10');
  });

  it('cuts the diffs at 20 KB', () => {
    commit('S-1 Big route', { 'src/routes.mjs': `${'// acme filler line\n'.repeat(1600)}` });
    const diffs = section(build().text, 'Fix diffs');
    expect(diffs.trimEnd().endsWith('(cut at 20 KB)')).toBe(true);
    expect(Buffer.byteLength(diffs.replace(/\n*\(cut at 20 KB\)\s*$/, ''))).toBeLessThanOrEqual(20 * 1024);
  });

  it('says (none found) with no where files', () => {
    commit('S-1 Fix route', { 'src/routes.mjs': 'x\n' });
    const text = build(candidate({ evidence: [{ story: 'S-1', rule: 'Acme' }] })).text;
    expect(section(text, 'Fix diffs').trim()).toBe('(none found)');
  });

  it('says (none found) when git fails', () => {
    const text = build(candidate(), { run: () => ({ status: 128, stdout: '', stderr: 'fatal' }) }).text;
    expect(section(text, 'Fix diffs').trim()).toBe('(none found)');
  });

  it('includes the lesson and CLAUDE.md, with secrets blanked', () => {
    write(join(root, 'CLAUDE.md'), `# Acme rules\n\nTests first. Deploy key ${GHP}.\n`);
    const c = candidate();
    c.evidence[0].observed = `the route printed ${GHP}`;
    const text = build(c).text;
    expect(section(text, 'The lesson')).toContain('f-0123456789ab');
    expect(section(text, 'The lesson')).toContain('S-1, S-2');
    expect(section(text, 'The lesson')).toContain('"where": "src/routes.mjs:12"');
    expect(section(text, 'CLAUDE.md')).toContain('Tests first.');
    expect(text).not.toContain(GHP);
  });

  it('says (none) without a CLAUDE.md', () => {
    expect(section(build().text, 'CLAUDE.md').trim()).toBe('(none)');
  });

  it('lists the owner traits, the learned traits and every skill with its description', () => {
    const config = configWith({}, { roles: { builders: { developer: { agent: 'foreman:builder', use: 'everything', traits: ['Acme: keep handlers small'] } } } });
    seedTrait('Acme: every route has a test');
    seedSkill('acme-routes');
    write(join(root, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { 'acme-apex': { source: 'acme/skills' } } }));
    write(join(root, '.claude', 'skills', 'acme-apex', 'SKILL.md'), '---\nname: acme-apex\ndescription: Use when writing Acme Apex classes\n---\n');
    write(join(root, '.claude', 'skills', 'acme-deploy', 'SKILL.md'), "---\nname: acme-deploy\ndescription: 'Use when deploying Acme'\n---\n");
    write(join(root, '.claude', 'skills', 'foreman-learned-stale', 'SKILL.md'), '---\ndescription: Use when stale\n---\n');
    const r = learnerInput(candidate(), { root, stateDir: state, config, env: {}, values: [], home: '/home/acme' });
    const traits = section(r.text, 'Current traits');
    expect(traits).toContain('Acme: keep handlers small');
    expect(traits).toContain('[L-1] developer: Acme: every route has a test');
    const skills = section(r.text, 'Skills');
    expect(skills).toContain('foreman-learned-acme-routes');
    expect(skills).toContain('Use when seeding acme-routes');
    expect(skills).toContain('acme-apex');
    expect(skills).toContain('Use when writing Acme Apex classes');
    expect(skills).toContain('acme-deploy');
    expect(skills).toContain('Use when deploying Acme');
    expect(skills).not.toContain('Use when stale');
    expect(r.skillIds).toEqual(['L-2']);
  });
});

describe('capProblem', () => {
  const caps = (learning = {}) => {
    const ctx = ctxFor(learning);
    return (target = null) => capProblem({ items: ctx.items, ledger: ctx.ledger, learning: ctx.learning, now: NOW, target });
  };

  it('holds back at maxEvaluating items on trial, not one below', () => {
    seedTrait('Acme: architect names the files', 'architect', YESTERDAY);
    expect(caps({ maxEvaluating: 2 })()).toBeNull();
    seedTrait('Acme: tester checks 404s', 'tester', YESTERDAY);
    expect(caps({ maxEvaluating: 2 })()).toBe('2 learned items are already on trial (the most is 2)');
  });

  it('does not count the target of a merge', () => {
    seedTrait('Acme: architect names the files', 'architect', YESTERDAY);
    seedTrait('Acme: tester checks 404s', 'tester', YESTERDAY);
    expect(caps({ maxEvaluating: 2 })('L-2')).toBeNull();
  });

  it('holds back at maxPerDay changes by Foreman today, not one below', () => {
    seedTrait('Acme: architect today', 'architect', TODAY);
    keepItem(state, 'L-1', TODAY);
    expect(caps({ maxPerDay: 2 })()).toBeNull();
    seedTrait('Acme: tester today', 'tester', TODAY);
    keepItem(state, 'L-2', TODAY);
    expect(caps({ maxPerDay: 2 })()).toBe('Foreman already made 2 learned changes today (the most is 2)');
  });
});

describe('learnerSpentToday and recordLearnerCall', () => {
  it('keeps the stories count when given', () => {
    recordLearnerCall(state, { at: '2026-10-24T01:00:00.000Z', key: 'f-0123456789ab', stories: 2, model: 'haiku', costUsd: 0.01, verdict: 'trait', error: null });
    expect(JSON.parse(readFileSync(join(state, 'learner.jsonl'), 'utf8'))).toMatchObject({ key: 'f-0123456789ab', stories: 2 });
  });

  const file = () => join(state, 'learner.jsonl');

  it('sums only the lines of the same UTC day', () => {
    recordLearnerCall(state, { at: '2026-10-24T00:10:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 0.25, verdict: 'trait', error: null });
    recordLearnerCall(state, { at: '2026-10-24T23:50:00.000Z', key: 'f-0123456789ab', model: 'sonnet', costUsd: 0.5, verdict: 'skill', error: null });
    recordLearnerCall(state, { at: '2026-10-23T23:59:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 1, verdict: 'none', error: null });
    expect(learnerSpentToday(state, NOW)).toBe(0.75);
    expect(JSON.parse(readFileSync(file(), 'utf8').split('\n')[0])).toEqual({ at: '2026-10-24T00:10:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 0.25, verdict: 'trait', error: null, tokens: null });
  });

  it('is 0 with no file', () => {
    expect(learnerSpentToday(state, NOW)).toBe(0);
  });

  it('writes the token counts on the line', () => {
    const tokens = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, turns: 3, models: ['claude-haiku-5'] };
    recordLearnerCall(state, { at: '2026-10-24T00:10:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 0.25, verdict: 'trait', error: null, tokens });
    expect(JSON.parse(readFileSync(file(), 'utf8').trim()).tokens).toEqual(tokens);
  });

  it('reads the lines back, skipping a torn one, and [] with no file', () => {
    expect(readLearnerCalls(state)).toEqual([]);
    recordLearnerCall(state, { at: '2026-10-24T01:00:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 0.5, verdict: 'trait', error: null });
    appendFileSync(file(), '{"at":"2026-10-24T02:00:00.000Z","costUsd":9');
    recordLearnerCall(state, { at: '2026-10-24T03:00:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 0.25, verdict: 'none', error: null, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, turns: 1, models: [] } });
    const lines = readLearnerCalls(state);
    expect(lines.map((l) => l.at)).toEqual(['2026-10-24T01:00:00.000Z', '2026-10-24T03:00:00.000Z']);
    expect(lines[1].tokens).toMatchObject({ input: 1 });
  });

  it('skips a torn line and never joins a new line to it', () => {
    recordLearnerCall(state, { at: '2026-10-24T01:00:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 0.5, verdict: 'trait', error: null });
    appendFileSync(file(), '{"at":"2026-10-24T02:00:00.000Z","costUsd":9');
    recordLearnerCall(state, { at: '2026-10-24T03:00:00.000Z', key: 'f-0123456789ab', model: 'haiku', costUsd: 0.25, verdict: 'none', error: null });
    expect(learnerSpentToday(state, NOW)).toBe(0.75);
    expect(readFileSync(file(), 'utf8').trim().split('\n')).toHaveLength(3);
  });
});
