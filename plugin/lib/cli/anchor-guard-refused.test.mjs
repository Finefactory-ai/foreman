// Inside a Foreman run (FOREMAN_RUN=1), each command that writes a project's config, local
// settings, keys or owner controls refuses when its target is the project the run builds, from
// the slot worktree and from the anchor, and changes nothing there. The fixture is
// test/anchor-guard-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { anchor, refusal, run, slot, snapshot, SWITCH, withAnchorRepos } from '../../../test/anchor-guard-fixture.mjs';

withAnchorRepos();

describe('guarded commands in a story session', () => {
  const REFUSED = [
    [['settings', 'set', 'workers', '1'], 'foreman settings set'],
    [['settings', 'reset', 'workers'], 'foreman settings reset'],
    [['settings', 'set', 'workers', '1', '--team'], 'foreman settings set'],
    [['features', 'on', SWITCH], 'foreman features on'],
    [['features', 'off', SWITCH], 'foreman features off'],
    [['init', 'write', '--force'], 'foreman init write'],
    [['traits', 'add', 'all', 'Acme rule'], 'foreman traits add'],
    [['learning', 'undo', 'L-1'], 'foreman learning undo'],
    [['learning', 'keep', 'L-1'], 'foreman learning keep'],
    [['learn', 'reopen', 'D-1'], 'foreman learn reopen'],
    [['decide', 'answer', 'D-1', 'yes'], 'foreman decide answer'],
    [['run', '--dry-run'], 'foreman run'],
    [['pause'], 'foreman pause'],
    [['resume'], 'foreman resume'],
    [['stop'], 'foreman stop'],
    [['stop', '--now'], 'foreman stop'],
    [['fixed'], 'foreman fixed'],
    [['workers', '1'], 'foreman workers'],
    [['slot', 'w1', 'park'], 'foreman slot'],
    [['handback', 'S-1'], 'foreman handback'],
    [['next', 'S-1'], 'foreman next'],
    [['sf', 'deletes', 'allow', 'S-1'], 'foreman sf deletes'],
  ];
  describe.each([['the slot worktree', () => slot], ['the anchor', () => anchor]])('from %s', (_, where) => {
    it.each(REFUSED)('refuses %j against the anchor', async (argv, what) => {
      const before = snapshot();
      const r = await run(argv, { cwd: where() });
      expect(r.err).toBe(refusal(what, anchor));
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(snapshot()).toEqual(before);
    });
  });
});
