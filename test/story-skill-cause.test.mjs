// The story skill tells a session when to end a story as failed with `--cause environment`, so
// the run counts it as the environment, not a story that did not ship. Only the rare files say
// so; SKILL.md stays under its size cap.

import { describe, expect, it } from 'vitest';
import { skillFile } from './story-skill.mjs';

describe('the story skill and --cause', () => {
  it('ship-ci.md names it for CI that never started, did not finish or could not be read', () => {
    const text = skillFile('ship-ci.md');
    expect(text).toContain('`--cause environment`');
    expect(text).toMatch(/never started, did not finish, or its checks\s+could not be read, pass `--cause environment`/);
  });
  it('ship-stopped.md names it for a second mergeable-recheck', () => {
    const text = skillFile('ship-stopped.md');
    expect(text).toMatch(/at `mergeable-recheck` a second time[^]*`--cause environment` to `foreman story end`/);
  });
  it('ship-conflict.md names it for a conflict that could not be settled', () => {
    const text = skillFile('ship-conflict.md');
    expect(text).toContain('`--cause environment`');
    expect(text).toMatch(/exit 6 came\s+back after the last round/);
  });
  it('failed.md names it with the load-failure rule, and says a stage rejection passes none', () => {
    const text = skillFile('failed.md');
    expect(text).toContain('--cause environment');
    expect(text).toContain('could not be loaded');
    expect(text).toContain('git diff --name-only <remote>/<base>...HEAD');
    expect(text).toMatch(/stage\s+rejected the story after every round[\s\S]*pass nothing\s+\(or `--cause story`\)/);
  });
  it('SKILL.md does not mention it', () => expect(skillFile('SKILL.md')).not.toContain('--cause'));
});
