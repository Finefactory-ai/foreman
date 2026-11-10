// `foreman cloud tick` end to end, the jobs that stop instead of waiting when no slot can take a
// story: a parked slot, and a paused run with an owner command waiting to be applied. The fixture
// is cloud-tick-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { calls, foremanIn, repos, tick, withCloudTickRepos } from './cloud-tick-fixture.mjs';

withCloudTickRepos();

describe('foreman cloud tick, end to end', () => {
  it('stops instead of waiting when no slot can take a story', () => {
    const laptop = repos.clone('laptop');
    expect(foremanIn(laptop, 'slot', 'w1', 'park').status).toBe(0);
    const r = tick();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Nothing can start now: no slot is free');
    expect(calls()).not.toMatch(/^claude /m);
  }, 120_000);

  it('a paused run with an owner command waiting applies it, then stops instead of waiting', () => {
    const laptop = repos.clone('laptop');
    for (const args of [['pause'], ['slot', 'w1', 'park']]) expect(foremanIn(laptop, ...args).status).toBe(0);
    const r = tick();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Building one story.');
    expect(r.stdout).toContain('Nothing can start now: paused.');
    expect(calls()).not.toMatch(/^claude /m);
    expect(JSON.parse(repos.remoteFile('slots/w1.json')).state).toBe('parked');
  }, 120_000);
});
