// The "This project" step's model: the form's words, the config the page's answers make (the
// same as /foreman:init makes for the same answers), and the check command run once, with a time
// limit and its output tail redacted.
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect } from '../engine/init-helpers.mjs';
import { CHECK_RUN_MS, KEEP_BYTES, KILL_GRACE_MS, MAX_RUN, PROJECT_FORM, SANDBOX_STAGE, STARTER_JQL, STARTER_WHERE, TAIL_CHARS, TAIL_LINES, WORDS, checkRunError, envSecrets, fileSecrets, projectChange, projectConfig, runCheckCommand } from './project.mjs';
import { PACKS } from '../../packs/index.mjs';
import { ROLLBACK_COMMAND } from '../../packs/salesforce/config.mjs';
import { DEFAULTS } from '../config/defaults.mjs';
import { loadConfig } from '../config/load.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { readTeam, teamApply } from '../settings/team.mjs';

const FIXTURE = new URL('../../../test/fixtures/acme-init/', import.meta.url);
const CASES = JSON.parse(readFileSync(new URL('cases.json', FIXTURE), 'utf8'));

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-project-'));
  made.push(dir);
  return dir;
};
// The fixture's repo, copied and git-inited.
function acmeRepo() {
  const dir = tempDir();
  cpSync(new URL('repo', FIXTURE), dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const MARKDOWN = CASES.find((c) => c.name === 'markdown');
const JIRA = CASES.find((c) => c.name === 'jira');
const errorsOf = (detected, answers) => {
  const r = projectConfig(detected, answers);
  expect(r.ok, JSON.stringify(r)).toBe(false);
  expect(Array.isArray(r.errors)).toBe(true);
  for (const e of r.errors) expect(typeof e).toBe('string');
  return r.errors;
};

describe('the constants', () => {
  it('are the limits the design names', () => {
    expect([MAX_RUN, CHECK_RUN_MS, TAIL_CHARS, TAIL_LINES, KEEP_BYTES]).toEqual([1000, 180_000, 4000, 40, 64 * 1024]);
  });

  it('waits 2 seconds after the time limit before it answers without the output closing', () => {
    expect(KILL_GRACE_MS).toBe(2000);
  });
});

describe('PROJECT_FORM', () => {
  it('names the fields in order, with the words they show', () => {
    expect(PROJECT_FORM.fields.map((f) => f.id)).toEqual(['name', 'source', 'dir', 'site', 'jql', 'check', 'ci']);
    const field = (id) => PROJECT_FORM.fields.find((f) => f.id === id);
    expect(field('source').options).toEqual([
      { value: 'markdown', label: 'Story files in this repository (markdown)' },
      { value: 'jira', label: 'Jira' },
    ]);
    expect(field('dir').when).toEqual({ source: 'markdown' });
    expect(field('site').when).toEqual({ source: 'jira' });
    expect(field('jql').when).toEqual({ source: 'jira' });
    expect(field('jql').placeholder).toBe('project = KEY AND labels = foreman AND statusCategory != Done ORDER BY Rank');
    expect(field('check').action).toBe('Run it');
    expect(field('ci').kind).toBe('jobs');
    expect(typeof field('ci').empty).toBe('string');
    expect(PROJECT_FORM.save).toBe('Save foreman.config.json');
    for (const k of ['running', 'saving', 'saved', 'retry']) expect(typeof PROJECT_FORM[k], k).toBe('string');
    expect(PROJECT_FORM.retry).toBe('Try again');
  });
});

describe('projectConfig: the same config as /foreman:init', () => {
  it.each(CASES.map((c) => [c.name, c]))('%s', (name, c) => {
    const r = projectConfig(detect(acmeRepo()), c.answers);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(JSON.stringify(r.config, null, 2)).toBe(JSON.stringify(c.config, null, 2));
  });

  it('takes the detected CI jobs when ci is left out', () => {
    const { ci, ...answers } = MARKDOWN.answers;
    const r = projectConfig(detect(acmeRepo()), answers);
    expect(r.ok).toBe(true);
    expect(r.config.ship.ci.required).toEqual(['Unit tests', 'lint']);
  });
});

describe('projectConfig: errors in plain words', () => {
  let detected;
  const acme = () => (detected ??= detect(acmeRepo()));
  const md = (extra) => ({ ...MARKDOWN.answers, ...extra });
  const jira = (extra) => ({ ...JIRA.answers, ...extra });

  it('wants a name', () => {
    expect(errorsOf(acme(), md({ name: '   ' }))).toContain(WORDS.needName);
  });

  it('wants a known source', () => {
    expect(errorsOf(acme(), md({ source: 'trello' }))).toContain(WORDS.pickSource);
  });

  it.each([['../x'], ['/abs'], ['   '], ['docs/../../x'], ['.'], ['./'], ['.git'], ['.git/hooks'], ['.foreman'], ['./.foreman/x'], ['docs/..']])('wants a story folder inside the project, not %j', (dir) => {
    expect(errorsOf(acme(), md({ dir }))).toContain(WORDS.badDir);
  });

  it('trims the story folder and drops a trailing slash', () => {
    expect(projectConfig(acme(), md({ dir: ' docs/stories/ ' })).config.stories).toEqual({ adapter: 'markdown', dir: 'docs/stories' });
  });

  it('still takes a folder that starts with ./', () => {
    expect(projectConfig(acme(), md({ dir: './stories' })).config.stories).toEqual({ adapter: 'markdown', dir: './stories' });
  });

  it('wants a Jira site and filter', () => {
    expect(errorsOf(acme(), jira({ site: '' }))).toContain(WORDS.needSite);
    expect(errorsOf(acme(), jira({ jql: '  ' }))).toContain(WORDS.needJql);
  });

  it('says why a Jira site is refused', () => {
    const errors = errorsOf(acme(), jira({ site: 'not a host' }));
    expect(errors.some((e) => e.startsWith('Jira site: '))).toBe(true);
  });

  it('cleans the Jira site to its host', () => {
    expect(projectConfig(acme(), jira({ site: 'https://ACME.atlassian.net/' })).config.stories.site).toBe('acme.atlassian.net');
  });

  it('wants a check command when the detection suggested checks', () => {
    expect(errorsOf(acme(), md({ check: '  ' }))).toContain(WORDS.needCheck);
    const { check, ...noCheck } = MARKDOWN.answers;
    expect(errorsOf(acme(), noCheck)).toContain(WORDS.needCheck);
  });

  it('wants the check command on one line', () => {
    expect(errorsOf(acme(), md({ check: 'npm test\nrm -rf /' }))).toContain(WORDS.checkOneLine);
  });

  it('wants the check command no longer than 1000 characters', () => {
    expect(errorsOf(acme(), md({ check: 'x'.repeat(1001) }))).toContain(WORDS.checkTooLong);
  });

  it('takes only CI jobs read from .github/workflows, and never repeats the one sent', () => {
    const errors = errorsOf(acme(), md({ ci: ['Unit tests', 'acme-made-up-job'] }));
    expect(errors).toContain(WORDS.badJobs);
    for (const e of errors) expect(e).not.toContain('acme-made-up-job');
    expect(errorsOf(acme(), md({ ci: 'Unit tests' }))).toContain(WORDS.badJobs);
  });

  it('takes only the answers it knows, and strings where strings go', () => {
    const errors = errorsOf(acme(), md({ slots: '2' }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errorsOf(acme(), md({ name: 42 })).length).toBeGreaterThan(0);
    expect(errorsOf(acme(), null).length).toBeGreaterThan(0);
  });
});

describe('projectConfig: a pack that brings its own checks', () => {
  const packDetected = () => ({
    suggested: {
      version: 1,
      project: { name: 'acme' },
      pack: 'acme',
      stories: { adapter: 'markdown', dir: 'stories' },
      ship: { steps: ['push', 'pr', 'merge'], ci: { required: [] } },
      acme: { org: 'acme-dev1' },
    },
    found: { ciJobs: [], storySourceHint: 'unknown' },
  });

  it('leaves checks out for a blank check, and keeps pack second after project', () => {
    const r = projectConfig(packDetected(), { name: 'Acme', source: 'markdown', dir: 'stories', check: '' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(Object.keys(r.config)).toEqual(['version', 'project', 'pack', 'stories', 'ship', 'acme']);
    expect(r.config.acme).toEqual({ org: 'acme-dev1' });
    expect(r.config.ship).toEqual({ steps: ['push', 'pr', 'merge'], ci: { required: [] } });
  });

  it('puts a given check before stories', () => {
    const r = projectConfig(packDetected(), { name: 'Acme', source: 'markdown', dir: 'stories', check: 'make acme' });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.config)).toEqual(['version', 'project', 'pack', 'checks', 'stories', 'ship', 'acme']);
    expect(r.config.checks).toEqual([{ run: 'make acme', when: 'always' }]);
  });
});

describe('checkRunError', () => {
  it('takes one line of up to 1000 characters', () => {
    expect(checkRunError('npm test')).toBeNull();
    expect(checkRunError('x'.repeat(1000))).toBeNull();
    for (const bad of ['', '   ', 42, 'a\nb', 'a\rb', 'x'.repeat(1001), null, undefined]) expect(typeof checkRunError(bad), JSON.stringify(bad)).toBe('string');
  });
});

describe('runCheckCommand', () => {
  it('passes on exit 0', async () => {
    const r = await runCheckCommand('true', { cwd: tempDir(), env: process.env });
    expect(r).toMatchObject({ passed: true, exitCode: 0, timedOut: false });
    expect(typeof r.seconds).toBe('number');
    expect(r.detail).toBe(WORDS.passed(r.seconds));
  });

  it('fails on another exit code', async () => {
    const r = await runCheckCommand('exit 3', { cwd: tempDir(), env: process.env });
    expect(r).toMatchObject({ passed: false, exitCode: 3, timedOut: false });
    expect(r.detail).toBe(WORDS.failed(3, r.seconds));
  });

  it('stops the whole group at the time limit', async () => {
    const started = Date.now();
    // `sleep 30; true` keeps sh alive as the parent of sleep, so only a group kill ends it in time.
    const r = await runCheckCommand('sleep 30; true', { cwd: tempDir(), env: process.env, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('keeps only the tail: the last 40 lines, at most 4000 characters', async () => {
    const r = await runCheckCommand('seq 1 5000', { cwd: tempDir(), env: process.env });
    expect(r.passed).toBe(true);
    expect(r.tail.endsWith('5000')).toBe(true);
    expect(r.tail.split('\n').length).toBeLessThanOrEqual(40);
    expect(r.tail.length).toBeLessThanOrEqual(4000);
    expect(r.tail.startsWith('1\n')).toBe(false);
  });

  it('adds the child to track while it runs, and takes it out after', async () => {
    const track = new Set();
    const running = runCheckCommand('sleep 0.2', { cwd: tempDir(), env: process.env, track });
    expect(track.size).toBe(1);
    await running;
    expect(track.size).toBe(0);
  });

  it("blanks the files' values, the environment's keys and token-shaped text before the tail is cut", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env.local'), 'ACME_DB_PASSWORD=acme-db-hunter2\n');
    writeFileSync(join(dir, '.env.foreman'), 'JIRA_CLIENT_SECRET=acme-client-secret-77\n');
    const r = await runCheckCommand('cat .env.local .env.foreman; echo sk-ant-acmeacmeacme123; echo TOKEN=acme-plain-token; echo $ANTHROPIC_API_KEY; echo done', {
      cwd: dir,
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-acme-env-value' },
      secrets: fileSecrets({ root: dir, config: null }),
    });
    for (const secret of ['acme-db-hunter2', 'acme-client-secret-77', 'sk-ant-acmeacmeacme123', 'sk-ant-acme-env-value', 'acme-plain-token']) expect(r.tail, secret).not.toContain(secret);
    expect(r.tail).toContain('•••');
    expect(r.tail).toContain('done');
  });

  it("blanks the files' values even when no key name is printed beside them", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env.local'), 'ACME_DB_PASSWORD=acme-db-hunter2\n');
    writeFileSync(join(dir, '.env.foreman'), 'JIRA_CLIENT_SECRET=acme-client-secret-77\n');
    // Only fileSecrets knows these bare values: the generic redactor has no key name to go on.
    const r = await runCheckCommand('cut -d= -f2 .env.local .env.foreman; echo done', {
      cwd: dir,
      env: process.env,
      secrets: fileSecrets({ root: dir, config: null }),
    });
    expect(r.tail).not.toContain('acme-db-hunter2');
    expect(r.tail).not.toContain('acme-client-secret-77');
    expect(r.tail).toContain('•••');
    expect(r.tail).toContain('done');
  });

  it('redacts before the tail is cut, so a cut never leaves a piece of a secret', async () => {
    // One line of 4018 characters: a 4000-character cut lands inside the value, past its key name.
    const r = await runCheckCommand(`awk 'BEGIN { s = "ACME_API_TOKEN=acmeleakvalue"; for (i = 0; i < 3990; i++) s = s "z"; print s }'`, { cwd: tempDir(), env: process.env });
    expect(r.passed).toBe(true);
    expect(r.tail).not.toContain('leakvalue');
    expect(r.tail).toContain('ACME_API_TOKEN=•••');
  });

  it('answers at the time limit even when a process outside the group holds the output open', async () => {
    const dir = tempDir();
    // Node's detached spawn calls setsid, so the sleep 20 leaves the group but keeps the pipes.
    // It writes its pid to "ready" once it is running, and sh waits for that file, so the
    // holder exists well before the 3 s limit fires. Only the grace timer can then answer
    // before the sleep 20 ends.
    const holder = "const c=require('child_process').spawn('sleep',['20'],{detached:true,stdio:['ignore','inherit','inherit']});c.unref();require('fs').writeFileSync('ready',String(c.pid))";
    const run = `${JSON.stringify(process.execPath)} -e "${holder}"; while [ ! -f ready ]; do sleep 0.05; done; sleep 30`;
    const started = Date.now();
    try {
      const r = await runCheckCommand(run, { cwd: dir, env: process.env, timeoutMs: 3000, graceMs: 300 });
      expect(Date.now() - started).toBeLessThan(8000);
      expect(existsSync(join(dir, 'ready'))).toBe(true);
      expect(r).toMatchObject({ timedOut: true, passed: false, exitCode: null });
      expect(r.detail).toBe(WORDS.timedOut('3 seconds'));
    } finally {
      try {
        process.kill(Number(readFileSync(join(dir, 'ready'), 'utf8')), 'SIGKILL');
      } catch {
        // the holder never started or has gone
      }
    }
  });

  it('kills what the command left in its group once sh exits', async () => {
    const dir = tempDir();
    const r = await runCheckCommand('(sleep 1; touch left) >/dev/null 2>&1 & echo started', { cwd: dir, env: process.env });
    expect(r.passed).toBe(true);
    expect(r.tail).toContain('started');
    expect(r.detail).toBe(WORDS.passed(r.seconds));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(join(dir, 'left'))).toBe(false);
  });

  it("blanks the values of Foreman's keys and of secret-looking names in the environment", async () => {
    const env = {
      ...process.env,
      JIRA_CLIENT_SECRET: 'acme-jira-secret-value-1234',
      ACME_DATABASE_URL: 'postgres://u:acme-db-pass@h/db',
      GEARSET_API_TOKEN: 'acme-gearset-tok-99',
      ACME_FLAG_KEY: '1',
    };
    // The values are printed bare, with no NAME= beside them.
    const r = await runCheckCommand(`printf '%s\\n' "$JIRA_CLIENT_SECRET" "$ACME_DATABASE_URL" "$GEARSET_API_TOKEN"; echo count 1; echo done`, { cwd: tempDir(), env });
    for (const secret of ['acme-jira-secret-value-1234', 'postgres://u:acme-db-pass@h/db', 'acme-db-pass', 'acme-gearset-tok-99']) expect(r.tail, secret).not.toContain(secret);
    expect(r.tail).toContain('•••');
    // The short flag value is not blanked, so ordinary output stays.
    expect(r.tail).toContain('count 1');
    expect(r.tail).toContain('done');
  });

  it('says so when the command cannot start', async () => {
    const r = await runCheckCommand('true', { cwd: join(tempDir(), 'not-there'), env: process.env });
    expect(r.passed).toBe(false);
    expect(r.detail).toBe(WORDS.couldNotStart);
  });
});

describe('envSecrets', () => {
  it("picks values by Foreman's key names and by secret-looking names", () => {
    const got = envSecrets({ RESEND_API_KEY: 're_acme_key_123', JIRA_CLIENT_ID: 'acme-client-id-000', ACME_SERVICE_URL: 'https://acme.example/x', acme_password: 'acme-pass-word' });
    expect(got.sort()).toEqual(['acme-client-id-000', 'acme-pass-word', 'https://acme.example/x', 're_acme_key_123']);
  });

  it('leaves out short values, the email addresses and ordinary names', () => {
    expect(
      envSecrets({
        ACME_SHORT_TOKEN: 'short',
        ACME_FLAG_KEY: '1',
        RESEND_FROM_EMAIL: 'robot@acme.example',
        FOREMAN_NOTIFY_EMAIL: 'owner@acme.example',
        FACTORY_NOTIFY_EMAIL: 'owner@acme.example',
        PATH: '/usr/bin:/bin:/opt/acme/bin',
        HOME: '/home/acme-owner',
      }),
    ).toEqual([]);
  });

  it('gives each value once', () => {
    expect(envSecrets({ ACME_TOKEN: 'acme-same-value', ACME_SECRET: 'acme-same-value', GH_TOKEN: 'acme-same-value' })).toEqual(['acme-same-value']);
  });

  it('is empty with no environment', () => {
    expect(envSecrets(undefined)).toEqual([]);
  });
});

describe('fileSecrets', () => {
  it('is empty when neither file is there', () => {
    expect(fileSecrets({ root: tempDir(), config: null })).toEqual([]);
  });

  it('reads both files, the configured names first, and skips values under 4 characters', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'acme.env'), 'ACME_SHORT=abc\nACME_LONG=acme-long-value\n');
    writeFileSync(join(dir, 'acme-own.env'), 'JIRA_CLIENT_SECRET=acme-own-secret\n');
    expect(fileSecrets({ root: dir, config: { envFile: 'acme.env', foremanEnvFile: 'acme-own.env' } }).sort()).toEqual(['acme-long-value', 'acme-own-secret']);
    writeFileSync(join(dir, '.env.local'), 'ACME_ONE=abcd\n');
    expect(fileSecrets({ root: dir, config: null })).toEqual(['abcd']);
  });
});

describe('PROJECT_FORM.change: what Foreman uses, on a project that has a config', () => {
  it('names the source, pack, alias and org ID fields, with the pack only for an sfdx project', () => {
    const c = PROJECT_FORM.change;
    expect(c.fields.map((f) => f.id)).toEqual(['source', 'pack', 'alias', 'orgId']);
    const field = (id) => c.fields.find((f) => f.id === id);
    expect(field('source').options).toEqual([
      { value: 'markdown', label: 'Markdown files' },
      { value: 'jira', label: 'Jira' },
      { value: 'salesforce', label: 'Salesforce Cases' },
    ]);
    expect(field('source').help).toContain('Salesforce Cases: needs the Salesforce pack; Foreman saves a starter filter of open Cases of Type Foreman.');
    expect(field('pack').options.map((o) => o.value)).toEqual(['none', 'salesforce']);
    expect(field('pack').when).toEqual({ sfdx: true });
    expect(field('alias').when).toEqual({ pack: 'salesforce', packNow: 'none' });
    expect(field('orgId').when).toEqual({ pack: 'salesforce', packNow: 'none' });
    for (const k of ['title', 'save', 'saving', 'saved']) expect(typeof c[k], k).toBe('string');
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
    expect(Object.isFrozen(c.fields[1].options[0])).toBe(true);
  });

  it('starts the Jira filter with one that runs on any site', () => {
    expect(STARTER_JQL).toBe('labels = foreman AND statusCategory != Done ORDER BY Rank');
    expect(SANDBOX_STAGE).toBe('qa');
  });

  it('starts the Salesforce Cases filter with open Cases of Type Foreman', () => {
    expect(STARTER_WHERE).toBe("IsClosed = false AND Type = 'Foreman'");
  });
});

describe('projectChange', () => {
  const MD = { version: 1, project: { name: 'Acme' }, stories: { adapter: 'markdown', dir: 'stories' }, ship: { steps: [...DEFAULTS.ship.steps], ci: { required: [] } } };
  const JIRA_RAW = { ...MD, stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME' } };
  const BLOCK = { orgs: { dev: { orgId: '00D000000000001' } }, build: 'dev', stages: [{ name: 'qa', org: 'dev' }] };
  const ctx = (more = {}) => ({ sfdx: false, site: null, packs: PACKS, ...more });
  const refused = (raw, change, more) => {
    const r = projectChange(raw, change, ctx(more));
    expect(r.ok, JSON.stringify(r)).toBe(false);
    return r.errors;
  };
  // The edits applied to the file as the server applies them, through the team layer.
  function applied(raw, edits) {
    const dir = tempDir();
    writeFileSync(join(dir, 'foreman.config.json'), `${JSON.stringify(raw, null, 2)}\n`);
    expect(teamApply(dir, edits)).toEqual({ errors: [] });
    const loaded = loadConfig(dir);
    expect(loaded.errors ?? []).toEqual([]);
    return readTeam(dir).raw;
  }

  it('turns markdown into Jira with a starter filter and no site when none is signed in', () => {
    const r = projectChange(MD, { source: 'jira' }, ctx());
    expect(r).toEqual({
      ok: true,
      edits: [{ name: 'stories', value: { adapter: 'jira', jql: STARTER_JQL } }],
      lines: ['set stories.adapter to jira', 'set stories.jql to a starter filter; narrow it on the Jira site and filter screen', COMMIT_REMINDER],
    });
    expect(applied(MD, r.edits).stories).toEqual({ adapter: 'jira', jql: STARTER_JQL });
  });

  it('adds the one signed-in site', () => {
    const r = projectChange(MD, { source: 'jira' }, ctx({ site: 'acme.atlassian.net' }));
    expect(r.edits).toEqual([{ name: 'stories', value: { adapter: 'jira', site: 'acme.atlassian.net', jql: STARTER_JQL } }]);
    expect(r.lines).toContain('set stories.site to acme.atlassian.net');
    expect(r.lines.at(-1)).toBe(COMMIT_REMINDER);
  });

  it('changes nothing when the source is already the one picked', () => {
    expect(projectChange(JIRA_RAW, { source: 'jira' }, ctx())).toEqual({ ok: true, edits: [], lines: [WORDS.nothingChanged] });
    expect(projectChange(MD, { source: 'markdown', pack: 'none' }, ctx({ sfdx: true }))).toEqual({ ok: true, edits: [], lines: [WORDS.nothingChanged] });
    expect(projectChange(MD, {}, ctx())).toEqual({ ok: true, edits: [], lines: [WORDS.nothingChanged] });
    const { stories, ...noStories } = MD;
    expect(projectChange(noStories, { source: 'markdown' }, ctx())).toEqual({ ok: true, edits: [], lines: [WORDS.nothingChanged] });
  });

  it('turns Jira back into markdown files in the stories folder', () => {
    const r = projectChange(JIRA_RAW, { source: 'markdown' }, ctx());
    expect(r.edits).toEqual([{ name: 'stories', value: { adapter: 'markdown', dir: 'stories' } }]);
    expect(r.lines).toEqual(['set stories.adapter to markdown (folder stories)', COMMIT_REMINDER]);
    expect(applied(JIRA_RAW, r.edits).stories).toEqual({ adapter: 'markdown', dir: 'stories' });
  });

  it("turns the Salesforce pack on with one sandbox and the pack's ship steps", () => {
    const r = projectChange(MD, { pack: 'salesforce', alias: ' dev ', orgId: ' 00D000000000001 ' }, ctx({ sfdx: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const d = PACKS.salesforce.defaults(BLOCK);
    expect(r.edits).toEqual([
      { name: 'pack', value: 'salesforce' },
      { name: 'salesforce', value: BLOCK },
      { name: 'ship.steps', value: d.ship.steps },
      { name: 'ship.rollback', value: d.ship.rollback },
    ]);
    expect(d.ship.steps).toContain('sf-org-guard');
    expect(r.lines).toEqual([
      'set pack to salesforce',
      `added the salesforce block: sandbox dev builds and releases (stage ${SANDBOX_STAGE})`,
      "set ship.steps to the Salesforce pack's steps",
      COMMIT_REMINDER,
    ]);
    const raw = applied(MD, r.edits);
    expect(raw.pack).toBe('salesforce');
    expect(raw.ship.steps).toContain('sf-org-guard');
  });

  it('with the project folder, leaves ci out of the pack steps when no workflow runs on pull requests', () => {
    const root = tempDir();
    const r = projectChange(MD, { pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' }, ctx({ sfdx: true, root }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const steps = r.edits.find((e) => e.name === 'ship.steps').value;
    expect(steps).not.toContain('ci');
    expect(steps).toContain('sf-validate');
    expect(steps).toEqual(PACKS.salesforce.defaults(BLOCK).ship.steps.filter((s) => s !== 'ci'));
  });

  it('with the project folder, keeps ci when a workflow runs on pull_request', () => {
    const root = tempDir();
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\non: pull_request\njobs: {}\n');
    const r = projectChange(MD, { pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' }, ctx({ sfdx: true, root }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.edits.find((e) => e.name === 'ship.steps').value).toEqual(PACKS.salesforce.defaults(BLOCK).ship.steps);
    expect(r.edits.find((e) => e.name === 'ship.steps').value).toContain('ci');
  });

  it('refuses the pack without sfdx-project.json, and without a sandbox', () => {
    expect(refused(MD, { pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' })).toEqual([WORDS.noSalesforce]);
    expect(refused(MD, { pack: 'salesforce', alias: '  ', orgId: '00D000000000001' }, { sfdx: true })).toEqual([WORDS.needSandbox]);
    expect(refused(MD, { pack: 'salesforce', alias: 'dev' }, { sfdx: true })).toEqual([WORDS.needSandbox]);
  });

  it('refuses an alias without a pack turn-on, an unknown key, a value that is not text and an unknown source', () => {
    expect(refused(MD, { alias: 'dev' })).toEqual([WORDS.unknownChange]);
    const on = { ...MD, pack: 'salesforce', salesforce: BLOCK };
    expect(refused(on, { pack: 'salesforce', orgId: '00D000000000001' }, { sfdx: true })).toEqual([WORDS.unknownChange]);
    const unknown = refused(MD, { source: 'jira', acmeSecret: 'x' });
    expect(unknown).toEqual([WORDS.unknownChange]);
    expect(JSON.stringify(unknown)).not.toContain('acmeSecret');
    expect(refused(MD, { source: 3 })).toEqual([WORDS.changeNotText]);
    expect(refused(MD, { source: ['jira'] })).toEqual([WORDS.changeNotText]);
    // The change form has no CI jobs, so its word does not name them.
    expect(WORDS.changeNotText).not.toMatch(/CI jobs/);
    expect(refused(MD, { source: 'confluence' })).toEqual([WORDS.pickSource]);
    expect(refused(MD, ['source'])).toEqual([WORDS.badChange]);
    expect(refused(MD, null)).toEqual([WORDS.badChange]);
  });

  // A name every object already has would set the orgs' prototype or hide a method, so the
  // config check refuses it and nothing is written.
  it.each(['__proto__', 'constructor'])('turns the pack on with the alias %s, which the config then refuses', (alias) => {
    const r = projectChange(MD, { pack: 'salesforce', alias, orgId: '00D000000000001' }, ctx({ sfdx: true }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const dir = tempDir();
    writeFileSync(join(dir, 'foreman.config.json'), `${JSON.stringify(MD, null, 2)}\n`);
    const before = readFileSync(join(dir, 'foreman.config.json'));
    const { errors } = teamApply(dir, r.edits);
    expect(errors.some((e) => e.startsWith(`salesforce.orgs.${alias}: `)), JSON.stringify(errors)).toBe(true);
    expect(readFileSync(join(dir, 'foreman.config.json')).equals(before)).toBe(true);
  });

  describe('Salesforce Cases as the story source', () => {
    const d = PACKS.salesforce.defaults(BLOCK);
    const ON = { ...MD, pack: 'salesforce', salesforce: BLOCK, ship: { steps: d.ship.steps, ci: { required: [] }, rollback: d.ship.rollback }, env: { adapter: 'sandbox-pool' } };
    const CASES = { adapter: 'salesforce', org: 'dev', where: STARTER_WHERE };
    const LINES = ['set stories.adapter to salesforce (Cases in dev)', 'set stories.where to a starter filter: open Cases of Type Foreman; change it in foreman.config.json'];

    it('turns markdown into Salesforce Cases in the first sandbox, with a starter filter', () => {
      const r = projectChange(ON, { source: 'salesforce' }, ctx({ sfdx: true }));
      expect(r).toEqual({ ok: true, edits: [{ name: 'stories', value: CASES }], lines: [...LINES, COMMIT_REMINDER] });
      expect(applied(ON, r.edits).stories).toEqual(CASES);
    });

    it('turns Jira into Salesforce Cases, and Cases back into markdown', () => {
      const jira = { ...ON, stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME' } };
      expect(projectChange(jira, { source: 'salesforce' }, ctx()).edits).toEqual([{ name: 'stories', value: CASES }]);
      const cases = { ...ON, stories: CASES };
      const back = projectChange(cases, { source: 'markdown' }, ctx());
      expect(back.edits).toEqual([{ name: 'stories', value: { adapter: 'markdown', dir: 'stories' } }]);
      expect(applied(cases, back.edits).stories).toEqual({ adapter: 'markdown', dir: 'stories' });
    });

    it('takes the first org that is not production and not named prod or production', () => {
      const orgs = { 'acme-main': { orgId: '00D000000000004', production: true }, prod: { orgId: '00D000000000005' }, production: { orgId: '00D000000000006' }, 'acme-qa': { orgId: '00D000000000002' }, 'acme-uat': { orgId: '00D000000000003' } };
      const r = projectChange({ ...MD, pack: 'salesforce', salesforce: { ...BLOCK, orgs } }, { source: 'salesforce' }, ctx());
      expect(r.edits).toEqual([{ name: 'stories', value: { adapter: 'salesforce', org: 'acme-qa', where: STARTER_WHERE } }]);
    });

    it('uses the sandbox of the same change when it turns the pack on', () => {
      const r = projectChange(MD, { source: 'salesforce', pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' }, ctx({ sfdx: true }));
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.edits.find((e) => e.name === 'stories').value).toEqual(CASES);
      expect(r.edits.map((e) => e.name)).toEqual(expect.arrayContaining(['pack', 'salesforce', 'ship.steps']));
      expect(r.lines).toEqual(expect.arrayContaining(LINES));
      expect(r.lines.at(-1)).toBe(COMMIT_REMINDER);
      const raw = applied(MD, r.edits);
      expect(raw.stories).toEqual(CASES);
      expect(raw.pack).toBe('salesforce');
    });

    it('is refused without the pack, and with the pack turned off in the same change', () => {
      expect(refused(MD, { source: 'salesforce' }, { sfdx: true })).toEqual([WORDS.needSalesforcePack]);
      expect(refused(MD, { source: 'salesforce', pack: 'none' }, { sfdx: true })).toEqual([WORDS.needSalesforcePack]);
      expect(refused(ON, { source: 'salesforce', pack: 'none' }, { sfdx: true })).toEqual([WORDS.needSalesforcePack]);
      expect(WORDS.needSalesforcePack).toBe('Salesforce Cases need the Salesforce pack: turn it on, with the sandbox that holds the Cases.');
    });

    it('is refused when every org is production, or there is none', () => {
      const prodOnly = { ...MD, pack: 'salesforce', salesforce: { orgs: { 'acme-main': { orgId: '00D000000000004', production: true }, prod: { orgId: '00D000000000005' } } } };
      expect(refused(prodOnly, { source: 'salesforce' })).toEqual([WORDS.noCasesOrg]);
      expect(refused({ ...MD, pack: 'salesforce' }, { source: 'salesforce' })).toEqual([WORDS.noCasesOrg]);
      expect(WORDS.noCasesOrg).toBe('Add a sandbox to salesforce.orgs first: Foreman never reads Cases from a production org.');
    });

    it('changes nothing when the stories already come from Salesforce', () => {
      expect(projectChange({ ...ON, stories: CASES }, { source: 'salesforce' }, ctx())).toEqual({ ok: true, edits: [], lines: [WORDS.nothingChanged] });
    });

    it('refuses to turn the pack off while the stories come from Salesforce, unless the same change moves them', () => {
      const cases = { ...ON, stories: CASES };
      expect(refused(cases, { pack: 'none' }, { sfdx: true })).toEqual([WORDS.casesNeedPack]);
      expect(WORDS.casesNeedPack).toBe('The stories come from Salesforce Cases: pick another story source before turning the pack off.');
      for (const source of ['markdown', 'jira']) {
        const r = projectChange(cases, { source, pack: 'none' }, ctx({ sfdx: true }));
        expect(r.ok, source).toBe(true);
        expect(r.edits.map((e) => e.name), source).toEqual(expect.arrayContaining(['stories', 'pack']));
      }
      // Cases stay with the pack on; other sources turn the pack off as before.
      expect(projectChange(ON, { pack: 'none' }, ctx({ sfdx: true })).ok).toBe(true);
    });

    it('leaves the first-run form refusing Salesforce Cases', () => {
      const answers = { ...MARKDOWN.answers, source: 'salesforce' };
      expect(errorsOf(detect(acmeRepo()), answers)).toEqual([WORDS.pickSource]);
      expect(PROJECT_FORM.fields.find((f) => f.id === 'source').options.map((o) => o.value)).toEqual(['markdown', 'jira']);
    });
  });

  it("turns the pack off: no pack, no salesforce block, Foreman's own steps, and no pack rollback or slot pool", () => {
    const d = PACKS.salesforce.defaults(BLOCK);
    const on = { ...MD, pack: 'salesforce', salesforce: BLOCK, env: { adapter: 'sandbox-pool' }, ship: { steps: d.ship.steps, ci: { required: [] }, rollback: d.ship.rollback } };
    const r = projectChange(on, { pack: 'none' }, ctx({ sfdx: true }));
    expect(r.edits).toEqual([
      { name: 'pack', remove: true },
      { name: 'salesforce', remove: true },
      { name: 'ship.steps', value: DEFAULTS.ship.steps },
      { name: 'ship.rollback', remove: true },
      { name: 'env', remove: true },
    ]);
    expect(r.lines).toEqual(['removed pack and the salesforce block', "set ship.steps to Foreman's own steps", COMMIT_REMINDER]);
    const raw = applied(on, r.edits);
    expect(raw).toEqual({ ...MD, ship: { steps: DEFAULTS.ship.steps, ci: { required: [] } } });
  });
});
