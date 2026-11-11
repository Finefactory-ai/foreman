import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sfCommand, { makeSfCommand } from './sf-command.mjs';
import { PACKS } from '../index.mjs';
import { answerDeletes, askDeletes, readDeletes } from './deletes.mjs';
import { markReached, readDeployed, recordFirstDeploy } from './releases.mjs';
import { readSlot, startStory } from '../../lib/engine/state.mjs';
import { fakeSh } from '../../../test/ship-fakes.mjs';
import { ACME_DEV1_ID, ACME_QA_ID, ACME_UAT_ID, acmePlugins, acmeSfRoutes, fakeSfShell, orgRecord, orgRoute, sfOk, sfRaw } from '../../../test/fake-sf.mjs';
import { DEPLOY_QUERY } from './steps/sf-verify.mjs';
import { gitIn, gitSh, makeSkillsSource } from '../../../test/fake-skills.mjs';

let dir;
let root;
let src;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfcmd-'));
  root = path.join(dir, 'acme');
  fs.mkdirSync(root);
  src = makeSkillsSource(path.join(dir, 'source'), {
    '1.66.0': {
      'platform-apex-generate': { 'SKILL.md': '# Apex for Acme\n' },
      'platform-lwc-build': { 'SKILL.md': '# LWC for Acme\n', 'references/a.md': 'notes\n' },
    },
  });
  writeConfig();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeConfig(edit) {
  const file = {
    version: 1,
    project: { name: 'Acme' },
    pack: 'salesforce',
    salesforce: {
      productionBranch: 'main',
      orgs: { 'acme-dev1': { orgId: ACME_DEV1_ID }, 'acme-qa': { orgId: ACME_QA_ID } },
      build: ['acme-dev1'],
      stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
      skills: { source: src, tag: '1.66.0' },
    },
  };
  edit?.(file);
  fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify(file));
}

async function run(args, command = makeSfCommand({ sh: gitSh, packs: PACKS, tmpDir: dir }), extraEnv = {}) {
  let out = '';
  let err = '';
  const code = await command.run(args, {
    cwd: root,
    root,
    env: { FOREMAN_STATE_DIR: path.join(dir, 'state'), ...extraEnv },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  const lines = out.trim().split('\n');
  let last = null;
  try {
    last = JSON.parse(lines.at(-1));
  } catch {
    last = null;
  }
  return { code, out, err, last };
}

describe('foreman sf', () => {
  it('is the sf command', () => {
    expect(sfCommand).toMatchObject({ name: 'sf', summary: 'Salesforce pack tools (sf skills, sf deletes allow|keep-out <id>, sf baseline [--refresh|--story], sf rollback <id>, sf fixed <stage>)' });
    expect(typeof sfCommand.run).toBe('function');
  });

  it('sf skills installs the configured tag and says what to commit', async () => {
    const r = await run(['skills']);
    expect(r.code).toBe(0);
    const commit = gitIn(src, 'rev-parse', '1.66.0^{commit}');
    expect(r.last).toEqual({ ok: true, source: src, tag: '1.66.0', commit, installed: 2, removed: [] });
    expect(r.out).toContain(`installed 2 skills from ${src} at 1.66.0 (${commit.slice(0, 7)}); commit skills-lock.json, .agents/skills and .claude/skills`);
    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'platform-lwc-build', 'references', 'a.md'))).toBe(true);
    expect(fs.readlinkSync(path.join(root, '.claude', 'skills', 'platform-apex-generate'))).toBe('../../.agents/skills/platform-apex-generate');
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8')).skills)).toEqual(['platform-apex-generate', 'platform-lwc-build']);
  });

  it('sf skills warns on stderr when the tag moved upstream since the lock was written', async () => {
    expect((await run(['skills'])).code).toBe(0);
    const old = gitIn(src, 'rev-parse', '1.66.0^{commit}');
    fs.writeFileSync(path.join(src, 'skills', 'platform-apex-generate', 'SKILL.md'), '# Apex for Acme, moved\n');
    gitIn(src, 'commit', '-qam', 'moved');
    gitIn(src, 'tag', '-f', '1.66.0');
    const now = gitIn(src, 'rev-parse', '1.66.0^{commit}');

    const r = await run(['skills']);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`warning: tag 1.66.0 of ${src} now points at ${now.slice(0, 7)}, not ${old.slice(0, 7)}`);
    expect(r.last).toEqual({ ok: true, source: src, tag: '1.66.0', commit: now, installed: 2, removed: [], movedFrom: old });
  });

  it('refuses a project that does not use the salesforce pack', async () => {
    fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' } }));
    const r = await run(['skills']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('this project does not use the salesforce pack');
    expect(fs.existsSync(path.join(root, 'skills-lock.json'))).toBe(false);
  });

  it('exits 1 with the errors of an invalid config', async () => {
    writeConfig((file) => { file.salesforce.skills = { source: 7, tag: '1.66.0' }; });
    const r = await run(['skills']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('skills.source');
    expect(fs.existsSync(path.join(root, 'skills-lock.json'))).toBe(false);
  });

  for (const args of [[], ['nope'], ['rollback'], ['rollback', '-x'], ['rollback', 'S-1', 'S-2'], ['fixed'], ['fixed', '-x'], ['fixed', 'qa', 'uat'], ['deletes'], ['deletes', 'maybe', 'S-1'], ['deletes', 'allow'], ['deletes', 'allow', 'S-1', 'S-2'], ['baseline', '--force'], ['baseline', '--refresh', 'acme-qa'], ['baseline', '--story', '--refresh'], ['baseline', '--refresh', '--story'], ['baseline', '--story', 'x'], ['baseline', 'constructor']]) {
    it(`prints its usage and exits 64 for ${JSON.stringify(args)}`, async () => {
      const r = await run(args);
      expect(r.code).toBe(64);
      expect(r.err).toContain('usage: foreman sf skills');
      expect(r.err).toContain('deletes allow|keep-out <story id>');
      expect(r.err).toContain('foreman sf rollback <story id>');
      expect(r.err).toContain('foreman sf fixed <stage>');
      expect(r.err).toContain('foreman sf baseline [--refresh|--story]');
    });
  }

  describe('sf deletes', () => {
    const state = () => path.join(dir, 'state');
    const SHA = 'c'.repeat(64);
    const ask = () => askDeletes(state(), { story: 'S-1', sha256: SHA, deletes: [{ type: 'ApexClass', member: 'AcmeOld' }, { type: 'ApexPage', member: 'AcmeOldPage' }] }, new Date('2026-10-24T10:00:00.000Z'));

    for (const answer of ['allow', 'keep-out']) {
      it(`${answer} records the owner's answer on the waiting deletes`, async () => {
        ask();
        const r = await run(['deletes', answer, 'S-1']);
        expect(r.code).toBe(0);
        expect(r.last).toEqual({ ok: true, story: 'S-1', answer, sha256: SHA, deletes: 2 });
        expect(readDeletes(state(), 'S-1')).toMatchObject({ answer, sha256: SHA });
        expect(readDeletes(state(), 'S-1').answeredAt).toEqual(expect.any(String));
      });
    }

    it('exits 1 when no deletes wait for the story', async () => {
      const r = await run(['deletes', 'allow', 'S-1']);
      expect(r.code).toBe(1);
      expect(r.last).toEqual({ ok: false, reason: 'no deletes wait for S-1' });
    });

    it('can change an answer already given', async () => {
      ask();
      answerDeletes(state(), 'S-1', 'keep-out', new Date('2026-10-24T11:00:00.000Z'));
      expect((await run(['deletes', 'allow', 'S-1'])).code).toBe(0);
      expect(readDeletes(state(), 'S-1').answer).toBe('allow');
    });

    it('refuses a project that does not use the salesforce pack', async () => {
      ask();
      fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' } }));
      const r = await run(['deletes', 'allow', 'S-1']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('this project does not use the salesforce pack');
      expect(readDeletes(state(), 'S-1').answer).toBeNull();
    });
  });

  describe('sf baseline', () => {
    const RUN = '707000000000001AAA';
    const RUN2 = '707000000000002AAA';
    const state = () => path.join(dir, 'state');
    const START = 'apex run test --test-level RunLocalTests';
    const sfHome = () => path.join(dir, 'sf-home');
    const write = (alias, orgId, over = {}) => {
      const file = path.join(state(), 'salesforce', 'baseline', `${alias}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ alias, orgId, testRunId: RUN, startedAt: '2026-10-23T08:00:00.000Z', state: 'done', finishedAt: '2026-10-23T09:00:00.000Z', failing: [], coverage: 82, ...over }));
    };
    const withUat = (test) => (file) => {
      file.salesforce.orgs['acme-uat'] = { orgId: ACME_UAT_ID };
      file.salesforce.stages.push({ name: 'uat', org: 'acme-uat', branch: 'uat' });
      if (test) file.salesforce.test = test;
    };

    it("prints each org's saved baseline and the slot's test org, running no sf", async () => {
      writeConfig(withUat());
      write('acme-dev1', ACME_DEV1_ID);
      write('acme-qa', ACME_QA_ID, { failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19 });
      write('acme-uat', ACME_UAT_ID, { state: 'running', finishedAt: undefined, failing: undefined, coverage: undefined });
      const sh = fakeSfShell({});
      const r = await run(['baseline'], makeSfCommand({ sh, packs: PACKS, homedir: dir }), { FOREMAN_SLOT: 'w1' });
      expect(r.code).toBe(0);
      expect(sh.calls).toEqual([]);
      expect(r.last).toEqual({
        ok: true,
        testOrg: 'acme-dev1',
        orgs: [
          { alias: 'acme-dev1', roles: ['build'], state: 'done', failing: [], coverage: 82, finishedAt: '2026-10-23T09:00:00.000Z' },
          { alias: 'acme-qa', roles: ['stage qa'], state: 'done', failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19, finishedAt: '2026-10-23T09:00:00.000Z' },
          { alias: 'acme-uat', roles: ['stage uat'], state: 'running', failing: [], coverage: null, finishedAt: null },
        ],
      });
      expect(r.out.trim().split('\n')).toHaveLength(4);
      expect(r.out).toContain('AcmeServiceTest.sumsTheOrder');
    });

    it("names the test stage's org as the test org, and an org with no baseline as none", async () => {
      writeConfig(withUat('qa'));
      write('acme-qa', '00D000000000009AAA');
      const r = await run(['baseline'], makeSfCommand({ sh: fakeSfShell({}), packs: PACKS, homedir: dir }), { FOREMAN_SLOT: 'w1' });
      expect(r.code).toBe(0);
      expect(r.last.testOrg).toBe('acme-qa');
      expect(r.last.orgs.map((o) => [o.alias, o.state])).toEqual([['acme-dev1', 'none'], ['acme-qa', 'none'], ['acme-uat', 'none']]);
    });

    it('lists a shared org once, with both roles', async () => {
      writeConfig((file) => {
        file.salesforce.orgs = { 'acme-dev1': { orgId: ACME_DEV1_ID } };
        file.salesforce.build = 'acme-dev1';
        file.salesforce.stages = [{ name: 'dev', org: 'acme-dev1' }];
        delete file.salesforce.productionBranch;
      });
      const r = await run(['baseline'], makeSfCommand({ sh: fakeSfShell({}), packs: PACKS, homedir: dir }));
      expect(r.code).toBe(0);
      expect(r.last.orgs.map((o) => [o.alias, o.roles])).toEqual([['acme-dev1', ['build', 'stage dev']]]);
    });

    it('--refresh starts new runs in the isolated sf home and saves them as running', async () => {
      write('acme-qa', ACME_QA_ID, { failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 19 });
      const sh = fakeSfShell(acmeSfRoutes({ [START]: sfOk({ testRunId: RUN2 }) }));
      const r = await run(['baseline', '--refresh'], makeSfCommand({ sh, packs: PACKS, homedir: dir }), { FOREMAN_SF_HOME: sfHome() });
      expect(r.code).toBe(0);
      expect(r.last).toEqual({ ok: true, started: [{ alias: 'acme-dev1', testRunId: RUN2 }, { alias: 'acme-qa', testRunId: RUN2 }], failed: [] });
      for (const call of sh.calls) expect(call.opts.env.HOME).toBe(sfHome());
      const saved = JSON.parse(fs.readFileSync(path.join(state(), 'salesforce', 'baseline', 'acme-qa.json'), 'utf8'));
      expect(saved).toMatchObject({ alias: 'acme-qa', orgId: ACME_QA_ID, testRunId: RUN2, state: 'running' });
      expect(saved).not.toHaveProperty('failing');
    });

    it('--refresh exits 1 naming an org that is not a sandbox, and still starts the others', async () => {
      write('acme-qa', ACME_QA_ID);
      const sh = fakeSfShell(acmeSfRoutes({ [orgRoute('acme-qa')]: orgRecord(ACME_QA_ID, false), [START]: sfOk({ testRunId: RUN2 }) }));
      const r = await run(['baseline', '--refresh'], makeSfCommand({ sh, packs: PACKS, homedir: dir }), { FOREMAN_SF_HOME: sfHome() });
      expect(r.code).toBe(1);
      expect(r.last).toEqual({ ok: false, started: [{ alias: 'acme-dev1', testRunId: RUN2 }], failed: [{ alias: 'acme-qa', reason: 'acme-qa is not a sandbox; production is never a target' }] });
      expect(sh.sfLines().filter((l) => l.includes(START))).toEqual(['apex run test --test-level RunLocalTests --code-coverage --target-org acme-dev1 --json']);
      expect(fs.existsSync(path.join(state(), 'salesforce', 'baseline', 'acme-qa.json'))).toBe(false);
    });

    describe('--story', () => {
      const BRANCH = 'story/acme-7';
      const unix = (iso) => Math.floor(Date.parse(iso) / 1000);
      // git for the story checkout: symbolic-ref names the branch (or fails, detached), and
      // reflog gives the entries, newest first, as [iso, subject].
      const gitFake = (entries, branch = BRANCH) => (cmd, args) => {
        if (cmd === 'git' && args[0] === 'symbolic-ref') return branch ? { status: 0, stdout: `${branch}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
        if (cmd === 'git' && args[0] === 'reflog') return { status: 0, stdout: entries.map(([iso, subject]) => `${branch}@{${unix(iso)}}\t${subject}\n`).join(''), stderr: '' };
        return { status: 1, stdout: '', stderr: `unexpected ${cmd} ${args.join(' ')}` };
      };
      const touch = (alias, iso) => {
        const at = new Date(iso);
        fs.utimesSync(path.join(state(), 'salesforce', 'baseline', `${alias}.json`), at, at);
      };
      const story = (sh) => run(['baseline', '--story'], makeSfCommand({ sh, packs: PACKS, homedir: dir }), { FOREMAN_SLOT: 'w1' });

      it('counts a baseline finished and saved before the story branch was created', async () => {
        write('acme-dev1', ACME_DEV1_ID, { failing: ['AcmeServiceTest.sumsTheOrder'] });
        touch('acme-dev1', '2026-10-23T10:00:00.000Z');
        const sh = fakeSfShell({}, gitFake([['2026-10-24T00:00:00.000Z', 'branch: Created from origin/main']]));
        const r = await story(sh);
        expect(r.code).toBe(0);
        expect(sh.sfLines()).toEqual([]);
        expect(r.last.ok).toBe(true);
        expect(r.last.testOrg).toBe('acme-dev1');
        expect(r.last.branchStart).toBe('2026-10-24T00:00:00.000Z');
        expect(r.last.orgs[0]).toEqual({ alias: 'acme-dev1', roles: ['build'], state: 'done', failing: ['AcmeServiceTest.sumsTheOrder'], coverage: 82, finishedAt: '2026-10-23T09:00:00.000Z', trusted: true });
        expect(r.last.orgs[1]).toMatchObject({ alias: 'acme-qa', state: 'none', failing: [], trusted: false });
        const reflog = sh.calls.find((c) => c.cmd === 'git' && c.args[0] === 'reflog');
        expect(reflog.args).toEqual(['reflog', 'show', '--date=unix', '--format=%gd%x09%gs', `refs/heads/${BRANCH}`]);
        expect(reflog.opts.cwd).toBe(root);
        expect(r.out).not.toContain('not counted as inherited');
      });

      it('does not count a baseline file saved after the branch was created, though its finishedAt is older', async () => {
        write('acme-dev1', ACME_DEV1_ID, { failing: ['AcmeServiceTest.sumsTheOrder'] });
        touch('acme-dev1', '2026-10-24T01:00:00.000Z');
        const r = await story(fakeSfShell({}, gitFake([['2026-10-24T00:00:00.000Z', 'branch: Created from origin/main']])));
        expect(r.code).toBe(0);
        expect(r.last.orgs[0]).toMatchObject({ alias: 'acme-dev1', state: 'done', failing: [], trusted: false });
        const line = r.out.split('\n').find((l) => l.startsWith('acme-dev1'));
        expect(line).toContain("not counted as inherited: saved after this story's branch was created");
      });

      it('takes the newest creation or reset of the branch, not its newest entry', async () => {
        write('acme-dev1', ACME_DEV1_ID, { finishedAt: '2026-10-22T09:00:00.000Z', failing: ['AcmeServiceTest.sumsTheOrder'] });
        touch('acme-dev1', '2026-10-22T10:00:00.000Z');
        write('acme-qa', ACME_QA_ID, { finishedAt: '2026-10-20T09:00:00.000Z', failing: ['AcmeOtherTest.adds'] });
        touch('acme-qa', '2026-10-20T10:00:00.000Z');
        const r = await story(fakeSfShell({}, gitFake([
          ['2026-10-25T00:00:00.000Z', 'commit: x'],
          ['2026-10-24T00:00:00.000Z', 'merge origin/main: Merge made by the \'ort\' strategy.'],
          ['2026-10-21T00:00:00.000Z', 'branch: Reset to origin/main'],
          ['2026-10-01T00:00:00.000Z', 'branch: Created from origin/main'],
        ])));
        expect(r.code).toBe(0);
        expect(r.last.branchStart).toBe('2026-10-21T00:00:00.000Z');
        expect(r.last.orgs.map((o) => [o.alias, o.trusted, o.failing])).toEqual([['acme-dev1', false, []], ['acme-qa', true, ['AcmeOtherTest.adds']]]);
      });

      for (const [name, sh] of [
        ['a detached HEAD', () => fakeSfShell({}, gitFake([['2026-10-24T00:00:00.000Z', 'branch: Created from origin/main']], null))],
        ['a reflog with no creation entry', () => fakeSfShell({}, gitFake([['2026-10-25T00:00:00.000Z', 'commit: x']]))],
        ['a reflog that fails', () => fakeSfShell({}, (cmd, args) => (args[0] === 'symbolic-ref' ? { status: 0, stdout: `${BRANCH}\n`, stderr: '' } : { status: 128, stdout: '', stderr: 'fatal' }))],
        ['a symbolic-ref that fails but prints a name', () => {
          const git = gitFake([['2026-10-24T00:00:00.000Z', 'branch: Created from origin/main']]);
          return fakeSfShell({}, (cmd, args, opts) => (args[0] === 'symbolic-ref' ? { status: 1, stdout: `${BRANCH}\n`, stderr: '' } : git(cmd, args, opts)));
        }],
        ['a reflog that fails but prints a creation entry', () => {
          const git = gitFake([['2026-10-24T00:00:00.000Z', 'branch: Created from origin/main']]);
          return fakeSfShell({}, (cmd, args, opts) => (args[0] === 'reflog' ? { ...git(cmd, args, opts), status: 128 } : git(cmd, args, opts)));
        }],
        ['a git that throws', () => fakeSfShell({}, () => { throw new Error('spawn git ENOENT'); })],
      ]) {
        it(`counts nothing as inherited with ${name}, and still exits 0`, async () => {
          write('acme-dev1', ACME_DEV1_ID, { failing: ['AcmeServiceTest.sumsTheOrder'] });
          touch('acme-dev1', '2026-10-01T00:00:00.000Z');
          write('acme-qa', ACME_QA_ID, { failing: ['AcmeOtherTest.adds'] });
          touch('acme-qa', '2026-10-01T00:00:00.000Z');
          const fake = sh();
          const r = await story(fake);
          expect(r.code).toBe(0);
          expect(fake.sfLines()).toEqual([]);
          expect(r.last.branchStart).toBeNull();
          for (const o of r.last.orgs) expect(o).toMatchObject({ trusted: false, failing: [] });
          expect(r.out).toContain("not counted as inherited: this story's branch start could not be read");
        });
      }

      it('does not trust a running or aborted baseline', async () => {
        write('acme-dev1', ACME_DEV1_ID, { state: 'running', finishedAt: undefined, failing: undefined, coverage: undefined });
        touch('acme-dev1', '2026-10-01T00:00:00.000Z');
        write('acme-qa', ACME_QA_ID, { state: 'aborted', failing: undefined, coverage: undefined });
        touch('acme-qa', '2026-10-01T00:00:00.000Z');
        const r = await story(fakeSfShell({}, gitFake([['2026-10-24T00:00:00.000Z', 'branch: Created from origin/main']])));
        expect(r.code).toBe(0);
        expect(r.last.orgs.map((o) => [o.alias, o.state, o.trusted, o.failing])).toEqual([['acme-dev1', 'running', false, []], ['acme-qa', 'aborted', false, []]]);
      });

      it('reads the branch start from real git after `git checkout -B`', async () => {
        gitIn(root, 'init', '-q', '-b', 'main');
        gitIn(root, 'commit', '-q', '--allow-empty', '-m', 'Acme start');
        gitIn(root, 'checkout', '-q', '-B', 'story/acme-7', 'main');
        write('acme-dev1', ACME_DEV1_ID, { finishedAt: '2000-01-01T00:00:00.000Z', failing: ['AcmeServiceTest.sumsTheOrder'] });
        touch('acme-dev1', '2000-01-01T01:00:00.000Z');
        write('acme-qa', ACME_QA_ID, { finishedAt: '2000-01-01T00:00:00.000Z', failing: ['AcmeOtherTest.adds'] });
        touch('acme-qa', new Date(Date.now() + 60 * 60 * 1000).toISOString());
        const sh = fakeSfShell({}, gitSh);
        const r = await story(sh);
        expect(r.code).toBe(0);
        expect(sh.sfLines()).toEqual([]);
        expect(r.last.branchStart).toEqual(expect.any(String));
        expect(Math.abs(Date.parse(r.last.branchStart) - Date.now())).toBeLessThan(5 * 60 * 1000);
        expect(r.last.orgs.map((o) => [o.alias, o.trusted, o.failing])).toEqual([['acme-dev1', true, ['AcmeServiceTest.sumsTheOrder']], ['acme-qa', false, []]]);
      });
    });

    it('refuses a project that does not use the salesforce pack', async () => {
      fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' } }));
      for (const args of [['baseline'], ['baseline', '--refresh']]) {
        const sh = fakeSfShell({});
        const r = await run(args, makeSfCommand({ sh, packs: PACKS, homedir: dir }));
        expect(r.code).toBe(1);
        expect(r.err).toContain('this project does not use the salesforce pack');
        expect(sh.calls).toEqual([]);
      }
    });
  });

  it('exits 1 with { ok: false, reason } for an unknown tag', async () => {
    writeConfig((file) => { file.salesforce.skills.tag = '9.9.9'; });
    const r = await run(['skills']);
    expect(r.code).toBe(1);
    expect(r.last).toEqual({ ok: false, reason: `${src} has no tag 9.9.9` });
    expect(fs.existsSync(path.join(root, '.agents'))).toBe(false);
  });

  describe('sf rollback', () => {
    const state = () => path.join(dir, 'state');
    const seed = (reached) => {
      for (const stage of reached) markReached(state(), 'S-1', stage, 'bbb');
      recordFirstDeploy(state(), 'S-1', { stage: 'qa', org: 'acme-qa', orgId: ACME_QA_ID, branch: 'qa', merge: 'a'.repeat(40), method: 'merge', jobId: '0Af000000000001AAA', deployedAt: '2026-10-24T10:00:00.000Z' });
    };
    const command = (sh) => makeSfCommand({ sh, packs: PACKS, now: () => new Date('2026-10-24T12:00:00.000Z'), sleep: async () => {} });

    it('prints a line and the refusal as JSON, and exits 1, for a story that reached uat', async () => {
      writeConfig((file) => { file.salesforce.orgs['acme-uat'] = { orgId: '00D000000000003AAA' }; file.salesforce.stages.push({ name: 'uat', org: 'acme-uat', branch: 'uat' }); });
      seed(['qa', 'uat']);
      const sh = fakeSh([]);
      const r = await run(['rollback', 'S-1'], command(sh));
      expect(r.code).toBe(1);
      expect(r.last).toMatchObject({ ok: false, refused: true, reason: expect.stringContaining('S-1 reached uat') });
      expect(r.out.trim().split('\n')).toHaveLength(2);
      expect(sh.calls).toEqual([]);
    });

    it('exits 1 when nothing is recorded for the story', async () => {
      const r = await run(['rollback', 'S-9'], command(fakeSh([])));
      expect(r.code).toBe(1);
      expect(r.last).toEqual({ ok: false, refused: true, reason: 'No deploy of S-9 to qa is recorded; nothing to roll back.' });
    });

    it('keeps the slot alive while it waits on the deploy, beating on every poll', async () => {
      startStory(state(), { id: 'S-1', title: 'Acme' }, new Date('2026-10-24T09:00:00.000Z'), 'w1');
      seed(['qa']);
      const JOB = '0Af000000000005AAA';
      const pkg = '<Package><types><members>AcmeService</members><name>ApexClass</name></types><version>62.0</version></Package>';
      // sgd writes a delta of one class and no deletes into its --output-dir.
      const sgd = (line) => {
        const out = /--output-dir (\S+)/.exec(line)[1];
        fs.mkdirSync(path.join(out, 'package'), { recursive: true });
        fs.mkdirSync(path.join(out, 'destructiveChanges'), { recursive: true });
        fs.writeFileSync(path.join(out, 'package', 'package.xml'), pkg);
        fs.writeFileSync(path.join(out, 'destructiveChanges', 'destructiveChanges.xml'), '<Package><version>62.0</version></Package>');
        return sfOk({ success: true });
      };
      let clock = Date.parse('2026-10-24T12:00:00.000Z');
      const beats = [];
      let polls = 0;
      const sh = fakeSh([
        ['git rev-parse HEAD', `${'b'.repeat(40)}\n`],
        [/^sf plugins --core/, sfRaw(acmePlugins({ 'sfdx-git-delta': '6.45.1' }))],
        [/FROM Organization --target-org acme-qa/, orgRecord(ACME_QA_ID)],
        [/^sf sgd source delta /, sgd],
        [/^sf project deploy start /, sfOk({ id: JOB, status: 'Queued' })],
        [/^sf project deploy report /, () => {
          // What the slot said at the moment of this poll.
          beats.push(readSlot(state(), 'w1').lastBeat);
          polls += 1;
          return sfOk({ id: JOB, status: polls < 3 ? 'InProgress' : 'Succeeded', details: {} });
        }],
      ]);
      const cmd = makeSfCommand({ sh, packs: PACKS, now: () => new Date(clock), sleep: async (ms) => { clock += ms; } });
      const r = await run(['rollback', 'S-1'], cmd, { FOREMAN_SLOT: 'w1', FOREMAN_SF_HOME: path.join(dir, 'sf-home') });
      expect(r.code).toBe(0);
      expect(r.last).toMatchObject({ ok: true, jobId: JOB });
      // Each poll comes right after a beat at that poll's time.
      expect(beats).toEqual(['2026-10-24T12:00:00.000Z', '2026-10-24T12:00:10.000Z', '2026-10-24T12:00:20.000Z']);
      const slot = readSlot(state(), 'w1');
      expect(slot.story.stage).toBe('release');
      expect(slot.story.detail).toBe('rolling S-1 back on qa');
      expect(slot.lastBeat).toBe('2026-10-24T12:00:20.000Z');
    });

    it('prints one by hand line per manual step before the JSON line, and exits 0', async () => {
      seed(['qa']);
      const JOB = '0Af000000000005AAA';
      // sgd writes a delta of one class and a Flow delete, which the rollback leaves to the owner.
      const sgd = (line) => {
        const out = /--output-dir (\S+)/.exec(line)[1];
        fs.mkdirSync(path.join(out, 'package'), { recursive: true });
        fs.mkdirSync(path.join(out, 'destructiveChanges'), { recursive: true });
        fs.writeFileSync(path.join(out, 'package', 'package.xml'), '<Package><types><members>AcmeService</members><name>ApexClass</name></types><version>62.0</version></Package>');
        fs.writeFileSync(path.join(out, 'destructiveChanges', 'destructiveChanges.xml'), '<Package><types><members>AcmeFlow</members><name>Flow</name></types><version>62.0</version></Package>');
        return sfOk({ success: true });
      };
      const sh = fakeSh([
        ['git rev-parse HEAD', `${'b'.repeat(40)}\n`],
        [/^sf plugins --core/, sfRaw(acmePlugins({ 'sfdx-git-delta': '6.45.1' }))],
        [/FROM Organization --target-org acme-qa/, orgRecord(ACME_QA_ID)],
        [/^sf sgd source delta /, sgd],
        [/^sf project deploy start /, sfOk({ id: JOB, status: 'Queued' })],
        [/^sf project deploy report /, sfOk({ id: JOB, status: 'Succeeded', details: {} })],
      ]);
      const r = await run(['rollback', 'S-1'], command(sh), { FOREMAN_SF_HOME: path.join(dir, 'sf-home') });
      expect(r.code).toBe(0);
      const lines = r.out.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('1 manual step(s) left');
      expect(lines[1]).toBe('  by hand: Delete Flow AcmeFlow by hand in acme-qa; the rollback never deletes Flows');
      expect(r.last).toMatchObject({ ok: true, manualSteps: ['Delete Flow AcmeFlow by hand in acme-qa; the rollback never deletes Flows'] });
    });

    it('refuses a project that does not use the salesforce pack', async () => {
      fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' } }));
      const r = await run(['rollback', 'S-1'], command(fakeSh([])));
      expect(r.code).toBe(1);
      expect(r.err).toContain('this project does not use the salesforce pack');
    });
  });

  describe('sf fixed', () => {
    const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12';
    const JOB = '0Af000000000007AAA';
    const command = (sh) => makeSfCommand({ sh, packs: PACKS, now: () => new Date('2026-10-24T12:00:00.000Z') });
    const shWith = (identity = orgRecord(ACME_QA_ID)) =>
      fakeSh([
        ['git rev-parse --verify refs/remotes/origin/qa', `${HEAD}\n`],
        [/FROM Organization --target-org acme-qa/, identity],
        [`sf data query --use-tooling-api --query ${DEPLOY_QUERY}`, sfOk({ records: [{ Id: JOB, Status: 'Succeeded' }], totalSize: 1, done: true })],
      ]);

    it("records the stage as fixed at the branch head with the org's newest deploy", async () => {
      const sh = shWith();
      const r = await run(['fixed', 'qa'], command(sh), { FOREMAN_SF_HOME: path.join(dir, 'sf-home') });
      expect(r.code).toBe(0);
      expect(r.last).toEqual({ ok: true, stage: 'qa', org: 'acme-qa', commit: HEAD, jobId: JOB });
      expect(r.out.trim().split('\n')).toHaveLength(2);
      expect(sh.calls[0]).toBe('git fetch --quiet origin +refs/heads/qa:refs/remotes/origin/qa');
      expect(readDeployed(path.join(dir, 'state'), 'qa')).toMatchObject({ commit: HEAD, jobId: JOB });
    });

    it('exits 1 and records nothing for an org that is not the configured one', async () => {
      const r = await run(['fixed', 'qa'], command(shWith(orgRecord(ACME_UAT_ID))), { FOREMAN_SF_HOME: path.join(dir, 'sf-home') });
      expect(r.code).toBe(1);
      expect(r.last.ok).toBe(false);
      expect(readDeployed(path.join(dir, 'state'), 'qa')).toBeNull();
    });

    it('exits 1 for a stage the layout does not have', async () => {
      const r = await run(['fixed', 'uat'], command(fakeSh([])));
      expect(r.code).toBe(1);
      expect(r.last).toEqual({ ok: false, reason: 'The salesforce block has no stage named uat.' });
    });
  });
});
