import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKPOINT, clearCheckpoint, entryKey, mergeCheckpoint, readCheckpoint, redoneWork, resumePoint, stageOutputs, structuredOutput, worktreeTree, writeCheckpoint } from './checkpoint.mjs';

const ID = 'ACME-1';
const at = (min) => new Date(Date.UTC(2026, 9, 29, 10, 0, 0) + min * 60_000).toISOString();
const line = (event) => JSON.stringify(event);
let uses = 0;

// One agent's transcript: a first line at `from`, its usage, then (when `output` is given) the
// StructuredOutput call and its result at `to`.
function transcript({ from, to, output, tokens = 100, result = 'ok' }) {
  const id = `tu-${++uses}`;
  const lines = [
    line({ type: 'user', timestamp: at(from), message: { role: 'user', content: 'Build it.' } }),
    line({ type: 'assistant', timestamp: at(from), message: { id: `m-${id}`, model: 'claude-opus-5-5', usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'working' }] } }),
  ];
  if (output !== undefined) {
    lines.push(line({ type: 'assistant', timestamp: at(to), message: { id: `n-${id}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'StructuredOutput', id, input: output }] } }));
    if (result === 'ok') lines.push(line({ type: 'user', timestamp: at(to), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'Structured output provided successfully' }] } }));
    if (result === 'error') lines.push(line({ type: 'user', timestamp: at(to), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'Output does not match the schema' }] } }));
  } else {
    lines.push(line({ type: 'assistant', timestamp: at(to), message: { id: `n-${id}`, content: [{ type: 'text', text: 'still going' }] } }));
  }
  return `${lines.join('\n')}\n`;
}

// The default config's roles (config/defaults.mjs): each label's agent and phase follow them.
const ROLES = {
  architect: { agent: 'foreman:architect' },
  builders: { developer: { agent: 'foreman:builder' } },
  tester: { agent: 'foreman:tester' },
  reviewers: [
    { name: 'compliance', agent: 'foreman:compliance-reviewer' },
    { name: 'security', agent: 'foreman:security-reviewer' },
  ],
};
const REVIEWERS = ROLES.reviewers.map((r) => r.name);
const PHASE = { architect: 'Architect', build: 'Build', fix: 'Build', test: 'Test' };
const AGENT = { architect: ROLES.architect.agent, build: ROLES.builders.developer.agent, fix: ROLES.builders.developer.agent, test: ROLES.tester.agent, ...Object.fromEntries(ROLES.reviewers.map((r) => [r.name, r.agent])) };
// `meta` overrides the transcript's agentType or workflowPhase (undefined removes it).
const sub = (label, opts, meta = {}) => {
  const name = label.slice(0, label.indexOf(':'));
  const m = { agentType: AGENT[name] ?? `foreman:${name}-reviewer`, description: label, workflowPhase: PHASE[name] ?? 'Review', ...meta };
  for (const key of Object.keys(m)) if (m[key] === undefined) delete m[key];
  return { meta: m, text: transcript(opts) };
};

const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: ['src/acme.mjs'], design: 'Change acme.mjs.', test_plan: 'acme.test.mjs', done_when: 'npm test' };
const BUILT = { complete: true, summary: 'Built it.', files: ['src/acme.mjs'], commands: [], problem: '' };
const minor = { severity: 'minor', rule: 'naming', where: 'src/acme.mjs:1', observed: 'x', fix: 'y' };
const major = { ...minor, severity: 'major' };
const OK = (findings = []) => ({ approved: true, findings, checked: 'ran it' });

// A session stopped in review: the tester and security approved, compliance had not answered.
const inReview = () => [
  sub(`architect:${ID}`, { from: 0, to: 5, output: PLAN }),
  sub(`build:${ID}`, { from: 5, to: 30, output: BUILT, tokens: 5000 }),
  sub(`test:${ID}#1`, { from: 30, to: 40, output: OK([minor]) }),
  sub(`compliance:${ID}#1`, { from: 40, to: 55, tokens: 700 }),
  sub(`security:${ID}#1`, { from: 41, to: 50, output: OK() }),
];
const checkpointOf = (subs, tree = 'T1') => mergeCheckpoint(null, { story: ID, entries: stageOutputs(subs, ID, ROLES), tree, at: at(60) });
// The entryKey of the entry with this label first seen at minute `min`.
const keyOf = (label, min) => entryKey({ label, at: at(min) });
const PLAN_ONLY = { plan: PLAN, resume: null, kept: [`architect:${ID}`], keys: [keyOf(`architect:${ID}`, 0)] };
const NONE = { plan: null, resume: null, kept: [], keys: [] };

describe('structuredOutput', () => {
  it('takes the last call that succeeded', () => {
    const text = transcript({ from: 0, to: 1, output: { n: 1 } }) + transcript({ from: 2, to: 3, output: { n: 2 } });
    expect(structuredOutput(text)).toEqual({ n: 2 });
  });
  it('ignores a call whose result is an error', () => {
    const text = transcript({ from: 0, to: 1, output: { n: 1 } }) + transcript({ from: 2, to: 3, output: { n: 2 }, result: 'error' });
    expect(structuredOutput(text)).toEqual({ n: 1 });
    expect(structuredOutput(transcript({ from: 2, to: 3, output: { n: 2 }, result: 'error' }))).toBeNull();
  });
  it('is null with no call, or a call with no result (an agent killed mid-answer)', () => {
    expect(structuredOutput(transcript({ from: 0, to: 1 }))).toBeNull();
    expect(structuredOutput(transcript({ from: 0, to: 1, output: { n: 1 }, result: 'none' }))).toBeNull();
    expect(structuredOutput('')).toBeNull();
    expect(structuredOutput(undefined)).toBeNull();
  });
  it('skips torn lines', () => {
    const text = transcript({ from: 0, to: 1, output: { n: 1 } });
    expect(structuredOutput(`{"type":"assistant","mess\nnot json\n${text}{"type":"user","message":{"content":[{"type":"tool_res`)).toEqual({ n: 1 });
  });
});

describe('stageOutputs', () => {
  it('maps each pipeline label to its role and name, sorted by first timestamp', () => {
    const subs = [
      sub(`fix:${ID}#1`, { from: 60, to: 70, output: BUILT }),
      sub(`architect:${ID}`, { from: 0, to: 5, output: PLAN }),
      sub(`security:${ID}#1`, { from: 41, to: 50, output: OK() }),
      sub(`build:${ID}`, { from: 5, to: 30, output: BUILT }),
      sub(`test:${ID}#1`, { from: 30, to: 40, output: OK() }),
    ];
    const out = stageOutputs(subs, ID, ROLES);
    expect(out.map((e) => [e.label, e.role, e.name, e.round])).toEqual([
      [`architect:${ID}`, 'architect', 'architect', null],
      [`build:${ID}`, 'builder', 'build', 1],
      [`test:${ID}#1`, 'tester', 'test', 1],
      [`security:${ID}#1`, 'reviewer', 'security', 1],
      [`fix:${ID}#1`, 'builder', 'fix', 1],
    ]);
    expect(out[0].output).toEqual(PLAN);
  });
  it("drops another story's agents and agents that are not the pipeline's", () => {
    const subs = [
      sub(`architect:${ID}`, { from: 0, to: 5, output: PLAN }),
      sub('architect:ACME-12', { from: 1, to: 5, output: PLAN }),
      sub('test:ACME-12#1', { from: 1, to: 5, output: OK() }),
      { meta: { agentType: 'Explore' }, text: transcript({ from: 2, to: 3 }) },
      { meta: {}, text: transcript({ from: 2, to: 3 }) },
    ];
    expect(stageOutputs(subs, ID, ROLES).map((e) => e.label)).toEqual([`architect:${ID}`]);
    expect(stageOutputs(undefined, ID, ROLES)).toEqual([]);
  });
  it('takes at, endAt and tokens from the lines', () => {
    const [e] = stageOutputs([sub(`build:${ID}`, { from: 5, to: 30, output: BUILT, tokens: 5000 })], ID, ROLES);
    expect(e).toMatchObject({ at: at(5), endAt: at(30), tokens: 5000, output: BUILT });
  });
  it('drops a transcript whose phase or agent does not match its role', () => {
    const refused = [
      sub(`security:${ID}#1`, { from: 41, to: 50, output: OK() }, { agentType: 'foreman:builder' }), // a builder posing as a reviewer
      sub(`security:${ID}#1`, { from: 41, to: 50, output: OK() }, { workflowPhase: 'Build' }),
      sub(`test:${ID}#1`, { from: 30, to: 40, output: OK() }, { workflowPhase: undefined }),
      sub(`compliance:${ID}#1`, { from: 40, to: 55, output: OK() }, { agentType: 'foreman:security-reviewer' }),
      sub(`a11y:${ID}#1`, { from: 40, to: 55, output: OK() }), // a reviewer that is not configured
      sub(`architect:${ID}`, { from: 0, to: 5, output: PLAN }, { agentType: 'Explore' }),
    ];
    for (const s of refused) expect(stageOutputs([s], ID, ROLES), JSON.stringify(s.meta)).toEqual([]);
  });
  it('accepts the configured agent with or without its prefix, or as foreman:<name>', () => {
    const labels = (subs, roles = ROLES) => stageOutputs(subs, ID, roles).map((e) => e.label);
    expect(labels([sub(`build:${ID}`, { from: 5, to: 30, output: BUILT }, { agentType: 'builder' })])).toEqual([`build:${ID}`]);
    expect(labels([sub(`build:${ID}`, { from: 5, to: 30, output: BUILT }, { agentType: 'foreman:builder' })])).toEqual([`build:${ID}`]);
    const acme = { ...ROLES, builders: { developer: { agent: 'acme:builder' } } };
    expect(labels([sub(`fix:${ID}#1`, { from: 5, to: 30, output: BUILT }, { agentType: 'acme:builder' })], acme)).toEqual([`fix:${ID}#1`]);
    expect(labels([sub(`fix:${ID}#1`, { from: 5, to: 30, output: BUILT }, { agentType: 'acme:tester' })], acme)).toEqual([]);
  });
  it('gives [] without the roles', () => {
    expect(stageOutputs(inReview(), ID)).toEqual([]);
    expect(stageOutputs(inReview(), ID, null)).toEqual([]);
    expect(stageOutputs(inReview(), ID, 'roles')).toEqual([]);
  });
});

describe('resumePoint', () => {
  it('after a stop in review, gives the plan, the build and the approved tester and reviewer', () => {
    const point = resumePoint(checkpointOf(inReview()), { tree: 'T1', reviewers: REVIEWERS });
    expect(point.plan).toEqual(PLAN);
    expect(point.resume).toEqual({ build: { summary: 'Built it.', files: ['src/acme.mjs'] }, verdicts: { tester: { findings: [minor] }, security: { findings: [] } } });
    expect(point.kept).toEqual([`architect:${ID}`, `build:${ID}`, `test:${ID}#1`, `security:${ID}#1`]);
  });
  it('trusts no tester with a major finding', () => {
    const subs = inReview();
    subs[2] = sub(`test:${ID}#1`, { from: 30, to: 40, output: { approved: true, findings: [major], checked: 'x' } });
    const point = resumePoint(checkpointOf(subs), { tree: 'T1', reviewers: REVIEWERS });
    expect(point.resume).toEqual({ build: { summary: 'Built it.', files: ['src/acme.mjs'] }, verdicts: {} });
    expect(point.kept).toEqual([`architect:${ID}`, `build:${ID}`]);
  });
  it('carries no reviewer without the tester', () => {
    const subs = inReview();
    subs[2] = sub(`test:${ID}#1`, { from: 30, to: 40 });
    const point = resumePoint(checkpointOf(subs), { tree: 'T1', reviewers: REVIEWERS });
    expect(point.resume.verdicts).toEqual({});
    expect(point.kept).toEqual([`architect:${ID}`, `build:${ID}`]);
  });
  it('takes a fix that started after the approvals, without them, or only the plan when the fix gave nothing', () => {
    const rejected = [...inReview().slice(0, 3), sub(`security:${ID}#1`, { from: 41, to: 50, output: { approved: false, findings: [major], checked: 'x' } })];
    const fixed = resumePoint(checkpointOf([...rejected, sub(`fix:${ID}#1`, { from: 51, to: 59, output: { ...BUILT, summary: 'Fixed it.' } })]), { tree: 'T1', reviewers: REVIEWERS });
    expect(fixed.resume).toEqual({ build: { summary: 'Fixed it.', files: ['src/acme.mjs'] }, verdicts: {} });
    expect(fixed.kept).toEqual([`architect:${ID}`, `fix:${ID}#1`]);
    const killed = resumePoint(checkpointOf([...rejected, sub(`fix:${ID}#1`, { from: 51, to: 59 })]), { tree: 'T1', reviewers: REVIEWERS });
    expect(killed).toEqual(PLAN_ONLY);
  });
  it('gives no resume for a build that is not complete', () => {
    const subs = inReview();
    subs[1] = sub(`build:${ID}`, { from: 5, to: 30, output: { ...BUILT, complete: false, problem: 'red' } });
    expect(resumePoint(checkpointOf(subs), { tree: 'T1', reviewers: REVIEWERS })).toEqual(PLAN_ONLY);
  });
  it('gives only the plan when the tree changed or is unknown', () => {
    const cp = checkpointOf(inReview());
    expect(resumePoint(cp, { tree: 'T2', reviewers: REVIEWERS })).toEqual(PLAN_ONLY);
    expect(resumePoint(cp, { tree: null, reviewers: REVIEWERS })).toEqual(PLAN_ONLY);
    expect(resumePoint(checkpointOf(inReview(), null), { tree: null, reviewers: REVIEWERS })).toEqual(PLAN_ONLY);
  });
  it('gives no plan for an architect that was not ready', () => {
    const subs = inReview();
    subs[0] = sub(`architect:${ID}`, { from: 0, to: 5, output: { ...PLAN, ready: false, blocker: 'ACME-2' } });
    expect(resumePoint(checkpointOf(subs), { tree: 'T1', reviewers: REVIEWERS })).toEqual(NONE);
    expect(resumePoint(null, { tree: 'T1', reviewers: REVIEWERS })).toEqual(NONE);
  });
});

describe('resumePoint and refused transcripts', () => {
  it('carries no tester approval from a transcript with the wrong agent', () => {
    const subs = inReview();
    subs[2] = sub(`test:${ID}#1`, { from: 30, to: 40, output: OK([minor]) }, { agentType: 'foreman:builder' });
    const point = resumePoint(checkpointOf(subs), { tree: 'T1', reviewers: REVIEWERS });
    expect(point.resume.verdicts).toEqual({});
    expect(point.kept).toEqual([`architect:${ID}`, `build:${ID}`]);
  });
});

describe('resumePoint and the tree of each entry', () => {
  // Session 1: the plan, the build and an approved tester, ending at T1.
  const session1 = () => checkpointOf(inReview().slice(0, 3), 'T1');
  const then = (cp, subs, tree) => mergeCheckpoint(cp, { story: ID, entries: stageOutputs(subs, ID, ROLES), tree, at: at(200) });

  it("stamps each session's new entries with its own tree", () => {
    const cp = then(session1(), [sub(`security:${ID}#1`, { from: 70, to: 80, output: OK() })], 'T2');
    expect(cp.entries.map((e) => [e.label, e.tree])).toEqual([
      [`architect:${ID}`, 'T1'],
      [`build:${ID}`, 'T1'],
      [`test:${ID}#1`, 'T1'],
      [`security:${ID}#1`, 'T2'],
    ]);
  });
  it('gives only the plan when the last build was on another tree', () => {
    const cp = then(session1(), [sub(`security:${ID}#1`, { from: 70, to: 80, output: OK() })], 'T2');
    expect(resumePoint(cp, { tree: 'T2', reviewers: REVIEWERS })).toEqual(PLAN_ONLY);
    expect(resumePoint(cp, { tree: 'T1', reviewers: REVIEWERS })).toEqual(PLAN_ONLY);
  });
  it("takes a later session's fix and its tester, not the approval of the first build", () => {
    const cp = then(session1(), [sub(`fix:${ID}#1`, { from: 70, to: 80, output: { ...BUILT, summary: 'Fixed it.' } }), sub(`test:${ID}#2`, { from: 80, to: 90, output: OK() })], 'T2');
    const point = resumePoint(cp, { tree: 'T2', reviewers: REVIEWERS });
    expect(point.resume).toEqual({ build: { summary: 'Fixed it.', files: ['src/acme.mjs'] }, verdicts: { tester: { findings: [] } } });
    expect(point.kept).toEqual([`architect:${ID}`, `fix:${ID}#1`, `test:${ID}#2`]);
  });
  it('carries no tester approval given on another tree after the build', () => {
    // Session 2 approved at T2; session 3 went back to T1 with a security approval.
    const two = then(checkpointOf(inReview().slice(0, 2), 'T1'), [sub(`test:${ID}#1`, { from: 70, to: 80, output: OK() })], 'T2');
    const three = mergeCheckpoint(two, { story: ID, entries: stageOutputs([sub(`security:${ID}#1`, { from: 90, to: 95, output: OK() })], ID, ROLES), tree: 'T1', at: at(300) });
    const point = resumePoint(three, { tree: 'T1', reviewers: REVIEWERS });
    expect(point.resume.verdicts).toEqual({});
    expect(point.kept).toEqual([`architect:${ID}`, `build:${ID}`]);
  });
  it('gives only the plan for entries with no tree (an older file)', () => {
    const cp = session1();
    const old = { ...cp, entries: cp.entries.map(({ tree, ...rest }) => rest) };
    expect(old.tree).toBe('T1');
    expect(resumePoint(old, { tree: 'T1', reviewers: REVIEWERS })).toEqual(PLAN_ONLY);
  });
  it('gives the entryKey of each kept entry as keys', () => {
    const cp = checkpointOf(inReview());
    const point = resumePoint(cp, { tree: 'T1', reviewers: REVIEWERS });
    expect(point.keys).toEqual(point.kept.map((label) => entryKey(cp.entries.find((e) => e.label === label))));
    expect(point.keys).toEqual([keyOf(`architect:${ID}`, 0), keyOf(`build:${ID}`, 5), keyOf(`test:${ID}#1`, 30), keyOf(`security:${ID}#1`, 41)]);
  });
});

describe('mergeCheckpoint', () => {
  it("adds to the same story's entries, keeping only what a resume needs", () => {
    const first = checkpointOf(inReview().slice(0, 2));
    const second = mergeCheckpoint(first, { story: ID, entries: stageOutputs(inReview().slice(2), ID, ROLES), tree: 'T9', at: at(90) });
    expect(second).toMatchObject({ story: ID, tree: 'T9', at: at(90) });
    expect(second.entries.map((e) => e.label)).toEqual([`architect:${ID}`, `build:${ID}`, `test:${ID}#1`, `compliance:${ID}#1`, `security:${ID}#1`]);
    expect(Object.keys(second.entries[0]).sort()).toEqual(['at', 'label', 'name', 'output', 'role', 'round', 'tree']);
  });
  it("drops another story's entries", () => {
    const other = mergeCheckpoint(null, { story: 'ACME-2', entries: stageOutputs([sub('architect:ACME-2', { from: 0, to: 5, output: PLAN })], 'ACME-2', ROLES), tree: 'T1', at: at(1) });
    const cp = mergeCheckpoint(other, { story: ID, entries: [], tree: 'T1', at: at(2) });
    expect(cp).toEqual({ story: ID, tree: 'T1', at: at(2), entries: [] });
  });
  it("keeps the first session's tester approval and adds the second session's security approval", () => {
    const first = checkpointOf([...inReview().slice(0, 3), sub(`security:${ID}#1`, { from: 41, to: 50 }), sub(`compliance:${ID}#1`, { from: 41, to: 50 })]);
    expect(resumePoint(first, { tree: 'T1', reviewers: REVIEWERS }).resume.verdicts).toEqual({ tester: { findings: [minor] } });
    const second = mergeCheckpoint(first, { story: ID, entries: stageOutputs([sub(`security:${ID}#1`, { from: 70, to: 80, output: OK([minor]) }), sub(`compliance:${ID}#1`, { from: 70, to: 85 })], ID, ROLES), tree: 'T1', at: at(90) });
    const point = resumePoint(second, { tree: 'T1', reviewers: REVIEWERS });
    expect(point.resume.verdicts).toEqual({ tester: { findings: [minor] }, security: { findings: [minor] } });
    expect(point.kept).toEqual([`architect:${ID}`, `build:${ID}`, `test:${ID}#1`, `security:${ID}#1`]);
  });
});

describe('redoneWork', () => {
  it('sums the tokens and minutes of the entries not kept', () => {
    const entries = stageOutputs(inReview(), ID, ROLES);
    const { keys } = resumePoint(checkpointOf(inReview()), { tree: 'T1', reviewers: REVIEWERS });
    // Only compliance is redone: 700 tokens over 15 minutes.
    expect(redoneWork(entries, keys)).toEqual({ tokens: 700, minutes: 15 });
    expect(redoneWork(entries, [])).toEqual({ tokens: 5000 + 700 + 300, minutes: 5 + 25 + 10 + 15 + 9 });
    expect(redoneWork([], [])).toEqual({ tokens: 0, minutes: 0 });
  });
  it('counts a redone entry whose label repeats an earlier kept one', () => {
    // A resumed pipeline starts again at round 1: two `test:<id>#1`, only the first kept.
    const entries = stageOutputs([sub(`test:${ID}#1`, { from: 30, to: 40, output: OK(), tokens: 300 }), sub(`test:${ID}#1`, { from: 130, to: 145, output: OK(), tokens: 300 })], ID, ROLES);
    expect(redoneWork(entries, [entryKey(entries[0])])).toEqual({ tokens: 300, minutes: 15 });
    expect(entryKey({ label: 'x' })).toBe(JSON.stringify(['x', null]));
  });
});

describe('the checkpoint file', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-checkpoint-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is written, read and cleared by story, under a safe name', () => {
    expect(CHECKPOINT(dir, 'ACME-1/../x')).toBe(join(dir, 'checkpoints', 'ACME-1..x.json'));
    expect(readCheckpoint(dir, ID)).toBeNull();
    const cp = checkpointOf(inReview());
    writeCheckpoint(dir, cp);
    expect(readCheckpoint(dir, ID)).toEqual(cp);
    clearCheckpoint(dir, ID);
    expect(readCheckpoint(dir, ID)).toBeNull();
    clearCheckpoint(dir, ID);
  });
  it('reads a bad file as none', () => {
    mkdirSync(join(dir, 'checkpoints'));
    writeFileSync(CHECKPOINT(dir, ID), '{not json');
    expect(readCheckpoint(dir, ID)).toBeNull();
    writeFileSync(CHECKPOINT(dir, ID), '[1]');
    expect(readCheckpoint(dir, ID)).toBeNull();
  });
});

describe('worktreeTree', () => {
  let dir;
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(k)));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-tree-'));
    spawnSync('git', ['init', '-q'], { cwd: dir, env });
    git('config', 'user.email', 'acme@example.com');
    git('config', 'user.name', 'Acme');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'acme.mjs'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'first');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const GEN = [{ path: 'gen/**', regenerate: 'npm run gen' }];

  it('gives the same sha for the same content and a new one for an untracked file', () => {
    const a = worktreeTree(dir, GEN);
    expect(a).toMatch(/^[0-9a-f]{40,64}$/);
    expect(worktreeTree(dir, GEN)).toBe(a);
    writeFileSync(join(dir, 'src', 'new.mjs'), 'x\n');
    const b = worktreeTree(dir, GEN);
    expect(b).not.toBe(a);
    writeFileSync(join(dir, 'src', 'acme.mjs'), 'export const a = 2;\n');
    expect(worktreeTree(dir, GEN)).not.toBe(b);
  });
  it('ignores a change to a generated path', () => {
    const a = worktreeTree(dir, GEN);
    mkdirSync(join(dir, 'gen'));
    writeFileSync(join(dir, 'gen', 'types.ts'), 'x\n');
    expect(worktreeTree(dir, GEN)).toBe(a);
    expect(worktreeTree(dir, [])).not.toBe(a);
  });
  it('leaves the real index untouched', () => {
    writeFileSync(join(dir, 'src', 'new.mjs'), 'x\n');
    writeFileSync(join(dir, 'src', 'acme.mjs'), 'export const a = 3;\n');
    const before = git('status', '--porcelain');
    const index = readFileSync(join(dir, '.git', 'index'));
    expect(worktreeTree(dir, GEN)).toBeTruthy();
    expect(git('status', '--porcelain')).toBe(before);
    expect(readFileSync(join(dir, '.git', 'index')).equals(index)).toBe(true);
  });
  it('is null outside a repo', () => {
    const plain = mkdtempSync(join(tmpdir(), 'foreman-plain-'));
    try {
      expect(worktreeTree(plain, GEN)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
