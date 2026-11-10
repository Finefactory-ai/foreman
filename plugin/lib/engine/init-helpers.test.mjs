import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, parseWorkflowJobs, writeInit } from './init-helpers.mjs';
import { validate } from '../config/validate.mjs';
import { loadConfig } from '../config/load.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

let dir;
const put = (rel, text = '') => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (rel) => fs.existsSync(path.join(dir, rel));
const pkg = (scripts, name = 'my-app') => put('package.json', JSON.stringify({ name, scripts }));
const det = () => detect(dir, { gitRemote: () => null });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-init-'));
});

describe('parseWorkflowJobs', () => {
  it('uses name: when set, else the job key', () => {
    const yml = ['name: ci', 'on: push', 'jobs:', '  lint:', '    runs-on: x', '  test:', '    name: "Unit tests"  # c', '    steps:', '      - name: not a job', '  build:', '    steps: []', 'other:', '  x:', ''].join('\n');
    expect(parseWorkflowJobs(yml)).toEqual(['lint', 'Unit tests', 'build']);
  });
  it('returns nothing with no jobs block', () => {
    expect(parseWorkflowJobs('name: x\n')).toEqual([]);
  });
});

describe('detect: node', () => {
  it('prefers a check script', () => {
    pkg({ check: 'x', test: 'y' });
    const { suggested, found } = det();
    expect(suggested.checks).toEqual([{ run: 'npm run check', when: 'always' }]);
    expect(found.node).toBe(true);
  });
  it('falls back to test', () => {
    pkg({ test: 'y' });
    expect(det().suggested.checks).toEqual([{ run: 'npm test', when: 'always' }]);
  });
  it('picks install from the lockfile', () => {
    pkg({ test: 'y' });
    put('package-lock.json', '{}');
    expect(det().suggested.install).toEqual({ run: 'npm ci', when: 'package-lock.json', creates: 'node_modules' });
    fs.rmSync(path.join(dir, 'package-lock.json'));
    put('pnpm-lock.yaml');
    expect(det().suggested.install).toEqual({ run: 'pnpm install --frozen-lockfile', when: 'pnpm-lock.yaml', creates: 'node_modules' });
    fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
    put('yarn.lock');
    expect(det().suggested.install).toEqual({ run: 'yarn install --frozen-lockfile', when: 'yarn.lock', creates: 'node_modules' });
  });
  it('takes the project name from package.json', () => {
    pkg({ test: 'y' });
    expect(det().suggested.project.name).toBe('my-app');
  });
  it('suggests mergeable-recheck right before merge', () => {
    pkg({ test: 'y' });
    expect(det().suggested.ship.steps).toEqual(['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge']);
  });
  it('reads CI job names', () => {
    pkg({ test: 'y' });
    put('.github/workflows/ci.yml', 'jobs:\n  test:\n    name: test\n  lint:\n    runs-on: x\n');
    const { suggested, found } = det();
    expect(suggested.ship.ci.required).toEqual(['test', 'lint']);
    expect(found.ciJobs).toEqual(['test', 'lint']);
  });
});

describe('detect: python and make', () => {
  it('suggests pytest and pip install', () => {
    put('pyproject.toml', '[project]\nname = "pyapp"\n');
    const { suggested, found } = det();
    expect(suggested.checks).toEqual([{ run: 'pytest', when: 'always' }]);
    expect(suggested.install).toEqual({ run: 'pip install -e .', when: 'pyproject.toml' });
    expect(suggested.project.name).toBe('pyapp');
    expect(found.python).toBe(true);
  });
  it('uses uv with uv.lock', () => {
    put('pyproject.toml', '[project]\nname = "pyapp"\n');
    put('uv.lock');
    const { suggested } = det();
    expect(suggested.checks).toEqual([{ run: 'uv run pytest', when: 'always' }]);
    expect(suggested.install).toEqual({ run: 'uv sync', when: 'uv.lock' });
  });
  it('uses make test as a fallback only', () => {
    put('Makefile', 'build:\n\tx\ntest:\n\ty\n');
    expect(det().suggested.checks).toEqual([{ run: 'make test', when: 'always' }]);
    expect(det().found.make).toBe(true);
    pkg({ test: 'y' });
    expect(det().suggested.checks).toEqual([{ run: 'npm test', when: 'always' }]);
  });
});

describe('detect: general', () => {
  it('falls back to the folder name and default stories dir', () => {
    const { suggested, found } = det();
    expect(suggested.project.name).toBe(path.basename(dir));
    expect(suggested.stories.dir).toBe('stories');
    expect(found).toMatchObject({ node: false, python: false, make: false, hasStories: false, hasClaudeMd: false, gitRemote: null });
  });
  it('hints at the story source: unknown with no story notes', () => {
    expect(det().found.storySourceHint).toBe('unknown');
    put('stories/readme.md', 'no frontmatter here');
    expect(det().found.storySourceHint).toBe('unknown');
  });
  it('finds an existing stories folder with id frontmatter', () => {
    put('docs/stories/a.md', '---\nid: A-1\n---\nbody');
    const { suggested, found } = det();
    expect(suggested.stories.dir).toBe('docs/stories');
    expect(found).toMatchObject({ hasStories: true, storiesDir: 'docs/stories', storySourceHint: 'markdown' });
  });
  it('notes CLAUDE.md and the git remote', () => {
    put('CLAUDE.md', '#');
    const r = detect(dir, { gitRemote: () => 'git@x:y/z.git' });
    expect(r.found).toMatchObject({ hasClaudeMd: true, gitRemote: 'git@x:y/z.git' });
  });
  it('always suggests a valid config', () => {
    expect(validate(det().suggested)).toEqual([]);
    pkg({ check: 'x' });
    put('pyproject.toml', '[project]\nname = "p"\n');
    put('Makefile', 'test:\n');
    put('.github/workflows/ci.yml', 'jobs:\n  a:\n    runs-on: x\n');
    expect(validate(det().suggested)).toEqual([]);
  });
});

describe('detect: packs', () => {
  const CORE_STEPS = ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'];
  const claims = (d) => (fs.existsSync(path.join(d, 'acme-project.json')) ? { packageDirs: ['force-app'] } : null);
  const detWith = (packs) => detect(dir, { gitRemote: () => null, packs });

  it('a pack that claims the project adds pack and its findings', () => {
    put('acme-project.json', '{}');
    const spy = vi.fn(claims);
    const { suggested, found } = detWith({ acme: fakePack({ detect: spy }) });
    expect(found.pack).toBe('acme');
    expect(found.packFindings).toEqual({ packageDirs: ['force-app'] });
    expect(suggested.pack).toBe('acme');
    expect(Object.keys(suggested).indexOf('pack')).toBe(Object.keys(suggested).indexOf('project') + 1);
    expect(spy).toHaveBeenCalledWith(dir);
  });
  it('true counts as a claim with no findings', () => {
    const { found } = detWith({ acme: fakePack({ detect: () => true }) });
    expect(found.pack).toBe('acme');
    expect(found.packFindings).toEqual({});
  });
  it('adds no pack keys when no pack claims', () => {
    const { suggested, found } = detWith({ acme: fakePack({ detect: claims }) });
    expect(found).not.toHaveProperty('pack');
    expect(found).not.toHaveProperty('packFindings');
    expect(found).not.toHaveProperty('packErrors');
    expect(suggested).not.toHaveProperty('pack');
  });
  it('leaves Node and Python output unchanged when no pack claims', () => {
    pkg({ test: 'y' });
    put('package-lock.json', '{}');
    put('.github/workflows/ci.yml', 'jobs:\n  test:\n    runs-on: x\n');
    expect(detWith({ acme: fakePack() })).toEqual(detWith({}));
    for (const f of ['package.json', 'package-lock.json']) fs.rmSync(path.join(dir, f));
    put('pyproject.toml', '[project]\nname = "pyapp"\n');
    put('uv.lock');
    expect(detWith({ acme: fakePack() })).toEqual(detWith({}));
  });
  it('still runs Node detection on a claimed project', () => {
    pkg({ test: 'y' });
    put('acme-project.json', '{}');
    const { suggested, found } = detWith({ acme: fakePack({ detect: claims }) });
    expect(suggested.checks).toEqual([{ run: 'npm test', when: 'always' }]);
    expect(found.node).toBe(true);
    expect(found.pack).toBe('acme');
  });
  it("suggests the pack's ship steps, else the core list", () => {
    put('acme-project.json', '{}');
    expect(detWith({ acme: fakePack({ detect: claims }) }).suggested.ship.steps).toEqual(['merge-main', 'push', 'acme-deploy']);
    expect(detWith({ acme: fakePack({ detect: claims, defaults: undefined }) }).suggested.ship.steps).toEqual(CORE_STEPS);
  });
  it('reports a detect that throws and asks the next pack', () => {
    put('acme-project.json', '{}');
    const packs = {
      boom: fakePack({ name: 'boom', detect: () => { throw new Error('bad dir'); } }),
      zeta: fakePack({ name: 'zeta', detect: claims }),
    };
    let r;
    expect(() => (r = detWith(packs))).not.toThrow();
    expect(r.found.packErrors).toEqual([{ pack: 'boom', message: 'bad dir' }]);
    expect(r.found.pack).toBe('zeta');
  });
  it('a lone pack that throws claims nothing, and detection goes on', () => {
    pkg({ test: 'y' });
    const r = detWith({ boom: fakePack({ name: 'boom', detect: () => { throw new Error('bad dir'); } }) });
    expect(r.found).not.toHaveProperty('pack');
    expect(r.found.packErrors).toEqual([{ pack: 'boom', message: 'bad dir' }]);
    const { packErrors, ...found } = r.found;
    expect({ suggested: r.suggested, found }).toEqual(detWith({}));
  });
  it('keeps the core ship steps when defaults throws, and reports it', () => {
    put('acme-project.json', '{}');
    const r = detWith({ acme: fakePack({ detect: claims, defaults: () => { throw new Error('no defaults'); } }) });
    expect(r.found.pack).toBe('acme');
    expect(r.suggested.ship.steps).toEqual(CORE_STEPS);
    expect(r.found.packErrors).toEqual([{ pack: 'acme', message: 'no defaults' }]);
  });
  it('keeps the core checks when defaults throws, and reports it once', () => {
    pkg({ test: 'y' });
    put('acme-project.json', '{}');
    const r = detWith({ acme: fakePack({ detect: claims, defaults: () => { throw new Error('no defaults'); } }) });
    expect(r.suggested.checks).toEqual([{ run: 'npm test', when: 'always' }]);
    expect(r.found.packErrors).toEqual([{ pack: 'acme', message: 'no defaults' }]);
  });
  const withChecks = (checks) => () => ({ ship: { steps: ['merge-main', 'push', 'acme-deploy'] }, checks });
  it("leaves out the core checks when the claiming pack gives its own", () => {
    pkg({ test: 'y' });
    put('acme-project.json', '{}');
    const packs = { acme: fakePack({ detect: claims, defaults: withChecks([{ run: 'acme check', when: 'always' }]) }) };
    const { suggested } = detWith(packs);
    expect(suggested).not.toHaveProperty('checks');
    expect(validate(suggested, { packs })).toEqual([]);
  });
  it('keeps the core checks when the pack gives no usable checks', () => {
    pkg({ test: 'y' });
    put('acme-project.json', '{}');
    for (const checks of [[], [{ when: 'always' }], [{ run: '', when: 'always' }], ['acme check'], 'acme check']) {
      const { suggested } = detWith({ acme: fakePack({ detect: claims, defaults: withChecks(checks) }) });
      expect(suggested.checks, JSON.stringify(checks)).toEqual([{ run: 'npm test', when: 'always' }]);
    }
  });
  it('calls the pack defaults once', () => {
    put('acme-project.json', '{}');
    const defaults = vi.fn(withChecks([{ run: 'acme check', when: 'always' }]));
    detWith({ acme: fakePack({ detect: claims, defaults }) });
    expect(defaults).toHaveBeenCalledTimes(1);
    // The block is not written yet; the pack gets the project folder to read.
    expect(defaults).toHaveBeenCalledWith(undefined, { root: dir, fs });
  });
  it('the first claim wins, in name order', () => {
    const zeta = vi.fn(() => ({ z: 1 }));
    const r = detWith({ zeta: fakePack({ name: 'zeta', detect: zeta }), acme: fakePack({ detect: () => ({ a: 1 }) }) });
    expect(r.found.pack).toBe('acme');
    expect(r.found.packFindings).toEqual({ a: 1 });
    expect(zeta).not.toHaveBeenCalled();
  });
  it('suggests a valid config for a claimed project', () => {
    put('acme-project.json', '{}');
    const packs = { acme: fakePack({ detect: claims }) };
    expect(validate(detWith(packs).suggested, { packs })).toEqual([]);
  });
  const BAD = 'detect must return an object or null';
  const circular = () => {
    const o = {};
    o.self = o;
    return o;
  };
  it('an async detect does not claim, even when it resolves to findings', () => {
    for (const fn of [async () => ({ a: 1 }), async () => null]) {
      const { found } = detWith({ acme: fakePack({ detect: fn }) });
      expect(found).not.toHaveProperty('pack');
      expect(found).not.toHaveProperty('packFindings');
      expect(found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
    }
  });
  it('a rejecting async detect is reported, not left unhandled', async () => {
    const { found } = detWith({ acme: fakePack({ detect: async () => { throw new Error('late'); } }) });
    expect(found).not.toHaveProperty('pack');
    expect(found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
    await new Promise((r) => setTimeout(r, 0));
  });
  it('a string result does not claim', () => {
    const { found } = detWith({ acme: fakePack({ detect: () => 'yes' }) });
    expect(found).not.toHaveProperty('pack');
    expect(found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
  });
  it.each([
    ['a number', 1],
    ['an array', ['x']],
    ['a function', () => {}],
    ['a class instance', new (class Acme {})()],
    ['zero', 0],
    ['an empty string', ''],
  ])('%s does not claim', (_, value) => {
    const { found } = detWith({ acme: fakePack({ detect: () => value }) });
    expect(found).not.toHaveProperty('pack');
    expect(found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
  });
  it('a thenable whose then getter throws is reported, not thrown', () => {
    const bad = Object.defineProperty({}, 'then', { get() { throw new Error('no then'); } });
    let r;
    expect(() => (r = detWith({ acme: fakePack({ detect: () => bad }) }))).not.toThrow();
    expect(r.found).not.toHaveProperty('pack');
    expect(r.found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
  });
  const badProto = () => new Proxy({}, { getPrototypeOf() { throw new Error('pp'); } });
  it('an answer whose prototype read throws is reported, not thrown', () => {
    const bad = badProto();
    let r;
    expect(() => (r = detWith({ acme: fakePack({ detect: () => bad }) }))).not.toThrow();
    expect(r.found).not.toHaveProperty('pack');
    expect(r.found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
  });
  it('an answer whose prototype read throws passes the claim on to the next pack', () => {
    const bad = badProto();
    const r = detWith({ acme: fakePack({ detect: () => bad }), zeta: fakePack({ name: 'zeta', detect: () => ({ z: 1 }) }) });
    expect(r.found.pack).toBe('zeta');
    expect(r.found.packFindings).toEqual({ z: 1 });
    expect(r.found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
  });
  it('circular findings are reported, and detection still returns JSON-safe output', () => {
    const r = detWith({ acme: fakePack({ detect: circular }) });
    expect(r.found).not.toHaveProperty('pack');
    expect(r.found.packErrors[0].pack).toBe('acme');
    expect(r.found.packErrors[0].message).toMatch(/^detect must return a JSON-safe object/);
    expect(() => JSON.stringify(r)).not.toThrow();
  });
  it('a bad answer passes the claim on to the next pack', () => {
    const r = detWith({ acme: fakePack({ detect: () => 'yes' }), zeta: fakePack({ name: 'zeta', detect: () => ({ z: 1 }) }) });
    expect(r.found.pack).toBe('zeta');
    expect(r.found.packFindings).toEqual({ z: 1 });
    expect(r.found.packErrors).toEqual([{ pack: 'acme', message: BAD }]);
  });
  it.each([
    ['false', false],
    ['undefined', undefined],
  ])('%s claims nothing and reports nothing', (_, value) => {
    const { found } = detWith({ acme: fakePack({ detect: () => value }) });
    expect(found).not.toHaveProperty('pack');
    expect(found).not.toHaveProperty('packErrors');
  });
  it('a null-prototype object claims', () => {
    const { found } = detWith({ acme: fakePack({ detect: () => Object.assign(Object.create(null), { a: 1 }) }) });
    expect(found.pack).toBe('acme');
    expect(found.packFindings).toEqual({ a: 1 });
  });
});

describe('writeInit', () => {
  const cfg = () => ({ version: 1, project: { name: 'P' } });

  it('writes config, settings, gitignore and example story', () => {
    const r = writeInit(dir, cfg());
    expect(r.ok).toBe(true);
    expect(JSON.parse(read('foreman.config.json'))).toEqual(cfg());
    expect(JSON.parse(read('.claude/settings.json'))).toEqual({ enabledPlugins: { 'foreman@foreman': true } });
    expect(read('.gitignore')).toBe('.foreman/\n');
    expect(read('stories/S-1.md')).toMatch(/^---\nid: S-1\n/);
    expect(r.lines.length).toBe(4);
    expect(loadConfig(dir).config).not.toBeNull();
  });
  it('rejects invalid config', () => {
    const r = writeInit(dir, { version: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/project\.name/);
    expect(has('foreman.config.json')).toBe(false);
  });
  it('refuses a config that is not an object, without throwing', () => {
    for (const bad of [null, [], 'str', 42]) {
      const r = writeInit(dir, bad);
      expect(r.ok).toBe(false);
      expect(r.errors).toEqual(['config must be a JSON object']);
    }
    expect(has('foreman.config.json')).toBe(false);
    expect(has('.claude/settings.json')).toBe(false);
  });
  it('never overwrites without force', () => {
    put('foreman.config.json', 'old');
    expect(writeInit(dir, cfg()).ok).toBe(false);
    expect(read('foreman.config.json')).toBe('old');
    expect(writeInit(dir, cfg(), { force: true }).ok).toBe(true);
    expect(JSON.parse(read('foreman.config.json')).project.name).toBe('P');
  });
  it('keeps the user settings and plugins', () => {
    put('.claude/settings.json', JSON.stringify({ model: 'x', enabledPlugins: { 'other@m': true } }));
    writeInit(dir, cfg(), { marketplace: 'mine' });
    expect(JSON.parse(read('.claude/settings.json'))).toEqual({ model: 'x', enabledPlugins: { 'other@m': true, 'foreman@mine': true } });
  });
  it('does not clobber unreadable settings', () => {
    put('.claude/settings.json', '{ nope');
    const r = writeInit(dir, cfg());
    expect(r.ok).toBe(false);
    expect(read('.claude/settings.json')).toBe('{ nope');
  });
  it('adds the state dir to .gitignore once', () => {
    put('.gitignore', 'node_modules');
    writeInit(dir, { ...cfg(), stateDir: '.state' });
    writeInit(dir, { ...cfg(), stateDir: '.state' }, { force: true });
    expect(read('.gitignore')).toBe('node_modules\n.state/\n');
    put('.gitignore', '.foreman\n');
    writeInit(dir, cfg(), { force: true });
    expect(read('.gitignore')).toBe('.foreman\n');
  });
  const jira = (stories = {}) => ({
    ...cfg(),
    stories: {
      adapter: 'jira',
      site: 'acme.atlassian.net',
      jql: 'project = ACME AND labels = foreman AND statusCategory != Done ORDER BY Rank',
      ownerLabel: 'foreman-owner',
      transitions: { started: 'In Progress', shipped: 'Done' },
      ...stories,
    },
  });
  it('writes a Jira stories block, and makes no example story for it', () => {
    const r = writeInit(dir, jira());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(JSON.parse(read('foreman.config.json'))).toEqual(jira());
    expect(has('stories')).toBe(false);
    expect(r.lines.join('\n')).not.toMatch(/example/);
  });
  it('checks a Jira stories block with the adapter\'s own option check', () => {
    for (const [stories, message] of [
      [{ jql: undefined }, /stories\.jql is required/],
      [{ site: 'not a host' }, /stories\.site: /],
      [{ transitions: { later: 'Done' } }, /stories\.transitions\.later is not an event/],
      [{ transitions: { started: '' } }, /stories\.transitions\.started must be a transition name/],
      [{ colour: 'red' }, /stories\.colour is not a known option/],
    ]) {
      const config = jira(stories);
      if (stories.jql === undefined && 'jql' in stories) delete config.stories.jql;
      const r = writeInit(dir, config);
      expect(r.ok).toBe(false);
      expect(r.errors.join('; ')).toMatch(message);
      expect(has('foreman.config.json')).toBe(false);
    }
  });
  it('checks a Salesforce stories block with the adapter\'s own option check', () => {
    const salesforce = { orgs: { 'acme-qa': { orgId: '00D000000000002AAA' } }, build: 'acme-qa', stages: [{ name: 'qa', org: 'acme-qa' }] };
    const sf = (stories) => ({ ...cfg(), pack: 'salesforce', salesforce, stories: { adapter: 'salesforce', org: 'acme-qa', ...stories } });
    const missing = writeInit(dir, sf({}));
    expect(missing.ok).toBe(false);
    expect(missing.errors.join('; ')).toMatch(/stories\.where or stories\.listView is required/);
    expect(has('foreman.config.json')).toBe(false);
    const both = writeInit(dir, sf({ where: 'IsClosed = false', listView: 'Foreman_Stories' }));
    expect(both.errors.join('; ')).toMatch(/give stories\.where or stories\.listView, not both/);
  });
  it('checks a markdown stories block too, and refuses an unknown adapter', () => {
    const bad = writeInit(dir, { ...cfg(), stories: { adapter: 'markdown', dir: 'stories', track: 'sideways' } });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('; ')).toMatch(/stories\.track/);
    const unknown = writeInit(dir, { ...cfg(), stories: { adapter: 'trello' } });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join('; ')).toMatch(/unknown story source: trello/);
  });
  it('creates the example story only when no story files exist, and not with example:false', () => {
    put('stories/X.md', '---\nid: X\n---\n');
    writeInit(dir, cfg());
    expect(has('stories/S-1.md')).toBe(false);
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-init-'));
    writeInit(d2, cfg(), { example: false });
    expect(fs.existsSync(path.join(d2, 'stories'))).toBe(false);
  });

  // An example story is only ever written inside the project (FM-218).
  describe('a stories folder outside the project', () => {
    const withDir = (storiesDir) => ({ ...cfg(), stories: { adapter: 'markdown', dir: storiesDir } });
    const nothingWritten = (root) => {
      for (const rel of ['foreman.config.json', '.claude/settings.json', '.gitignore']) expect(fs.existsSync(path.join(root, rel)), rel).toBe(false);
    };

    it('refuses a relative dir that climbs out, with the example on, and writes nothing', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-init-base-'));
      const root = path.join(base, 'acme');
      fs.mkdirSync(root);
      const r = writeInit(root, withDir('../escaped'));
      expect(r.ok).toBe(false);
      expect(r.errors.join('; ')).toMatch(/stories\.dir: \.\.\/escaped is outside the project/);
      nothingWritten(root);
      expect(fs.existsSync(path.join(base, 'escaped'))).toBe(false);
    });
    it('refuses an absolute dir outside the project', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-init-outside-'));
      const r = writeInit(dir, withDir(outside));
      expect(r.ok).toBe(false);
      expect(r.errors.join('; ')).toMatch(/is outside the project/);
      expect(fs.existsSync(path.join(outside, 'S-1.md'))).toBe(false);
      nothingWritten(dir);
    });
    it('allows an absolute dir inside the project', () => {
      const r = writeInit(dir, withDir(path.join(dir, 'notes')));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(has('notes/S-1.md')).toBe(true);
    });
    it('allows an outside dir with example: false, as for a notes vault', () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-init-base-'));
      const root = path.join(base, 'acme');
      fs.mkdirSync(root);
      const r = writeInit(root, withDir('../vault'), { example: false });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'foreman.config.json'), 'utf8')).stories.dir).toBe('../vault');
      expect(fs.readdirSync(base)).toEqual(['acme']);
    });
    it("allows a folder inside the project whose name starts with '..'", () => {
      const r = writeInit(dir, withDir('..stories'));
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(has('..stories/S-1.md')).toBe(true);
    });
  });

  it('refuses a config loadConfig would refuse, such as a pack whose defaults throw', () => {
    const packs = { acme: fakePack({ defaults: () => { throw new Error('dflt boom'); } }) };
    const r = writeInit(dir, { ...cfg(), pack: 'acme' }, { packs });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['acme: the acme pack could not give its defaults: dflt boom']);
    expect(has('foreman.config.json')).toBe(false);
  });
});
