import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { openProjectStories } from '../../engine/story-source.mjs';
import { openConsole } from '../../engine/console.mjs';
import { loadConfig } from '../../config/load.mjs';
import { create as emailResend } from '../../adapters/notify/email-resend.mjs';
import { REGISTRY } from '../../settings/registry.mjs';

let dir;
const configFile = () => join(dir, 'foreman.config.json');
const localFile = () => join(dir, '.foreman', 'settings.json');
const writeConfig = (raw) => writeFileSync(configFile(), `${JSON.stringify(raw, null, 2)}\n`);
const config = () => JSON.parse(readFileSync(configFile(), 'utf8'));
const local = () => JSON.parse(readFileSync(localFile(), 'utf8'));
const BASE = { version: 1, project: { name: 'T' }, slots: 2 };
const ACME_SF = {
  version: 1,
  project: { name: 'Acme' },
  pack: 'salesforce',
  salesforce: {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-settings-'));
  mkdirSync(join(dir, 'stories'));
  writeConfig(BASE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

// After a --team write the config still passes `foreman config check`.
async function checkOk() {
  const { code, out } = await run(['config', 'check']);
  expect(out).toBe('ok\n');
  expect(code).toBe(0);
}

const row = (out, name) => out.split('\n').find((l) => l.split(/\s+/)[0] === name);

describe('foreman settings list', () => {
  it('lists each setting that applies here with its value, source and when it applies', async () => {
    const { code, out } = await run(['settings', 'list']);
    expect(code).toBe(0);
    expect(row(out, 'slots')).toMatch(/^slots\s+2\s+\(team\)\s+restart$/);
    expect(row(out, 'rounds')).toMatch(/^rounds\s+3\s+\(default\)\s+next-story$/);
    expect(row(out, 'features.followUps')).toMatch(/^features\.followUps\s+true\s+\(default\)\s+next-story$/);
    expect(row(out, 'ship.smoke.urls')).toMatch(/^ship\.smoke\.urls\s+\[\]\s+\(default\)\s+next-story$/);
    expect(row(out, 'console.host')).toMatch(/^console\.host\s+127\.0\.0\.1\s+\(default\)\s+restart$/);
  });

  it('hides the settings that do not apply, such as the Jira ones with markdown stories', async () => {
    const { out } = await run(['settings', 'list']);
    for (const name of ['stories.jql', 'stories.pollSeconds', 'stories.ownerLabel', 'stories.transitions', 'notify.to', 'ship.watch.minutes']) expect(row(out, name), name).toBeUndefined();
  });

  it('shows the Jira settings when the story source is Jira', async () => {
    writeConfig({ ...BASE, stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = X' } });
    const { out } = await run(['settings', 'list', '--group', 'jira']);
    expect(row(out, 'stories.jql')).toMatch(/^stories\.jql\s+project = X\s+\(team\)\s+next-story$/);
    expect(row(out, 'stories.pollSeconds')).toMatch(/\s60\s+\(default\)/);
    expect(row(out, 'stories.transitions')).toMatch(/\s\{\}\s+\(default\)/);
  });

  it('--group shows one group', async () => {
    const { out } = await run(['settings', 'list', '--group', 'features']);
    const names = out.trim().split('\n').map((l) => l.split(/\s+/)[0]);
    expect(names).toEqual(REGISTRY.filter((e) => e.group === 'features').map((e) => e.name));
  });

  it('--json gives the rows as JSON', async () => {
    const { code, out } = await run(['settings', 'list', '--group', 'run', '--json']);
    expect(code).toBe(0);
    const rows = JSON.parse(out);
    expect(rows.map((r) => r.name)).toEqual(['workers', 'slots', 'rounds', 'watchdog.quietMinutes', 'watchdog.buildMinutes', 'claude.fallback', 'checkRuns.maxParallel']);
    expect(rows[1]).toMatchObject({ name: 'slots', value: 2, source: 'team', applies: 'restart', group: 'run', type: 'integer', default: 1, label: 'Slots' });
  });

  it('refuses an unknown group', async () => {
    const { code, err } = await run(['settings', 'list', '--group', 'nope']);
    expect(code).toBe(64);
    expect(err).toContain('run, models, features, learning, release, jira, notify, console');
  });

  it("lists, sets and resets each agent role's model", async () => {
    const listed = await run(['settings', 'list', '--group', 'models']);
    expect(listed.code).toBe(0);
    expect(listed.out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0])).toEqual([
      'session.model', 'roles.architect.model', 'roles.builders.developer.model', 'roles.tester.model', 'roles.reviewers.compliance.model', 'roles.reviewers.compliance.engine', 'roles.reviewers.security.model', 'roles.reviewers.security.engine',
    ]);
    expect(await run(['settings', 'set', 'roles.reviewers.security.model', 'haiku', '--team'])).toMatchObject({ code: 0, err: '' });
    expect(config().roles.reviewers[1]).toEqual({ name: 'security', agent: 'foreman:security-reviewer', model: 'haiku' });
    await checkOk();
    expect((await run(['settings', 'get', 'roles.reviewers.security.model'])).out).toBe('"haiku"\n');
    expect((await run(['settings', 'reset', 'roles.reviewers.security.model', '--team'])).code).toBe(0);
    expect(config().roles.reviewers[1]).toEqual({ name: 'security', agent: 'foreman:security-reviewer' });
    expect(await run(['settings', 'set', 'roles.tester.model', 'gpt'])).toMatchObject({ code: 1, err: 'roles.tester.model: must be one of haiku, sonnet, opus, fable\n' });
    expect(await run(['settings', 'get', 'roles.reviewers.ux.model'])).toMatchObject({ code: 1, err: 'roles.reviewers.ux.model applies only when the project has a reviewer named ux\n' });
  });

  it("sets and resets a reviewer's engine, locally and for the team", async () => {
    expect(await run(['settings', 'set', 'roles.reviewers.security.engine', 'antigravity:claude-opus-4-6-thinking'])).toMatchObject({ code: 0, err: '' });
    expect((await run(['settings', 'get', 'roles.reviewers.security.engine'])).out).toBe('"antigravity:claude-opus-4-6-thinking"\n');
    expect(config().roles).toBeUndefined();
    expect((await run(['settings', 'reset', 'roles.reviewers.security.engine'])).code).toBe(0);
    expect(await run(['settings', 'set', 'roles.reviewers.security.engine', 'antigravity:claude-opus-4-6-thinking', '--team'])).toMatchObject({ code: 0, err: '' });
    expect(config().roles.reviewers[1]).toEqual({ name: 'security', agent: 'foreman:security-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } });
    await checkOk();
    expect(await run(['settings', 'set', 'roles.reviewers.security.engine', 'antigravity', '--team'])).toMatchObject({ code: 1, err: 'roles.reviewers.security.engine: expected engine:model, the engine being antigravity, such as antigravity:claude-opus-4-6-thinking\n' });
    expect((await run(['settings', 'reset', 'roles.reviewers.security.engine', '--team'])).code).toBe(0);
    expect(config().roles.reviewers[1]).toEqual({ name: 'security', agent: 'foreman:security-reviewer' });
  });

  it('warns about a local value it ignores', async () => {
    mkdirSync(join(dir, '.foreman'));
    writeFileSync(localFile(), JSON.stringify({ rounds: 99 }));
    const { out, err } = await run(['settings', 'list']);
    expect(row(out, 'rounds')).toMatch(/\(default\)/);
    expect(err).toContain('warning: local setting rounds ignored: must be a whole number from 1 to 10');
  });

  it('says why when the config is invalid', async () => {
    writeConfig({ version: 1 });
    const { code, err } = await run(['settings', 'list']);
    expect(code).toBe(1);
    expect(err).toContain('project.name');
  });
});

describe('foreman settings: the learning group', () => {
  const LEARNING = ['auto', 'apply', 'model', 'skillModel', 'window', 'maxPerRole', 'maxSkills', 'maxEvaluating', 'maxPerDay', 'maxUsdPerDay', 'redact'].map((k) => `learning.${k}`);

  it('list --group learning lists exactly the learning settings', async () => {
    const { code, out } = await run(['settings', 'list', '--group', 'learning']);
    expect(code).toBe(0);
    expect(out.trim().split('\n').map((l) => l.split(/\s+/)[0])).toEqual(LEARNING);
  });

  it('sets learning.auto on the local layer and reads it back', async () => {
    const { code } = await run(['settings', 'set', 'learning.auto', 'false']);
    expect(code).toBe(0);
    expect(local()).toEqual({ 'learning.auto': false });
    expect((await run(['settings', 'get', 'learning.auto'])).out).toBe('false\n');
  });

  it('sets learning.auto on the team layer, and the config still checks', async () => {
    const { code } = await run(['settings', 'set', 'learning.auto', 'false', '--team']);
    expect(code).toBe(0);
    expect(config().learning).toEqual({ auto: false });
    await checkOk();
  });

  it('refuses a short window and an unknown model, and writes nothing', async () => {
    for (const [name, value, why] of [['learning.window', '2', 'must be a whole number of at least 3'], ['learning.model', 'gpt-4', 'must be one of haiku, sonnet, opus']]) {
      const { code, err } = await run(['settings', 'set', name, value]);
      expect(code, name).toBe(1);
      expect(err).toContain(`${name}: ${why}`);
    }
    expect(existsSync(localFile())).toBe(false);
  });
});

describe('foreman settings get', () => {
  it('prints the effective value as JSON', async () => {
    expect(await run(['settings', 'get', 'slots'])).toEqual({ code: 0, out: '2\n', err: '' });
    expect((await run(['settings', 'get', 'console.host'])).out).toBe('"127.0.0.1"\n');
    expect((await run(['settings', 'get', 'features.followUpsOfFollowUps'])).out).toBe('false\n');
    expect((await run(['settings', 'get', 'features.autoApplyDependsOn'])).out).toBe('false\n');
  });
  it('refuses an unknown name', async () => {
    const { code, err } = await run(['settings', 'get', 'nope']);
    expect(code).toBe(1);
    expect(err).toContain('unknown setting: nope');
  });
  it('needs a name', async () => expect((await run(['settings', 'get'])).code).toBe(64));
});

describe('foreman settings set and reset: the local layer', () => {
  it('writes the value to the state folder, not the config', async () => {
    const before = readFileSync(configFile(), 'utf8');
    const { code, out } = await run(['settings', 'set', 'rounds', '5']);
    expect(code).toBe(0);
    expect(out).toBe('rounds = 5 (local; applies next-story)\n');
    expect(local()).toEqual({ rounds: 5 });
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    expect((await run(['settings', 'get', 'rounds'])).out).toBe('5\n');
    expect(row((await run(['settings', 'list'])).out, 'rounds')).toMatch(/^rounds\s+5\s+\(local\)/);
  });

  it('reads lists and maps', async () => {
    await run(['settings', 'set', 'ship.smoke.urls', 'https://a.com,https://b.com']);
    expect(local()['ship.smoke.urls']).toEqual(['https://a.com', 'https://b.com']);
  });

  it('checks the value against the type and limits, and writes nothing when it is wrong', async () => {
    for (const [name, value, why] of [['rounds', '11', 'must be a whole number from 1 to 10'], ['rounds', 'x', 'expected a number'], ['features.followUps', 'maybe', 'expected true or false'], ['workers', '3', 'must be a whole number from 1 to 2']]) {
      const { code, err } = await run(['settings', 'set', name, value]);
      expect(code, name).toBe(1);
      expect(err).toContain(`${name}: ${why}`);
    }
    expect(existsSync(localFile())).toBe(false);
  });

  it('refuses a ship.pr.into that is not a branch name on the local layer too', async () => {
    for (const value of ['a..b', 'qa:main', 'a b']) {
      const { code, err } = await run(['settings', 'set', 'ship.pr.into', value]);
      expect(code, value).toBe(1);
      expect(err).toContain('ship.pr.into: expected a branch name');
    }
    expect(existsSync(localFile())).toBe(false);
    expect((await run(['settings', 'set', 'ship.pr.into', 'qa'])).code).toBe(0);
    expect(local()).toEqual({ 'ship.pr.into': 'qa' });
  });

  it("refuses a ship.pr.into that is the salesforce pack's productionBranch, on both layers", async () => {
    writeConfig(ACME_SF);
    const before = readFileSync(configFile(), 'utf8');
    const local1 = await run(['settings', 'set', 'ship.pr.into', 'main']);
    expect(local1.code).toBe(1);
    expect(local1.err).toContain('ship.pr.into: must not be salesforce.productionBranch: nothing merges into production');
    expect(existsSync(localFile())).toBe(false);
    const team = await run(['settings', 'set', 'ship.pr.into', 'main', '--team']);
    expect(team.code).toBe(1);
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    expect((await run(['settings', 'set', 'ship.pr.into', 'release'])).code).toBe(0);
    expect(local()).toEqual({ 'ship.pr.into': 'release' });
  });

  it('lets a local workers go up to a local slots', async () => {
    await run(['settings', 'set', 'slots', '4']);
    expect((await run(['settings', 'set', 'workers', '3'])).code).toBe(0);
    expect((await run(['settings', 'get', 'workers'])).out).toBe('3\n');
  });

  it('refuses a setting that does not apply to this project', async () => {
    const { code, err } = await run(['settings', 'set', 'stories.jql', 'project = X']);
    expect(code).toBe(1);
    expect(err).toContain('stories.jql applies only when stories.adapter is "jira"');
    expect(existsSync(localFile())).toBe(false);
  });

  it('refuses an unknown name, and a secret-looking one with its own reason', async () => {
    expect((await run(['settings', 'set', 'nope', '1'])).err).toContain('unknown setting: nope');
    for (const name of ['RESEND_API_KEY', 'stories.token', 'notify.password']) {
      const { code, err } = await run(['settings', 'set', name, 'abc']);
      expect(code).toBe(1);
      expect(err).toContain(`${name} looks like a secret`);
      expect(err).not.toContain('abc');
    }
    expect(existsSync(localFile())).toBe(false);
  });

  it('reset removes the local value, and says so when there was none', async () => {
    writeConfig({ ...BASE, rounds: 4 });
    await run(['settings', 'set', 'rounds', '6']);
    const { code, out } = await run(['settings', 'reset', 'rounds']);
    expect(code).toBe(0);
    expect(out).toBe('rounds: local value removed; now 4 (team)\n');
    expect(local()).toEqual({});
    expect((await run(['settings', 'reset', 'rounds'])).out).toBe('rounds has no local value\n');
  });

  it('needs a name and a value', async () => {
    expect((await run(['settings', 'set', 'rounds'])).code).toBe(64);
    expect((await run(['settings', 'set'])).code).toBe(64);
    expect((await run(['settings', 'reset'])).code).toBe(64);
    expect((await run(['settings', 'wat'])).code).toBe(64);
    expect((await run(['settings'])).code).toBe(64);
  });
});

describe('foreman settings set and reset --team: the config file', () => {
  it('writes foreman.config.json, keeps its other keys and 2-space formatting, and reminds you to commit it', async () => {
    writeConfig({ ...BASE, checks: [{ run: 'npm test', when: 'always' }] });
    const { code, out } = await run(['settings', 'set', 'rounds', '5', '--team']);
    expect(code).toBe(0);
    expect(out).toBe('rounds = 5 (team; applies next-story)\nforeman.config.json changed; commit it so the team gets it\n');
    expect(readFileSync(configFile(), 'utf8')).toBe(`${JSON.stringify({ ...BASE, checks: [{ run: 'npm test', when: 'always' }], rounds: 5 }, null, 2)}\n`);
    expect(existsSync(localFile())).toBe(false);
    await checkOk();
  });

  it('refuses a change that would make the config invalid, and leaves the file alone', async () => {
    const before = readFileSync(configFile(), 'utf8');
    const { code, err } = await run(['settings', 'set', 'workers', '3', '--team']);
    expect(code).toBe(1);
    expect(err).toContain('workers: must be a whole number from 1 to 2');
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
  });

  it('refuses a change only the whole config can catch, such as slots below workers', async () => {
    writeConfig({ ...BASE, workers: 2 });
    const { code, err } = await run(['settings', 'set', 'slots', '1', '--team']);
    expect(code).toBe(1);
    expect(err).toContain('foreman.config.json would be invalid: workers: must not be more than slots (1)');
    expect(config().slots).toBe(2);
  });

  it('notes when a local value still wins on this machine', async () => {
    await run(['settings', 'set', 'rounds', '6']);
    const { out } = await run(['settings', 'set', 'rounds', '5', '--team']);
    expect(out).toContain('note: the local value 6 still wins on this machine; `foreman settings reset rounds` drops it');
  });

  it('reset --team removes the value from the file', async () => {
    await run(['settings', 'set', 'features.followUps', 'false', '--team']);
    expect(config().features).toEqual({ followUps: false });
    const { code, out } = await run(['settings', 'reset', 'features.followUps', '--team']);
    expect(code).toBe(0);
    expect(out).toBe('features.followUps: team value removed; now true (default)\nforeman.config.json changed; commit it so the team gets it\n');
    expect(config()).toEqual(BASE);
    expect((await run(['settings', 'reset', 'features.followUps', '--team'])).out).toBe('features.followUps has no team value\n');
    await checkOk();
  });

  describe('settings inside an adapter block keep the adapter happy', () => {
    it('ship.ci, ship.deploy-github and ship.smoke', async () => {
      for (const [name, value] of [['ship.ci.timeoutMinutes', '45'], ['ship.ci.settleSeconds', '30'], ['ship.deploy-github.timeoutMinutes', '20'], ['ship.smoke.urls', 'https://a.com']]) {
        expect((await run(['settings', 'set', name, value, '--team'])).code, name).toBe(0);
        await checkOk();
      }
      expect(config().ship).toMatchObject({ steps: ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'], ci: { required: [], timeoutMinutes: 45, settleSeconds: 30 }, 'deploy-github': { timeoutMinutes: 20 }, smoke: { urls: ['https://a.com'] } });
    });

    it('ship.watch, once a watch is configured', async () => {
      expect((await run(['settings', 'set', 'ship.watch.minutes', '5', '--team'])).err).toContain('applies only when ship.watch is configured');
      writeConfig({ ...BASE, ship: { steps: ['pr', 'watch'], watch: { command: 'true' } } });
      expect((await run(['settings', 'set', 'ship.watch.minutes', '5', '--team'])).code).toBe(0);
      expect((await run(['settings', 'set', 'ship.watch.everySeconds', '30', '--team'])).code).toBe(0);
      await checkOk();
      expect(config().ship.watch).toEqual({ command: 'true', minutes: 5, everySeconds: 30 });
    });

    it('console.port and console.host, and the console still opens', async () => {
      expect((await run(['settings', 'set', 'console.port', '5000', '--team'])).code).toBe(0);
      expect((await run(['settings', 'set', 'console.host', '0.0.0.0', '--team'])).code).toBe(0);
      await checkOk();
      expect(config().console).toEqual({ adapter: 'dashboard', host: '0.0.0.0', port: 5000 });
      expect(() => openConsole({ config: loadConfig(dir).config, ctx: { stateDir: join(dir, '.foreman') } })).not.toThrow();
    });

    it('console.* is refused for a console that does not take them', async () => {
      writeConfig({ ...BASE, console: { adapter: 'artifacts', commandCenterUrl: 'https://x', decisionsUrl: 'https://y' } });
      expect((await run(['settings', 'set', 'console.port', '5000', '--team'])).err).toContain('applies only when console.adapter is "dashboard"');
      expect((await run(['settings', 'set', 'console.port', '5000'])).err).toContain('applies only when console.adapter is "dashboard"');
    });

    it('notify.to, with the email notifier, and the notifier still accepts its options', async () => {
      expect((await run(['settings', 'set', 'notify.to', 'a@b.com', '--team'])).err).toContain('applies only when notify.adapter is "email-resend"');
      writeConfig({ ...BASE, notify: { adapter: 'email-resend', from: 'f@b.com' } });
      expect((await run(['settings', 'set', 'notify.to', 'a@b.com', '--team'])).code).toBe(0);
      await checkOk();
      expect(config().notify).toEqual({ adapter: 'email-resend', from: 'f@b.com', to: 'a@b.com' });
      expect(() => emailResend(loadConfig(dir).config.notify, {})).not.toThrow();
    });

    it('stories.* with the Jira source', async () => {
      writeConfig({ ...BASE, stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = X' } });
      for (const [name, value] of [['stories.jql', 'project = Y ORDER BY rank'], ['stories.pollSeconds', '30'], ['stories.ownerLabel', 'mine'], ['stories.transitions', '{"started":"In Progress","shipped":"Done"}']]) {
        expect((await run(['settings', 'set', name, value, '--team'])).code, name).toBe(0);
        await checkOk();
      }
      expect(config().stories).toEqual({ adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = Y ORDER BY rank', pollSeconds: 30, ownerLabel: 'mine', transitions: { started: 'In Progress', shipped: 'Done' } });
      expect((await run(['settings', 'set', 'stories.transitions', '{"start":"x"}', '--team'])).err).toContain('unknown key start');
    });

    it('a markdown story source still opens after team writes', async () => {
      await run(['settings', 'set', 'rounds', '4', '--team']);
      await run(['settings', 'set', 'features.followUps', 'false', '--team']);
      await checkOk();
      expect(() => openProjectStories({ root: dir, env: {} }).list()).not.toThrow();
    });
  });
});
