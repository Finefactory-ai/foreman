import { beforeEach, describe, expect, it } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInitCommand } from '../plugin/lib/cli/commands/init.mjs';
import traits from '../plugin/lib/cli/commands/traits.mjs';
import { loadConfig } from '../plugin/lib/config/load.mjs';
import { PACKS } from '../plugin/packs/index.mjs';
import { checkConfig, layout } from '../plugin/packs/salesforce/config.mjs';
import { STEPS, stepById } from '../plugin/lib/setup/steps.mjs';

const text = readFileSync(fileURLToPath(new URL('../plugin/skills/init/SKILL.md', import.meta.url)), 'utf8');

describe('skills/init/SKILL.md', () => {
  const at = (s) => {
    const i = text.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };
  it('is the init skill', () => {
    expect(text).toMatch(/^---\nname: init\ndescription: .+\n---\n/);
  });
  it('drives set-up through the foreman command and the Set up page', () => {
    const commands = [
      'foreman init detect',
      'foreman init write',
      'foreman init write --answers',
      'foreman setup',
      'run_in_background',
      'foreman setup next',
      'foreman setup steps --step project --json',
      'foreman keys set',
      'foreman doctor',
      '/foreman:story',
      '/foreman:run',
    ];
    for (const cmd of commands) expect(text).toContain(cmd);
  });
  it('names only steps the set-up model has', () => {
    const ids = new Set([...text.matchAll(/--step ([a-z0-9-]+)/g), ...text.matchAll(/step `([a-z0-9-]+)`/g)].map((m) => m[1]));
    expect(ids.has('project')).toBe(true);
    expect(ids.has('sf-orgs')).toBe(true);
    for (const id of ids) expect(stepById(id), id).toBeTruthy();
    const titles = STEPS.map((s) => s.title);
    const screens = [...text.matchAll(/Set up › ([^\n]+)/g)].map((m) => m[1]);
    expect(screens.length).toBeGreaterThan(0);
    for (const screen of screens) expect(titles.some((t) => screen.startsWith(t)), screen).toBe(true);
  });
  it('asks one question at a time and never asks for a key', () => {
    expect(text).toMatch(/one question at a time/i);
    expect(text).toMatch(/never ask for the value/i);
    expect(text).not.toMatch(/\.env/);
    expect(text).not.toMatch(/foreman keys set \S+ \S/);
    expect(text).not.toMatch(/(paste|send|give|type|tell)[^.\n]*(key|token|secret|password)[^.\n]*(here|in (the )?chat|to me)/i);
    expect(text).not.toContain('keys migrate');
  });
  it("holds none of the set-up model's own words", () => {
    for (const step of STEPS) {
      expect(text, `${step.id} why`).not.toContain(step.why);
      for (const line of step.guide ?? []) if (typeof line.text === 'string') expect(text, `${step.id} guide`).not.toContain(line.text);
    }
    // The scopes, the callback and the jwt command live in the set-up model (plugin/lib/setup/steps.mjs).
    for (const s of ['read:jira-work', 'offline_access', 'http://localhost:8765/callback', 'sf org login jwt --alias']) expect(text).not.toContain(s);
  });
  it('detects, hands off to the page, falls back to the chat, then runs the doctor', () => {
    const detect = at('foreman init detect');
    const handOff = at('Start `foreman setup`');
    const noBrowser = at('**No browser.**');
    const next = text.indexOf('foreman setup next', noBrowser);
    expect(detect).toBeLessThan(handOff);
    expect(handOff).toBeLessThan(noBrowser);
    expect(next).toBeGreaterThan(noBrowser);
    const doctor = text.lastIndexOf('Run `foreman doctor`');
    expect(doctor).toBeGreaterThan(handOff);
    expect(doctor).toBeGreaterThan(next);
    const answers = text.indexOf('foreman init write --answers', noBrowser);
    expect(answers).toBeGreaterThan(noBrowser);
    expect(answers).toBeLessThan(next);
  });
  it('picks a step from the setup steps output by its id, never by its place', () => {
    // `foreman setup steps --step <id> --json` prints every step; --step only limits the checks.
    expect(text).not.toMatch(/steps\[\d+\]/);
    const project = at('the entry in `steps` whose id is `project`');
    expect(project).toBeGreaterThan(at('foreman setup steps --step project --json'));
    expect(project).toBeLessThan(at('foreman init write'));
    const key = at('the entry in `steps` whose id is <id>');
    expect(key).toBeGreaterThan(at('**No browser.**'));
    expect(key).toBeLessThan(text.indexOf('foreman keys set', at('**No browser.**')));
    expect(text.indexOf("kind: 'key'", key)).toBeGreaterThan(key);
  });
});

describe('skills/init/SKILL.md: packs', () => {
  const at = (s) => {
    const i = text.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };
  it("names the pack, its findings and the pack's own questions, one at a time", () => {
    for (const s of ['found.pack', 'found.packFindings', '## Pack: <name>']) at(s);
    expect(text).toMatch(/pack's own questions,\s+one at a time/);
  });
  it('asks the pack questions after the detection and before the first write', () => {
    const step = at('If `found.pack` is set');
    expect(at('foreman init detect')).toBeLessThan(step);
    expect(step).toBeLessThan(at('foreman init write'));
  });
});

describe('skills/init/SKILL.md: Pack: salesforce', () => {
  const start = text.indexOf('## Pack: salesforce');
  const next = start === -1 ? -1 : text.indexOf('\n## ', start + 1);
  const sf = start === -1 ? '' : text.slice(start, next === -1 ? undefined : next);
  const at = (s) => {
    const i = sf.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };
  it('has its section under Packs', () => {
    expect(start).toBeGreaterThan(text.indexOf('## Packs'));
    expect(text.indexOf('## Packs')).toBeGreaterThan(-1);
  });
  it('asks the eight questions in order, one at a time', () => {
    const labels = [
      '**Sandboxes.**',
      '**Branches.**',
      '**Production deploys.**',
      '**Build sandboxes.**',
      '**Release stages.**',
      '**Production branch.**',
      '**Release path.**',
      '**Where to stop.**',
    ];
    const order = labels.map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sf).toMatch(/one at a time/i);
  });
  it('asks whether anything deploys the single branch to production, after the branches', () => {
    const q = at('Does anything deploy <branch> to production: a CI job, Gearset or another tool?');
    expect(q).toBeGreaterThan(at('**Branches.**'));
    expect(q).toBeLessThan(at('**Build sandboxes.**'));
    expect(sf).toMatch(/this layout needs environment branches/i);
  });
  it('never offers production as a stage or a place to stop', () => {
    at('Never offer production as a stage');
    expect(sf).toMatch(/production is never a target/i);
    expect(sf).not.toMatch(/"name":\s*"prod/i);
    expect(sf).not.toMatch(/stopAt[^\n]*production"/);
  });
  it('asks the conditional questions only when they apply', () => {
    expect(sf).toMatch(/environment-branch layout only/i);
    at('only with environment branches');
    at('more than one stage');
    at('one story at a time');
  });
  it('names every org by its alias and org ID, in the new shape only', () => {
    for (const s of ['00D', 'orgId', 'alias']) at(s);
    expect(sf).toMatch(/15 or 18/);
    expect(sf).not.toContain('pool');
    expect(sf).not.toContain('orgs.qa');
  });
  it('offers the release paths', () => {
    for (const s of ['`sf`', '`ci`', '`gearset`']) at(s);
  });
  it('leaves the keys the pack fills out of the file', () => {
    at('Leave out `ship`, `checks` and `install`');
    at('foreman config show');
  });
  it('keeps only the orgs a step uses', () => {
    expect(sf).toMatch(/keeps only the orgs a step uses/i);
  });
  it('sets slots from the build sandboxes', () => {
    expect(sf).toMatch(/slots[^.]*number of build sandboxes/i);
  });
  it('leaves the Salesforce traits to the pack', () => {
    expect(sf).not.toContain('foreman traits add security');
    expect(sf).not.toContain('WITH USER_MODE');
    expect(sf).toMatch(/the pack brings its own traits/i);
  });
  it('installs the skills after the write and before the doctor', () => {
    const write = text.indexOf('foreman init write');
    const skills = text.indexOf('foreman sf skills');
    expect(write).toBeGreaterThan(-1);
    expect(write).toBeLessThan(skills);
    expect(skills).toBeLessThan(text.lastIndexOf('Run `foreman doctor`'));
    at('skills-lock.json');
    at('.agents/skills');
  });
  it('leaves the org sign-in to the owner, on the sf-orgs step, before the doctor', () => {
    expect(sf).toMatch(/never run `sf org login`/i);
    expect(sf).toMatch(/Foreman's own sf home/);
    at('step `sf-orgs` (Set up › Salesforce org sign-in)');
    at('during the hand-off');
    const guide = text.indexOf('foreman setup steps --step sf-orgs --json');
    expect(guide).toBeGreaterThan(text.indexOf('foreman sf skills'));
    expect(guide).toBeLessThan(text.lastIndexOf('Run `foreman doctor`'));
  });
  it('does the after-write steps in order: pack traits, skills, org sign-in', () => {
    const order = ['**After the write**', '1. The pack brings its own traits', '2. Run `foreman sf skills`', '3. Never log in to an org', 'foreman setup steps --step sf-orgs --json'].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('init write with the Salesforce answers', () => {
  const fixture = fileURLToPath(new URL('./fixtures/acme-sfdx', import.meta.url));
  const init = makeInitCommand({ packs: PACKS });
  let dir;
  let out;
  let err;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-initsf-'));
    fs.cpSync(fixture, dir, { recursive: true });
    out = '';
    err = '';
  });
  const ctx = (stdin) => ({ root: dir, cwd: dir, env: {}, stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, readStdin: () => stdin });
  const configFile = () => path.join(dir, 'foreman.config.json');

  // The suggestion from `foreman init detect`, as the skill sees it.
  async function suggested() {
    expect(await init.run(['detect'], ctx())).toBe(0);
    const { suggested: s, found } = JSON.parse(out);
    expect(found.pack).toBe('salesforce');
    out = '';
    return s;
  }
  // What the section writes: the suggestion without the keys the pack fills, plus the answers.
  const leaveOut = ({ ship, checks, install, roles, ...rest }) => rest;
  // The copied fixture has no workflows, so the pack leaves out ci.
  const COMMON = ['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'pr', 'sf-validate', 'mergeable-recheck', 'merge'];
  // Two build sandboxes, then QA and UAT on their own branches; the last stage, uat, is stopAt.
  const uatAnswers = {
    productionBranch: 'main',
    orgs: {
      'acme-dev1': { orgId: '00D000000000001' },
      'acme-dev2': { orgId: '00D000000000002AAA' },
      'acme-qa': { orgId: '00D000000000003' },
      'acme-uat': { orgId: '00D000000000004' },
    },
    build: ['acme-dev1', 'acme-dev2'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  };
  const write = (config) => init.run(['write'], ctx(JSON.stringify(config)));

  it('writes a config that validates, with the sf/uat steps and PRs into qa', async () => {
    const config = { ...leaveOut(await suggested()), salesforce: uatAnswers, slots: 2 };
    expect(await write(config), err).toBe(0);
    const loaded = loadConfig(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.ship.steps).toEqual([...COMMON, 'sf-deploy-qa', 'sf-verify-qa', 'sf-deploy-uat', 'sf-verify-uat']);
    expect(loaded.config.ship.pr.into).toBe('qa');
    expect(loaded.config.checks[0].run.startsWith('sf project deploy start --dry-run')).toBe(true);
    expect(loaded.config.slots).toBe(2);
  });
  it('writes a Gearset config that keeps the branch after the merge', async () => {
    const config = { ...leaveOut(await suggested()), salesforce: { ...uatAnswers, stopAt: 'qa', release: 'gearset' }, slots: 2 };
    expect(await write(config), err).toBe(0);
    const loaded = loadConfig(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.ship.steps).toEqual(['sf-org-guard', 'merge-main', 'sf-delta', 'push', 'gearset-pr', 'sf-validate', 'gearset-promote-qa']);
    expect(loaded.config.ship.merge.keepBranch).toBe(true);
  });
  it("refuses a config that keeps the suggestion's ship, which would merge into production", async () => {
    const s = await suggested();
    const { ship } = s;
    const config = { ...leaveOut(s), ship, salesforce: uatAnswers, slots: 2 };
    expect(await write(config)).toBe(1);
    expect(err).toContain('salesforce.productionBranch: pull requests would merge into main');
    expect(fs.existsSync(configFile())).toBe(false);
  });
  it('refuses answers that would reach production or name no org ID', async () => {
    const base = leaveOut(await suggested());
    const cases = [
      [{ ...uatAnswers, stopAt: 'production' }, /salesforce\.stopAt: must name a stage \(qa, uat\); production is never a target/],
      [{ ...uatAnswers, orgs: { ...uatAnswers.orgs, prod: { orgId: '00D000000000005' } } }, /salesforce\.orgs\.prod: .*production is never a target/],
      [{ ...uatAnswers, orgs: { ...uatAnswers.orgs, 'acme-qa': {} } }, /salesforce\.orgs\.acme-qa\.orgId: required: every org is identified by its org ID/],
      [{ ...uatAnswers, orgs: { ...uatAnswers.orgs, 'acme-spare': { orgId: '00D000000000005' } } }, /salesforce\.orgs\.acme-spare: no step uses acme-spare/],
    ];
    for (const [salesforce, message] of cases) {
      err = '';
      expect(await write({ ...base, salesforce })).toBe(1);
      expect(err).toMatch(message);
      expect(fs.existsSync(configFile())).toBe(false);
    }
  });
  // Every good write: the file passes the pack's own check and the loader, and holds none of
  // the keys the pack fills.
  const readWritten = () => {
    const file = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    expect(checkConfig(file.salesforce, file)).toEqual([]);
    const loaded = loadConfig(dir);
    expect(loaded.errors).toEqual([]);
    for (const key of ['ship', 'checks', 'install', 'roles']) expect(file).not.toHaveProperty(key);
    return { file, loaded };
  };
  // (a) One sandbox builds and takes the dev releases, on one branch.
  const exampleA = {
    orgs: { 'acme-dev1': { orgId: '00D000000000001' } },
    build: 'acme-dev1',
    stages: [{ name: 'dev', org: 'acme-dev1' }],
  };
  // (b) One build sandbox, then QA and UAT on their own branches.
  const exampleB = {
    productionBranch: 'main',
    orgs: {
      'acme-dev1': { orgId: '00D000000000001' },
      'acme-qa': { orgId: '00D000000000002' },
      'acme-uat': { orgId: '00D000000000003' },
    },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }, { name: 'uat', org: 'acme-uat', branch: 'uat' }],
  };
  // (c) Two build sandboxes and one QA stage, on one branch.
  const exampleC = {
    orgs: {
      'acme-dev1': { orgId: '00D000000000001' },
      'acme-dev2': { orgId: '00D000000000002' },
      'acme-qa': { orgId: '00D000000000003' },
    },
    build: ['acme-dev1', 'acme-dev2'],
    stages: [{ name: 'qa', org: 'acme-qa' }],
  };

  it('writes example (a): one sandbox that builds and takes the releases, on main', async () => {
    expect(await write({ ...leaveOut(await suggested()), salesforce: exampleA }), err).toBe(0);
    const { file, loaded } = readWritten();
    expect(loaded.config.ship.steps).toEqual([...COMMON, 'sf-deploy-dev', 'sf-verify-dev']);
    expect(layout(file.salesforce, file).prInto).toBe('main');
    expect(loaded.config.slots).toBe(1);
  });
  it('writes example (b): QA and UAT on environment branches', async () => {
    expect(await write({ ...leaveOut(await suggested()), salesforce: exampleB }), err).toBe(0);
    const { loaded } = readWritten();
    expect(loaded.config.ship.steps).toEqual([...COMMON, 'sf-deploy-qa', 'sf-verify-qa', 'sf-deploy-uat', 'sf-verify-uat']);
    expect(loaded.config.ship.pr.into).toBe('qa');
    expect(loaded.config.ship.merge.keepBranch).toBe(true);
  });
  it('writes example (c): two build sandboxes and a QA stage, on main', async () => {
    expect(await write({ ...leaveOut(await suggested()), salesforce: exampleC, slots: 2 }), err).toBe(0);
    const { file, loaded } = readWritten();
    expect(loaded.config.ship.steps).toEqual([...COMMON, 'sf-deploy-qa', 'sf-verify-qa']);
    expect(layout(file.salesforce, file).prInto).toBe('main');
    expect(loaded.config.slots).toBe(2);
  });
  it("writes the skill's own JSON sample", async () => {
    // Detect, then write the sample, as the skill does.
    await suggested();
    const start = text.indexOf('## Pack: salesforce');
    const next = text.indexOf('\n## ', start + 1);
    const sf = text.slice(start, next === -1 ? undefined : next);
    const samples = [...sf.matchAll(/```json\n([\s\S]*?)\n```/g)];
    expect(samples).toHaveLength(1);
    const sample = JSON.parse(samples[0][1]);
    for (const key of ['ship', 'checks', 'install', 'roles']) expect(sample).not.toHaveProperty(key);
    expect(await write(sample), err).toBe(0);
    readWritten();
  });
  it('refuses the answers the questions refuse', async () => {
    const base = leaveOut(await suggested());
    const cases = [
      [{ ...exampleA }, 2, /stages\[0\]\.org: acme-dev1 is a build org/],
      [{ ...exampleA, stages: [{ name: 'production', org: 'acme-dev1' }] }, undefined, /stages\[0\]\.name: .*production is never a target/],
      [{ ...exampleA, release: 'gearset' }, undefined, /stages\[0\]\.branch: required for release "gearset"/],
      [(({ productionBranch, ...rest }) => rest)(exampleB), undefined, /productionBranch: required when a stage has its own branch/],
    ];
    for (const [salesforce, slots, message] of cases) {
      err = '';
      expect(await write({ ...base, salesforce, ...(slots === undefined ? {} : { slots }) })).toBe(1);
      expect(err).toMatch(message);
      expect(fs.existsSync(configFile())).toBe(false);
    }
  });
  it("adds a trait for a configured role after a good write, and refuses a role the config doesn't name", async () => {
    expect(await write({ ...leaveOut(await suggested()), salesforce: uatAnswers, slots: 2 }), err).toBe(0);
    const stderr = { write: (s) => (err += s) };
    const trait = 'Apex classes are declared with sharing, unless a comment in the class says why not.';
    expect(await traits.run(['add', 'security', trait], { root: dir, stderr }), err).toBe(0);
    expect(fs.readFileSync(path.join(dir, '.claude/foreman/traits/security.md'), 'utf8')).toContain(trait);
    expect(await traits.run(['add', 'production', 'Deploy on Fridays.'], { root: dir, stderr })).toBe(1);
    expect(err).toContain('unknown role production');
  });
});
