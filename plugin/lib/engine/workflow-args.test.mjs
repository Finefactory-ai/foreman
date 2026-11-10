import { describe, it, expect } from 'vitest';
import { workflowArgs } from './workflow-args.mjs';
import { runWorkflow } from '../../../test/workflow-harness.mjs';
import { withDefaults } from '../config/defaults.mjs';

const config = withDefaults({
  version: 1,
  project: { name: 'T' },
  checks: [{ run: 'npm test', when: 'always' }],
  resources: { db: { paths: ['db/**'], describe: 'database schema' } },
  roles: { tester: { agent: 'foreman:tester', traits: ['x'] } },
});
const story = { id: 'S-1', title: 'Add it', group: '2', groupName: 'Accounts' };

describe('workflowArgs', () => {
  const args = workflowArgs({ story, briefPath: '/p/S-1.md', groupLabel: 'Phase', config, traits: { tester: 'T' }, holds: ['db'] });

  it('shapes the args', () => {
    expect(args.story).toEqual({ id: 'S-1', title: 'Add it', brief: '/p/S-1.md', group: '2', groupName: 'Accounts', groupLabel: 'Phase' });
    expect(args.rounds).toBe(config.rounds);
    expect(args.resources).toEqual({ db: 'database schema' });
    expect(args.checks).toEqual(config.checks);
    expect(args.holds).toEqual(['db']);
    expect(args.traits).toEqual({ tester: 'T' });
    expect(JSON.stringify(args.roles)).not.toContain('traits');
    expect(args.plan).toBeUndefined();
  });

  it('names the base the story branched from, as <remote>/<base>', () => {
    expect(args.base).toBe('origin/main');
    const other = withDefaults({ ...config, remote: 'up', baseBranch: 'trunk' });
    expect(workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config: other }).base).toBe('up/trunk');
  });

  it('adds plan, startAt and findings only when given', () => {
    const a = workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config, traits: {}, holds: [], plan: { p: 1 }, startAt: 'fix', findings: [{ f: 1 }] });
    expect(a).toMatchObject({ plan: { p: 1 }, startAt: 'fix', findings: [{ f: 1 }] });
  });

  it('adds designFile only when given, after plan and before startAt, with resume last', () => {
    expect(Object.hasOwn(args, 'designFile')).toBe(false);
    const resume = { build: { summary: 's', files: ['a'] } };
    const a = workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config, plan: { ready: true }, designFile: '/state/plans/S-1.md', startAt: 'fix', findings: [{ f: 1 }], resume });
    expect(a.designFile).toBe('/state/plans/S-1.md');
    const keys = Object.keys(a);
    expect(keys.indexOf('designFile')).toBe(keys.indexOf('plan') + 1);
    expect(keys.indexOf('startAt')).toBe(keys.indexOf('designFile') + 1);
    expect(keys.at(-1)).toBe('resume');
  });

  it('adds earlier only when it is a non-empty list, and rethink when given, both before resume', () => {
    const one = [{ stage: 'security', severity: 'major', rule: 'r', where: 'src/acme.mjs:1', observed: 'o', fix: 'f' }];
    for (const earlier of [undefined, []]) expect(Object.hasOwn(workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config, earlier }), 'earlier')).toBe(false);
    expect(Object.hasOwn(args, 'rethink')).toBe(false);
    const rethink = { round: 2, findings: one };
    const resume = { build: { summary: 's', files: ['a'] } };
    const a = workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config, earlier: one, rethink, resume });
    expect(a.earlier).toEqual(one);
    expect(a.rethink).toEqual(rethink);
    expect(Object.keys(a).at(-1)).toBe('resume');
  });

  it('adds resume only when given', () => {
    expect(Object.hasOwn(args, 'resume')).toBe(false);
    const resume = { build: { summary: 's', files: ['a'] }, verdicts: { tester: { findings: [] } } };
    const a = workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config, plan: { p: 1 }, resume });
    expect(a.resume).toEqual(resume);
    expect(Object.keys(a).at(-1)).toBe('resume');
  });

  it("carries each role's model through, with the traits still stripped", () => {
    const withModels = withDefaults({
      version: 1,
      project: { name: 'Acme' },
      roles: {
        tester: { agent: 'foreman:tester', model: 'haiku', traits: ['x'] },
        reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer', model: 'sonnet', traits: ['y'] }, { name: 'security', agent: 'foreman:security-reviewer' }],
      },
    });
    const a = workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config: withModels });
    expect(a.roles.tester).toEqual({ agent: 'foreman:tester', model: 'haiku' });
    expect(a.roles.reviewers[0]).toEqual({ name: 'compliance', agent: 'foreman:compliance-reviewer', model: 'sonnet' });
    expect(Object.hasOwn(a.roles.reviewers[1], 'model')).toBe(false);
    expect(Object.hasOwn(a.roles.architect, 'model')).toBe(false);
    expect(Object.hasOwn(a.roles.builders.developer, 'model')).toBe(false);
    expect(JSON.stringify(a.roles)).not.toContain('traits');
  });

  it('carries fullChecks on a builder and quick on a check through', () => {
    const quick = withDefaults({
      version: 1,
      project: { name: 'Acme' },
      checks: [{ run: 'npm test', when: 'always', quick: 'npm test -- --changed' }],
      roles: { builders: { developer: { agent: 'foreman:builder', use: 'everything', fullChecks: true, traits: ['x'] } } },
    });
    const a = workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config: quick });
    expect(a.roles.builders.developer.fullChecks).toBe(true);
    expect(a.checks).toEqual([{ run: 'npm test', when: 'always', quick: 'npm test -- --changed' }]);
    expect(JSON.stringify(a.roles)).not.toContain('traits');
    expect(Object.hasOwn(args.roles.builders.developer, 'fullChecks')).toBe(false);
  });

  it('always says whether the slot holds the plan\'s files, false unless told', () => {
    expect(args.filesHeld).toBe(false);
    expect(workflowArgs({ story, briefPath: 'b', groupLabel: 'G', config, filesHeld: true }).filesHeld).toBe(true);
  });

  it('is accepted by the workflow', async () => {
    const plan = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], design: 'd', test_plan: 't', done_when: 'ok' };
    const built = { complete: true, summary: 's', files: [], commands: [], problem: '' };
    const ok = { approved: true, findings: [], checked: 'x' };
    const { result } = await runWorkflow(args, { 'architect:': plan, 'build:': built, 'test:': ok, 'compliance:': ok, 'security:': ok });
    expect(result.status).toBe('passed');
  });
});
