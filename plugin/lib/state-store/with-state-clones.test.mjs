// foreman commands on the branch state store across two clones of one project: what one clone
// writes, the other reads. The rest of withState is in with-state.test.mjs; the helpers both use
// are in test/with-state-fixture.mjs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, makeRepos, sh } from '../../../test/state-repos.mjs';
import { io, recording } from '../../../test/with-state-fixture.mjs';
import { main } from '../cli/main.mjs';

// git and child-process heavy: give each test and hook room on a busy machine.
const SLOW_MS = 30_000;
vi.setConfig({ testTimeout: SLOW_MS, hookTimeout: SLOW_MS });

describe('foreman commands on the branch store, two clones', () => {
  let repos;
  let a;
  let b;
  beforeEach(() => {
    repos = makeRepos();
    a = repos.clone('a');
    b = repos.clone('b');
  });
  afterEach(() => repos.cleanup());

  const run = async (root, argv, log) => {
    const { out, stdout, stderr } = io();
    const code = await main(argv, { cwd: root, env: { FOREMAN_PROJECT_DIR: root }, now: () => new Date('2026-10-18T09:00:00Z'), stdout, stderr, sh: log ? recording(log) : sh, sleep: async () => {} });
    return { code, ...out };
  };

  it('an answer given in one clone shows as answered in the other', async () => {
    const add = await run(a, ['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'Which table?', '--option', 'Reuse', '--option', 'New']);
    expect(add.code).toBe(0);
    const id = add.stdout.trim();
    const before = await run(b, ['decide', 'list']);
    expect(before.stdout).toMatch(new RegExp(`${id} .*\\[waiting\\]`));
    const answer = await run(b, ['decide', 'answer', id, 'Reuse']);
    expect(answer.code).toBe(0);
    const list = await run(a, ['decide', 'list']);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(new RegExp(`${id} .*\\[answered: Reuse\\]`));
  });

  it('decide answer pulls, writes, then pushes', async () => {
    const id = (await run(a, ['decide', 'add', '--story', 'S-1', '--kind', 'decision', '--title', 'T', '--option', 'Yes', '--option', 'No'])).stdout.trim();
    await run(b, ['decide', 'list']);
    const file = join(b, '.foreman', 'decisions', `${id}.json`);
    const answered = () => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).answer !== null;
    const log = [];
    const watch = (cmd, args, opts) => {
      if (args.includes('fetch')) log.push(`fetch:${answered()}`);
      if (args.includes('push')) log.push(`push:${answered()}`);
      return sh(cmd, args, opts);
    };
    const { stdout, stderr } = io();
    const code = await main(['decide', 'answer', id, 'Yes'], { cwd: b, env: { FOREMAN_PROJECT_DIR: b }, stdout, stderr, sh: watch, sleep: async () => {} });
    expect(code).toBe(0);
    expect(log[0]).toBe('fetch:false');
    expect(log.at(-1)).toBe('push:true');
    expect(JSON.parse(repos.remoteFile(`decisions/${id}.json`)).answer).toMatchObject({ option: 'Yes' });
  });

  it('pause in one clone is seen by status in the other', async () => {
    expect((await run(a, ['pause'])).code).toBe(0);
    const status = await run(b, ['status']);
    expect(status.stdout).toMatch(/paused/);
  });

  it('a local setting set in one clone reaches the other; a team setting does not touch the branch', async () => {
    expect((await run(a, ['settings', 'set', 'features.followUps', 'false'])).code).toBe(0);
    expect(JSON.parse(repos.remoteFile('settings.json'))).toEqual({ 'features.followUps': false });
    await run(b, ['status']);
    expect(JSON.parse(readFileSync(join(b, '.foreman', 'settings.json'), 'utf8'))).toEqual({ 'features.followUps': false });
    const head = sh('git', ['rev-parse', 'foreman-state'], { cwd: repos.remote }).stdout;
    const log = [];
    expect((await run(a, ['settings', 'set', 'features.learnTraits', 'false', '--team'], log)).code).toBe(0);
    expect(log).toEqual([]);
    expect(sh('git', ['rev-parse', 'foreman-state'], { cwd: repos.remote }).stdout).toBe(head);
  });
});
