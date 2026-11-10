import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCloudCommand } from './cloud.mjs';
import { actionsWorkflow } from '../../cloud/workflow-template.mjs';
import { withDefaults } from '../../config/defaults.mjs';
import { main } from '../main.mjs';

let root;
const CONFIG = { version: 1, project: { name: 'P' }, state: { store: 'branch' }, cloud: { envVars: ['RESEND_API_KEY'] } };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-cloud-'));
  writeFileSync(join(root, 'foreman.config.json'), JSON.stringify(CONFIG));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(args, deps = {}, env = {}) {
  let out = '';
  let err = '';
  const command = makeCloudCommand(deps);
  const code = await command.run(args, { cwd: root, root, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, now: () => new Date('2026-10-18T10:00:00Z') });
  return { code, out, err };
}
const WORKFLOW = () => join(root, '.github', 'workflows', 'foreman.yml');

describe('foreman cloud actions init', () => {
  it('writes the workflow for this config, and says which secrets to add', async () => {
    const { code, out } = await run(['actions', 'init']);
    expect(code).toBe(0);
    expect(readFileSync(WORKFLOW(), 'utf8')).toBe(actionsWorkflow({ config: withDefaults(CONFIG) }));
    expect(out).toContain('.github/workflows/foreman.yml');
    for (const name of ['FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'RESEND_API_KEY']) expect(out).toContain(name);
  });

  it('offers a classic token with the repo scope, or a fine-grained one with the permissions the ci step can use', async () => {
    const { out } = await run(['actions', 'init']);
    expect(out).toMatch(/classic token with the `repo` scope/);
    expect(out).toMatch(/fine-grained token for this repository with Contents and Pull requests read and write, and Actions and Commit statuses read/);
    expect(out).toMatch(/Deployments read/);
    expect(out).toMatch(/a check that other apps post is not seen/);
    expect(out).not.toMatch(/fine-grained token cannot read a pull request's check runs/);
  });

  it('matches the snapshot when run in a project, through the CLI', async () => {
    let out = '';
    const code = await main(['cloud', 'actions', 'init'], { cwd: root, env: { FOREMAN_PROJECT_DIR: root }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(code).toBe(0);
    // The snapshot pins Foreman 0.5.0; this source may be another version.
    const written = readFileSync(WORKFLOW(), 'utf8').replace(/FOREMAN_VERSION: 'v[^']+'/, "FOREMAN_VERSION: 'v0.5.0'");
    expect(written).toBe(readFileSync(new URL('../../../../test/fixtures/cloud/foreman.yml', import.meta.url), 'utf8'));
  });

  it('refuses to overwrite a workflow without --force', async () => {
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(WORKFLOW(), 'mine\n');
    const r = await run(['actions', 'init']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/--force/);
    expect(readFileSync(WORKFLOW(), 'utf8')).toBe('mine\n');
    expect((await run(['actions', 'init', '--force'])).code).toBe(0);
    expect(readFileSync(WORKFLOW(), 'utf8')).toMatch(/^name: Foreman$/m);
  });

  it('refuses to write through a linked workflow, even with --force', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'foreman-cloud-outside-'));
    try {
      const theirs = join(outside, 'theirs.yml');
      writeFileSync(theirs, 'theirs\n');
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      symlinkSync(theirs, WORKFLOW());
      const r = await run(['actions', 'init', '--force']);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/link/);
      expect(readFileSync(theirs, 'utf8')).toBe('theirs\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses without the branch store, and says what to set', async () => {
    writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ ...CONFIG, state: { store: 'files' } }));
    const r = await run(['actions', 'init']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"state": { "store": "branch" }');
    expect(existsSync(WORKFLOW())).toBe(false);
  });

  it('stops at an invalid config', async () => {
    writeFileSync(join(root, 'foreman.config.json'), '{');
    expect((await run(['actions', 'init'])).code).toBe(1);
  });
});

describe('foreman cloud tick', () => {
  it('hands the story and the clock to the tick', async () => {
    const seen = {};
    const r = await run(['tick', '--story', 'S-2'], { tick: async (opts) => Object.assign(seen, opts) && 7 });
    expect(r.code).toBe(7);
    expect(seen).toMatchObject({ root, story: 'S-2' });
    expect(typeof seen.startSupervisor).toBe('function');
  });

  it('refuses unknown arguments', async () => {
    expect((await run(['tick', '--fast'], { tick: async () => 0 })).code).toBe(64);
    expect((await run(['tick', '--story'], { tick: async () => 0 })).code).toBe(64);
  });
});

describe('foreman cloud sync', () => {
  it('pushes the state folder to the state branch', async () => {
    const calls = [];
    const r = await run(['sync'], { syncState: async (opts) => calls.push(opts) && { pushed: true, refused: [] }, changedFiles: () => new Map() });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ root, direction: 'push', message: 'foreman cloud sync', branch: 'foreman-state', remote: 'origin' });
  });

  it('fails, saying why, when the push fails or there is no branch store', async () => {
    const r = await run(['sync'], { syncState: async () => { throw new Error('rejected'); }, changedFiles: () => new Map() });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rejected/);
    writeFileSync(join(root, 'foreman.config.json'), JSON.stringify({ ...CONFIG, state: { store: 'files' } }));
    expect((await run(['sync'])).code).toBe(1);
  });
});

describe('foreman cloud run', () => {
  it('hands the environment and the real world to the runner', async () => {
    const seen = {};
    const r = await run(['run'], { cloudRun: async (opts) => Object.assign(seen, opts) && 4 });
    expect(r.code).toBe(4);
    for (const dep of ['sh', 'startSupervisor', 'startDashboard', 'wait']) expect(typeof seen[dep]).toBe('function');
    expect(seen.proc).toBe(process);
    expect(seen.env).toEqual({});
  });

  it('takes no arguments; the settings come from the environment', async () => {
    const r = await run(['run', '--repo', 'x'], { cloudRun: async () => 0 });
    expect(r.code).toBe(64);
  });
});

describe('foreman cloud doctor', () => {
  it('runs the runner checks, and the project checks when a project is here', async () => {
    const calls = [];
    const sh = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0, stdout: cmd === 'claude' ? '{"type":"result","is_error":false}' : 'true\n', stderr: '' };
    };
    let out = '';
    const command = makeCloudCommand({ sh });
    const code = await command.run(['doctor'], { cwd: root, root, env: { GH_TOKEN: '' }, stdout: { write: (t) => { out += t; } }, stderr: { write: () => {} } });
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL {2}GH_TOKEN — /m);
    expect(out).toMatch(/^FAIL {2}FOREMAN_REPO — /m);
    // The config here has the branch store, so its branch is checked too.
    expect(out).toMatch(/^ok {4}state branch$/m);
    expect(calls.some((c) => c.startsWith('git push --dry-run'))).toBe(true);
  });
});

it('prints the usage for an unknown subcommand', async () => {
  const r = await run(['launch']);
  expect(r.code).toBe(64);
  expect(r.err).toMatch(/usage: foreman cloud/);
});

describe('foreman cloud run and tick inside a story session', () => {
  it.each([['run', 'foreman cloud run'], ['tick', 'foreman cloud tick']])('%s refuses with FOREMAN_RUN=1, writing no env file', async (sub, what) => {
    let called = false;
    const deps = { cloudRun: async () => { called = true; return 0; }, tick: async () => { called = true; return 0; } };
    const r = await run([sub], deps, { FOREMAN_RUN: '1', RESEND_API_KEY: 're_acme' });
    expect(r.code).toBe(1);
    expect(r.err).toBe(`${what} does not run inside a Foreman story session (FOREMAN_RUN=1); run it yourself from the project's folder.\n`);
    expect(called).toBe(false);
    expect(existsSync(join(root, '.env.local'))).toBe(false);
    expect(existsSync(join(root, '.env.foreman'))).toBe(false);
  });
});
