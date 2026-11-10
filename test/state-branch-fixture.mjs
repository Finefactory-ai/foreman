// The fixture for the branch state store's git tests (branch.test.mjs, branch-sync.test.mjs,
// branch-sync-recovery.test.mjs): a bare remote and two clones of it, a and b, made fresh for
// each test, and the sync helpers they share.

import { afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepos, sh, writeFile } from './state-repos.mjs';
import { syncState } from '../plugin/lib/state-store/branch.mjs';

export let repos;
export let a;
export let b;

// Registers the hooks that give each test in the calling describe fresh repos and clones.
export function withClones() {
  beforeEach(() => {
    repos = makeRepos();
    a = repos.clone('a');
    b = repos.clone('b');
  });
  afterEach(() => repos.cleanup());
}

export const opts = (root, extra = {}) => ({ root, stateDir: join(root, '.foreman'), branch: 'foreman-state', remote: 'origin', sh, sleep: async () => {}, ...extra });
export const pull = (root, extra) => syncState({ ...opts(root, extra), direction: 'pull' });
export const push = (root, message = 'test change', extra) => syncState({ ...opts(root, extra), direction: 'push', message });
export const decision = (root, id, answer = null) => writeFile(join(root, '.foreman', 'decisions', `${id}.json`), `${JSON.stringify({ id, title: id, options: ['Yes', 'No'], answer }, null, 2)}\n`);
export const readDecision = (root, id) => JSON.parse(readFileSync(join(root, '.foreman', 'decisions', `${id}.json`), 'utf8'));
export const LEARNING = ['learning.jsonl', 'learned/traits/developer.md', 'learned/skills/foreman-learned-acme-routes/SKILL.md', 'learned/.history/L-1/v1.md'];
export const D1 = 'd-20261018090000-aaaa';
export const D2 = 'd-20261018090000-bbbb';
