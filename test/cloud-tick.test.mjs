// `foreman cloud tick` end to end, the jobs that build: one story per job, and the next job the
// next story. The jobs that build nothing, once the backlog is done or when they stop at once,
// are in cloud-tick-stops.test.mjs and cloud-tick-no-slot.test.mjs; the fixture they share is
// cloud-tick-fixture.mjs.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { calls, overlay, repos, rmRunner, runner, stateLog, tick, withCloudTickRepos } from './cloud-tick-fixture.mjs';

withCloudTickRepos();

describe('foreman cloud tick, end to end', () => {
  it('builds exactly one story through the supervisor and pushes the state once, at the end', () => {
    const r = tick([], { RESEND_API_KEY: 're_end_to_end' });
    expect(r.stderr).not.toMatch(/foreman: /);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Building one story.');
    expect(r.stdout).toContain('Reached the 1 story asked for.');
    expect(r.stdout).not.toContain('re_end_to_end');

    // One session, for the first story, with the per-command sync off and no project key.
    const sessions = calls().split('\n').filter((l) => l.startsWith('claude '));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatch(/^claude -p \/foreman:story S-1 .* sync=off resend=unset$/);

    // The state branch has the story done and the run recorded, in one commit after its start.
    expect(overlay('S-1').status).toBe('done');
    expect(repos.remoteFiles().some((f) => f.startsWith('runs/'))).toBe(true);
    expect(stateLog()).toEqual(['foreman cloud tick', 'Start Foreman state']);

    // Git was signed in through gh and given the token account's identity.
    expect(calls()).toContain('gh auth setup-git');
    const email = spawnSync('git', ['config', '--local', 'user.email'], { cwd: runner, encoding: 'utf8' }).stdout.trim();
    expect(email).toBe('42+octo@users.noreply.github.com');
  }, 120_000);

  it('picks up where the last job left off: the next job builds the next story', () => {
    expect(tick().status).toBe(0);
    rmRunner();
    expect(tick().status).toBe(0);
    const sessions = calls().split('\n').filter((l) => l.startsWith('claude '));
    expect(sessions.map((l) => l.split(' ')[2])).toEqual(['/foreman:story', '/foreman:story']);
    expect(sessions[1]).toContain('S-2');
    expect(overlay('S-2').status).toBe('done');
  }, 180_000);

});
