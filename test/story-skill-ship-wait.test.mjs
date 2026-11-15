// The story skill runs `foreman ship` in the foreground with a Bash timeout long enough for a
// Gearset release's waits, and asks the owner (Waiting on you) when the release was stopped from
// outside or Gearset posted no status. The rare paths sit in ship-stopped.md and ship-ci.md.

import { describe, expect, it } from 'vitest';
import { SHIP_TIMEOUT_MS } from '../plugin/lib/engine/session.mjs';
import { skillFile } from './story-skill.mjs';

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

// A section of a markdown text: from its heading to the next heading of the same level.
function section(text, heading) {
  const start = text.indexOf(heading);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the story skill and a long release wait', () => {
  it('SKILL.md runs ship in the foreground with the supervisor-given timeout, never in the background', () => {
    const release = collapse(section(skillFile(), '## 5. Release'));
    expect(release).toContain(String(SHIP_TIMEOUT_MS));
    expect(release).toContain('foreground');
    expect(release).toContain('never in the background');
    expect(release).toContain('Bash `timeout`');
  });

  describe('ship-stopped.md', () => {
    const text = skillFile('ship-stopped.md');
    const at = text.indexOf('- **1, with `stage` `interrupted`**');
    const bullet = collapse(text.slice(at, text.indexOf('\n- **', at + 5)));

    it('has the interrupted bullet before the plain exit 1 bullet', () => {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(text.indexOf('\n- **1** —'));
    });

    it('runs ship once more when nothing went live, and otherwise asks on Waiting on you', () => {
      expect(bullet).toContain('lockReleased');
      expect(bullet).toContain('foreman ship --story <ID>');
      expect(bullet).toContain('foreground');
      expect(bullet).toContain('foreman story block <ID>');
      expect(bullet).toContain('foreman decide add --story <ID> --kind task');
      expect(bullet).toContain("--body '<the ship JSON line>'");
      expect(bullet).toContain("'\\''");
      expect(bullet).toContain('`failed`');
      expect(bullet).toContain('--cause environment');
    });

    it('keeps the wording the mergeable-recheck tests match', () => {
      expect(text).toContain('\n- **1** —');
      expect(text).toMatch(/at `mergeable-recheck` a second time/);
    });
  });

  describe('ship-ci.md', () => {
    const text = skillFile('ship-ci.md');
    const at = text.indexOf('`noStatus: true`');
    const bullet = collapse(text.slice(at, text.indexOf('\n  - ', at + 5)));

    it('has a noStatus bullet under exit 2, before the CI-never-started and inherited bullets', () => {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(text.indexOf('CI **never started**'));
      expect(at).toBeLessThan(text.indexOf('`inherited: true`'));
    });

    it('sends nothing to the builder and asks on Waiting on you', () => {
      expect(bullet).toContain('send nothing to the builder');
      expect(bullet).toContain('foreman story block <ID>');
      expect(bullet).toContain('foreman decide add --story <ID> --kind task');
      expect(bullet).toContain("'\\''");
      expect(bullet).toContain('`blocked`');
      expect(bullet).not.toContain('fix round');
    });
  });
});
