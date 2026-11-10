import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { idleReason, tick } from './tick.mjs';
import { withDefaults } from '../config/defaults.mjs';
import * as decisions from '../console/decisions.mjs';

let root;
let dir;

const STORY = (id, status = 'todo', deps = []) => `---\nid: ${id}\ntitle: Story ${id}\nstatus: ${status}\ndepends_on: [${deps.join(', ')}]\n---\n\nDo ${id}.\n`;

function project({ config = {}, stories = { 'S-1': STORY('S-1') } } = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tick-'));
  dir = path.join(root, '.foreman');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'P' }, state: { store: 'branch' }, ...config }));
  fs.mkdirSync(path.join(root, 'stories'));
  for (const [id, text] of Object.entries(stories)) fs.writeFileSync(path.join(root, 'stories', `${id}.md`), text);
}
const write = (rel, value) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), typeof value === 'string' ? value : JSON.stringify(value));
};
const config = () => withDefaults(JSON.parse(fs.readFileSync(path.join(root, 'foreman.config.json'), 'utf8')));
const NOW = () => new Date('2026-10-18T10:00:00Z');

// Fakes for the outside world; `order` records what ran, in order.
function fakes({ pull = 'ok', push = 'ok', supervisor = 0, onSupervisor = null, learning = { status: 0, stdout: '' } } = {}) {
  const order = [];
  const seen = {};
  return {
    order,
    seen,
    deps: {
      syncState: async (opts) => {
        order.push(opts.direction);
        if (opts.direction === 'pull' && pull !== 'ok') throw new Error(pull);
        if (opts.direction === 'push') {
          seen.pushMessage = opts.message;
          if (push !== 'ok') throw new Error(push);
        }
        return { setup: { created: false, moved: [], leftover: null }, pushed: true, refused: [] };
      },
      changedFiles: () => new Map(),
      startSupervisor: async ({ args, env }) => {
        order.push('supervisor');
        seen.args = args;
        seen.env = env;
        seen.envFileAtStart = fs.existsSync(path.join(root, '.env.local')) ? fs.readFileSync(path.join(root, '.env.local'), 'utf8') : null;
        seen.foremanFileAtStart = fs.existsSync(path.join(root, '.env.foreman')) ? fs.readFileSync(path.join(root, '.env.foreman'), 'utf8') : null;
        onSupervisor?.();
        return supervisor;
      },
      learningTick: ({ env }) => {
        order.push('learning');
        seen.learningEnv = env;
        return learning;
      },
      sh: (cmd, args) => {
        order.push([cmd, ...args].slice(0, 3).join(' '));
        // `git ls-files` lists nothing: no key file is tracked.
        return { status: 0, stdout: cmd === 'git' && args[0] !== 'ls-files' ? 'me@example.com\n' : '', stderr: '' };
      },
    },
  };
}

async function runTick(f, { env = {}, story } = {}) {
  let out = '';
  let err = '';
  const code = await tick({ root, env, story, now: NOW, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, ...f.deps });
  return { code, out, err };
}
const steps = (f) => f.order.filter((s) => ['pull', 'supervisor', 'push'].includes(s));

beforeEach(() => project());

describe('foreman cloud tick', () => {
  it('pulls the state, runs the supervisor for one story with one worker, then pushes the state', async () => {
    const f = fakes();
    const { code, out } = await runTick(f);
    expect(code).toBe(0);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
    expect(f.seen.args).toEqual(['--max', '1', '--workers', '1', '--once']);
    expect(f.seen.pushMessage).toBe('foreman cloud tick');
    expect(out).toMatch(/Building one story/);
  });

  it('signs git in before the first pull', async () => {
    const f = fakes();
    await runTick(f);
    expect(f.order.indexOf('gh auth setup-git')).toBeGreaterThanOrEqual(0);
    expect(f.order.indexOf('gh auth setup-git')).toBeLessThan(f.order.indexOf('pull'));
  });

  it("turns off the per-command state sync for the supervisor's children, and passes the run markers", async () => {
    const f = fakes();
    await runTick(f, { env: { PATH: '/bin' } });
    expect(f.seen.env).toMatchObject({ PATH: '/bin', FOREMAN_STATE_SYNC: 'off' });
  });

  it('writes the project keys to the envFile and keeps them out of the supervisor environment', async () => {
    project({ config: { cloud: { envVars: ['RESEND_API_KEY'] } } });
    const f = fakes();
    const { out, err } = await runTick(f, { env: { RESEND_API_KEY: 're_secret_1', GH_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-ant-x' } });
    expect(f.seen.foremanFileAtStart).toContain('RESEND_API_KEY=');
    expect(f.seen.envFileAtStart).toBeNull();
    expect(f.seen.env.RESEND_API_KEY).toBeUndefined();
    expect(f.seen.env).toMatchObject({ GH_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-ant-x' });
    expect(out + err).not.toContain('re_secret_1');
  });

  it('never writes the keys to an envFile git would commit, and still keeps them from the sessions', async () => {
    project({ config: { cloud: { envVars: ['RESEND_API_KEY'] } } });
    const f = fakes();
    const sh = f.deps.sh;
    f.deps.sh = (cmd, args, opts) => (cmd === 'git' && args[0] === 'check-ignore' ? { status: 1, stdout: '', stderr: '' } : sh(cmd, args, opts));
    const { code, err } = await runTick(f, { env: { RESEND_API_KEY: 're_secret_1' } });
    expect(code).toBe(0);
    expect(f.seen.envFileAtStart).toBeNull();
    expect(f.seen.foremanFileAtStart).toBeNull();
    expect(f.seen.env.RESEND_API_KEY).toBeUndefined();
    expect(err).toMatch(/\.env\.foreman is not ignored by git/);
    expect(err).not.toContain('re_secret_1');
  });

  it('names the project keys that are missing, without failing', async () => {
    project({ config: { cloud: { envVars: ['RESEND_API_KEY'] } } });
    const f = fakes();
    const { code, err } = await runTick(f, { env: {} });
    expect(code).toBe(0);
    expect(err).toMatch(/not set: RESEND_API_KEY/);
  });

  it('passes the supervisor exit code on, after pushing', async () => {
    const f = fakes({ supervisor: 3 });
    expect((await runTick(f)).code).toBe(3);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
  });

  it('builds nothing when the pull fails, so it never works on a stale copy', async () => {
    const f = fakes({ pull: 'network down' });
    const { code, err } = await runTick(f);
    expect(code).toBe(1);
    expect(steps(f)).toEqual(['pull']);
    expect(err).toMatch(/network down/);
  });

  it('fails when the push fails, and says the state stays committed here', async () => {
    const f = fakes({ push: 'rejected' });
    const { code, err } = await runTick(f);
    expect(code).toBe(1);
    expect(err).toMatch(/rejected/);
  });

  it('refuses to run without the branch store', async () => {
    project({ config: { state: { store: 'files' } } });
    const f = fakes();
    const { code, err } = await runTick(f);
    expect(code).toBe(1);
    expect(f.order).toEqual([]);
    expect(err).toMatch(/state\.store/);
    expect(err).toMatch(/"branch"/);
  });

  it('asks for the given story first, then runs', async () => {
    const f = fakes({ onSupervisor: () => expect(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')).nextStory).toBe('S-1') });
    const { code } = await runTick(f, { story: 'S-1' });
    expect(code).toBe(0);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
  });

  it('refuses a story id that is not one', async () => {
    const f = fakes();
    const { code, err } = await runTick(f, { story: 'S 1; rm -rf' });
    expect(code).toBe(1);
    expect(f.order).not.toContain('supervisor');
    expect(err).toMatch(/S 1; rm -rf/);
  });

  describe('exits 0 at once, without the supervisor', () => {
    const idle = async (why) => {
      const f = fakes();
      const { code, out } = await runTick(f);
      expect(code).toBe(0);
      expect(steps(f)).toEqual(['pull', 'push']);
      expect(out).toMatch(why);
    };

    it('when nothing can be built', async () => {
      project({ stories: { 'S-1': STORY('S-1', 'done'), 'S-2': STORY('S-2', 'todo', ['S-3']), 'S-3': STORY('S-3', 'blocked') } });
      await idle(/Nothing to do: nothing can be built/);
    });

    it('when paused', async () => {
      write('control.json', { paused: true });
      await idle(/Nothing to do: paused/);
    });

    it('when Foreman paused itself and no resume came after', async () => {
      write('state.json', { autoPausedAt: '2026-10-18T09:00:00Z', autoPauseReason: 'Out of credit.' });
      write('control.json', { resumeAt: '2026-10-18T08:00:00Z' });
      await idle(/Nothing to do: paused.*Out of credit/);
    });

    it('when Foreman paused itself and its retry time is still ahead, or there is none', async () => {
      write('state.json', { autoPausedAt: '2026-10-18T09:00:00Z', autoPauseReason: 'Out of credit.', autoResumeAt: '2999-01-01T00:00:00Z' });
      await idle(/Nothing to do: paused.*Out of credit/);
    });

    it('when halted', async () => {
      write('HALT', 'the release of S-1 failed');
      await idle(/Nothing to do: halted/);
    });
  });

  it('runs the supervisor when a resume came after its own pause', async () => {
    write('state.json', { autoPausedAt: '2026-10-18T09:00:00Z' });
    write('control.json', { resumeAt: '2026-10-18T09:30:00Z' });
    const f = fakes();
    await runTick(f);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
  });

  it('runs the supervisor when Foreman paused itself for credit and its retry time has come, so it can probe', async () => {
    write('state.json', { autoPausedAt: '2026-10-18T09:00:00Z', autoPauseReason: 'Out of credit.', autoResumeAt: '2026-10-18T10:00:00Z' });
    const f = fakes();
    await runTick(f);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
  });

  it('still idles for the owner\'s own pause when the retry time has come', async () => {
    write('state.json', { autoPausedAt: '2026-10-18T09:00:00Z', autoPauseReason: 'Out of credit.', autoResumeAt: '2026-10-18T10:00:00Z' });
    write('control.json', { paused: true });
    const f = fakes();
    const { out } = await runTick(f);
    expect(steps(f)).toEqual(['pull', 'push']);
    expect(out).toMatch(/Nothing to do: paused with `foreman pause`/);
  });

  it('runs the supervisor when halted but the owner said it is fixed, so the fix is checked', async () => {
    write('HALT', 'x');
    write('control.json', { fixedAt: '2026-10-18T09:00:00Z' });
    const f = fakes();
    await runTick(f);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
  });

  it('runs the supervisor when a story is in progress, even with nothing new to build', async () => {
    project({ stories: { 'S-1': STORY('S-1', 'done') } });
    write('claims/S-9.json', { pid: 999999, slot: 'w1', story: 'S-9', by: 'factory' });
    const f = fakes();
    await runTick(f);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
  });

  it('leaves the decision to the supervisor for a story source it cannot read offline', async () => {
    project({ config: { stories: { adapter: 'jira', site: 'x.atlassian.net', jql: 'project = X' } }, stories: {} });
    const f = fakes();
    await runTick(f);
    expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
  });

  describe('the learning tick', () => {
    const order = (f) => f.order.filter((s) => ['pull', 'supervisor', 'learning', 'push'].includes(s));

    it('runs once after the supervisor and before the push, with the state sync off', async () => {
      const f = fakes({ learning: { status: 0, stdout: 'No new lessons.\n' } });
      const { code, out } = await runTick(f);
      expect(code).toBe(0);
      expect(order(f)).toEqual(['pull', 'supervisor', 'learning', 'push']);
      expect(f.seen.learningEnv.FOREMAN_STATE_SYNC).toBe('off');
      expect(out).toContain('No new lessons.');
    });

    it('does not run on an idle job', async () => {
      write('control.json', { paused: true });
      const f = fakes();
      await runTick(f);
      expect(f.order).not.toContain('learning');
    });

    it('does not run with learning.auto off', async () => {
      project({ config: { learning: { auto: false } } });
      const f = fakes();
      await runTick(f);
      expect(order(f)).toEqual(['pull', 'supervisor', 'push']);
    });

    it('warns when it fails and leaves the exit code alone', async () => {
      const f = fakes({ learning: { status: 1, stdout: '', stderr: 'boom\nthe learner broke\n' } });
      const { code, err } = await runTick(f);
      expect(code).toBe(0);
      expect(err).toContain('warning: learning tick failed: the learner broke');
      expect(order(f)).toEqual(['pull', 'supervisor', 'learning', 'push']);
    });
  });

  describe('foreman stop', () => {
    it('holds the scheduled jobs: with nothing in progress, it pauses and builds nothing', async () => {
      write('STOP', '2026-10-18T09:00:00Z\n');
      const f = fakes();
      const { code, out } = await runTick(f);
      expect(code).toBe(0);
      expect(steps(f)).toEqual(['pull', 'push']);
      expect(fs.existsSync(path.join(dir, 'STOP'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')).paused).toBe(true);
      expect(out).toMatch(/foreman resume/);
    });

    it('lets the supervisor finish a story in progress first, then pauses', async () => {
      write('STOP', 'x');
      write('claims/S-9.json', { pid: 999999, slot: 'w1', story: 'S-9', by: 'factory' });
      const f = fakes({ onSupervisor: () => expect(fs.existsSync(path.join(dir, 'STOP'))).toBe(true) });
      await runTick(f);
      expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8')).paused).toBe(true);
    });
  });
});

describe('idleReason', () => {
  it('is null when a story can be built', async () => {
    expect(await idleReason({ root, dir, config: config(), env: {}, now: NOW })).toBeNull();
  });

  it('is null when an owner command waits, even while paused, so the supervisor applies it', async () => {
    write('control.json', { paused: true, slots: { w1: { action: 'discard', at: '2026-10-18T09:00:00Z' } } });
    expect(await idleReason({ root, dir, config: config(), env: {}, now: NOW })).toBeNull();
  });

  it('counts a slot holding a committed story as in progress', async () => {
    project({ stories: { 'S-1': STORY('S-1', 'done') } });
    write('slots/w1.json', { state: 'held', heldStory: 'S-1' });
    expect(await idleReason({ root, dir, config: config(), env: {}, now: NOW })).toBeNull();
  });

  describe('an answer the supervisor applies', () => {
    const BLOCKED = '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: blocked\nblocked_by: Factory could not pass review; nothing was built\n---\n\nDo ACME-1.\n';
    const review = ({ answered = true, applied = false } = {}) => {
      const id = decisions.add(dir, { story: 'ACME-1', kind: 'decision', title: 'ACME-1 could not pass review', options: ['Retry with a note to the architect', "I'll take it", 'Drop'] }, NOW());
      if (answered) decisions.answer(dir, id, { option: 'Retry with a note to the architect', note: 'Use the cache' }, NOW());
      if (applied) decisions.applied(dir, id, NOW());
    };
    const reason = () => idleReason({ root, dir, config: config(), env: {}, now: NOW });
    beforeEach(() => project({ stories: { 'ACME-1': BLOCKED } }));

    it('is null when one is waiting, though nothing can be built yet', async () => {
      review();
      expect(await reason()).toBeNull();
    });

    it('still says nothing can be built when the item is unanswered or already applied', async () => {
      review({ answered: false });
      expect(await reason()).toMatch(/^nothing can be built/);
      review({ applied: true });
      expect(await reason()).toMatch(/^nothing can be built/);
    });

    it('still says paused while paused, since the supervisor applies nothing then', async () => {
      review();
      write('control.json', { paused: true });
      expect(await reason()).toMatch(/^paused/);
    });

    describe('an answered owner task about a story', () => {
      const IN_WORDS = BLOCKED.replace('Factory could not pass review; nothing was built', 'Owner decision needed: which store?');
      const ON_STORY = BLOCKED.replace('Factory could not pass review; nothing was built', 'ACME-2 must land first');
      const DONE = BLOCKED.replace('status: blocked', 'status: done');
      const ownerTask = () => {
        const id = decisions.add(dir, { story: 'ACME-1', kind: 'task', title: 'ACME-1: which store?', options: [] }, NOW());
        decisions.answer(dir, id, { option: null, note: '(A) the database' }, NOW());
      };

      it('is null when the story is blocked for a reason in words, so the supervisor puts it back', async () => {
        project({ stories: { 'ACME-1': IN_WORDS } });
        ownerTask();
        expect(await reason()).toBeNull();
      });

      it('still says nothing can be built when the story waits on another story, or is done', async () => {
        for (const text of [ON_STORY, DONE]) {
          project({ stories: { 'ACME-1': text, 'ACME-2': STORY('ACME-2', 'blocked') } });
          ownerTask();
          expect(await reason(), text).toMatch(/^nothing can be built/);
        }
      });
    });

    describe('with the artifacts console', () => {
      const ARTIFACTS = { adapter: 'artifacts', commandCenterUrl: 'https://claude.ai/public/artifacts/acme-cc', decisionsUrl: 'https://claude.ai/public/artifacts/acme-dec' };
      const pageItem = () => write('sync/decisions/items/d-1.json', { kind: 'decision', title: 'ACME-1 could not pass review', story: 'ACME-1', options: ['Retry with a note to the architect', "I'll take it", 'Drop'], createdAt: '2026-10-18T09:00:00Z' });
      const pageAnswer = (extra = {}) => write('sync/decisions/answers/d-1.json', { item: 'd-1', choice: 'Retry with a note to the architect', text: 'Use the cache', at: '2026-10-18T09:30:00Z', ...extra });
      beforeEach(() => project({ config: { console: ARTIFACTS }, stories: { 'ACME-1': BLOCKED } }));

      it("is null when the page copy holds an answered review", async () => {
        pageItem();
        pageAnswer();
        expect(await reason()).toBeNull();
      });

      it('still says nothing can be built when the copy holds no answer, or an applied one', async () => {
        pageItem();
        expect(await reason()).toMatch(/^nothing can be built/);
        pageAnswer({ applied: '2026-10-18T09:45:00Z' });
        expect(await reason()).toMatch(/^nothing can be built/);
      });

      it("does not count an answer in the files console's folder, since the config names the console", async () => {
        review();
        expect(await reason()).toMatch(/^nothing can be built/);
      });

      it('is null when the console cannot be opened, so the supervisor decides', async () => {
        project({ config: { console: { adapter: 'artifacts', commandCenterUrl: ARTIFACTS.commandCenterUrl } }, stories: { 'ACME-1': BLOCKED } });
        expect(await reason()).toBeNull();
      });

      it('runs the supervisor for an answered review, and idles without one', async () => {
        pageItem();
        pageAnswer();
        const f = fakes();
        await runTick(f);
        expect(steps(f)).toEqual(['pull', 'supervisor', 'push']);

        fs.rmSync(path.join(dir, 'sync/decisions/answers/d-1.json'));
        const idle = fakes();
        const { out } = await runTick(idle);
        expect(steps(idle)).toEqual(['pull', 'push']);
        expect(out).toContain('Nothing to do: nothing can be built');
      });
    });
  });

  it('is null when the stories cannot be read, so the supervisor decides', async () => {
    fs.writeFileSync(path.join(root, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'P' }, state: { store: 'branch' }, stories: { adapter: 'markdown', dir: 'missing' } }));
    expect(await idleReason({ root, dir, config: config(), env: {}, now: NOW })).toBeNull();
  });
});
