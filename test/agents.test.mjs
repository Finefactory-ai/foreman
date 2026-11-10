import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The template agents the plugin ships. They hold general practice only: every project
// rule comes from the target project's CLAUDE.md, its checks and its traits.
const DIR = fileURLToPath(new URL('../plugin/agents/', import.meta.url));
const NAMES = ['architect', 'builder', 'tester', 'compliance-reviewer', 'security-reviewer'];
const READ_ONLY = ['architect', 'tester', 'compliance-reviewer', 'security-reviewer'];

const read = (name) => readFileSync(`${DIR}${name}.md`, 'utf8');

const frontmatter = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  return Object.fromEntries(
    match[1]
      .split('\n')
      .map((line) => line.match(/^([a-z]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.trim()]),
  );
};

const tools = (name) => frontmatter(read(name)).tools.split(',').map((t) => t.trim());

describe('template agents', () => {
  for (const name of NAMES) {
    describe(name, () => {
      it('exists with name, description and tools, and its name matches the file', () => {
        expect(existsSync(`${DIR}${name}.md`)).toBe(true);
        const meta = frontmatter(read(name));
        expect(meta).not.toBeNull();
        expect(meta.name).toBe(name);
        expect(meta.description).toBeTruthy();
        expect(meta.tools).toBeTruthy();
      });

      it("points at the project's CLAUDE.md, the Checks section and the Project traits", () => {
        const text = read(name);
        expect(text).toContain('CLAUDE.md');
        expect(text.includes('## Checks') || text.includes('Checks section')).toBe(true);
        expect(text).toContain('Project traits');
      });

      it('reads a listed learned skill before that kind of work', () => {
        expect(read(name)).toContain('## Learned skills');
      });
    });
  }

  describe('review-relay', () => {
    it('exists, may write the prompt file and run foreman, and never edits', () => {
      const meta = frontmatter(read('review-relay'));
      expect(meta.name).toBe('review-relay');
      expect(meta.description).toMatch(/engine/);
      expect(tools('review-relay')).toEqual(expect.arrayContaining(['Write', 'Bash']));
      expect(tools('review-relay')).not.toContain('Edit');
    });
    it('relays through foreman review, copies the text byte for byte, and never reviews itself', () => {
      const text = read('review-relay');
      expect(text).toContain('foreman review --start');
      expect(text).toContain('foreman review --wait');
      expect(text).toContain('--chars');
      expect(text).toMatch(/byte for byte/);
      expect(text).toMatch(/[Dd]o not review/);
      expect(text).toContain('"engine": "unavailable"');
    });
  });

  it('gives the tester and the reviewers no Write or Edit tool', () => {
    for (const name of READ_ONLY) {
      expect(tools(name), name).not.toContain('Write');
      expect(tools(name), name).not.toContain('Edit');
    }
  });

  it('gives the builder Write and Edit', () => {
    expect(tools('builder')).toContain('Write');
    expect(tools('builder')).toContain('Edit');
  });

  it('has the architect choose from the Builders section', () => {
    expect(read('architect')).toContain('Builders');
  });

  it('has the architect explain its owner question in plain words', () => {
    const text = read('architect');
    expect(text).toContain('`explain: { purpose, happened, damage?, recommendation }`');
    for (const part of ['purpose', 'happened', 'damage', 'recommendation']) expect(text, part).toContain(part);
    expect(text).toContain('280 characters');
    expect(text).toContain('no file paths');
    expect(text).toContain('`blocker`');
  });
});

describe('the same kind of bug coming back', () => {
  const flat = (name) => read(name).replace(/\s+/g, ' ');
  for (const name of ['tester', 'compliance-reviewer', 'security-reviewer']) {
    it(`has the ${name} mark a finding that repeats an earlier one`, () => {
      const text = flat(name);
      expect(text).toContain('`## Earlier findings`');
      expect(text).toContain('`repeats`');
      expect(text).toContain('same kind of bug');
    });
  }

  it('has the architect change the approach when the same kind of bug came back', () => {
    const text = flat('architect');
    expect(text).toContain('`## Change the approach`');
    expect(text).toContain('`approach`');
    expect(text).toContain('ends the whole kind');
    expect(text).toContain('`## Earlier findings`');
  });

  it('has the builder say when the story itself cannot hold', () => {
    const text = flat('builder');
    expect(text).toContain('`blocked_by: "story"`');
    expect(text).toContain('`done_when_line`');
    expect(text).toContain('`blocked_by: "code"`');
  });

  for (const name of ['architect', 'sf-architect']) {
    it(`has the ${name} correct the story the builder found cannot hold`, () => {
      const text = flat(name);
      expect(text).toContain('`## Correct the story`');
      expect(text).toContain('`owner_question`');
    });
  }
});

describe('the agents that read the change', () => {
  // In a worktree the local base branch is not kept up to date, so `git diff main` would
  // show stories merged since as this one's change (seen on a real run, 2026-10-19).
  for (const name of ['tester', 'compliance-reviewer', 'security-reviewer']) {
    it(`${name} diffs against where the branch left the header's Base, never a local main`, () => {
      const text = read(name);
      expect(text).toContain('`git diff --merge-base <base>`');
      expect(text).toMatch(/`Base:` line/);
      expect(text).not.toContain('git diff main');
    });
  }
});

describe("the project's own Foreman files", () => {
  for (const name of ['builder', 'tester']) {
    it(`${name} keeps off them and checks Foreman commands in a scratch git repo`, () => {
      const text = read(name);
      expect(text).toContain('scratch git repo');
      expect(text).toContain('FOREMAN_');
      expect(text).toMatch(/never unset/i);
      expect(text).not.toMatch(/variables unset|variables removed/);
      const flat = text.replace(/\s+/g, ' ');
      expect(flat).toContain('every Foreman command (settings, keys, decide, story, stage, lock, learn and the rest) acts on the scratch repo');
      expect(flat).toMatch(/never check a Foreman command from (your|the) slot/);
    });

    it(`${name} starts a supervisor only in a scratch repo, in the foreground, and stops it before finishing`, () => {
      const flat = read(name).replace(/\s+/g, ' ');
      expect(flat).toContain('Start a supervisor only in such a scratch repo, with `foreman run --foreground`');
      expect(flat).toContain('`foreman stop`');
      expect(flat).toContain('`supervisor.pid` is gone');
      expect(flat).toContain('after 5 minutes on standby');
    });

    it(`${name} runs the owner's controls only against a temp project, through the shared helper in tests`, () => {
      const flat = read(name).replace(/\s+/g, ' ');
      expect(flat).toContain("Never run the owner's controls (`foreman stop`, `pause`, `resume`, `run`) except against a temp project");
      expect(flat).toContain('shared helper that builds an owner environment from scratch in a temporary project');
    });
  }
});

describe('the checks each agent runs', () => {
  const flat = (name) => read(name).replace(/\s+/g, ' ');

  it('has the tester run every check fresh, never reusing a record', () => {
    const text = flat('tester');
    expect(text).toContain('`foreman checks --changed`');
    expect(text).not.toContain('foreman checks --changed --reuse');
    expect(text).toMatch(/never `--reuse`/);
    // The commit step reuses the tester's run when nothing changed after it.
    expect(text).not.toMatch(/the commit read/);
    expect(text).not.toContain('the commit runs the checks again itself');
    expect(text).toContain('the commit reuses it when nothing changed after it');
  });

  it('has the builder run the quick checks, leave the full suite to the tester, and name the full run as the fallback', () => {
    const text = flat('builder');
    expect(text).toContain('`foreman checks --changed --quick`');
    expect(text).toContain('`foreman checks --changed --quick --start`');
    expect(text).toContain('`foreman checks --wait <id>`');
    expect(text).toMatch(/leave the full suite to the tester/i);
    expect(text).toContain('`foreman checks --changed`');
    expect(text).toMatch(/runs the full checks in the build/);
    expect(text).not.toContain('--reuse');
  });

  for (const name of ['compliance-reviewer', 'security-reviewer']) {
    it(`has the ${name} read the newest recorded run with --reuse, not claim it is the tester's`, () => {
      expect(flat(name)).toContain('`foreman checks --changed --reuse`');
      expect(flat(name)).toMatch(/targeted runs stay free/i);
      expect(flat(name)).toContain('prints the newest recorded run of this exact tree');
      expect(flat(name)).not.toContain("prints the tester's recorded run");
    });
  }

  it('has the architect not run the checks, and only read the last record with foreman checks --recorded', () => {
    const text = flat('architect');
    expect(text).toContain('`foreman checks --recorded`');
    expect(text).toMatch(/do not run the checks/i);
    expect(text).toMatch(/never starts a run/);
    expect(text).not.toContain('--reuse');
    expect(text).not.toContain('--start');
    expect(text).not.toContain('foreman checks --wait');
  });

  // The Bash tool ends a call that runs too long, and the suite can outlast it, so an agent starts
  // the checks and collects the result in calls that each return in time.
  for (const name of ['builder', 'tester', 'compliance-reviewer', 'security-reviewer']) {
    it(`has the ${name} start the checks and wait for them, never background them by hand`, () => {
      const text = flat(name);
      expect(text).toContain('--start');
      expect(text).toContain('`foreman checks --wait <id>`');
      expect(text).toMatch(/never run a check's command by hand or background it to a file/i);
    });
  }

  it('has each agent start the checks with the flags it already uses', () => {
    expect(flat('builder')).toContain('`foreman checks --changed --start`');
    expect(flat('tester')).toContain('`foreman checks --changed --start`');
    for (const name of ['compliance-reviewer', 'security-reviewer']) expect(flat(name)).toContain('`foreman checks --changed --reuse --start`');
  });
});

describe('the check guard in the agent prompts', () => {
  const SENTENCE = "Foreman denies a check's command run by hand, so run the brief's checks only through `foreman checks`.";
  const agents = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

  it('covers all 12 agents', () => {
    expect(agents.length).toBe(12);
  });

  for (const name of agents) {
    it(`has the ${name} told that Foreman denies a hand run of a check`, () => {
      expect(read(name)).toContain(SENTENCE);
    });
  }

  for (const name of NAMES) {
    it(`puts the sentence right after the ${name}'s never-by-hand sentence`, () => {
      const flat = read(name).replace(/\s+/g, ' ');
      expect(flat).toContain(`Never run a check's command by hand or background it to a file. ${SENTENCE}`);
    });
  }
});

describe('the scan guard in the agent prompts', () => {
  const SENTENCE =
    'Search and list only inside the project, the `.claude` folder in your home folder and the temp folder: never search the whole disk or the home folder (no `find`, `du`, `ls -R`, `grep -r` or `rg` starting at `/` or the home folder). Foreman denies such a search, and on macOS it makes the owner answer privacy prompts.';
  const agents = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));

  for (const name of agents) {
    it(`has the ${name} told not to scan the whole disk or the home folder`, () => {
      expect(read(name).replace(/\s+/g, ' ')).toContain(SENTENCE);
    });
  }

  it('names no private path', () => {
    for (const name of agents) expect(SENTENCE).not.toMatch(/~\/|\/Users\//);
  });
});

describe('the kill guard in the agent prompts', () => {
  const SENTENCE = "Stop only processes you started, by the PID you recorded when you started them (`<command> > <log file> 2>&1 & echo $!`, then `kill <that pid>`): never by name or pattern (no `pkill`, `killall`, or `kill` of a process group), because that can match the running factory and stop every story; Foreman denies it. Keep scratch files in the worktree or in a folder of your own under the temp folder (`$TMPDIR/<slot>`), never at a fixed `/tmp` path another slot could share.";
  for (const name of ['builder', 'tester', 'sf-developer', 'sf-tester']) {
    it(`has the ${name} stop only processes it started, by a recorded PID`, () => {
      expect(read(name).replace(/\s+/g, ' ')).toContain(SENTENCE);
    });
    it(`puts the ${name}'s sentence right after its scan sentence`, () => {
      expect(read(name).replace(/\s+/g, ' ')).toMatch(/makes the owner answer privacy prompts\. Stop only processes you started/);
    });
  }

  it('names no private path', () => {
    expect(SENTENCE).not.toMatch(/~\/|\/Users\//);
  });
});
