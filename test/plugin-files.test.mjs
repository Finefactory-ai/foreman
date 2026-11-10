import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RARE, allText, skillFile } from './story-skill.mjs';

const file = (rel) => readFileSync(fileURLToPath(new URL(`../plugin/${rel}`, import.meta.url)), 'utf8');

describe('hooks/hooks.json', () => {
  const hooks = JSON.parse(file('hooks/hooks.json')).hooks;

  it('runs the agent-events hook on agent start, stop and every tool call', () => {
    expect(Object.keys(hooks).sort()).toEqual(['PreToolUse', 'SubagentStart', 'SubagentStop']);
  });

  it('points every command at the plugin copy of the hook', () => {
    const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    expect(commands.length).toBeGreaterThan(0);
    for (const h of commands) {
      expect(h.type).toBe('command');
      expect(h.command).toContain('${CLAUDE_PLUGIN_ROOT}/lib/hooks/agent-events.mjs');
      expect(h.timeout).toBe(10);
    }
  });
});

// The story skill: SKILL.md holds the main path, and each rare path sits in a file next to it.
describe('skills/story/*', () => {
  const text = skillFile();
  const all = allText();

  it('records the start as a command of its own, and leaves the plan file to workflow-args (FM-348)', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('record the start first, never chained: `foreman story start <ID>`');
    // The session no longer looks for the plan file itself: `foreman workflow-args <ID>` reuses it.
    expect(flat).not.toContain('`test -f`');
    expect(flat).toContain('Later calls of `workflow-args <ID>` reuse it while current');
    expect(all).not.toMatch(/foreman story start <ID>`?\s*(;|&&)/);
  });

  it('sends checks that fail on the merged code (ship exit 2 at merge-main) to a fix round', () => {
    const ci = skillFile('ship-ci.md');
    const at = ci.indexOf('`stage` is `merge-main`');
    expect(at).toBeGreaterThan(-1);
    const bullet = ci.slice(at, ci.indexOf('\n  - ', at));
    expect(bullet).toContain('failures');
    expect(bullet).toContain('stage: "checks"');
    expect(bullet).toContain('fix round');
    expect(at).toBeLessThan(ci.indexOf('CI **never started**'));
  });

  it('re-runs every check with foreman checks --all after the merge-main fix round, since the next ship runs no check', () => {
    const ci = skillFile('ship-ci.md');
    const at = ci.indexOf('`stage` is `merge-main`');
    const bullet = ci.slice(at, ci.indexOf('\n  - ', at)).replace(/\s+/g, ' ');
    expect(bullet).toContain('foreman checks --all --start');
    expect(bullet).toContain('foreman checks --wait <id>');
    expect(bullet).not.toContain('from `failures` yourself');
    expect(bullet).toContain('does not run the checks again');
    expect(bullet).toContain('failed path');
    expect(bullet).toContain('never amend');
  });

  it('sends a rethink result to rethink.md, which writes the rethink file and saves the new plan', () => {
    const flat = text.replace(/\s+/g, ' ');
    expect(flat).toContain('**`rethink`**');
    expect(flat).toContain('read `${CLAUDE_SKILL_DIR}/rethink.md`');
    const rethink = skillFile('rethink.md').replace(/\s+/g, ' ');
    expect(rethink.startsWith('# The same kind of bug came back')).toBe(true);
    for (const part of ['foreman workflow-args <ID> --rethink', 'foreman-<slot>-<ID>-rethink.json', 'findings file', '--save-plan']) expect(rethink, part).toContain(part);
    expect(rethink).toContain('"cause": "story"');
    expect(rethink).toContain('cannot hold');
    expect(flat).toContain('cannot hold as written');
    expect(flat).toContain('the same kind of bug came back, or the builder found the story cannot hold as written: read `${CLAUDE_SKILL_DIR}/rethink.md`');
    expect(flat).not.toContain('bug again or story');
    expect(skillFile('fix-round.md')).toContain('`rethink` → as in `rethink.md`.');
  });

  it('is the story skill', () => {
    expect(text).toMatch(/^---\nname: story\ndescription: .+\n---\n/);
  });

  it('runs the plugin workflow and ends with the supervisor protocol', () => {
    expect(text).toContain('foreman:pipeline');
    expect(text).toContain('FACTORY_RESULT: <shipped|ready-to-promote|blocked|failed|empty|halted|deferred|held> <story id or ->');
  });

  it('frees the slot for a release that finishes later (ship exit 9)', () => {
    const stopped = skillFile('ship-stopped.md');
    expect(stopped).toMatch(/^- \*\*9\*\* — /m);
    expect(stopped).toContain('foreman story end ready-to-promote');
  });

  it('keeps the plan in the state folder, so a later session can reuse it', () => {
    expect(text).toContain('<state folder>/plans/<ID>.json');
  });

  it('uses --strict only when no mode word is given', () => {
    expect(text).toContain('`foreman story next --id <ID> --strict`');
    expect(text).toContain('`foreman story next --id <ID>`, without `--strict`');
  });

  it('commits with --allow-empty when the story changed no file, so ship finds a commit ahead', () => {
    const start = text.indexOf('## 4. Commit');
    const end = text.indexOf('## 5. Release');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
    const step4 = text.slice(start, end);
    expect(step4).toContain('git status --porcelain');
    expect(step4).toContain('git commit --allow-empty');
    expect(step4).toContain('nothing to change for this story source');
    expect(step4).toContain('make one commit for the story');
    expect(step4.toLowerCase()).toContain('attribution');
  });

  it("starts the commit checks with --reuse and waits for them, never committing without the exact tree's passing result", () => {
    const step4 = text.slice(text.indexOf('## 4. Commit'), text.indexOf('## 5. Release')).replace(/\s+/g, ' ');
    expect(step4).toContain('foreman checks --changed --reuse --start');
    expect(step4).toContain('foreman checks --wait <id>');
    expect(step4).toMatch(/never run a check's command by hand or background it to a file/i);
    expect(step4).toContain('never committed without a passing full-suite result for its exact tree');
    expect(step4).not.toContain('Do not add `--reuse`');
  });

  it('checks the live site before closing a merged story', () => {
    expect(text).toContain('foreman health --site');
    expect(text).toContain('merged; no live site is configured');
    expect(all).not.toContain('merged; live site not checked');
  });

  it('names no project-specific service or file', () => {
    for (const name of ['SKILL.md', ...RARE]) {
      for (const word of ['supabase', 'vercel', 'colima', 'artifactdata', 'obsidian', 'vault', '.env.local']) {
        expect(skillFile(name).toLowerCase(), `${name}: ${word}`).not.toContain(word);
      }
    }
  });

  it('blocks on a failed file claim with only the first stderr line, quoted', () => {
    const deferred = skillFile('deferred.md');
    expect(deferred.replace(/\s+/g, ' ')).toContain("'Could not claim the files: <the first line of its stderr>'");
    expect(deferred.split("`'\\''`").length - 1).toBeGreaterThanOrEqual(2);
  });

  it('makes its changes through the foreman command', () => {
    for (const cmd of ['foreman story next', 'foreman story start', 'foreman story block', 'foreman story done', 'foreman story finalize', 'foreman story todo', 'foreman story summary', 'foreman story end', 'foreman stage commit', 'foreman checks --changed', 'foreman workflow-args', 'foreman lock take', 'foreman lock release', 'foreman lock files', 'foreman ship --story']) {
      expect(all).toContain(cmd);
    }
  });

  it('writes group summaries in group-summary mode, accepting the old phase-summary word', () => {
    const modes = skillFile('modes.md');
    expect(modes).toContain('/foreman:story <ID> group-summary');
    expect(modes).toContain('`phase-summary`');
    expect(all).not.toContain('not supported yet');
    expect(modes).toContain('## <groupLabel> <group> is finished');
  });

  it('asks the owner through foreman decide and applies the answers', () => {
    for (const cmd of ['foreman decide add', 'foreman decide pending', 'foreman decide applied', 'foreman lock owner-claim']) {
      expect(all).toContain(cmd);
    }
    for (const option of ['"Retry with a note to the architect"', `"I'll take it"`, '"Drop"']) {
      expect(all).toContain(option);
    }
    expect(all.toLowerCase()).not.toContain('decisions page');
  });

  it('records the builder with the findings and applies trait proposals through foreman learn', () => {
    expect(text).toMatch(/foreman story end [^\n]*--findings <findings file> --builder <builder>/);
    const answers = skillFile('answers.md');
    expect(answers).toContain('`Add a trait for <builder>: <rule>?`');
    expect(answers).toContain('foreman learn apply <item id>');
    expect(answers).toContain('foreman learn ignore <item id>');
    expect(answers).toContain('"Add as a trait"');
  });

  it('keeps a finding that names a learned rule [L-n] unchanged, and says how Foreman learns from findings', () => {
    const paragraph = text.split(/\n\n/).find((p) => p.includes('[L-n]'));
    expect(paragraph).toBeDefined();
    expect(paragraph).toMatch(/findings file unchanged, tag included/);
    expect(paragraph).toContain('Never drop or reword the tag');
    const start = text.indexOf('## Tell the command centre how it ended');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('\n## ', start + 1);
    const section = text.slice(start, end === -1 ? undefined : end);
    expect(section).toContain('learning.auto');
    expect(section).not.toMatch(/(^|[.\n] ?)Repeated findings for one builder become trait proposals for the owner\./);
  });

  it('applies follow-up proposals through foreman learn', () => {
    const answers = skillFile('answers.md');
    expect(answers).toContain('`Follow up on <ID>: <n> minor finding(s)?`');
    expect(answers).toContain('**"Create a follow-up story"** — `foreman learn apply <item id>`');
  });

  it('leaves the note about follow-ups Foreman created to the supervisor', () => {
    const answers = skillFile('answers.md');
    const at = answers.indexOf('`Foreman created <n> follow-up stories`');
    expect(at).toBeGreaterThan(-1);
    const paragraph = answers.slice(at, answers.indexOf('\n\n', at)).replace(/\s+/g, ' ');
    expect(paragraph).toContain('leave it alone');
    expect(paragraph).toContain('`foreman learn undo`');
  });

  it('proposes depends_on fixes to the owner and applies them through foreman story set', () => {
    expect(all).toContain('"Add depends_on: <ids> to <ID>?"');
    expect(all).toContain('foreman story set <ID> --depends-on');
  });

  it('proposes a depends_on fix only when features.dependsOnProposals prints true', () => {
    const text = skillFile('blocked.md');
    const at = text.indexOf('foreman settings get features.dependsOnProposals');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(text.indexOf('--title "Add depends_on: <ids> to <ID>?"'));
    expect(text).toContain('Only when it prints `true`, also ask the owner to approve the fix');
    expect(text).toContain('When it prints anything else, or fails, propose nothing.');
  });

  it('applies the depends_on fix at once when features.autoApplyDependsOn prints true', () => {
    const text = skillFile('blocked.md');
    const proposals = text.indexOf('features.dependsOnProposals');
    const auto = text.indexOf('foreman settings get features.autoApplyDependsOn');
    expect(auto).toBeGreaterThan(proposals);
    expect(auto).toBeLessThan(text.indexOf('--title "Add depends_on: <ids> to <ID>?"'));
    expect(text).toContain("foreman story depend <ID> --on <ids> --reason '");
  });

  it('says the supervisor applies depends_on, dependency-note and learned-change answers even while sessions run', () => {
    const text = skillFile('answers.md');
    const at = text.indexOf('# The owner\'s answers');
    expect(at).toBeGreaterThan(-1);
    const section = text.slice(at, text.indexOf('Each answered item that asks about a failed story', at)).replace(/\s+/g, ' ');
    expect(section).toContain('the review, trait, follow-up and deletes answers itself when no session is running');
    expect(section).toMatch(/depends_on, dependency-note and learned-change answers[^]*even while sessions run/);
    expect(section).toContain('run `foreman decide pending` again');
    expect(section).toMatch(/Before applying a depends_on or dependency-note answer/);
    expect(section).toContain('Leave learned-change notes alone');
  });

  it('applies the answer to a dependency note through foreman story set', () => {
    const text = skillFile('answers.md');
    const at = text.indexOf('`<ID> now waits for <ids>`');
    expect(at).toBeGreaterThan(-1);
    const entry = text.slice(at, at + 800);
    expect(entry).toContain('**"Undo"**');
    expect(entry).toContain('**"Keep"**');
    expect(entry).toContain("--depends-on ''");
  });
});
