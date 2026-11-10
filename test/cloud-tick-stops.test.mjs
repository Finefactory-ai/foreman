// `foreman cloud tick` end to end, the jobs that build nothing: once the backlog is done, and a
// paused run. The jobs that stop instead of waiting for a slot are in cloud-tick-no-slot.test.mjs,
// the jobs that build in cloud-tick.test.mjs; the fixture they share is cloud-tick-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { calls, foremanIn, repos, rmRunner, tick, withCloudTickRepos } from './cloud-tick-fixture.mjs';

withCloudTickRepos();

describe('foreman cloud tick, end to end', () => {
  it('builds nothing and starts no session once the backlog is done', () => {
    expect(tick().status).toBe(0);
    rmRunner();
    expect(tick().status).toBe(0);
    rmRunner();
    const r = tick();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Nothing to do: nothing can be built/);
    expect(calls().split('\n').filter((l) => l.startsWith('claude '))).toHaveLength(2);
  }, 240_000);

  it('a paused run starts no session and exits at once', () => {
    const laptop = repos.clone('laptop');
    const pause = foremanIn(laptop, 'pause');
    expect(pause.status).toBe(0);
    const r = tick();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Nothing to do: paused/);
    expect(calls()).not.toMatch(/^claude /m);
  }, 120_000);
});
