// The Cloud runner set-up step: the workflow and its Actions secrets through gh, or the
// container's runner file and its docker run line. The fake gh records every call; a value only
// ever goes to gh as opts.input, and to the token checks as GH_TOKEN in their env.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { RUNNER_FILE, cloudSetup } from './cloud.mjs';
import { CLOUD_SCREEN } from './cloud-screen.mjs';
import { checkShape } from './keys.mjs';
import { LOCAL_SAFE } from '../cloud/doctor.mjs';
import { WORKFLOW } from '../cloud/actions.mjs';
import { actionsWorkflow } from '../cloud/workflow-template.mjs';
import { runnerImage } from '../cloud/versions.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { loadResolved } from '../settings/load.mjs';
import { fakeGh } from '../../../test/fake-gh.mjs';

const E = CLOUD_SCREEN.errors;
const hex = () => randomBytes(12).toString('hex');
const GH = `ghp_acme_${hex()}`;
const KEY = `sk-ant-api03-acme${hex()}`;
const OAUTH = `sk-ant-oat01-acme${hex()}`;
const RESEND = `re_acme_${hex()}`;
const DASH = `acme-dashboard-${hex()}${hex()}`;
// The owner's own gh token, in the dashboard's environment: no call may ever carry it.
const OWNER = `ghp_owner_${hex()}`;
const VALUES = [GH, KEY, OAUTH, RESEND, DASH, OWNER];

let root;
let sh;
let answers; // every answer a test got, as text
const file = () => join(root, 'foreman.config.json');
const saved = () => JSON.parse(readFileSync(file(), 'utf8'));

function project(extra = {}) {
  writeFileSync(file(), `${JSON.stringify({ version: 1, project: { name: 'Acme' }, state: { store: 'branch' }, cloud: { envVars: ['RESEND_API_KEY'] }, ...extra }, null, 2)}\n`);
}
const SF = {
  pack: 'salesforce',
  salesforce: {
    productionBranch: 'main',
    orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
    build: ['acme-dev1'],
    stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
  },
};
const ignore = () => writeFileSync(join(root, '.gitignore'), '.foreman/\n.env.runner\n');

const BASE_ENV = () => ({ FOREMAN_STATE_DIR: join(root, '.foreman'), PATH: '/usr/bin' });
function setup({ stored = { ANTHROPIC_API_KEY: KEY, RESEND_API_KEY: RESEND, FOREMAN_DASHBOARD_TOKEN: DASH }, gh = {}, wrap = null, env = {}, checks } = {}) {
  sh = fakeGh({ root, ...gh });
  const run = wrap ? wrap(sh) : sh;
  return cloudSetup({ root, env: { ...BASE_ENV(), ...env }, sh: run, valueOf: (n) => stored[n] ?? null, ...(checks ? { checks } : {}) });
}
// A second folder, outside root, for the targets of links.
const outsideDir = () => mkdtempSync(join(tmpdir(), 'foreman-cloud-outside-'));
const seen = (r) => {
  answers += JSON.stringify(r);
  return r;
};
const refused = async (fn) => {
  try {
    await fn();
  } catch (err) {
    answers += `${err.message} ${err.fix ?? ''}`;
    return { status: err.status, message: err.message, fix: err.fix };
  }
  throw new Error('expected a refusal');
};
const line = (c) => [c.cmd, ...c.args].join(' ');
const setCalls = () => sh.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'secret' && c.args[1] === 'set');

const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === '.git' ? [] : filesIn(join(dir, d.name))) : [join(dir, d.name)]));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-cloud-setup-'));
  answers = '';
  sh = null;
});
afterEach(() => {
  // No value in an arg, in an answer, or in a file but .env.runner; in a call's env only the
  // GitHub token, as GH_TOKEN of a token check, never of a `gh secret set`.
  for (const c of sh?.calls ?? []) {
    for (const v of VALUES) expect(c.args.join(' '), line(c)).not.toContain(v);
    for (const [name, value] of Object.entries(c.opts.env ?? {})) {
      const isCheck = name === 'GH_TOKEN' && value === GH && !(c.args[0] === 'secret');
      if (!isCheck) for (const v of VALUES) expect(String(value), `${line(c)} ${name}`).not.toContain(v);
    }
  }
  for (const v of VALUES) expect(answers).not.toContain(v);
  for (const f of filesIn(root)) {
    if (relative(root, f) === RUNNER_FILE) continue;
    const text = readFileSync(f, 'utf8');
    for (const v of VALUES) expect(text, relative(root, f)).not.toContain(v);
  }
  rmSync(root, { recursive: true, force: true });
});

describe('current', () => {
  it('says where things stand with booleans only, asking gh nothing', () => {
    project();
    const cloud = setup();
    const now = seen(cloud.current());
    expect(now).toEqual({
      mode: null,
      stateBranch: true,
      workflow: { exists: false, current: false },
      runnerFile: { file: '.env.runner', exists: false, ignored: 'not-ignored' },
      repo: 'acme/app',
      names: {
        token: 'FOREMAN_GH_TOKEN',
        signIn: [{ name: 'ANTHROPIC_API_KEY', stored: true, step: 'claude-signin' }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', stored: false, step: 'claude-signin' }],
        keys: [{ name: 'RESEND_API_KEY', stored: true, step: 'notifications' }],
        runner: [{ name: 'FOREMAN_DASHBOARD_TOKEN', stored: true, step: 'project-keys' }, { name: 'RESEND_API_KEY', stored: true, step: 'notifications' }],
      },
      dockerRun: `docker run -d --name foreman --restart on-failure --stop-timeout 900 --env-file .env.runner -v foreman-work:/work -p 127.0.0.1:4317:4317 ${runnerImage({})}`,
    });
    expect(sh.calls.filter((c) => c.cmd === 'gh')).toEqual([]);
  });

  it('picks the mode from the files there: the workflow, else the runner file', () => {
    project();
    ignore();
    const cloud = setup();
    writeFileSync(join(root, RUNNER_FILE), 'FOREMAN_BRANCH=main\n', { mode: 0o600 });
    expect(cloud.current()).toMatchObject({ mode: 'container', runnerFile: { exists: true, ignored: 'ignored' } });
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, WORKFLOW), 'old\n');
    expect(cloud.current()).toMatchObject({ mode: 'actions', workflow: { exists: true, current: false } });
    writeFileSync(join(root, WORKFLOW), actionsWorkflow({ config: loadResolved(root, { env: BASE_ENV() }).config }));
    expect(cloud.current().workflow).toEqual({ exists: true, current: true });
  });
});

describe('stateBranch', () => {
  it('writes state.store, then answers nothingChanged the second time', () => {
    project({ state: { store: 'files' } });
    const cloud = setup();
    expect(cloud.current().stateBranch).toBe(false);
    expect(seen(cloud.stateBranch({}))).toEqual({ ok: true, lines: ['set state.store to branch', COMMIT_REMINDER] });
    expect(saved().state.store).toBe('branch');
    expect(cloud.current().stateBranch).toBe(true);
    expect(seen(cloud.stateBranch({}))).toEqual({ ok: true, lines: [E.nothingChanged] });
  });
});

describe('workflow', () => {
  it('is a 409 needsBranch while the state is not on a branch', async () => {
    project({ state: { store: 'files' } });
    const cloud = setup();
    expect(await refused(() => cloud.workflow({ replace: false }))).toMatchObject({ status: 409, message: E.needsBranch });
    expect(existsSync(join(root, WORKFLOW))).toBe(false);
  });

  it('writes the workflow, then is a 409 workflowExists unless replace', async () => {
    project();
    const cloud = setup();
    const r = seen(cloud.workflow({ replace: false }));
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toBe(CLOUD_SCREEN.workflow.commit);
    expect(readFileSync(join(root, WORKFLOW), 'utf8')).toBe(actionsWorkflow({ config: loadResolved(root, { env: BASE_ENV() }).config }));
    writeFileSync(join(root, WORKFLOW), 'mine\n');
    expect(await refused(() => cloud.workflow({ replace: false }))).toMatchObject({ status: 409, message: E.workflowExists });
    expect(readFileSync(join(root, WORKFLOW), 'utf8')).toBe('mine\n');
    expect(seen(cloud.workflow({ replace: true })).ok).toBe(true);
    expect(readFileSync(join(root, WORKFLOW), 'utf8')).toMatch(/^name: Foreman$/m);
  });

  it('is a 409 workflowLink when foreman.yml is a link, even with replace, and writes through nothing', async () => {
    project();
    const outside = outsideDir();
    try {
      const theirs = join(outside, 'theirs.yml');
      writeFileSync(theirs, 'theirs\n');
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      symlinkSync(theirs, join(root, WORKFLOW));
      const cloud = setup();
      expect(await refused(() => cloud.workflow({ replace: true }))).toEqual({ status: 409, message: E.workflowLink, fix: undefined });
      expect(readFileSync(theirs, 'utf8')).toBe('theirs\n');

      unlinkSync(join(root, WORKFLOW));
      const missing = join(outside, 'missing.yml');
      symlinkSync(missing, join(root, WORKFLOW));
      expect(await refused(() => cloud.workflow({ replace: true }))).toMatchObject({ status: 409, message: E.workflowLink });
      expect(existsSync(missing)).toBe(false);
      unlinkSync(join(root, WORKFLOW));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('the bodies and the config', () => {
  it('is a 409 setupFirst with no config', async () => {
    const cloud = setup();
    for (const [name, body] of [['current', undefined], ['stateBranch', {}], ['workflow', { replace: false }], ['secrets', {}], ['setSecrets', {}], ['runnerFile', {}], ['ignoreRunnerFile', {}], ['check', {}]]) {
      expect(await refused(() => cloud[name](body)), name).toMatchObject({ status: 409, message: E.setupFirst });
    }
    expect(sh.calls.filter((c) => c.cmd === 'gh')).toEqual([]);
  });

  it('is a 400 badBody for an extra key or a wrong one', async () => {
    project();
    const cloud = setup();
    const bad = [
      ['stateBranch', { extra: 1 }],
      ['workflow', {}],
      ['workflow', { replace: 'yes' }],
      ['workflow', { replace: true, extra: 1 }],
      ['secrets', { repo: 'acme/other' }],
      ['setSecrets', { ghToken: GH, extra: 1 }],
      ['runnerFile', { token: GH }],
      ['ignoreRunnerFile', { file: '.env' }],
      ['check', { all: true }],
    ];
    for (const [name, body] of bad) expect(await refused(() => cloud[name](body)), name).toMatchObject({ status: 400, message: E.badBody });
    expect(sh.calls.filter((c) => c.cmd === 'gh')).toEqual([]);
  });
});

describe('secrets', () => {
  it('lists each name, whether GitHub has it and whether it is saved here, and what is missing', async () => {
    project();
    const cloud = setup({ gh: { secrets: ['FOREMAN_GH_TOKEN'] } });
    const r = seen(await cloud.secrets({}));
    expect(r).toEqual({
      ok: true,
      repo: 'acme/app',
      rows: [
        { name: 'FOREMAN_GH_TOKEN', set: true, stored: false },
        { name: 'ANTHROPIC_API_KEY', set: false, stored: true },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN', set: false, stored: false },
        { name: 'RESEND_API_KEY', set: false, stored: true },
      ],
      missing: [],
    });
    expect(setCalls()).toEqual([]);
  });

  it('is a 409 noRepo with no GitHub remote', async () => {
    project();
    const cloud = setup({ gh: { remote: 'https://gitlab.com/acme/app.git' } });
    expect(await refused(() => cloud.secrets({}))).toMatchObject({ status: 409, message: E.noRepo });
  });

  it('answers ghFailed when gh cannot list', async () => {
    project();
    const cloud = setup({ gh: { listError: `HTTP 403 near ${RESEND}` } });
    const r = seen(await cloud.secrets({}));
    expect(r.ok).toBe(false);
    expect(r.error.startsWith('gh secret list: ')).toBe(true);
    expect(r.error).toContain('HTTP 403');
  });
});

describe('setSecrets', () => {
  it('never puts a value on the command line: gh secret set takes it as opts.input, with no runner GH_TOKEN', async () => {
    project();
    const cloud = setup();
    const r = seen(await cloud.setSecrets({ ghToken: GH }));
    expect(r).toMatchObject({ ok: true, set: ['FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY'], failed: [], missing: [] });
    const calls = setCalls();
    expect(calls.map((c) => c.args)).toEqual([
      ['secret', 'set', 'FOREMAN_GH_TOKEN', '--repo', 'acme/app', '--app', 'actions'],
      ['secret', 'set', 'ANTHROPIC_API_KEY', '--repo', 'acme/app', '--app', 'actions'],
      ['secret', 'set', 'RESEND_API_KEY', '--repo', 'acme/app', '--app', 'actions'],
    ]);
    expect(calls.map((c) => c.opts.input)).toEqual([GH, KEY, RESEND]);
    for (const c of calls) {
      expect(c.opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
      expect(c.opts.env?.GH_TOKEN).not.toBe(GH);
    }
    expect(r.results.map((x) => x.name)).toEqual([...LOCAL_SAFE]);
    expect(r.results.every((x) => x.ok)).toBe(true);
  });

  it('runs the token checks with GH_TOKEN in their env, not in their args', async () => {
    project();
    const cloud = setup();
    await cloud.setSecrets({ ghToken: GH });
    const checks = sh.calls.filter((c) => c.cmd === 'gh' && c.args[0] !== 'secret');
    expect(checks.map(line)).toContain('gh api user --jq .login');
    expect(checks.map(line)).toContain('gh api repos/acme/app --jq .permissions.push');
    for (const c of checks) expect(c.opts.env.GH_TOKEN, line(c)).toBe(GH);
  });

  it('sets nothing when the checks refuse the token', async () => {
    project();
    const cloud = setup({ gh: { push: false } });
    const r = seen(await cloud.setSecrets({ ghToken: GH }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe(E.tokenRefused);
    expect(r.results.find((x) => x.name === 'github token')).toMatchObject({ ok: false, level: 'error' });
    expect(setCalls()).toEqual([]);
  });

  it("refuses a token of the wrong shape with checkShape's words, without the value", async () => {
    project();
    const cloud = setup();
    const wrong = `acme-not-a-token-${hex()}`;
    const r = await refused(() => cloud.setSecrets({ ghToken: wrong }));
    expect(r).toMatchObject({ status: 400, message: checkShape('GH_TOKEN', wrong) });
    expect(r.message).not.toContain(wrong);
    expect(sh.calls.filter((c) => c.cmd === 'gh')).toEqual([]);
  });

  it('lists the names neither on GitHub nor saved here, and does not set them', async () => {
    project();
    const cloud = setup({ stored: {} });
    const r = seen(await cloud.setSecrets({ ghToken: GH }));
    expect(r.set).toEqual(['FOREMAN_GH_TOKEN']);
    expect(r.missing).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'RESEND_API_KEY']);
    expect(setCalls().map((c) => c.args[2])).toEqual(['FOREMAN_GH_TOKEN']);
  });

  it('sets the stored names alone with no token, through the owner\'s own gh sign-in', async () => {
    project();
    const cloud = setup({ stored: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH }, gh: { secrets: ['FOREMAN_GH_TOKEN', 'RESEND_API_KEY'] } });
    const r = seen(await cloud.setSecrets({}));
    expect(r).toMatchObject({ ok: true, set: ['CLAUDE_CODE_OAUTH_TOKEN'], failed: [], missing: [], results: [] });
    expect(sh.calls.filter((c) => c.cmd === 'gh' && c.args[0] === 'api')).toEqual([]);
  });

  it('puts a gh secret set failure in failed, redacted', async () => {
    project();
    const cloud = setup({ gh: { setError: { RESEND_API_KEY: (v) => `HTTP 422: cannot store ${v}` } } });
    const r = seen(await cloud.setSecrets({ ghToken: GH }));
    expect(r.ok).toBe(false);
    expect(r.set).toEqual(['FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY']);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].name).toBe('RESEND_API_KEY');
    expect(r.failed[0].detail).toContain('HTTP 422');
    expect(r.missing).toEqual(['RESEND_API_KEY']);
  });
});

describe('runnerFile', () => {
  const runner = () => join(root, RUNNER_FILE);

  it("is refused when git does not ignore the file: 409 with fix 'ignore', and no file", async () => {
    project();
    const cloud = setup();
    const r = await refused(() => cloud.runnerFile({ ghToken: GH }));
    expect(r).toEqual({ status: 409, message: E.notIgnored.split('{file}').join('.env.runner'), fix: 'ignore' });
    expect(existsSync(runner())).toBe(false);
  });

  it('writes .env.runner at mode 600, keeping its other lines, and answers the docker run line', async () => {
    project({ baseBranch: 'trunk' });
    ignore();
    writeFileSync(runner(), '# the runner\nFOREMAN_WORKERS=2\nFOREMAN_BRANCH=old\n', { mode: 0o644 });
    const cloud = setup();
    const r = seen(await cloud.runnerFile({ ghToken: GH }));
    expect(r.ok).toBe(true);
    expect(r.file).toBe('.env.runner');
    expect(r.missing).toEqual([]);
    expect(r.dockerRun).toBe(`docker run -d --name foreman --restart on-failure --stop-timeout 900 --env-file .env.runner -v foreman-work:/work -p 127.0.0.1:4317:4317 ${runnerImage({})}`);
    expect(statSync(runner()).mode & 0o777).toBe(0o600);
    const text = readFileSync(runner(), 'utf8');
    expect(text).toContain('# the runner');
    expect(text).toContain('FOREMAN_WORKERS=2');
    expect(text).not.toContain('FOREMAN_BRANCH=old');
    const { parseEnv } = await import('node:util');
    expect(parseEnv(text)).toMatchObject({ FOREMAN_REPO: 'acme/app', FOREMAN_BRANCH: 'trunk', GH_TOKEN: GH, ANTHROPIC_API_KEY: KEY, FOREMAN_DASHBOARD_TOKEN: DASH, RESEND_API_KEY: RESEND });
    expect(r.written).toEqual(expect.arrayContaining(['FOREMAN_REPO', 'FOREMAN_BRANCH', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'FOREMAN_DASHBOARD_TOKEN', 'RESEND_API_KEY']));
  });

  it('answers the -salesforce image on a Salesforce pack', async () => {
    project(SF);
    ignore();
    const cloud = setup();
    const r = seen(await cloud.runnerFile({ ghToken: GH }));
    expect(r.dockerRun.endsWith(`${runnerImage({ pack: 'salesforce' })}`)).toBe(true);
    expect(r.dockerRun.endsWith('-salesforce')).toBe(true);
  });

  it('lists the names still missing from the file, such as FOREMAN_DASHBOARD_TOKEN when it is not stored', async () => {
    project();
    ignore();
    const cloud = setup({ stored: { RESEND_API_KEY: RESEND } });
    const r = seen(await cloud.runnerFile({}));
    expect(r.missing).toEqual(['GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'FOREMAN_DASHBOARD_TOKEN']);
  });

  it("refuses a token of the wrong shape with checkShape's words, and writes nothing", async () => {
    project();
    ignore();
    const cloud = setup();
    expect(await refused(() => cloud.runnerFile({ ghToken: 'acme nope' }))).toMatchObject({ status: 400, message: checkShape('GH_TOKEN', 'acme nope') });
    expect(existsSync(runner())).toBe(false);
  });

  it('is refused when git tracks the file: 409 runnerTracked with no fix, and the file unchanged', async () => {
    project();
    ignore();
    writeFileSync(runner(), 'FOREMAN_WORKERS=2\n', { mode: 0o600 });
    const cloud = setup({ gh: { tracked: ['.env.runner'] } });
    const r = await refused(() => cloud.runnerFile({ ghToken: GH }));
    expect(r).toEqual({ status: 409, message: E.runnerTracked.split('{file}').join('.env.runner'), fix: undefined });
    expect(readFileSync(runner(), 'utf8')).toBe('FOREMAN_WORKERS=2\n');
  });

  it('is refused when the file is a link: 409 runnerLink with no fix, and the target unchanged', async () => {
    project();
    ignore();
    const outside = outsideDir();
    try {
      const target = join(outside, 'mine.env');
      writeFileSync(target, 'mine\n');
      symlinkSync(target, runner());
      const cloud = setup();
      const r = await refused(() => cloud.runnerFile({ ghToken: GH }));
      expect(r).toEqual({ status: 409, message: E.runnerLink.split('{file}').join('.env.runner'), fix: undefined });
      expect(readFileSync(target, 'utf8')).toBe('mine\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('is refused when the file is a dangling link, and creates no target', async () => {
    project();
    ignore();
    const outside = outsideDir();
    try {
      const target = join(outside, 'missing.env');
      symlinkSync(target, runner());
      const cloud = setup();
      const r = await refused(() => cloud.runnerFile({ ghToken: GH }));
      expect(r).toEqual({ status: 409, message: E.runnerLink.split('{file}').join('.env.runner'), fix: undefined });
      expect(existsSync(target)).toBe(false);
      unlinkSync(runner());
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('ignoreRunnerFile', () => {
  it('adds the line to .gitignore, and then runnerFile writes', async () => {
    project();
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    const cloud = setup();
    const r = seen(cloud.ignoreRunnerFile({}));
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(['added .env.runner to .gitignore']);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules\n.env.runner\n');
    expect(cloud.current().runnerFile.ignored).toBe('ignored');
    expect(seen(cloud.ignoreRunnerFile({})).lines).toEqual(['git already ignores .env.runner']);
    expect(seen(await cloud.runnerFile({ ghToken: GH })).ok).toBe(true);
  });
});

describe('check', () => {
  it("runs only the LOCAL_SAFE checks against the file's values, and redacts them", async () => {
    project();
    ignore();
    writeFileSync(join(root, RUNNER_FILE), `FOREMAN_REPO=acme/app\nGH_TOKEN=${GH}\nANTHROPIC_API_KEY=${KEY}\nFOREMAN_DASHBOARD_TOKEN=${DASH}\n`, { mode: 0o600 });
    // gh echoes the token, and the dashboard token, when it refuses.
    const cloud = setup({
      wrap: (gh) => {
        const echo = (cmd, args = [], opts = {}) => {
          const r = gh(cmd, args, opts);
          if ([cmd, ...args].join(' ') === 'gh api user --jq .login') return { status: 1, stdout: '', stderr: `Bad credentials: ${opts.env?.GH_TOKEN} near ${DASH}\n` };
          return r;
        };
        return echo;
      },
    });
    const r = seen(await cloud.check({}));
    expect(r.results.map((x) => x.name)).toEqual([...LOCAL_SAFE]);
    expect(r.ok).toBe(false);
    const token = r.results.find((x) => x.name === 'github token');
    expect(token).toMatchObject({ ok: false, level: 'error' });
    expect(token.detail).toContain('Bad credentials');
    expect(r.results.find((x) => x.name === 'dashboard token')).toMatchObject({ ok: true });
    expect(sh.calls.map(line)).not.toContain('claude -p');
    expect(sh.calls.some((c) => c.cmd === 'claude')).toBe(false);
    for (const c of sh.calls.filter((x) => x.cmd === 'gh')) expect(c.opts.env.GH_TOKEN).toBe(GH);
  });

  it('is ok when every local check passes, and fails the dashboard token without one', async () => {
    project();
    ignore();
    writeFileSync(join(root, RUNNER_FILE), `FOREMAN_REPO=acme/app\nGH_TOKEN=${GH}\nFOREMAN_DASHBOARD_TOKEN=${DASH}\n`, { mode: 0o600 });
    const cloud = setup();
    const r = seen(await cloud.check({}));
    expect(r.ok).toBe(true);
    expect(r.results.every((x) => x.ok)).toBe(true);
    writeFileSync(join(root, RUNNER_FILE), `FOREMAN_REPO=acme/app\nGH_TOKEN=${GH}\n`, { mode: 0o600 });
    const without = seen(await cloud.check({}));
    expect(without.ok).toBe(false);
    expect(without.results.find((x) => x.name === 'dashboard token')).toMatchObject({ ok: false });
  });
});

describe("the owner's own GH_TOKEN", () => {
  const gh = () => sh.calls.filter((c) => c.cmd === 'gh');

  it('never reaches the token checks with a pasted token, nor a gh secret set', async () => {
    project();
    const cloud = setup({ env: { GH_TOKEN: OWNER } });
    const r = seen(await cloud.setSecrets({ ghToken: GH }));
    expect(r.ok).toBe(true);
    const api = gh().filter((c) => c.args[0] === 'api');
    expect(api.length).toBeGreaterThan(0);
    for (const c of api) expect(c.opts.env.GH_TOKEN, line(c)).toBe(GH);
    for (const c of sh.calls) expect(c.opts.env?.GH_TOKEN, line(c)).not.toBe(OWNER);
    expect(setCalls().map((c) => c.opts.input)).toEqual([GH, KEY, RESEND]);
    for (const c of setCalls()) expect(c.opts.env).toBeUndefined();
  });

  it("checks the runner file's token, not the owner's", async () => {
    project();
    ignore();
    writeFileSync(join(root, RUNNER_FILE), `FOREMAN_REPO=acme/app\nGH_TOKEN=${GH}\nFOREMAN_DASHBOARD_TOKEN=${DASH}\n`, { mode: 0o600 });
    const cloud = setup({ env: { GH_TOKEN: OWNER } });
    seen(await cloud.check({}));
    expect(gh().length).toBeGreaterThan(0);
    for (const c of gh()) expect(c.opts.env.GH_TOKEN, line(c)).toBe(GH);
  });

  // None of the real checks calls gh without a token, so this one always does.
  const probe = () => [{ name: 'probe', run: ({ sh: run }) => { run('gh', ['auth', 'status']); return { ok: true, level: 'error', detail: '' }; } }];
  const probeCall = () => sh.calls.find((c) => line(c) === 'gh auth status');

  it('gives an injected check the pasted token as GH_TOKEN', async () => {
    project();
    const cloud = setup({ env: { GH_TOKEN: OWNER }, checks: probe });
    const r = seen(await cloud.setSecrets({ ghToken: GH }));
    expect(r.results).toEqual([{ name: 'probe', ok: true, level: 'error', detail: '' }]);
    expect(probeCall().opts.env.GH_TOKEN).toBe(GH);
  });

  it('gives an injected check no GH_TOKEN at all when the runner file has none', async () => {
    project();
    ignore();
    writeFileSync(join(root, RUNNER_FILE), 'FOREMAN_REPO=acme/app\n', { mode: 0o600 });
    const cloud = setup({ env: { GH_TOKEN: OWNER }, checks: probe });
    seen(await cloud.check({}));
    expect(probeCall()).toBeDefined();
    expect(Object.hasOwn(probeCall().opts.env, 'GH_TOKEN')).toBe(false);
  });
});
