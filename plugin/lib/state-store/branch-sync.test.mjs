// syncState on the branch state store, pulls and pushes between two clones: what each brings in
// or sends out, and two clones writing at once. The fixture is test/state-branch-fixture.mjs.

import { describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { git, writeFile } from '../../../test/state-repos.mjs';
import { a, b, D1, D2, decision, pull, push, readDecision, repos, withClones } from '../../../test/state-branch-fixture.mjs';

// git and child-process heavy: give each test and hook room on a busy machine.
const SLOW_MS = 30_000;
vi.setConfig({ testTimeout: SLOW_MS, hookTimeout: SLOW_MS });

describe('syncState', () => {
  withClones();

  it('a pull brings a decision made on the other clone in', async () => {
    await pull(a);
    await pull(b);
    decision(a, D1, { option: 'Yes' });
    await push(a);
    expect(existsSync(join(b, '.foreman', 'decisions', `${D1}.json`))).toBe(false);
    await pull(b);
    expect(readDecision(b, D1).answer).toEqual({ option: 'Yes' });
  });

  it('a push sends local changes out, with the message given, and deletions too', async () => {
    await pull(a);
    decision(a, D1);
    const r = await push(a, 'decide answer');
    expect(r.pushed).toBe(true);
    expect(repos.remoteFiles()).toContain(`decisions/${D1}.json`);
    expect(git(repos.remote, 'log', '-1', '--format=%s', 'foreman-state')).toBe('decide answer');
    rmSync(join(a, '.foreman', 'decisions', `${D1}.json`));
    await push(a, 'drop it');
    expect(repos.remoteFiles()).not.toContain(`decisions/${D1}.json`);
  });

  it('a push with nothing changed sends nothing', async () => {
    await pull(a);
    const before = git(repos.remote, 'rev-parse', 'foreman-state');
    const r = await push(a);
    expect(r.pushed).toBe(false);
    expect(git(repos.remote, 'rev-parse', 'foreman-state')).toBe(before);
  });

  it('two clones answering different decisions at once both land, through the retry', async () => {
    await pull(a);
    await pull(b);
    decision(a, D1, { option: 'Yes' });
    decision(b, D2, { option: 'No' });
    const sleeps = [];
    const ra = await push(a);
    const rb = await push(b, 'b change', { sleep: async (ms) => sleeps.push(ms) });
    expect(ra.attempts).toBe(1);
    expect(rb.attempts).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(repos.remoteFiles()).toEqual(expect.arrayContaining([`decisions/${D1}.json`, `decisions/${D2}.json`]));
    await pull(a);
    expect(readDecision(a, D2).answer).toEqual({ option: 'No' });
  });

  it('when both change the same file, the later push re-applies its own write over the remote', async () => {
    await pull(a);
    await pull(b);
    writeFile(join(a, '.foreman', 'control.json'), '{"paused":true}\n');
    writeFile(join(b, '.foreman', 'control.json'), '{"workers":2}\n');
    decision(a, D1);
    await push(a);
    const rb = await push(b);
    expect(rb.attempts).toBe(2);
    expect(repos.remoteFile('control.json')).toBe('{"workers":2}');
    // A's other change is kept.
    expect(repos.remoteFiles()).toContain(`decisions/${D1}.json`);
    expect(git(join(b, '.foreman'), 'status', '--porcelain')).toBe('');
  });

  it('appends to a .jsonl file from both clones keep both lines', async () => {
    await pull(a);
    await pull(b);
    writeFile(join(a, '.foreman', 'events.jsonl'), '{"text":"from a"}\n');
    await push(a);
    await pull(b);
    writeFile(join(a, '.foreman', 'events.jsonl'), '{"text":"from a"}\n{"text":"a again"}\n');
    writeFile(join(b, '.foreman', 'events.jsonl'), '{"text":"from a"}\n{"text":"b too"}\n');
    await push(a);
    await push(b);
    const lines = repos.remoteFile('events.jsonl').split('\n');
    expect(lines).toEqual(expect.arrayContaining(['{"text":"a again"}', '{"text":"b too"}']));
  });
});
