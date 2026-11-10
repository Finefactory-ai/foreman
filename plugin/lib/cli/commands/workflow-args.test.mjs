import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../main.mjs';
import { RESOURCE, forceSet } from '../../engine/locks.mjs';
import { FILE_LOCK } from '../../engine/file-locks.mjs';
import { readSlot, startStory } from '../../engine/state.mjs';
import { addItem } from '../../engine/learning-store.mjs';
import { worktreeTree, writeCheckpoint } from '../../engine/checkpoint.mjs';
import { shortPlan } from '../../engine/plan-file.mjs';
import { writeEngineDown } from '../../engine/review-engine.mjs';
import { runWorkflow } from '../../../../test/workflow-harness.mjs';
import { markedSession } from '../../../../test/session-fixture.mjs';

const BIN = fileURLToPath(new URL('../../../bin/foreman', import.meta.url));

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-wa-'));
  fs.mkdirSync(path.join(dir, 'stories'));
  fs.writeFileSync(path.join(dir, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: Add it\ngroup: 2\ngroup_name: Accounts\n---\nbody\n');
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'T' },
      checks: [{ run: 'npm test', when: 'always' }],
      resources: { db: { paths: ['db/**'], describe: 'the db' }, cache: { paths: ['c/**'], describe: 'the cache' } },
      stories: { adapter: 'markdown', dir: 'stories', groupLabel: 'Phase' },
      roles: { tester: { agent: 'foreman:tester', traits: ['be strict'] } },
    }),
  );
});

async function run(argv, env = {}, { owner = false } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: owner ? { FOREMAN_PROJECT_DIR: dir, ...env } : { FOREMAN_PROJECT_DIR: dir, FOREMAN_SLOT: 'w1', ...env },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

// The owner's own command (no FOREMAN_SLOT): the owner's controls refuse from a story session.
const asOwner = (argv) => run(argv, {}, { owner: true });

const FULL = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: [], design: 'Change acme.mjs.', test_plan: 'acme.test.mjs', done_when: 'npm test' };

describe('foreman workflow-args', () => {
  it('passes the rounds in effect, the local settings layer included, read fresh each time', async () => {
    expect(JSON.parse((await run(['workflow-args', 'S-1'])).out).rounds).toBe(3);
    fs.mkdirSync(path.join(dir, '.foreman'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.foreman', 'settings.json'), JSON.stringify({ rounds: 5 }));
    expect(JSON.parse((await run(['workflow-args', 'S-1'])).out).rounds).toBe(5);
  });

  it('prints one line of args with holds, brief, groupLabel and traits', async () => {
    forceSet(RESOURCE(path.join(dir, '.foreman'), 'db'), { pid: process.pid, slot: 'w1', story: 'S-1' });
    forceSet(RESOURCE(path.join(dir, '.foreman'), 'cache'), { pid: process.pid, slot: 'w2', story: 'S-2' });
    const { code, out } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    const a = JSON.parse(out);
    expect(a.holds).toEqual(['db']);
    expect(a.story).toMatchObject({ id: 'S-1', brief: path.join(dir, 'stories', 'S-1.md'), groupLabel: 'Phase', group: '2', groupName: 'Accounts' });
    expect(a.traits).toEqual({ tester: 'be strict' });
    expect(a.roles.tester).toEqual({ agent: 'foreman:tester' });
    expect(a.resources).toEqual({ db: 'the db', cache: 'the cache' });
  });

  it('reads --plan, --start-at and --findings', async () => {
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(FULL));
    fs.writeFileSync(path.join(dir, 'f.json'), '[{"rule":"r"}]');
    const { code, out } = await run(['workflow-args', 'S-1', '--plan', 'plan.json', '--start-at', 'fix', '--findings', 'f.json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ plan: shortPlan(FULL), startAt: 'fix', findings: [{ rule: 'r' }] });
  });

  describe('--plan', () => {
    const state = () => path.join(dir, '.foreman');
    const withDesign = (design) => fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ ...FULL, design }));

    it('gives the short plan and the path of a design file, and saves both files', async () => {
      withDesign('Change acme.mjs only.\nKeep the rest.');
      const { code, out } = await run(['workflow-args', 'S-1', '--plan', 'plan.json']);
      expect(code).toBe(0);
      const a = JSON.parse(out);
      expect(a.plan).toEqual(shortPlan(FULL));
      expect(a.designFile).toBe(path.join(state(), 'plans', 'S-1.md'));
      const md = fs.readFileSync(a.designFile, 'utf8');
      expect(md).toContain('## Design\nChange acme.mjs only.\nKeep the rest.');
      expect(md).toContain('## Test plan\nacme.test.mjs');
      expect(JSON.parse(fs.readFileSync(path.join(state(), 'plans', 'S-1.json'), 'utf8'))).toEqual({ ...FULL, design: 'Change acme.mjs only.\nKeep the rest.' });
      expect(out).not.toContain('Change acme.mjs only');
    });

    it('prints args of the same length whatever the length of the design', async () => {
      withDesign('x');
      // The first design leaves a progress note on the story, which moves the brief to the merged
      // copy in the state folder; measure from the second run on, when the path is settled.
      await run(['workflow-args', 'S-1', '--plan', 'plan.json']);
      const small = (await run(['workflow-args', 'S-1', '--plan', 'plan.json'])).out;
      withDesign('y'.repeat(30_000));
      const big = (await run(['workflow-args', 'S-1', '--plan', 'plan.json'])).out;
      expect(big.length).toBe(small.length);
      expect(fs.readFileSync(path.join(state(), 'plans', 'S-1.md'), 'utf8')).toContain('y'.repeat(30_000));
    });

    it('prints no plan and no designFile without one, and writes no plan files', async () => {
      const a = JSON.parse((await run(['workflow-args', 'S-1'])).out);
      expect(Object.hasOwn(a, 'plan')).toBe(false);
      expect(Object.hasOwn(a, 'designFile')).toBe(false);
      expect(fs.existsSync(path.join(state(), 'plans'))).toBe(false);
    });
  });

  describe('filesHeld', () => {
    const state = () => path.join(dir, '.foreman');
    const hold = (file, slot) => forceSet(FILE_LOCK(state(), file), { pid: process.pid, slot, story: slot === 'w1' ? 'S-1' : 'S-2', by: 'factory', at: 'x', path: file });
    const plan = (files) => fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ ...FULL, files }));
    // Under the supervisor: FOREMAN_SUPERVISOR_PID names a live process that owns the locks.
    const held = async (argv = ['--plan', 'plan.json']) => JSON.parse((await run(['workflow-args', 'S-1', ...argv], { FOREMAN_SUPERVISOR_PID: String(process.pid) })).out).filesHeld;

    it('is false without a plan', async () => {
      hold('src/a.mjs', 'w1');
      expect(await held([])).toBe(false);
    });

    it('is true when this slot holds every claimable file of the plan', async () => {
      plan(['./src/a.mjs', `${dir}/src/b.mjs`, 'CHANGELOG.md']);
      hold('src/a.mjs', 'w1');
      expect(await held()).toBe(false);
      hold('src/b.mjs', 'w1');
      expect(await held()).toBe(true);
    });

    it('is false when another slot holds one of them', async () => {
      plan(['src/a.mjs', 'src/b.mjs']);
      hold('src/a.mjs', 'w1');
      hold('src/b.mjs', 'w2');
      expect(await held()).toBe(false);
    });

    it('is true by hand (no FOREMAN_* env) once lock files has claimed them, though the lock pid has exited', () => {
      plan(['src/a.mjs', 'src/b.mjs']);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FOREMAN_') && !k.startsWith('FACTORY_')));
      const foreman = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
      const lock = foreman('lock', 'files', 'S-1', '--plan', 'plan.json');
      expect(lock.status, lock.stderr).toBe(0);
      // The lock names the CLI process's pid, which has exited, so the lock is stale at once.
      expect(fs.existsSync(FILE_LOCK(state(), 'src/a.mjs'))).toBe(true);
      const wa = foreman('workflow-args', 'S-1', '--plan', 'plan.json');
      expect(wa.status, wa.stderr).toBe(0);
      expect(JSON.parse(wa.stdout).filesHeld).toBe(true);
    });

    // By hand: `run` sets no FOREMAN_SUPERVISOR_PID.
    const byHand = async () => JSON.parse((await run(['workflow-args', 'S-1', '--plan', 'plan.json'])).out).filesHeld;
    const exited = (file, slot, story) => forceSet(FILE_LOCK(state(), file), { pid: 999999, slot, story, by: 'factory', at: 'x', path: file });

    it('is false by hand when lock files never ran', async () => {
      plan(['src/a.mjs']);
      expect(await byHand()).toBe(false);
    });

    it('is false by hand when a lock names another slot or another story', async () => {
      plan(['src/a.mjs']);
      exited('src/a.mjs', 'w2', 'S-1');
      expect(await byHand()).toBe(false);
      exited('src/a.mjs', 'w1', 'S-2');
      expect(await byHand()).toBe(false);
      exited('src/a.mjs', 'w1', 'S-1');
      expect(await byHand()).toBe(true);
    });

    it('is true by hand when the plan claims no files', async () => {
      plan([]);
      expect(await byHand()).toBe(true);
    });

    it('is false under the supervisor when the lock holder has exited', async () => {
      plan(['src/a.mjs']);
      forceSet(FILE_LOCK(state(), 'src/a.mjs'), { pid: 999999, slot: 'w1', story: 'S-1', by: 'factory', at: 'x', path: 'src/a.mjs' });
      expect(await held()).toBe(false);
    });

    it('is still false by hand without --plan', async () => {
      plan(['src/a.mjs']);
      expect(JSON.parse((await run(['workflow-args', 'S-1'])).out).filesHeld).toBe(false);
    });

    it('is true when every file is ignored or generated, or there are none', async () => {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'foreman.config.json'), 'utf8'));
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ ...cfg, generated: [{ path: 'gen/a.ts', regenerate: 'npm run gen' }], fileLocks: { ignore: ['docs/**'] } }));
      plan(['gen/a.ts', 'docs/x.md']);
      expect(await held()).toBe(true);
      plan([]);
      expect(await held()).toBe(true);
    });
  });

  it('exits 1 for an unknown story and for trait errors', async () => {
    expect((await run(['workflow-args', 'S-9'])).code).toBe(1);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'foreman.config.json'), 'utf8'));
    cfg.roles.tester.traits = ['nope.md'];
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(cfg));
    const r = await run(['workflow-args', 'S-1']);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toContain('nope.md');
  });
});

describe('foreman workflow-args after a stop with a checkpoint', () => {
  const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], files: ['src/a.mjs'], design: 'd', test_plan: 't', done_when: 'w' };
  const BUILT = { complete: true, summary: 'Built it.', files: ['src/a.mjs'], commands: [], problem: '' };
  const minor = { severity: 'minor', rule: 'r', where: 'src/a.mjs:1', observed: 'o', fix: 'f' };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  };
  const entry = (label, role, name, round, min, output) => ({ label, role, name, round, at: new Date(Date.UTC(2026, 9, 29, 10, min)).toISOString(), output });
  // One session's entries, each with the tree it ended on, as mergeCheckpoint writes them.
  const checkpoint = (tree) =>
    writeCheckpoint(path.join(dir, '.foreman'), {
      story: 'S-1',
      tree,
      at: '2026-10-29T11:00:00.000Z',
      entries: [
        entry('architect:S-1', 'architect', 'architect', null, 0, PLAN),
        entry('build:S-1', 'builder', 'build', 1, 5, BUILT),
        entry('test:S-1#1', 'tester', 'test', 1, 30, { approved: true, findings: [minor], checked: 'c' }),
        entry('security:S-1#1', 'reviewer', 'security', 1, 40, null),
      ].map((e) => ({ ...e, tree })),
    });
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.foreman/\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
    spawnSync('git', ['init', '-q'], { cwd: dir, env });
    git('-c', 'user.email=acme@example.com', '-c', 'user.name=Acme', 'add', '.');
    git('-c', 'user.email=acme@example.com', '-c', 'user.name=Acme', 'commit', '-qm', 'first');
  });

  it('carries the plan and the finished stages, with a note on stderr and one line on stdout', async () => {
    checkpoint(worktreeTree(dir, []));
    // By hand, filesHeld needs the plan's files claimed for this slot and story.
    forceSet(FILE_LOCK(path.join(dir, '.foreman'), 'src/a.mjs'), { pid: 999999, slot: 'w1', story: 'S-1', by: 'factory', at: 'x', path: 'src/a.mjs' });
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code, err).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    const a = JSON.parse(out);
    expect(a.plan).toEqual(shortPlan(PLAN));
    expect(fs.readFileSync(a.designFile, 'utf8')).toContain('## Design\nd\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.foreman', 'plans', 'S-1.json'), 'utf8'))).toEqual(PLAN);
    expect(a.resume).toEqual({ build: { summary: 'Built it.', files: ['src/a.mjs'] }, verdicts: { tester: { findings: [minor] } } });
    expect(a.filesHeld).toBe(true);
    expect(err).toContain('resuming S-1 from its last finished stages: architect:S-1, build:S-1, test:S-1#1\n');
  });

  it('carries only the plan once a file has changed', async () => {
    checkpoint(worktreeTree(dir, []));
    fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 2;\n');
    const { code, out } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    const a = JSON.parse(out);
    expect(a.plan).toEqual(shortPlan(PLAN));
    expect(Object.hasOwn(a, 'resume')).toBe(false);
  });

  it('takes a --plan file over the checkpoint plan, still with the resume', async () => {
    checkpoint(worktreeTree(dir, []));
    fs.writeFileSync(path.join(dir, '.foreman', 'plan.json'), JSON.stringify({ ...PLAN, design: 'from the file' }));
    const a = JSON.parse((await run(['workflow-args', 'S-1', '--plan', '.foreman/plan.json'])).out);
    expect(fs.readFileSync(a.designFile, 'utf8')).toContain('from the file');
    expect(a.resume.build.summary).toBe('Built it.');
  });

  it('ignores the checkpoint with --start-at fix', async () => {
    checkpoint(worktreeTree(dir, []));
    fs.writeFileSync(path.join(dir, '.foreman', 'plan.json'), JSON.stringify(PLAN));
    fs.writeFileSync(path.join(dir, '.foreman', 'f.json'), '[{"rule":"r"}]');
    const { code, out, err } = await run(['workflow-args', 'S-1', '--plan', '.foreman/plan.json', '--start-at', 'fix', '--findings', '.foreman/f.json']);
    expect(code).toBe(0);
    const a = JSON.parse(out);
    expect(a.plan).toEqual(shortPlan(PLAN));
    expect(Object.hasOwn(a, 'resume')).toBe(false);
    expect(err).not.toContain('resuming');
  });

  it('prints the args as before with no checkpoint', async () => {
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    const a = JSON.parse(out);
    expect(Object.hasOwn(a, 'plan')).toBe(false);
    expect(Object.hasOwn(a, 'resume')).toBe(false);
    expect(a.filesHeld).toBe(false);
    expect(err).not.toContain('resuming');
  });
});

describe('foreman workflow-args --save-plan', () => {
  const state = () => path.join(dir, '.foreman');
  const PLAN = { ...FULL, files: ['src/a.mjs'], design: 'Change a.mjs.' };
  const architect = (output = PLAN) => ({ label: 'architect:S-1', phase: 'Architect', agentType: 'foreman:architect', output });

  it("saves the architect's own answer from the session's transcripts and prints the path", async () => {
    markedSession(state(), { agents: [architect()] });
    const { code, out, err } = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(code, err).toBe(0);
    const file = path.join(state(), 'plans', 'S-1.json');
    expect(out).toBe(`${file}\n`);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(PLAN);
    expect(fs.readFileSync(path.join(state(), 'plans', 'S-1.md'), 'utf8')).toContain('Change a.mjs.');
  });

  it('records the design on the story once: one progress line, none for the same plan again, stdout unchanged', async () => {
    markedSession(state(), { agents: [architect()] });
    const overlay = () => {
      const file = path.join(state(), 'stories', 'S-1.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.text) : [];
    };
    const first = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(first.out).toBe(`${path.join(state(), 'plans', 'S-1.json')}\n`);
    expect(first.err).toBe('');
    expect(overlay()).toEqual(['Design: The architect chose the developer builder, whose work is: everything.']);
    const again = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(again.out).toBe(first.out);
    expect(overlay()).toHaveLength(1);
  });

  it('records no design on the story with jiraComments off', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'foreman.config.json'), 'utf8')), features: { jiraComments: false } }));
    markedSession(state(), { agents: [architect()] });
    const { code } = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(state(), 'stories', 'S-1.json'))).toBe(false);
  });

  it('a plan given to the args (--plan) is recorded as the design too, once', async () => {
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(PLAN));
    await run(['workflow-args', 'S-1', '--plan', 'plan.json']);
    await run(['workflow-args', 'S-1', '--plan', 'plan.json']);
    const notes = JSON.parse(fs.readFileSync(path.join(state(), 'stories', 'S-1.json'), 'utf8')).notes;
    expect(notes.map((n) => n.text.split(':')[0])).toEqual(['Design']);
  });

  it('builds no args and notes nothing learned', async () => {
    startStory(state(), { id: 'S-1', title: 'Add it' }, new Date(), 'w1');
    markedSession(state(), { agents: [architect()] });
    const { out } = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(out).not.toContain('{');
    expect(readSlot(state(), 'w1').story.learned).toBeUndefined();
  });

  it('exits 1 with one line naming the plan file when the slot has no session', async () => {
    const { code, out, err } = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err.trim().split('\n')).toHaveLength(1);
    expect(err).toContain(path.join(state(), 'plans', 'S-1.json'));
    expect(err).toContain('write');
    expect(err).toContain('no story session in this slot');
    expect(fs.existsSync(path.join(state(), 'plans'))).toBe(false);
  });

  it('exits 1 when the session has no ready architect plan for the story', async () => {
    markedSession(state(), { agents: [architect({ ...PLAN, ready: false })] });
    const { code, err } = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(code).toBe(1);
    expect(err).toContain('no ready architect plan for S-1');
  });

  it('exits 1 with one line naming the plan file when the plan files cannot be written', async () => {
    markedSession(state(), { agents: [architect()] });
    // A file where the plans folder belongs: mkdir fails for every user, root included.
    fs.writeFileSync(path.join(state(), 'plans'), '');
    const { code, out, err } = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err.trim().split('\n')).toHaveLength(1);
    expect(err).toContain('workflow-args: ');
    expect(err).toContain(path.join(state(), 'plans', 'S-1.json'));
    expect(err).toContain('as JSON yourself');
    expect(fs.statSync(path.join(state(), 'plans')).isFile()).toBe(true);
  });

  it.each([
    ['--plan', 'x'],
    ['--start-at', 'fix'],
    ['--findings', 'x'],
  ])('refuses --save-plan with %s', async (...extra) => {
    const { code, out, err } = await run(['workflow-args', 'S-1', '--save-plan', ...extra]);
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toContain('usage: foreman workflow-args <id> [--plan <file>]');
    expect(err).toContain('foreman workflow-args <id> --save-plan');
  });

  it('reads the config before it looks at the session', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{"version":');
    const { code, out } = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(code).toBe(1);
    expect(out).toBe('');
  });
});

describe('a relaunch after deferred, end to end', () => {
  const state = () => path.join(dir, '.foreman');
  const PLAN = { ...FULL, files: ['src/a.mjs'], design: 'Change a.mjs only.' };
  const BUILT = { complete: true, summary: 'Built it.', files: ['src/a.mjs'], commands: [], problem: '' };
  const OK = { approved: true, findings: [], checked: 'ran it' };

  it('saves the plan from the architect answer, holds the files, and runs without the architect', async () => {
    // 1. The first launch: the architect plans, the files are not claimed.
    const first = JSON.parse((await run(['workflow-args', 'S-1'])).out);
    const launched = await runWorkflow(first, { 'architect:': PLAN });
    expect(launched.result).toMatchObject({ status: 'deferred', plan: PLAN, files: ['src/a.mjs'] });

    // 2. The session saves the plan from the architect's own answer.
    markedSession(state(), { agents: [{ label: 'architect:S-1', phase: 'Architect', agentType: 'foreman:architect', output: launched.result.plan }] });
    const saved = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(saved.code, saved.err).toBe(0);
    const planFile = saved.out.trim();

    // 3. The files are claimed, and the relaunch's args carry no design text.
    forceSet(FILE_LOCK(state(), 'src/a.mjs'), { pid: process.pid, slot: 'w1', story: 'S-1', by: 'factory', at: 'x', path: 'src/a.mjs' });
    const again = await run(['workflow-args', 'S-1', '--plan', planFile]);
    expect(again.code, again.err).toBe(0);
    const args = JSON.parse(again.out);
    expect(args.filesHeld).toBe(true);
    expect(again.out).not.toContain('Change a.mjs only.');
    expect(args.designFile).toBe(path.join(state(), 'plans', 'S-1.md'));

    // 4. The pipeline runs with no architect scripted: an unscripted label throws.
    const { result, calls } = await runWorkflow(args, { 'build:': BUILT, 'test:': OK, 'compliance:': OK, 'security:': OK });
    expect(result.status).toBe('passed');
    expect(Object.hasOwn(result, 'plan')).toBe(false);
    expect(calls.map((c) => c.label)).not.toContain('architect:S-1');
    const build = calls.find((c) => c.label === 'build:S-1');
    expect(build.prompt).toContain(`Read ${args.designFile}`);
    expect(build.prompt).not.toContain('Change a.mjs only.');
  });
});

describe('a plan saved by an earlier session', () => {
  const state = () => path.join(dir, '.foreman');
  const PLAN = { ...FULL, files: ['src/a.mjs'], design: 'Change a.mjs only.' };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=acme@example.com', '-c', 'user.name=Acme', ...args], { cwd: dir, env, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  const commit = (file, text, message) => {
    fs.writeFileSync(path.join(dir, file), text);
    git('add', '.');
    git('commit', '-qm', message);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return git('rev-parse', 'HEAD');
  };
  let first;
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, '.gitignore'), '.foreman/\n');
    fs.mkdirSync(path.join(dir, 'src'));
    spawnSync('git', ['init', '-q'], { cwd: dir, env });
    first = commit('src/a.mjs', 'export const a = 1;\n', 'first');
  });
  const save = async () => {
    markedSession(state(), { agents: [{ label: 'architect:S-1', phase: 'Architect', agentType: 'foreman:architect', output: PLAN }] });
    const saved = await run(['workflow-args', 'S-1', '--save-plan']);
    expect(saved.code, saved.err).toBe(0);
    return JSON.parse(fs.readFileSync(saved.out.trim(), 'utf8'));
  };

  it('is stamped with the base commit when saved, and a later plain call reuses it without the architect', async () => {
    const saved = await save();
    expect(saved).toMatchObject({ ...PLAN, baseCommit: first });
    expect(typeof saved.plannedAt).toBe('string');
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code, err).toBe(0);
    const a = JSON.parse(out);
    expect(a.plan).toEqual(shortPlan(PLAN));
    expect(a.designFile).toBe(path.join(state(), 'plans', 'S-1.md'));
    expect(err).toContain(`reusing the plan saved for S-1 on ${saved.plannedAt.slice(0, 10)}; the architect does not run again`);
    // The stamp is kept as it was, so the next call still compares against the same base.
    expect(JSON.parse(fs.readFileSync(path.join(state(), 'plans', 'S-1.json'), 'utf8')).baseCommit).toBe(first);
    const { calls } = await runWorkflow(a, { 'build:': { complete: true, summary: 'b', files: ['src/a.mjs'], commands: [], problem: '' }, 'test:': { approved: true, findings: [], checked: 'c' }, 'compliance:': { approved: true, findings: [], checked: 'c' }, 'security:': { approved: true, findings: [], checked: 'c' } });
    expect(calls.map((c) => c.label)).not.toContain('architect:S-1');
  });

  it('is left alone, with the reason on stderr, once a file it names changed on the base', async () => {
    await save();
    commit('src/a.mjs', 'export const a = 2;\n', 'moved on');
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code, err).toBe(0);
    expect(Object.hasOwn(JSON.parse(out), 'plan')).toBe(false);
    expect(err).toContain('not reusing the plan saved for S-1: 1 of its files changed on origin/main since it was written: src/a.mjs; the architect runs again');
  });

  it('is still reused after a change to a file it does not name', async () => {
    await save();
    commit('README.md', 'docs\n', 'unrelated');
    const { out, err } = await run(['workflow-args', 'S-1']);
    expect(JSON.parse(out).plan).toEqual(shortPlan(PLAN));
    expect(err).toContain('reusing the plan saved for S-1');
  });

  it('from before base commits were recorded is not reused', async () => {
    fs.mkdirSync(path.join(state(), 'plans'), { recursive: true });
    fs.writeFileSync(path.join(state(), 'plans', 'S-1.json'), JSON.stringify(PLAN));
    const { out, err } = await run(['workflow-args', 'S-1']);
    expect(Object.hasOwn(JSON.parse(out), 'plan')).toBe(false);
    expect(err).toContain('not reusing the plan saved for S-1: it records no base commit');
  });

  it('is not reused when it is not ready, and --plan or --start-at fix still take their own', async () => {
    fs.mkdirSync(path.join(state(), 'plans'), { recursive: true });
    fs.writeFileSync(path.join(state(), 'plans', 'S-1.json'), JSON.stringify({ ...PLAN, ready: false, blocker: 'S-0 first', baseCommit: first }));
    const plain = await run(['workflow-args', 'S-1']);
    expect(Object.hasOwn(JSON.parse(plain.out), 'plan')).toBe(false);
    expect(plain.err).not.toContain('reusing');
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ ...PLAN, design: 'another design' }));
    const given = JSON.parse((await run(['workflow-args', 'S-1', '--plan', 'other.json'])).out);
    expect(given.plan).toEqual(shortPlan(PLAN));
    expect(fs.readFileSync(given.designFile, 'utf8')).toContain('another design');
  });
});

describe('the reviewers while the review engine is out of quota', () => {
  const ENGINE = { name: 'antigravity', model: 'claude-opus-4-6-thinking' };
  beforeEach(() => {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'foreman.config.json'), 'utf8'));
    config.roles.reviewers = [{ name: 'compliance', agent: 'foreman:compliance-reviewer', engine: ENGINE }, { name: 'security', agent: 'foreman:security-reviewer' }];
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(config));
  });
  const future = () => new Date(Date.now() + 3600_000).toISOString();

  it('lose their engine in the args, with a note on stderr, so no relay is started', async () => {
    writeEngineDown(path.join(dir, '.foreman'), { engine: 'antigravity', until: future(), reason: 'quota reached', at: 'x' });
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code, err).toBe(0);
    expect(JSON.parse(out).roles.reviewers).toEqual([{ name: 'compliance', agent: 'foreman:compliance-reviewer' }, { name: 'security', agent: 'foreman:security-reviewer' }]);
    expect(err).toContain(`the antigravity engine is out of quota until`);
    expect(err).toContain('the reviewers run on Claude without a relay');
  });

  it('keep their engine when the record has passed or there is none', async () => {
    expect(JSON.parse((await run(['workflow-args', 'S-1'])).out).roles.reviewers[0].engine).toEqual(ENGINE);
    writeEngineDown(path.join(dir, '.foreman'), { engine: 'antigravity', until: '2026-01-01T00:00:00.000Z', reason: 'quota reached', at: 'x' });
    const { out, err } = await run(['workflow-args', 'S-1']);
    expect(JSON.parse(out).roles.reviewers[0].engine).toEqual(ENGINE);
    expect(err).not.toContain('out of quota');
  });
});

describe('foreman workflow-args with learned traits', () => {
  const HEADING = '### Learned by Foreman (CLAUDE.md and the traits above win)';
  const state = () => path.join(dir, '.foreman');
  const learn = (role, text) => {
    fs.mkdirSync(path.join(state(), 'learned', 'traits'), { recursive: true });
    fs.writeFileSync(path.join(state(), 'learned', 'traits', `${role}.md`), text);
  };
  const withBuilder = () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'foreman.config.json'), 'utf8'));
    cfg.roles.builders = { developer: { agent: 'foreman:builder', use: 'everything' } };
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(cfg));
  };
  beforeEach(() => {
    withBuilder();
    startStory(state(), { id: 'S-1', title: 'Add it' }, new Date(), 'w1');
  });

  it("gives the developer the learned trait under its heading and notes the id in the slot", async () => {
    learn('developer', '[L-1] Acme: test every error path.\n');
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code, err).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    const a = JSON.parse(out);
    expect(a.traits.developer).toContain(HEADING);
    expect(a.traits.developer).toContain('[L-1] Acme: test every error path.');
    expect(a.traits.tester).toBe('be strict');
    expect(readSlot(state(), 'w1').story.learned).toEqual(['L-1']);
  });

  it('leaves the learned trait out, and notes nothing, once learning.apply is off', async () => {
    learn('developer', '[L-1] Acme: test every error path.\n');
    // The local layer is flat, name to value, as `foreman settings set learning.apply false` writes it.
    expect((await asOwner(['settings', 'set', 'learning.apply', 'false'])).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(state(), 'settings.json'), 'utf8'))).toEqual({ 'learning.apply': false });
    const { code, out } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    const a = JSON.parse(out);
    expect(a.traits.developer).toBeUndefined();
    expect(a.traits).toEqual({ tester: 'be strict' });
    expect(out).not.toContain('Learned by Foreman');
    expect(readSlot(state(), 'w1').story.learned).toBeUndefined();
  });

  it('warns on stderr about learned traits over 3 KB, and still prints one line and exits 0', async () => {
    learn('developer', ['L-1', 'L-2', 'L-3'].map((id) => `[${id}] ${'a'.repeat(1200)}`).join('\n\n'));
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out).traits.developer).not.toContain('[L-3]');
    expect(err).toContain('warning: learned traits for developer are over 3 KB; left out L-3');
    expect(readSlot(state(), 'w1').story.learned).toEqual(['L-1', 'L-2']);
  });

  it('notes nothing when the slot holds another story', async () => {
    startStory(state(), { id: 'S-2', title: 'Other' }, new Date(), 'w1');
    learn('developer', '[L-1] Acme: test every error path.\n');
    const { code, out } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    expect(JSON.parse(out).traits.developer).toContain('[L-1]');
    expect(readSlot(state(), 'w1').story.learned).toBeUndefined();
  });
});

describe('foreman workflow-args with learned skills', () => {
  const SKILL = '---\nname: foreman-learned-acme-routes\ndescription: Use when adding an Acme route\n---\n## Steps\n...\n';
  const state = () => path.join(dir, '.foreman');
  beforeEach(() => {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'foreman.config.json'), 'utf8'));
    cfg.roles.builders = { developer: { agent: 'foreman:builder', use: 'everything' } };
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(cfg));
    startStory(state(), { id: 'S-1', title: 'Add it' }, new Date(), 'w1');
    expect(addItem(state(), { kind: 'skill', roles: ['developer'], slug: 'acme-routes', text: SKILL }).ok).toBe(true);
    // The slot's copy, as the supervisor's sync leaves it; the session runs in that folder.
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'foreman-learned-acme-routes'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'skills', 'foreman-learned-acme-routes', 'SKILL.md'), SKILL);
  });

  it("lists the developer's learned skill and notes its id in the slot", async () => {
    const { code, out, err } = await run(['workflow-args', 'S-1']);
    expect(code, err).toBe(0);
    const a = JSON.parse(out);
    expect(a.skills.developer).toEqual([{ id: 'L-1', name: 'foreman-learned-acme-routes', use: 'Use when adding an Acme route', path: '.claude/skills/foreman-learned-acme-routes/SKILL.md' }]);
    expect(a.skills.tester).toBeUndefined();
    expect(readSlot(state(), 'w1').story.learned).toContain('L-1');
  });

  it('gives no skills, and notes nothing, once learning.apply is off', async () => {
    expect((await asOwner(['settings', 'set', 'learning.apply', 'false'])).code).toBe(0);
    const { code, out } = await run(['workflow-args', 'S-1']);
    expect(code).toBe(0);
    expect(JSON.parse(out).skills).toEqual({});
    expect(readSlot(state(), 'w1').story.learned).toBeUndefined();
  });
});

describe('foreman traits add', () => {
  it('appends a paragraph, creating the file', async () => {
    expect((await run(['traits', 'add', 'tester', 'Always run the slow suite'])).code).toBe(0);
    expect((await run(['traits', 'add', 'tester', 'Second', 'one'])).code).toBe(0);
    const f = path.join(dir, '.claude/foreman/traits/tester.md');
    expect(fs.readFileSync(f, 'utf8')).toBe('Always run the slow suite\n\nSecond one\n');
  });

  it('rejects an unknown role, naming the known ones', async () => {
    const r = await run(['traits', 'add', 'wizard', 'x']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/all.*architect.*tester.*developer/s);
  });
});

describe('foreman config check traits', () => {
  it('warns about an oversize role but exits 0', async () => {
    fs.mkdirSync(path.join(dir, '.claude/foreman/traits'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude/foreman/traits/architect.md'), 'x'.repeat(9000));
    const r = await run(['config', 'check']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('traits for architect are 9 KB; keep them under 8 KB');
  });
});

describe('foreman workflow-args with a story that was sent back before', () => {
  const state = () => path.join(dir, '.foreman');
  const line = (over = {}) => ({ at: '2026-11-01T10:00:00.000Z', story: 'S-1', result: 'failed', builder: 'developer', stage: 'security', severity: 'major', rule: 'bounds read from raw text', where: 'src/a.mjs:4', observed: 'seen', fix: 'do it', ...over });
  const writeFindings = (lines) => {
    fs.mkdirSync(state(), { recursive: true });
    fs.writeFileSync(path.join(state(), 'findings.jsonl'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  };
  const overlay = () => {
    const file = path.join(state(), 'stories', 'S-1.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.text) : [];
  };

  it("passes only the story's blocker and major findings as earlier", async () => {
    writeFindings([line(), line({ severity: 'minor', rule: 'a nit' }), line({ story: 'S-2', rule: 'other' })]);
    const a = JSON.parse((await run(['workflow-args', 'S-1'])).out);
    expect(a.earlier).toEqual([{ stage: 'security', severity: 'major', rule: 'bounds read from raw text', where: 'src/a.mjs:4', observed: 'seen', fix: 'do it', at: '2026-11-01T10:00:00.000Z' }]);
  });

  it('has no earlier key with no findings file, or none for the story', async () => {
    expect(Object.hasOwn(JSON.parse((await run(['workflow-args', 'S-1'])).out), 'earlier')).toBe(false);
    writeFindings([line({ story: 'S-2' })]);
    expect(Object.hasOwn(JSON.parse((await run(['workflow-args', 'S-1'])).out), 'earlier')).toBe(false);
  });

  describe('--rethink', () => {
    const KIND = [line({ stage: 'security' }), line({ stage: 'compliance', rule: 'a comment hides the end', where: 'src/a.mjs:9' })].map(({ at, story, result, builder, ...f }) => f);
    const rethinkFile = (value = { round: 2, findings: KIND }) => {
      fs.writeFileSync(path.join(dir, 'rethink.json'), typeof value === 'string' ? value : JSON.stringify(value));
      return 'rethink.json';
    };
    const PLAN = { ...FULL, files: ['src/a.mjs'], design: 'Change a.mjs only.' };

    it('passes the file as args.rethink and prints no plan, with the story told in its notes', async () => {
      const { code, out, err } = await run(['workflow-args', 'S-1', '--rethink', rethinkFile()]);
      expect(code, err).toBe(0);
      const a = JSON.parse(out);
      expect(a.rethink).toEqual({ round: 2, findings: KIND });
      expect(Object.hasOwn(a, 'plan')).toBe(false);
      expect(overlay()).toContain('Round 2 found the same kind of bug again; sent back to the architect to change the approach.');
      expect(err).toBe('');
    });

    it('accepts a story cause and line, and tells the story the Done-when line cannot hold', async () => {
      const file = { round: 1, findings: KIND, cause: 'story', line: 1 };
      const { code, out, err } = await run(['workflow-args', 'S-1', '--rethink', rethinkFile(file)]);
      expect(code, err).toBe(0);
      const a = JSON.parse(out);
      expect(a.rethink).toEqual(file);
      expect(Object.hasOwn(a, 'plan')).toBe(false);
      expect(overlay()).toContain('The builder found Done-when 1 cannot hold; sent back to the architect to correct it.');
      expect(overlay().join('\n')).not.toContain('the same kind of bug');
    });

    it('tells the story nothing when a later step exits 1, and once on the next good run', async () => {
      const config = (traits) => fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({
        version: 1,
        project: { name: 'T' },
        checks: [{ run: 'npm test', when: 'always' }],
        resources: { db: { paths: ['db/**'], describe: 'the db' }, cache: { paths: ['c/**'], describe: 'the cache' } },
        stories: { adapter: 'markdown', dir: 'stories', groupLabel: 'Phase' },
        roles: { tester: { agent: 'foreman:tester', traits } },
      }));
      const NOTE = 'Round 2 found the same kind of bug again; sent back to the architect to change the approach.';
      config(['missing.md']);
      const bad = await run(['workflow-args', 'S-1', '--rethink', rethinkFile()]);
      expect(bad.code).toBe(1);
      expect(bad.out).toBe('');
      expect(bad.err).toContain('missing.md does not exist');
      expect(overlay()).toEqual([]);
      config(['be strict']);
      const good = await run(['workflow-args', 'S-1', '--rethink', rethinkFile()]);
      expect(good.code, good.err).toBe(0);
      expect(overlay().filter((t) => t === NOTE)).toHaveLength(1);
    });

    it('uses neither a fresh saved plan nor a checkpoint', async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
      const git = (...a) => expect(spawnSync('git', ['-c', 'user.email=acme@example.com', '-c', 'user.name=Acme', ...a], { cwd: dir, env, encoding: 'utf8' }).status).toBe(0);
      fs.writeFileSync(path.join(dir, '.gitignore'), '.foreman/\n');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
      git('init', '-q');
      git('add', '.');
      git('commit', '-qm', 'first');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      markedSession(state(), { agents: [{ label: 'architect:S-1', phase: 'Architect', agentType: 'foreman:architect', output: PLAN }] });
      expect((await run(['workflow-args', 'S-1', '--save-plan'])).code).toBe(0);
      const tree = worktreeTree(dir, []);
      writeCheckpoint(state(), { story: 'S-1', tree, at: '2026-10-29T11:00:00.000Z', entries: [{ label: 'architect:S-1', role: 'architect', name: 'architect', round: null, at: '2026-10-29T10:00:00.000Z', output: PLAN, tree }] });
      const plain = await run(['workflow-args', 'S-1']);
      expect(JSON.parse(plain.out).plan).toEqual(shortPlan(PLAN));
      const { code, out, err } = await run(['workflow-args', 'S-1', '--rethink', rethinkFile()]);
      expect(code, err).toBe(0);
      expect(Object.hasOwn(JSON.parse(out), 'plan')).toBe(false);
      expect(Object.hasOwn(JSON.parse(out), 'resume')).toBe(false);
      expect(err).not.toContain('reusing');
    });

    it.each([
      ['a file that is not JSON', 'not json'],
      ['a round of 0', { round: 0, findings: KIND }],
      ['no findings', { round: 1, findings: [] }],
      ['a list', [1]],
      ['a cause that is not story', { round: 1, findings: KIND, cause: 'bug' }],
      ['a line of 0', { round: 1, findings: KIND, cause: 'story', line: 0 }],
    ])('exits 1 with nothing on stdout for %s, naming the file', async (_, value) => {
      const { code, out, err } = await run(['workflow-args', 'S-1', '--rethink', rethinkFile(value)]);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('workflow-args: rethink.json is not a rethink file: ');
      expect(overlay()).toEqual([]);
    });

    it('exits 1 for a file that does not exist', async () => {
      const { code, out, err } = await run(['workflow-args', 'S-1', '--rethink', 'nope.json']);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('nope.json');
    });

    it.each([
      ['--plan', 'x'],
      ['--start-at', 'fix'],
      ['--findings', 'x'],
      ['--save-plan'],
    ])('refuses --rethink with %s', async (...extra) => {
      const { code, out, err } = await run(['workflow-args', 'S-1', '--rethink', rethinkFile(), ...extra]);
      expect(code).toBe(1);
      expect(out).toBe('');
      expect(err).toContain('foreman workflow-args <id> --rethink <file>');
    });

    it('warns and still exits 0 when the story cannot be told', async () => {
      // A file where the overlay folder belongs: the note cannot be written.
      fs.mkdirSync(state(), { recursive: true });
      fs.writeFileSync(path.join(state(), 'stories'), '');
      const { code, out, err } = await run(['workflow-args', 'S-1', '--rethink', rethinkFile()]);
      expect(code, err).toBe(0);
      expect(JSON.parse(out).rethink.round).toBe(2);
      expect(err).toContain('warning: the story was not told it went back to the architect');
    });
  });

  describe('a plan saved before the story failed review', () => {
    const PLAN = { ...FULL, files: ['src/a.mjs'], design: 'Change a.mjs only.' };
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const git = (...a) => expect(spawnSync('git', ['-c', 'user.email=acme@example.com', '-c', 'user.name=Acme', ...a], { cwd: dir, env, encoding: 'utf8' }).status).toBe(0);
    const saved = async () => {
      fs.writeFileSync(path.join(dir, '.gitignore'), '.foreman/\n');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
      git('init', '-q');
      git('add', '.');
      git('commit', '-qm', 'first');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      markedSession(state(), { agents: [{ label: 'architect:S-1', phase: 'Architect', agentType: 'foreman:architect', output: PLAN }] });
      expect((await run(['workflow-args', 'S-1', '--save-plan'])).code).toBe(0);
      return JSON.parse(fs.readFileSync(path.join(state(), 'plans', 'S-1.json'), 'utf8')).plannedAt;
    };
    const later = (at, ms) => new Date(Date.parse(at) + ms).toISOString();

    it('is not reused when a failed line is later than the plan, so the architect sees the history', async () => {
      const at = await saved();
      writeFindings([line({ at: later(at, 60_000) })]);
      const { code, out, err } = await run(['workflow-args', 'S-1']);
      expect(code, err).toBe(0);
      const a = JSON.parse(out);
      expect(Object.hasOwn(a, 'plan')).toBe(false);
      expect(a.earlier).toHaveLength(1);
      expect(err).toContain('not reusing the plan saved for S-1: it failed review after it was written; the architect runs again');
    });

    it('is still reused when the failed line is older than the plan', async () => {
      const at = await saved();
      writeFindings([line({ at: later(at, -60_000) })]);
      const { out, err } = await run(['workflow-args', 'S-1']);
      expect(JSON.parse(out).plan).toEqual(shortPlan(PLAN));
      expect(err).toContain('reusing the plan saved for S-1');
    });
  });
});
