import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESIGN_FILE, PLAN_FILE, designText, planStaleness, readPlanFile, sessionPlan, shortPlan, stampPlan, writePlanFiles } from './plan-file.mjs';
import { markSession } from './session-files.mjs';
import { DEFAULTS } from '../config/defaults.mjs';
import { markedSession } from '../../../test/session-fixture.mjs';

const PLAN = {
  ready: true,
  blocker: '',
  needs_owner: false,
  builder: 'developer',
  resources: ['db'],
  files: ['src/acme.mjs'],
  design: 'Change acme.mjs.\nKeep the rest.',
  test_plan: 'acme.test.mjs proves it.',
  done_when: 'npm test passes',
  owner_question: { summary: 's', options: [], recommend: 'a' },
};

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-plan-file-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('shortPlan', () => {
  it('keeps only the short fields, in order', () => {
    const short = shortPlan(PLAN);
    expect(short).toEqual({ ready: true, builder: 'developer', resources: ['db'], files: ['src/acme.mjs'], done_when: 'npm test passes' });
    expect(Object.keys(short)).toEqual(['ready', 'builder', 'resources', 'files', 'done_when']);
  });

  it('gives {} for a plan with none of them', () => {
    expect(shortPlan({ design: 'd' })).toEqual({});
  });

  it('leaves out a field the plan does not have', () => {
    expect(Object.hasOwn(shortPlan({ ready: true, builder: 'developer' }), 'files')).toBe(false);
  });
});

describe('a plan with an approach', () => {
  const rethought = { ...PLAN, approach: 'Fail closed on anything not proven.' };
  it('keeps approach in the short plan, last', () => {
    expect(shortPlan(rethought).approach).toBe('Fail closed on anything not proven.');
    expect(Object.keys(shortPlan(rethought)).at(-1)).toBe('approach');
    expect(Object.hasOwn(shortPlan(PLAN), 'approach')).toBe(false);
  });
  it('starts the design text with the approach, and leaves a plan without one as it was', () => {
    expect(designText(rethought).startsWith('## Approach\nFail closed on anything not proven.\n\n## Design\n')).toBe(true);
    expect(designText({ ...PLAN, approach: '  ' })).toBe(designText(PLAN));
    expect(designText({ ...PLAN, approach: 3 })).toBe(designText(PLAN));
  });
});

describe('designText', () => {
  it('renders the design, the test plan and the done-when line', () => {
    expect(designText(PLAN)).toBe('## Design\nChange acme.mjs.\nKeep the rest.\n\n## Test plan\nacme.test.mjs proves it.\n\n## Done when\nnpm test passes\n');
  });

  it('renders missing parts as empty', () => {
    expect(designText({})).toBe('## Design\n\n\n## Test plan\n\n\n## Done when\n\n');
  });
});

describe('PLAN_FILE and DESIGN_FILE', () => {
  it('sit in <dir>/plans, named by the id', () => {
    expect(PLAN_FILE(dir, 'S-1')).toBe(join(dir, 'plans', 'S-1.json'));
    expect(DESIGN_FILE(dir, 'S-1')).toBe(join(dir, 'plans', 'S-1.md'));
  });

  it('keep an id like ../x inside the plans folder', () => {
    expect(PLAN_FILE(dir, '../x')).toBe(join(dir, 'plans', 'x.json'));
    expect(DESIGN_FILE(dir, '..')).toBe(join(dir, 'plans', 'none.md'));
  });
});

describe('writePlanFiles', () => {
  it('creates the plans folder and writes both files', () => {
    const { planFile, designFile } = writePlanFiles(dir, 'S-1', PLAN);
    expect(planFile).toBe(PLAN_FILE(dir, 'S-1'));
    expect(designFile).toBe(DESIGN_FILE(dir, 'S-1'));
    expect(JSON.parse(readFileSync(planFile, 'utf8'))).toEqual(PLAN);
    expect(readFileSync(planFile, 'utf8')).toBe(`${JSON.stringify(PLAN, null, 2)}\n`);
    expect(readFileSync(designFile, 'utf8')).toBe(designText(PLAN));
  });

  it('replaces the files a second time', () => {
    writePlanFiles(dir, 'S-1', PLAN);
    writePlanFiles(dir, 'S-1', { ...PLAN, design: 'Second.' });
    expect(readFileSync(DESIGN_FILE(dir, 'S-1'), 'utf8')).toContain('Second.');
  });
});

describe('sessionPlan', () => {
  const roles = DEFAULTS.roles;
  const arch = (label, output, over = {}) => ({ label, phase: 'Architect', agentType: 'foreman:architect', output, ...over });
  const ask = (id = 'S-1') => sessionPlan({ dir, slot: 'w1', id, roles });

  it('gives the architect plan of the slot session', () => {
    markedSession(dir, { agents: [arch('architect:S-1', PLAN)] });
    expect(ask()).toEqual({ plan: PLAN });
  });

  it('gives the later of two architect answers', () => {
    markedSession(dir, { agents: [arch('architect:S-1', { ...PLAN, design: 'first' }), arch('architect:S-1', { ...PLAN, design: 'second' })] });
    expect(ask().plan.design).toBe('second');
  });

  it("ignores another story's label", () => {
    markedSession(dir, { agents: [arch('architect:S-2', PLAN)] });
    expect(ask().reason).toMatch(/no ready architect plan for S-1/);
  });

  it('ignores a transcript whose phase is not Architect', () => {
    markedSession(dir, { agents: [arch('architect:S-1', PLAN, { phase: 'Build' })] });
    expect(ask().reason).toMatch(/no ready architect plan/);
  });

  it('gives a reason for a plan that is not ready', () => {
    markedSession(dir, { agents: [arch('architect:S-1', { ...PLAN, ready: false })] });
    expect(ask().reason).toMatch(/no ready architect plan/);
  });

  it('gives a reason for an architect that never answered', () => {
    markedSession(dir, { agents: [arch('architect:S-1', null)] });
    expect(ask().reason).toMatch(/no ready architect plan/);
  });

  it('gives a reason when the slot has no mark', () => {
    expect(ask()).toEqual({ reason: 'no story session in this slot' });
  });

  it("names the other story when the slot's mark is for it", () => {
    markedSession(dir, { story: 'S-2', agents: [arch('architect:S-2', PLAN)] });
    expect(ask().reason).toBe("this slot's session is for S-2");
  });

  it('gives a reason when the mark names a log that is not there', () => {
    markSession(dir, 'w1', { story: 'S-1', pid: 1, log: join(dir, 'logs', 'none.log'), projects: join(dir, 'projects') });
    expect(ask()).toEqual({ reason: 'no story session in this slot' });
  });

  it('gives a reason, and never throws, when the transcripts cannot be read', () => {
    markedSession(dir, { agents: [arch('architect:S-1', PLAN)] });
    const read = () => {
      throw new Error('EIO');
    };
    expect(sessionPlan({ dir, slot: 'w1', id: 'S-1', roles, read })).toEqual({ reason: 'its transcripts could not be read' });
  });
});

// A repository whose origin/main is a plain ref, so no remote is needed.
describe('a saved plan and the base it was written against', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=acme@example.com', '-c', 'user.name=Acme', ...args], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const commit = (file, text, message) => {
    writeFileSync(join(dir, file), text);
    git('add', '.');
    git('commit', '-qm', message);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return git('rev-parse', 'HEAD');
  };
  const opts = () => ({ cwd: dir, remote: 'origin', base: 'main' });
  let first;
  beforeEach(() => {
    mkdirSync(join(dir, 'src'));
    git('init', '-q');
    first = commit('src/acme.mjs', 'export const a = 1;\n', 'first');
  });

  it('readPlanFile gives the saved plan, or null when there is none or it is not an object', () => {
    expect(readPlanFile(dir, 'S-1')).toBeNull();
    writePlanFiles(dir, 'S-1', PLAN);
    expect(readPlanFile(dir, 'S-1')).toEqual(PLAN);
    writeFileSync(PLAN_FILE(dir, 'S-2'), '[1]');
    expect(readPlanFile(dir, 'S-2')).toBeNull();
  });

  it('stampPlan records the base commit and the time once, and leaves a stamped plan alone', () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    const stamped = stampPlan(PLAN, { ...opts(), now });
    expect(stamped).toEqual({ ...PLAN, baseCommit: first, plannedAt: '2026-11-09T12:00:00.000Z' });
    expect(stampPlan(stamped, { ...opts(), now: new Date() })).toBe(stamped);
    expect(stampPlan(PLAN, { cwd: dir, remote: 'nowhere', base: 'main', now })).toBe(PLAN);
  });

  it('a stamped plan is fresh until one of its files changes on the base', () => {
    const plan = stampPlan(PLAN, opts());
    expect(planStaleness(plan, opts())).toEqual({ fresh: true });
    commit('README.md', 'other\n', 'unrelated');
    expect(planStaleness(plan, opts())).toEqual({ fresh: true });
    commit('src/acme.mjs', 'export const a = 2;\n', 'the file the plan names');
    expect(planStaleness(plan, opts())).toEqual({ fresh: false, reason: '1 of its files changed on origin/main since it was written: src/acme.mjs' });
  });

  it('a plan without a base commit, or with one this repository lacks, is stale', () => {
    expect(planStaleness(PLAN, opts())).toEqual({ fresh: false, reason: 'it records no base commit' });
    const unknown = { ...PLAN, baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
    expect(planStaleness(unknown, opts()).reason).toBe('its base commit deadbeefde is not in this repository');
  });

  it('a plan that names no files is fresh while its base commit is known', () => {
    const plan = stampPlan({ ...PLAN, files: [] }, opts());
    commit('src/acme.mjs', 'export const a = 3;\n', 'change');
    expect(planStaleness(plan, opts())).toEqual({ fresh: true });
  });
});
