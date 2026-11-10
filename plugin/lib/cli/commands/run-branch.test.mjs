// `foreman run` with the branch state store, between two clones of one project: a STOP from the
// other machine, a state branch that cannot be fetched, and what reaches the supervisor, which a
// fake launcher stands in for. The rest of `foreman run` is in run.test.mjs and run-real.test.mjs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { makeRunCommand } from './run.mjs';
import { makeRepos, sh as repoSh } from '../../../../test/state-repos.mjs';

describe('foreman run with the branch store', { timeout: 30_000 }, () => {
  let repos;
  let a;
  let b;
  beforeEach(() => {
    repos = makeRepos({ version: 1, project: { name: 'T' }, state: { store: 'branch' }, install: null });
    a = repos.clone('a');
    b = repos.clone('b');
  });
  afterEach(() => repos.cleanup());

  const io = () => {
    const out = { stdout: '', stderr: '' };
    return { out, stdout: { write: (t) => { out.stdout += t; } }, stderr: { write: (t) => { out.stderr += t; } } };
  };
  const inClone = async (root, argv, extra = {}) => {
    const { out, stdout, stderr } = io();
    const code = await main(argv, { cwd: root, env: { FOREMAN_PROJECT_DIR: root }, now: () => new Date('2026-10-18T09:00:00Z'), stdout, stderr, sh: repoSh, sleep: async () => {}, ...extra });
    return { code, ...out };
  };
  // `foreman run` in clone a, with a launcher that records what it saw instead of starting
  // the supervisor.
  const runIn = async (root, args, shell = repoSh) => {
    const seen = { started: false };
    const record = async ({ args: argv }) => {
      seen.started = true;
      seen.argv = argv;
      seen.stopHere = existsSync(join(root, '.foreman', 'STOP'));
      seen.stopOnRemote = repos.remoteFiles().includes('STOP');
      return 0;
    };
    const command = makeRunCommand({ startSupervisor: record, startDetached: record, openService: () => null, alive: () => false });
    const { out, stdout, stderr } = io();
    const code = await command.run(args, { cwd: root, root, env: { FOREMAN_PROJECT_DIR: root }, stdout, stderr, sh: shell, sleep: async () => {} });
    return { code, seen, ...out };
  };

  it('clears a STOP from another machine on the state branch too, before the supervisor starts', async () => {
    expect((await inClone(b, ['stop'])).code).toBe(0);
    expect(repos.remoteFiles()).toContain('STOP');
    const r = await runIn(a, []);
    expect(r.code).toBe(0);
    expect(r.seen).toMatchObject({ started: true, stopHere: false, stopOnRemote: false });
    expect(repos.remoteFiles()).not.toContain('STOP');
    // The other machine sees the run is no longer stopped.
    await inClone(b, ['status']);
    expect(existsSync(join(b, '.foreman', 'STOP'))).toBe(false);
  });

  it('does not start when the state branch cannot be fetched', async () => {
    await inClone(b, ['stop']);
    const offline = (cmd, args, opts) => (args.includes('fetch') || args.includes('ls-remote') ? { status: 128, stdout: '', stderr: 'could not read from remote' } : repoSh(cmd, args, opts));
    const r = await runIn(a, [], offline);
    expect(r.code).toBe(1);
    expect(r.seen.started).toBe(false);
    expect(r.stderr).toMatch(/could not read from remote/);
  });

  it('passes --exit-when-idle on, after the story count and the workers', async () => {
    let r = await runIn(a, ['--exit-when-idle']);
    expect(r.seen.argv).toEqual(['--max', '0', '--exit-when-idle']);
    r = await runIn(a, ['2', '--exit-when-idle', '--workers', '1']);
    expect(r.seen.argv).toEqual(['--max', '2', '--workers', '1', '--exit-when-idle']);
    r = await runIn(a, ['--exit-when-idle', '--soon']);
    expect(r.code).toBe(64);
    expect(r.seen.started).toBe(false);
  });

  it('leaves the state alone on a dry run', async () => {
    await inClone(b, ['stop']);
    const r = await runIn(a, ['--dry-run']);
    expect(r.seen).toMatchObject({ started: true, stopOnRemote: true });
    expect(r.seen.argv).toContain('--dry-run');
  });
});
