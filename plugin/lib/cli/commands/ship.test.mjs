import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeShipCommand } from './ship.mjs';
import { main } from '../main.mjs';
import { fakeSh } from '../../../../test/ship-fakes.mjs';
import { fakePack } from '../../../../test/fake-pack.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ship-cli-'));
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' } }));
});
afterEach(() => {
  delete process.env.FOREMAN_SHIP_TEST_VALUE;
});

function harness({ result = { code: 0, result: { stage: 'shipped', pr: 'u', sha: 's' } }, rules = [] } = {}) {
  const seen = [];
  const sh = fakeSh([['git rev-parse --abbrev-ref HEAD', 'story/p4-01\n'], ...rules]);
  const command = makeShipCommand({
    sh,
    runShip: async ({ steps, ctx, onFailure }) => {
      seen.push({ steps, ctx, onFailure });
      return result;
    },
  });
  const run = async (args, env = {}) => {
    let out = '';
    let err = '';
    const code = await command.run(args, {
      cwd: dir,
      root: dir,
      env: { FOREMAN_PROJECT_DIR: dir, ...env },
      now: () => new Date(Date.UTC(2026, 9, 15, 12)),
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
    });
    const lines = out.trim().split('\n');
    return { code, out, err, last: JSON.parse(lines[lines.length - 1]) };
  };
  return { run, seen, sh };
}

describe('foreman ship', () => {
  it('is a registered command', async () => {
    let out = '';
    await main(['--help'], { cwd: dir, env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(out).toMatch(/^ship\s/m);
  });

  it('--preflight changes nothing and prints what each step needs', async () => {
    const h = harness();
    const r = await h.run(['--preflight']);
    expect(r.code).toBe(0);
    expect(r.last).toMatchObject({ preflight: true, gh_signed_in: true });
    expect(r.last.steps.map((s) => s.name)).toEqual(['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge']);
    expect(r.last.steps.find((s) => s.name === 'pr').needs).toContain('gh');
    expect(r.last.warnings).toContain('ship.ci.required is empty; CI is detected by settling');
    expect(h.seen).toHaveLength(0);
    expect(h.sh.calls).toEqual(['gh auth status']);
    expect(fs.readdirSync(dir)).toEqual(['foreman.config.json']);
  });

  it('--preflight warns when migrate-supabase runs without supabase-credentials before it', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ship: { steps: ['prepare-migrations', 'push', 'mergeable-recheck', 'migrate-supabase'], 'migrate-supabase': { projectRef: 'r' } } }));
    expect((await harness().run(['--preflight'])).last.warnings).toEqual(['ship.steps has migrate-supabase without supabase-credentials before push; missing hosted credentials show only after CI']);
  });

  describe('--preflight mergeable-recheck placement', () => {
    const warn = async (steps, extra = {}) => {
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ship: { steps, ci: { required: ['unit'] }, 'migrate-supabase': { projectRef: 'r' }, ...extra } }));
      return (await harness().run(['--preflight'])).last.warnings.filter((w) => w.includes('mergeable-recheck'));
    };
    it('is quiet when it sits right before merge', async () => {
      expect(await warn(['pr', 'ci', 'mergeable-recheck', 'merge'])).toEqual([]);
    });
    it('is quiet when it sits right before migrate-supabase', async () => {
      expect(await warn(['supabase-credentials', 'push', 'pr', 'ci', 'mergeable-recheck', 'migrate-supabase', 'merge'])).toHaveLength(0);
    });
    it('warns when it is missing', async () => {
      expect(await warn(['pr', 'ci', 'merge'])).toHaveLength(1);
    });
    it('warns when another step sits between it and the point of no return', async () => {
      expect(await warn(['pr', 'mergeable-recheck', 'ci', 'merge'])).toHaveLength(1);
    });
    it('warns when it comes after the first point of no return', async () => {
      expect(await warn(['pr', 'ci', 'migrate-supabase', 'mergeable-recheck', 'merge'])).toHaveLength(1);
    });
    it('does not warn when the release has no point-of-no-return step', async () => {
      expect(await warn(['pr', 'ci'])).toEqual([]);
    });
  });

  it('--preflight has no warning when CI checks are named', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ship: { steps: ['ci'], ci: { required: ['unit'] } } }));
    expect((await harness().run(['--preflight'])).last.warnings).toEqual([]);
  });

  it('--preflight lists the release steps\' needs, missing env names and option warnings', async () => {
    fs.writeFileSync(
      path.join(dir, 'foreman.config.json'),
      JSON.stringify({
        version: 1,
        project: { name: 'T' },
        ship: { steps: ['merge-main', 'prepare-migrations', 'resources', 'supabase-credentials', 'push', 'pr', 'ci', 'mergeable-recheck', 'migrate-supabase', 'merge', 'deploy-github', 'smoke'], ci: { required: ['unit'] } },
      }),
    );
    fs.writeFileSync(path.join(dir, '.env.local'), 'SUPABASE_DB_PASSWORD=pw-secret\n');
    try {
      const r = await harness().run(['--preflight']);
      expect(r.code).toBe(0);
      expect(r.last.steps).toEqual([
        { name: 'merge-main', needs: ['git'] },
        { name: 'prepare-migrations', needs: ['git'] },
        { name: 'resources', needs: ['git'] },
        { name: 'supabase-credentials', needs: [] },
        { name: 'push', needs: ['git'] },
        { name: 'pr', needs: ['gh'] },
        { name: 'ci', needs: ['gh'] },
        { name: 'mergeable-recheck', needs: ['git', 'gh'] },
        { name: 'migrate-supabase', needs: ['supabase'] },
        { name: 'merge', needs: ['gh', 'git'] },
        { name: 'deploy-github', needs: ['gh'] },
        { name: 'smoke', needs: [] },
      ]);
      expect(r.last.missing_env).toEqual(['SUPABASE_ACCESS_TOKEN']);
      expect(r.last.warnings).toEqual(['ship["migrate-supabase"].projectRef is not set', 'ship.smoke.urls is empty; the live site is not checked']);
      expect(r.out).not.toContain('pw-secret');
    } finally {
      delete process.env.SUPABASE_DB_PASSWORD;
    }
  });

  it('--preflight reports gh not signed in', async () => {
    const h = harness({ rules: [['gh auth status', 1]] });
    expect((await h.run(['--preflight'])).last.gh_signed_in).toBe(false);
  });

  it('takes the story id from --story', async () => {
    const h = harness();
    const r = await h.run(['--story', 'S-5'], { FOREMAN_STORY: 'S-9' });
    expect(h.seen[0].ctx.story).toBe('S-5');
    expect(r.code).toBe(0);
    expect(r.last).toEqual({ ok: true, code: 0, stage: 'shipped', pr: 'u', sha: 's' });
  });

  it('takes the story id from --story=<id>', async () => {
    const h = harness();
    await h.run(['--story=S-6']);
    expect(h.seen[0].ctx.story).toBe('S-6');
  });

  it('an exception escaping the runner prints a JSON line and exits 1', async () => {
    const command = makeShipCommand({
      sh: fakeSh(),
      runShip: async () => {
        throw new Error('kaboom');
      },
    });
    let out = '';
    const code = await command.run(['--story', 'S-1'], { cwd: dir, root: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(code).toBe(1);
    expect(JSON.parse(out.trim().split('\n').pop())).toMatchObject({ ok: false, code: 1, stage: 'runner', reason: expect.stringContaining('kaboom') });
  });

  it('the real shell passes values loaded from the env file to child processes', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), 'FOREMAN_SHIP_TEST_VALUE=very-secret\n');
    const command = makeShipCommand({
      runShip: async ({ ctx }) => {
        const r = ctx.sh('sh', ['-c', 'printf %s "$FOREMAN_SHIP_TEST_VALUE"']);
        return { code: 0, result: { stage: 'shipped', childSaw: r.stdout === 'very-secret' } };
      },
    });
    let out = '';
    await command.run(['--story', 'S-1'], { cwd: dir, root: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(JSON.parse(out.trim()).childSaw).toBe(true);
  });

  it('gives the steps the environment, env file included, and a shell that takes an env of its own', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), 'FOREMAN_SHIP_TEST_VALUE=very-secret\n');
    const command = makeShipCommand({
      runShip: async ({ ctx }) => {
        const own = ctx.sh('sh', ['-c', 'printf %s "$FOREMAN_SHIP_TEST_VALUE"'], { env: { PATH: process.env.PATH } });
        return { code: 0, result: { stage: 'shipped', inCtx: ctx.env.FOREMAN_SHIP_TEST_VALUE === 'very-secret', ownEnv: own.stdout } };
      },
    });
    let out = '';
    await command.run(['--story', 'S-1'], { cwd: dir, root: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(JSON.parse(out.trim())).toMatchObject({ inCtx: true, ownEnv: '' });
  });

  it('gives the steps only the registry names they declare in requires.env, and no other name from .env.foreman', async () => {
    const config = { version: 1, project: { name: 'Acme' }, pack: 'acme', ship: { steps: ['acme-deploy'] } };
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(config));
    fs.writeFileSync(path.join(dir, '.env.foreman'), 'GEARSET_API_TOKEN=gs_acme_file\nRESEND_API_KEY=re_acme_file\nACME_SHIP_ONLY=x\n');
    const deploy = { name: 'acme-deploy', needs: [], requires: { env: ['GEARSET_API_TOKEN'] }, async run() { return { ok: true }; } };
    const command = makeShipCommand({
      packs: { acme: fakePack({ steps: { 'acme-deploy': deploy } }) },
      runShip: async ({ ctx }) => {
        const child = ctx.sh('sh', ['-c', 'printf %s "$GEARSET_API_TOKEN|$RESEND_API_KEY|$ACME_SHIP_ONLY"']).stdout;
        return { code: 0, result: { stage: 'shipped', child: child === 'gs_acme_file||', resend: 'RESEND_API_KEY' in ctx.env } };
      },
    });
    const NAMES = ['GEARSET_API_TOKEN', 'RESEND_API_KEY', 'ACME_SHIP_ONLY'];
    const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
    for (const n of NAMES) delete process.env[n];
    let out = '';
    try {
      await command.run(['--story', 'S-1'], { cwd: dir, root: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    } finally {
      for (const n of NAMES) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    }
    expect(JSON.parse(out.trim())).toMatchObject({ child: true, resend: false });
    expect(out).not.toContain('acme_file');
  });

  describe('the time the story was last rolled back (ctx.rolledBackAt)', () => {
    const AT = '2026-11-10T18:00:00Z';
    const acme = { version: 1, project: { name: 'Acme' }, pack: 'acme', ship: { steps: ['acme-deploy'] } };
    const shipWith = async ({ config = acme, packs }) => {
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(config));
      const state = path.join(dir, 'state');
      const seen = [];
      const command = makeShipCommand({ sh: fakeSh([]), packs, runShip: async ({ ctx }) => (seen.push(ctx), { code: 0, result: { stage: 'shipped' } }) });
      let out = '';
      const code = await command.run(['--story', 'S-1'], { cwd: dir, root: dir, env: { FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: state }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
      return { code, seen, state };
    };

    it('is what the pack says, asked for the state folder and the story', async () => {
      const asked = [];
      const { code, seen, state } = await shipWith({ packs: { acme: fakePack({ rolledBackAt: (a) => (asked.push(a), AT) }) } });
      expect(code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].rolledBackAt).toBe(AT);
      expect(asked).toEqual([{ dir: state, story: 'S-1' }]);
    });

    it.each([
      ['the config names no pack', { config: { version: 1, project: { name: 'Acme' } }, packs: { acme: fakePack({ rolledBackAt: () => AT }) } }],
      ['the pack gives none', { packs: { acme: fakePack({ rolledBackAt: () => null }) } }],
      ['the pack throws', { packs: { acme: fakePack({ rolledBackAt: () => { throw new Error('boom'); } }) } }],
      ['the pack gives something that is not a time', { packs: { acme: fakePack({ rolledBackAt: () => 'not a time' }) } }],
    ])('is null, and the release still runs, when %s', async (_name, opts) => {
      const { code, seen } = await shipWith(opts);
      expect(code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].rolledBackAt).toBeNull();
    });
  });

  it('stops with a JSON line naming .env.foreman when that file cannot be read', async () => {
    fs.mkdirSync(path.join(dir, '.env.foreman'));
    const r = await harness().run(['--story', 'S-1']);
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ ok: false, stage: 'start', reason: 'Could not read .env.foreman.' });
  });

  it('gives the steps the project root, and a shell that takes a cwd of its own', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ship-cwd-'));
    const command = makeShipCommand({
      runShip: async ({ ctx }) => {
        const here = ctx.sh('pwd', []).stdout.trim();
        const there = ctx.sh('pwd', [], { cwd: ctx.root }).stdout.trim();
        return { code: 0, result: { stage: 'shipped', root: ctx.root, here, there } };
      },
    });
    let out = '';
    await command.run(['--story', 'S-1'], { cwd: elsewhere, root: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    const r = JSON.parse(out.trim());
    expect(r.root).toBe(dir);
    expect(fs.realpathSync(r.here)).toBe(fs.realpathSync(elsewhere));
    expect(fs.realpathSync(r.there)).toBe(fs.realpathSync(dir));
  });

  it('the real shell stops a command that runs past its timeout and says so', async () => {
    const command = makeShipCommand({
      runShip: async ({ ctx }) => {
        const started = Date.now();
        const slow = ctx.sh('sh', ['-c', 'sleep 5; echo late'], { timeout: 200 });
        const quick = ctx.sh('sh', ['-c', 'echo ok'], { timeout: 5000 });
        return { code: 0, result: { stage: 'shipped', slow: { ...slow, ms: Date.now() - started }, quick } };
      },
    });
    let out = '';
    await command.run(['--story', 'S-1'], { cwd: dir, root: dir, env: { FOREMAN_PROJECT_DIR: dir }, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    const { slow, quick } = JSON.parse(out.trim());
    expect(slow).toMatchObject({ timedOut: true, stdout: '' });
    expect(slow.status).not.toBe(0);
    expect(slow.ms).toBeLessThan(3000);
    expect(quick).toMatchObject({ status: 0, stdout: 'ok\n', timedOut: false });
  });

  it('hands the runner the rollback as onFailure when ship.rollback.command is set', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ship: { steps: ['merge', 'watch'], watch: { command: './check.sh' }, rollback: { command: 'vercel rollback --yes' } } }));
    const h = harness();
    await h.run(['--story', 'S-1']);
    expect(h.seen[0].steps.map((s) => s.name)).toEqual(['merge', 'watch']);
    expect(h.seen[0].onFailure.name).toBe('rollback');
  });

  it('hands the runner no onFailure without a rollback', async () => {
    const h = harness();
    await h.run(['--story', 'S-1']);
    expect(h.seen[0].onFailure).toBeNull();
  });

  describe('--preflight with watch and rollback', () => {
    const preflight = async (ship) => {
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ship: { ci: { required: ['unit'] }, ...ship } }));
      return (await harness().run(['--preflight'])).last;
    };
    const WATCH_ALONE = 'ship.steps has watch but ship.rollback.command is not set; a problem after the deploy halts releases but leaves production as it is';

    it('lists the rollback as running on failure', async () => {
      const r = await preflight({ steps: ['mergeable-recheck', 'merge', 'deploy-github', 'watch'], watch: { command: './check.sh' }, rollback: { command: 'vercel rollback --yes' } });
      expect(r.steps).toEqual([
        { name: 'mergeable-recheck', needs: ['git', 'gh'] },
        { name: 'merge', needs: ['gh', 'git'] },
        { name: 'deploy-github', needs: ['gh'] },
        { name: 'watch', needs: ['sh'] },
        { name: 'rollback', needs: ['sh'], when: 'on failure' },
      ]);
      expect(r.warnings).toEqual([]);
    });

    it('warns when a rollback is set but no deploy step comes before the checks', async () => {
      const r = await preflight({ steps: ['mergeable-recheck', 'merge', 'watch'], watch: { command: './check.sh' }, rollback: { command: 'vercel rollback --yes' } });
      expect(r.warnings).toEqual(['ship.rollback.command is set but ship.steps has no deploy step (deploy-github); the rollback runs only for a failure after a successful deploy, so it never runs']);
    });

    it('warns when watch has no rollback', async () => {
      const r = await preflight({ steps: ['mergeable-recheck', 'merge', 'watch'], watch: { command: './check.sh' } });
      expect(r.steps.map((s) => s.name)).toEqual(['mergeable-recheck', 'merge', 'watch']);
      expect(r.warnings).toEqual([WATCH_ALONE]);
    });
  });

  describe('the switches and settings, local layer included', () => {
    const RELEASE = { steps: ['mergeable-recheck', 'merge', 'deploy-github', 'watch'], ci: { required: ['unit'] }, watch: { command: './check.sh' }, rollback: { command: 'vercel rollback --yes' } };
    const localSettings = (values) => {
      fs.mkdirSync(path.join(dir, '.foreman'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.foreman', 'settings.json'), JSON.stringify(values));
    };
    beforeEach(() => {
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ship: RELEASE }));
    });

    it('--preflight leaves out watch and the rollback when features.watchRollback is off, and says so', async () => {
      localSettings({ 'features.watchRollback': false });
      const r = (await harness().run(['--preflight'])).last;
      expect(r.steps.map((s) => s.name)).toEqual(['mergeable-recheck', 'merge', 'deploy-github']);
      expect(r.warnings).toEqual(['features.watchRollback is off; the watch step and the rollback are skipped']);
    });

    it('--preflight leaves out mergeable-recheck when features.mergeableRecheck is off, and says so', async () => {
      localSettings({ 'features.mergeableRecheck': false });
      const r = (await harness().run(['--preflight'])).last;
      expect(r.steps.map((s) => s.name)).toEqual(['merge', 'deploy-github', 'watch', 'rollback']);
      expect(r.warnings).toEqual(['features.mergeableRecheck is off; the mergeable-recheck step is skipped, so the base branch can move after CI and the pull request fail to merge']);
    });

    it('a release runs without the switched-off steps and no rollback', async () => {
      localSettings({ 'features.watchRollback': false, 'features.mergeableRecheck': false });
      const h = harness();
      await h.run(['--story', 'S-1']);
      expect(h.seen[0].steps.map((s) => s.name)).toEqual(['merge', 'deploy-github']);
      expect(h.seen[0].onFailure).toBeNull();
    });

    it('the steps get the local ship timeouts', async () => {
      localSettings({ 'ship.ci.timeoutMinutes': 45, 'ship.watch.minutes': 3 });
      const h = harness();
      await h.run(['--story', 'S-1']);
      expect(h.seen[0].ctx.config.ship.ci.timeoutMinutes).toBe(45);
      expect(h.seen[0].ctx.config.ship.watch).toEqual({ command: './check.sh', minutes: 3 });
    });
  });

  it('takes the story id from FOREMAN_STORY', async () => {
    const h = harness();
    await h.run([], { FOREMAN_STORY: 'S-9' });
    expect(h.seen[0].ctx.story).toBe('S-9');
  });

  it('never rebuilds the story id from the branch name', async () => {
    const h = harness();
    const r = await h.run([]);
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ ok: false, code: 1, reason: 'no story id: pass --story or set FOREMAN_STORY' });
    expect(h.seen).toHaveLength(0);
  });

  it('exits with the runner\'s code and prints its result last', async () => {
    const h = harness({ result: { code: 6, result: { stage: 'merge-main', reason: 'conflict', conflicts: ['a'] } } });
    const r = await h.run(['--story', 'S-1']);
    expect(r.code).toBe(6);
    expect(r.last).toEqual({ ok: false, code: 6, stage: 'merge-main', reason: 'conflict', conflicts: ['a'] });
  });

  it('hands the runner the configured steps and a ctx wired to the state folder', async () => {
    const h = harness();
    await h.run(['--story', 'S-1'], { FOREMAN_SLOT: 'w2', FOREMAN_SUPERVISOR_PID: '4242' });
    const { steps, ctx } = h.seen[0];
    expect(steps.map((s) => s.name)).toEqual(['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge']);
    expect(ctx).toMatchObject({ slot: 'w2', holderPid: 4242, pid: process.pid });
    expect(ctx.isHalted()).toBe(false);
    ctx.halt({ stage: 'deploy', reason: 'down' });
    expect(ctx.isHalted()).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.foreman', 'HALT'), 'utf8')).toBe('2026-10-15T12:00:00.000Z {"stage":"deploy","reason":"down"}\n');
  });

  it('loads the env file into the process without printing its values', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), 'FOREMAN_SHIP_TEST_VALUE=very-secret\n');
    const h = harness();
    const r = await h.run(['--story', 'S-1']);
    expect(process.env.FOREMAN_SHIP_TEST_VALUE).toBe('very-secret');
    expect(r.out + r.err).not.toContain('very-secret');
  });

  it('an invalid config exits 1 with a JSON line', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{}');
    const r = await harness().run(['--story', 'S-1']);
    expect(r.code).toBe(1);
    expect(r.last).toMatchObject({ ok: false, code: 1, stage: 'start' });
  });

  it('an unknown ship step exits 1 naming it', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, ship: { steps: ['push', 'nope'] } }));
    const r = await harness().run(['--story', 'S-1']);
    expect(r.code).toBe(1);
    expect(r.last.reason).toContain('unknown ship step: nope');
  });
});

describe('foreman ship with a pack', () => {
  const config = { version: 1, project: { name: 'Acme' }, pack: 'acme', ship: { steps: ['merge-main', 'push', 'acme-deploy'] } };
  const run = async (command) => {
    let out = '';
    const code = await command.run(['--preflight'], {
      cwd: dir,
      root: dir,
      env: { FOREMAN_PROJECT_DIR: dir },
      now: () => new Date(Date.UTC(2026, 9, 15, 12)),
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    const lines = out.trim().split('\n');
    return { code, last: JSON.parse(lines[lines.length - 1]) };
  };
  const runShip = async () => ({ code: 0, result: {} });

  it('--preflight lists the pack step when the pack is installed', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(config));
    const r = await run(makeShipCommand({ sh: fakeSh([]), runShip, packs: { acme: fakePack() } }));
    expect(r.code).toBe(0);
    expect(r.last.steps).toEqual([
      { name: 'merge-main', needs: ['git'] },
      { name: 'push', needs: ['git'] },
      { name: 'acme-deploy', needs: ['acme-cli'] },
    ]);
    expect(r.last.missing_env).toContain('ACME_TOKEN');
  });
  it('refuses the config when the pack is not installed', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(config));
    const r = await run(makeShipCommand({ sh: fakeSh([]), runShip }));
    expect(r.code).toBe(1);
    expect(r.last.ok).toBe(false);
    expect(r.last.reason).toMatch(/pack/);
  });
  it('reports a pack defaults() that throws instead of throwing', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify(config));
    const packs = { acme: fakePack({ defaults: () => { throw new Error('dflt boom'); } }) };
    const r = await run(makeShipCommand({ sh: fakeSh([]), runShip, packs }));
    expect(r.code).toBe(1);
    expect(r.last.ok).toBe(false);
    expect(r.last.stage).toBe('start');
    expect(r.last.reason).toContain('acme: the acme pack could not give its defaults: dflt boom');
  });
});

describe('--preflight mergeable-recheck placement with a pack step', () => {
  const run = async (command) => {
    let out = '';
    const code = await command.run(['--preflight'], {
      cwd: dir,
      root: dir,
      env: { FOREMAN_PROJECT_DIR: dir },
      now: () => new Date(Date.UTC(2026, 9, 15, 12)),
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    const lines = out.trim().split('\n');
    return { code, last: JSON.parse(lines[lines.length - 1]) };
  };
  const runShip = async () => ({ code: 0, result: {} });
  const release = { name: 'acme-release', needs: [], beforeNoReturn: true, async run() { return { ok: true }; } };
  const plain = { name: 'acme-plain', needs: [], async run() { return { ok: true }; } };
  const packs = { acme: fakePack({ steps: { 'acme-release': release, 'acme-plain': plain } }) };
  const warn = async (steps) => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, pack: 'acme', ship: { steps, ci: { required: ['unit'] } } }));
    const r = await run(makeShipCommand({ sh: fakeSh([]), runShip, packs }));
    expect(r.code).toBe(0);
    return r.last.warnings.filter((w) => w.includes('mergeable-recheck'));
  };
  it('warns when a pack step marked beforeNoReturn has no mergeable-recheck right before it', async () => {
    const got = await warn(['pr', 'ci', 'acme-release']);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain('right before acme-release');
  });
  it('is quiet when mergeable-recheck sits right before the pack step', async () => {
    expect(await warn(['pr', 'ci', 'mergeable-recheck', 'acme-release'])).toEqual([]);
  });
  it('ignores a pack step without the flag', async () => {
    expect(await warn(['pr', 'ci', 'acme-plain'])).toEqual([]);
  });
});

describe('foreman ship: a release that stops is written on the story', () => {
  const overlay = () => {
    const file = path.join(dir, '.foreman', 'stories', 'S-1.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).notes.map((n) => n.text) : [];
  };
  beforeEach(() => {
    fs.mkdirSync(path.join(dir, 'stories'));
    fs.writeFileSync(path.join(dir, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: One\nstatus: in-progress\n---\n\n## Progress notes\n');
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, stories: { adapter: 'markdown', dir: 'stories' } }));
  });

  it('a conflict (exit 6) adds one release note with the reason, and the printed JSON is unchanged', async () => {
    const result = { stage: 'merge-main', reason: 'The branch conflicts in src/a.mjs.', pr: 'https://gh/pull/12' };
    const h = harness({ result: { code: 6, result } });
    const r = await h.run(['--story', 'S-1']);
    expect(r.code).toBe(6);
    expect(r.last).toEqual({ ok: false, code: 6, ...result });
    expect(overlay()).toEqual(['The release stopped: The branch conflicts with the base branch. The reason given: The branch conflicts in src/a.mjs.']);
  });

  it('adds one note for each code that stops the release for a reason, and a failed step', async () => {
    for (const code of [1, 2, 4, 5, 10]) {
      fs.rmSync(path.join(dir, '.foreman'), { recursive: true, force: true });
      await harness({ result: { code, result: { stage: 'ci', reason: `Stopped with ${code}.` } } }).run(['--story', 'S-1']);
      expect(overlay(), `exit ${code}`).toHaveLength(1);
    }
  });

  it('adds none for exit 0, 7, 8 or 9, nor for a failure before any step ran', async () => {
    for (const result of [{ code: 0, result: { stage: 'shipped' } }, { code: 7, result: { stage: 'x', reason: 'r' } }, { code: 8, result: { stage: 'x', reason: 'r' } }, { code: 9, result: { stage: 'x', reason: 'r', step: 'ci', parked: { reason: 'later' } } }, { code: 1, result: { stage: 'start', reason: 'r' } }]) {
      fs.rmSync(path.join(dir, '.foreman'), { recursive: true, force: true });
      await harness({ result }).run(['--story', 'S-1']);
      expect(overlay().filter((n) => n.startsWith('The release stopped')), `exit ${result.code}`).toEqual([]);
    }
  });

  it('adds none with jiraComments off, and a story the source does not know does not fail the release', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, stories: { adapter: 'markdown', dir: 'stories' }, features: { jiraComments: false } }));
    await harness({ result: { code: 6, result: { stage: 'merge-main', reason: 'x' } } }).run(['--story', 'S-1']);
    expect(overlay()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'T' }, stories: { adapter: 'markdown', dir: 'stories' } }));
    const r = await harness({ result: { code: 6, result: { stage: 'merge-main', reason: 'x' } } }).run(['--story', 'S-404']);
    expect(r.code).toBe(6);
  });
});
