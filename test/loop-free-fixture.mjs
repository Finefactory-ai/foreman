// The set-up for the tests that show no synchronous child holds the supervisor's loop
// (plugin/lib/engine/supervisor-loop-*.test.mjs): a real supervisor run on an Acme repo with the
// dashboard on, a fake `claude` and a fake `gh` (and, when asked, a `git` that wraps the real one)
// on the PATH, the short test tick, and a mark file that a slow child writes its pid to.
//
//   const ctx = withLoopFree({ config, claude, gh, git, setup })
//       registers the hooks (before and after each test, and the supervisors' own, last); ctx is
//       filled in before each test:
//       config   more of foreman.config.json (the console, keepAwake and learning are set here)
//       claude   the script of the fake `claude` (default: record its story, exit 1)
//       gh       the script of the fake `gh` (default: `pr list` gives [], anything else fails)
//       git      shell lines that run before the real git, with $LOOP_FREE_MARK to mark a pid;
//                the wrapper then execs the real git (resolved at set-up, so never itself)
//       setup    async (ctx) => {} after the repo and the bin folder exist; it may commit and push
//   ctx.clone, ctx.repos, ctx.bin, ctx.stateDir, ctx.port, ctx.mark
//   ctx.story(id, status, blockedBy), ctx.commit(message)
//   ctx.start()           starts the run in the foreground and gives the child
//   ctx.foreman(...args)  runs a `foreman` command in the clone
//   ctx.loop(), ctx.events(), ctx.slot(w), ctx.claudeCalls(), ctx.markPids(), ctx.gone(pid)
//   ctx.waitFor(what, test, ms)
//   holdsTheLoopFree(ctx, { pid })  the four checks every test shares, while the slow child (its
//       mark pid) runs: /api/status answers in 2 s, a pause is applied, the pid lives; then
//       `foreman stop --now` ends the run with 130, the pid is gone in 5 s and no event says the
//       supervisor woke late
//
// Tests stop only the pids they recorded in the mark file.

import { afterEach, beforeEach, expect } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { git as gitIn, makeRepos } from './state-repos.mjs';
import { fastTick } from './fast-tick.mjs';
import { runForeman, startForeman, useSupervisors } from './supervisors.mjs';

export const STORY = (id, status = 'todo', blockedBy = '') => `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\ndepends_on: []\n${blockedBy ? `blocked_by: ${blockedBy}\n` : ''}---\n\nDo ${id}.\n\n## Progress notes\n`;

const FAKE_CLAUDE = `#!/bin/sh
echo "$FOREMAN_STORY" >> "$LOOP_FREE_CLAUDE"
exit 1
`;
export const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr list") echo "[]" ;;
  *) exit 1 ;;
esac
`;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
};

export function withLoopFree({ config = {}, claude = FAKE_CLAUDE, gh = FAKE_GH, git = null, setup = async () => {} } = {}) {
  const ctx = {};
  let marks = null;

  beforeEach(async () => {
    ctx.port = await freePort();
    marks = mkdtempSync(join(tmpdir(), 'foreman-loop-free-'));
    ctx.mark = join(marks, 'mark');
    ctx.claudeLog = join(marks, 'claude');
    writeFileSync(ctx.claudeLog, '');
    ctx.repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'dashboard', port: ctx.port }, features: { keepAwake: false }, learning: { auto: false }, ...config });
    ctx.clone = ctx.repos.clone('acme');
    ctx.stateDir = join(ctx.clone, '.foreman');
    ctx.child = null;
    ctx.out = '';
    writeFileSync(join(ctx.clone, '.gitignore'), '.foreman/\n');
    mkdirSync(join(ctx.clone, 'stories'));
    ctx.bin = join(ctx.repos.base, 'bin');
    mkdirSync(ctx.bin);
    const script = (name, text) => {
      writeFileSync(join(ctx.bin, name), text);
      chmodSync(join(ctx.bin, name), 0o755);
    };
    script('claude', typeof claude === 'function' ? claude(ctx) : claude);
    script('gh', gh);
    if (git) {
      const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      script('git', `#!/bin/sh\n${git}\nexec "${real}" "$@"\n`);
    }
    ctx.env = () => {
      const env = { ...process.env, PATH: `${ctx.bin}:${process.env.PATH}`, HOME: ctx.repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LOOP_FREE_MARK: ctx.mark, LOOP_FREE_CLAUDE: ctx.claudeLog };
      for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
      return { ...env, ...fastTick };
    };
    ctx.story = (id, status, blockedBy) => writeFileSync(join(ctx.clone, 'stories', `${id}.md`), STORY(id, status, blockedBy));
    ctx.commit = (message = 'Set up') => {
      gitIn(ctx.clone, 'add', '.');
      gitIn(ctx.clone, 'commit', '-qm', message);
      gitIn(ctx.clone, 'push', '-q', 'origin', 'main');
    };
    ctx.start = () => {
      ctx.child = startForeman(['run', '--foreground'], { cwd: ctx.clone, env: ctx.env(), stdio: ['ignore', 'pipe', 'pipe'] });
      ctx.child.stdout.on('data', (d) => (ctx.out += d));
      ctx.child.stderr.on('data', (d) => (ctx.out += d));
      return ctx.child;
    };
    ctx.foreman = (...args) => runForeman(args, { cwd: ctx.clone, env: ctx.env(), encoding: 'utf8', timeout: 30_000 });
    ctx.loop = () => {
      try {
        return JSON.parse(readFileSync(join(ctx.stateDir, 'state.json'), 'utf8')).loop ?? null;
      } catch {
        return null;
      }
    };
    ctx.events = () => {
      const file = join(ctx.stateDir, 'events.jsonl');
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text) : [];
    };
    ctx.slot = (w = 'w1') => {
      try {
        return JSON.parse(readFileSync(join(ctx.stateDir, 'slots', `${w}.json`), 'utf8'));
      } catch {
        return null;
      }
    };
    ctx.claudeCalls = () => readFileSync(ctx.claudeLog, 'utf8').split('\n').filter(Boolean);
    ctx.markPids = () => (existsSync(ctx.mark) ? readFileSync(ctx.mark, 'utf8').split('\n').filter(Boolean).map(Number) : []);
    ctx.gone = gone;
    ctx.waitFor = async (what, test, ms) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (test()) return;
        if (ctx.child && ctx.child.exitCode !== null && ctx.child.exitCode !== undefined) throw new Error(`the run exited (${ctx.child.exitCode}) while waiting for ${what}: ${ctx.out.slice(-500)}`);
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${what}; loop ${JSON.stringify(ctx.loop())}; events ${JSON.stringify(ctx.events().slice(-5))}`);
    };
    await setup(ctx);
  });

  afterEach(() => {
    // Only the pids the slow children recorded.
    for (const pid of ctx.markPids?.() ?? []) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone already
      }
    }
    ctx.repos?.cleanup();
    if (marks) rmSync(marks, { recursive: true, force: true });
  });
  // After the hooks above, so it runs before them (vitest runs afterEach hooks last first).
  useSupervisors();
  return ctx;
}

// While the slow child (its mark pid) runs: the dashboard answers, a pause is applied, the pid
// lives. Then `foreman stop --now`: exit 130, the pid gone, no late wake.
export async function holdsTheLoopFree(ctx, { pid }) {
  await ctx.waitFor('the dashboard', () => ctx.out.includes('Dashboard: '), 20_000);
  const base = `http://127.0.0.1:${ctx.port}`;
  const started = Date.now();
  const status = await fetch(`${base}/api/status`);
  expect(status.status).toBe(200);
  expect(Date.now() - started).toBeLessThan(2000);

  expect(ctx.foreman('pause').status).toBe(0);
  await ctx.waitFor('the pause', () => ctx.loop()?.state === 'paused', 10_000);
  expect(ctx.gone(pid)).toBe(false);

  expect(ctx.foreman('stop', '--now').status).toBe(0);
  expect(await ctx.child.exited).toBe(130);
  await ctx.waitFor('the child to end', () => ctx.gone(pid), 5000);
  expect(ctx.events().filter((t) => /woke .* late/.test(t))).toEqual([]);
}
