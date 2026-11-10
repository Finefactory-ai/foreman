import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import init, { makeInitCommand } from './init.mjs';
import { fakePack } from '../../../../test/fake-pack.mjs';
import { detect } from '../../engine/init-helpers.mjs';
import { PACKS } from '../../../packs/index.mjs';
import { WORDS, projectConfig } from '../../setup/project.mjs';

let dir;
let out;
let err;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-initcmd-'));
  out = '';
  err = '';
});
const ctx = (stdin) => ({ root: dir, cwd: dir, env: {}, stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, readStdin: () => stdin });
const run = (args, stdin) => init.run(args, { root: dir, cwd: dir, env: {}, stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, readStdin: () => stdin });

describe('foreman init', () => {
  it('detect prints one JSON line', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"a","scripts":{"test":"x"}}');
    expect(await run(['detect'])).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    const r = JSON.parse(out);
    expect(r.suggested.checks[0].run).toBe('npm test');
    expect(r.found.node).toBe(true);
  });
  it('write reads stdin, writes, and refuses a second time', async () => {
    const cfg = JSON.stringify({ version: 1, project: { name: 'P' } });
    expect(await run(['write', '--no-example'], cfg)).toBe(0);
    expect(fs.existsSync(path.join(dir, 'foreman.config.json'))).toBe(true);
    expect(await run(['write'], cfg)).toBe(1);
    expect(err).toMatch(/--force/);
    expect(await run(['write', '--force', '--marketplace', 'm'], cfg)).toBe(0);
    expect(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).toContain('foreman@m');
  });
  it('detect says which story source the project looks like', async () => {
    expect(await run(['detect'])).toBe(0);
    expect(JSON.parse(out).found.storySourceHint).toBe('unknown');
  });
  it('write takes a Jira stories block, and exits 1 when its options are bad', async () => {
    const stories = { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME AND labels = foreman', ownerLabel: 'foreman-owner', transitions: { review: 'In Review' } };
    expect(await run(['write'], JSON.stringify({ version: 1, project: { name: 'P' }, stories: { ...stories, jql: '' } }))).toBe(1);
    expect(err).toMatch(/stories\.jql is required/);
    expect(await run(['write'], JSON.stringify({ version: 1, project: { name: 'P' }, stories }))).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'foreman.config.json'), 'utf8')).stories).toEqual(stories);
    expect(fs.existsSync(path.join(dir, 'stories'))).toBe(false);
  });
  it('write refuses an example story outside the project, and writes nothing', async () => {
    const cfg = JSON.stringify({ version: 1, project: { name: 'Acme' }, stories: { adapter: 'markdown', dir: '../x' } });
    expect(await run(['write'], cfg)).toBe(1);
    expect(err).toMatch(/stories\.dir/);
    expect(err).toMatch(/outside the project/);
    expect(fs.existsSync(path.join(dir, 'foreman.config.json'))).toBe(false);
  });
  it('write exits 1 with a clean error when fed null', async () => {
    expect(await run(['write'], 'null')).toBe(1);
    expect(err).toMatch(/config must be a JSON object/);
    expect(fs.existsSync(path.join(dir, 'foreman.config.json'))).toBe(false);
  });
  it('write reads --from and exits 1 on invalid config', async () => {
    fs.writeFileSync(path.join(dir, 'in.json'), '{"version":1}');
    expect(await run(['write', '--from', 'in.json'])).toBe(1);
    expect(err).toMatch(/project\.name/);
    expect(await run(['write'], 'not json')).toBe(1);
  });
  it('shows usage for an unknown subcommand', async () => {
    expect(await run(['nope'])).toBe(1);
    expect(err).toMatch(/usage/);
  });
});

describe('foreman init: packs', () => {
  it('detect prints the pack that claims the project and its findings', async () => {
    fs.writeFileSync(path.join(dir, 'acme-project.json'), '{}');
    const detect = (d) => (fs.existsSync(path.join(d, 'acme-project.json')) ? { packageDirs: ['force-app'] } : null);
    const cmd = makeInitCommand({ packs: { acme: fakePack({ detect }) } });
    expect(await cmd.run(['detect'], ctx())).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    const r = JSON.parse(out);
    expect(r.found.pack).toBe('acme');
    expect(r.found.packFindings).toEqual({ packageDirs: ['force-app'] });
    expect(r.suggested.pack).toBe('acme');
  });
  it('detect exits 0 and reports circular findings', async () => {
    const detect = () => {
      const o = {};
      o.self = o;
      return o;
    };
    const cmd = makeInitCommand({ packs: { acme: fakePack({ detect }) } });
    expect(await cmd.run(['detect'], ctx())).toBe(0);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out).found.packErrors[0].pack).toBe('acme');
  });
  it('the default command adds no pack key on a plain Node project', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"a","scripts":{"test":"x"}}');
    expect(await run(['detect'])).toBe(0);
    const r = JSON.parse(out);
    expect(r.found).not.toHaveProperty('pack');
    expect(r.suggested).not.toHaveProperty('pack');
  });
});

// The Set up page's "This project" form answers, written the way the page writes them.
describe('foreman init write --answers', () => {
  const answers = { name: 'Acme', source: 'markdown', dir: 'stories', check: 'npm test', ci: [] };
  const configFile = () => path.join(dir, 'foreman.config.json');
  const nodeProject = () => fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"acme","scripts":{"test":"vitest run"}}');

  it('writes the same config the Set up page writes for the same answers', async () => {
    nodeProject();
    const expected = projectConfig(detect(dir, { packs: PACKS }), answers);
    expect(expected.ok).toBe(true);
    expect(await run(['write', '--answers'], JSON.stringify(answers)), err).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8'))).toEqual(expected.config);
    expect(fs.existsSync(path.join(dir, 'stories/S-1.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).enabledPlugins['foreman@foreman']).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toMatch(/\.foreman/);
  });
  it('writes a Jira stories block and no stories folder', async () => {
    nodeProject();
    const jql = 'project = ACME AND labels = foreman';
    const jira = { name: 'Acme', source: 'jira', site: 'https://acme.atlassian.net', jql, check: 'npm test' };
    expect(await run(['write', '--answers'], JSON.stringify(jira)), err).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).stories).toEqual({ adapter: 'jira', site: 'acme.atlassian.net', jql });
    expect(fs.existsSync(path.join(dir, 'stories'))).toBe(false);
  });
  it('refuses bad answers, one error per line, and writes nothing', async () => {
    expect(await run(['write', '--answers'], JSON.stringify({ name: '', source: 'markdown', dir: '../x' }))).toBe(1);
    expect(err).toContain(WORDS.needName);
    expect(err).toContain(WORDS.badDir);
    expect(err.trim().split('\n')).toContain(WORDS.needName);
    expect(fs.existsSync(configFile())).toBe(false);
    err = '';
    expect(await run(['write', '--answers'], JSON.stringify({ ...answers, colour: 'blue' }))).toBe(1);
    expect(err).toContain(WORDS.unknownAnswer);
    err = '';
    expect(await run(['write', '--answers'], 'not json')).toBe(1);
    expect(err).toMatch(/answers are not valid JSON/);
    expect(fs.existsSync(configFile())).toBe(false);
  });
  it('refuses to replace a config without --force', async () => {
    nodeProject();
    expect(await run(['write', '--answers'], JSON.stringify(answers)), err).toBe(0);
    expect(await run(['write', '--answers'], JSON.stringify({ ...answers, name: 'Acme Two' }))).toBe(1);
    expect(err).toMatch(/--force/);
    expect(await run(['write', '--answers', '--force'], JSON.stringify({ ...answers, name: 'Acme Two' })), err).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).project.name).toBe('Acme Two');
  });
  it('reads the answers from --from', async () => {
    nodeProject();
    fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
    expect(await run(['write', '--answers', '--from', 'answers.json']), err).toBe(0);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf8')).project.name).toBe('Acme');
  });
  it('writes no example story with --no-example', async () => {
    nodeProject();
    expect(await run(['write', '--answers', '--no-example'], JSON.stringify(answers)), err).toBe(0);
    expect(fs.existsSync(path.join(dir, 'stories/S-1.md'))).toBe(false);
  });
  it("refuses a pack project, since the form has no answers for the pack's block", async () => {
    fs.cpSync(fileURLToPath(new URL('../../../../test/fixtures/acme-sfdx', import.meta.url)), dir, { recursive: true });
    expect(await run(['write', '--answers'], JSON.stringify({ name: 'Acme', source: 'markdown', dir: 'stories' }))).toBe(1);
    expect(err).toMatch(/salesforce: required/);
    expect(fs.existsSync(configFile())).toBe(false);
  });
});
