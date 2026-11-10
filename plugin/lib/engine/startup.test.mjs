import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closableIds, closableMergedIds, keepAwake, keepAwakeCommand, mergedStoryIds, mustFinishFor, remoteHasBranch } from './startup.mjs';
import { withDefaults } from '../config/defaults.mjs';
import { configWithLocal, effective } from '../settings/resolve.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

describe('keepAwakeCommand', () => {
  it('keeps a Mac awake while the supervisor lives', () => {
    expect(keepAwakeCommand({ features: { keepAwake: true } }, 'darwin', 77)).toEqual({ cmd: 'caffeinate', args: ['-i', '-s', '-w', '77'] });
  });
  it('does nothing on Linux', () => {
    expect(keepAwakeCommand({ features: { keepAwake: true } }, 'linux', 77)).toBeNull();
  });
  it('does nothing when keepAwake is off', () => {
    expect(keepAwakeCommand({ features: { keepAwake: false } }, 'darwin', 77)).toBeNull();
  });
  it('is on by default', () => {
    expect(keepAwakeCommand(withDefaults({ version: 1, project: { name: 'x' } }), 'darwin', 77)).not.toBeNull();
  });
  it('reads a config that still has the old top-level keepAwake as the team value of features.keepAwake', () => {
    const team = withDefaults({ version: 1, project: { name: 'x' }, keepAwake: false });
    expect(keepAwakeCommand(team, 'darwin', 77)).toBeNull();
    expect(effective(team, {})['features.keepAwake']).toEqual({ value: false, source: 'team' });
  });
  it('lets the local layer win over the old key', () => {
    const team = withDefaults({ version: 1, project: { name: 'x' }, keepAwake: false });
    expect(keepAwakeCommand(configWithLocal(team, { 'features.keepAwake': true }), 'darwin', 77)).not.toBeNull();
  });
});

describe('keepAwake', () => {
  const COMMAND = { cmd: 'caffeinate', args: ['-i', '-s', '-w', '77'] };
  // A spawn that records its calls and hands back children with kill and unref spies.
  const fakeSpawn = () => {
    const children = [];
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      child.kill = vi.fn();
      child.unref = vi.fn();
      children.push(child);
      return child;
    });
    return { spawn, children };
  };

  it('take() starts caffeinate once, detached and unref-ed', () => {
    const { spawn, children } = fakeSpawn();
    const awake = keepAwake(COMMAND, { spawn });
    awake.take();
    expect(spawn).toHaveBeenCalledWith('caffeinate', ['-i', '-s', '-w', '77'], { detached: true, stdio: 'ignore' });
    expect(children[0].unref).toHaveBeenCalled();
    expect(awake.held()).toBe(true);
    awake.take();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('release() stops it with SIGTERM, and the next take() starts a fresh one', () => {
    const { spawn, children } = fakeSpawn();
    const awake = keepAwake(COMMAND, { spawn });
    awake.take();
    awake.release();
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(awake.held()).toBe(false);
    awake.take();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(awake.held()).toBe(true);
  });

  it('release() with nothing held does nothing', () => {
    const { spawn } = fakeSpawn();
    const awake = keepAwake(COMMAND, { spawn });
    expect(() => awake.release()).not.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    expect(awake.held()).toBe(false);
  });

  it('with no command, take, release and held do nothing', () => {
    const { spawn } = fakeSpawn();
    const awake = keepAwake(null, { spawn });
    awake.take();
    awake.release();
    expect(spawn).not.toHaveBeenCalled();
    expect(awake.held()).toBe(false);
  });

  it('a child that fails to start is reported and dropped; one that exits on its own is dropped too', () => {
    const { spawn, children } = fakeSpawn();
    const onError = vi.fn();
    const awake = keepAwake(COMMAND, { spawn, onError });
    awake.take();
    const err = new Error('ENOENT');
    children[0].emit('error', err);
    expect(onError).toHaveBeenCalledWith(err);
    expect(awake.held()).toBe(false);
    awake.take();
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].emit('exit', 0, null);
    expect(awake.held()).toBe(false);
    awake.take();
    expect(spawn).toHaveBeenCalledTimes(3);
    // An old child exiting late does not drop the one held now.
    children[0].emit('exit', 1, null);
    expect(awake.held()).toBe(true);
  });
});

describe('mergedStoryIds', () => {
  const stories = [{ id: 'S-1' }, { id: 'S-2' }, { id: 'P5-04' }];

  it('maps merged branches to story ids through the story list', () => {
    expect(mergedStoryIds(['story/s-2', 'story/p5-04'], stories, 'story/')).toEqual(['S-2', 'P5-04']);
  });
  it('ignores branches that name no story or have another prefix', () => {
    expect(mergedStoryIds(['story/s-9', 'feature/s-1', 'main', 'story/'], stories, 'story/')).toEqual([]);
  });
  it('uses the configured prefix', () => {
    expect(mergedStoryIds(['fm/s-1', 'story/s-2'], stories, 'fm/')).toEqual(['S-1']);
  });
  it('lists each story once', () => {
    expect(mergedStoryIds(['story/s-1', 'story/s-1'], stories, 'story/')).toEqual(['S-1']);
  });
});

describe('mustFinishFor', () => {
  it('names the configured steps past the point of no return, plus the legacy stage', () => {
    expect(mustFinishFor({ ship: { steps: ['merge-main', 'push', 'pr', 'ci', 'merge'] } })).toEqual(['merge', 'hosted-db']);
  });
  it('names a step that may pass the point of no return at run time', () => {
    expect(mustFinishFor({ ship: { steps: ['prepare-migrations', 'push', 'migrate-supabase', 'merge'] } })).toEqual(['migrate-supabase', 'merge', 'hosted-db']);
  });
  it('has only the legacy stage when no step is a point of no return', () => {
    expect(mustFinishFor({ ship: { steps: ['push', 'pr'] } })).toEqual(['hosted-db']);
  });
});

describe('mustFinishFor with step flags', () => {
  const step = { name: 'acme-deploy', pointOfNoReturn: true, mustFinish: ['acme-legacy'], async run() { return { ok: true }; } };
  const packs = { acme: fakePack({ steps: { 'acme-deploy': step } }) };
  it('treats a configured pack step past the point of no return like merge, with its own legacy stages', () => {
    expect(mustFinishFor({ pack: 'acme', ship: { steps: ['push', 'acme-deploy'] } }, { packs })).toEqual(['acme-deploy', 'hosted-db', 'acme-legacy']);
  });
  it("counts a pack step's legacy stages even when that step is not configured", () => {
    expect(mustFinishFor({ pack: 'acme', ship: { steps: ['push', 'pr'] } }, { packs })).toEqual(['hosted-db', 'acme-legacy']);
  });
  it('has no pack stages when the config names no pack', () => {
    expect(mustFinishFor({ ship: { steps: ['push'] } }, { packs })).toEqual(['hosted-db']);
  });
  it('names each stage once', () => {
    const twice = { acme: fakePack({ steps: { 'acme-deploy': { ...step, mustFinish: ['hosted-db', 'acme-deploy'] } } }) };
    expect(mustFinishFor({ pack: 'acme', ship: { steps: ['push', 'acme-deploy'] } }, { packs: twice })).toEqual(['acme-deploy', 'hosted-db']);
  });
});

describe('remoteHasBranch', () => {
  const out = 'abc123\trefs/heads/story/s-10\ndef456\trefs/heads/story/s-2\n';
  it('finds a branch by its whole ref', () => {
    expect(remoteHasBranch(out, 'story/s-2')).toBe(true);
    expect(remoteHasBranch(out, 'story/s-10')).toBe(true);
  });
  it('does not match a branch that only starts the same', () => {
    expect(remoteHasBranch(out, 'story/s-1')).toBe(false);
    expect(remoteHasBranch('', 'story/s-1')).toBe(false);
  });
});

describe('closableIds', () => {
  it('keeps open stories and drops done, retired and ready-to-promote ones', () => {
    const status = { 'S-1': 'todo', 'S-2': 'in-progress', 'S-3': 'done', 'S-4': 'retired', 'S-5': 'ready-to-promote' };
    expect(closableIds(['S-1', 'S-2', 'S-3', 'S-4', 'S-5'], (id) => status[id])).toEqual(['S-1', 'S-2']);
  });
});

describe('closableMergedIds', () => {
  const stories = [
    { id: 'S-1', status: 'todo' },
    { id: 'S-2', status: 'in-progress' },
    { id: 'S-3', status: 'done' },
    { id: 'S-4', status: 'retired' },
    { id: 'S-5', status: 'ready-to-promote' },
  ];
  it('keeps merged open stories and drops done, retired and ready-to-promote ones', () => {
    const branches = ['story/s-1', 'story/s-2', 'story/s-3', 'story/s-4', 'story/s-5', 'other/x'];
    expect(closableMergedIds(branches, stories, 'story/')).toEqual(['S-1', 'S-2']);
  });
  it('does not close a ready-to-promote story whose pull request merged', () => {
    expect(closableMergedIds(['story/s-5'], stories, 'story/')).toEqual([]);
  });
  it('ignores a branch that names no story', () => {
    expect(closableMergedIds(['story/s-9', 'other/x', 'story/s-1'], stories, 'story/')).toEqual(['S-1']);
  });
});
