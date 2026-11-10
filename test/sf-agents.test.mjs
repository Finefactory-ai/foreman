import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { namedSkills } from '../plugin/packs/salesforce/skills.mjs';
import { BLOCK_DEFAULTS, defaults } from '../plugin/packs/salesforce/config.mjs';
import { resolveTraits } from '../plugin/lib/engine/traits.mjs';

// The Salesforce pack's agents and traits. They run unattended in a story's worktree, so
// they hold no gate, handoff file, git action, MCP name, path or org identity, and every skill
// they name is in the pinned sf-skills tag.
const DIR = fileURLToPath(new URL('../plugin/agents/', import.meta.url));
const AGENTS = ['sf-architect', 'sf-admin', 'sf-developer', 'sf-agentforce', 'sf-tester', 'sf-code-reviewer'];
const BUILDERS = ['sf-admin', 'sf-developer', 'sf-agentforce'];
const READ_ONLY = ['sf-architect', 'sf-tester', 'sf-code-reviewer'];
const VERDICTS = ['sf-tester', 'sf-code-reviewer'];
const TRAITS_DIR = fileURLToPath(new URL('../plugin/packs/salesforce/traits/', import.meta.url));

// The skill folders of forcedotcom/sf-skills at the pinned tag, made with:
//   gh api "repos/forcedotcom/sf-skills/contents/skills?ref=1.66.0" --jq '[.[]|select(.type=="dir")|.name]|sort'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/sf-skills-1.66.0.json', import.meta.url), 'utf8'));

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

const hits = (patterns, text) => patterns.filter((p) => p.test(text)).map(String);

// A gate makes an unattended run stop for a person who is not there.
const GATES = [/ask the user/i, /wait for/i, /CONFIRM/, /confirm before/i];
const gatePhrases = (text) => hits(GATES, text);

// The pipeline carries the work between stages; an agent writes no handoff file, runs no git
// action and calls no MCP server.
const PIPELINE_DUTIES = [
  /\.claude\/output/,
  /current-branch/,
  /components-created/,
  /design-requirements/,
  /\.claude\/templates/,
  /\bgit (commit|push|checkout|add|worktree|switch|branch|merge|rebase)\b/,
  /mcp__/,
];
const handoffs = (text) => hits(PIPELINE_DUTIES, text);

// Nothing that names a machine, a sibling folder or an org.
const PATHS = [
  /\/Users\//,
  /\/home\//,
  /~\//,
  /\.\.\//,
  /-worktrees/,
  /sf-agents-/,
  /00D[A-Za-z0-9]{12}/,
  /\bfp-(dev\d*|qa|uat)\b/,
  /[A-Za-z]:\\/,
];
const privatePaths = (text) => hits(PATHS, text);

// Backticked tokens that look like an sf-skills skill name.
const SKILL_LIKE = /^(platform|automation|experience|dx|omnistudio|agentforce|integration|design-systems)-[a-z0-9-]+$/;
const skillMentions = (text) => [...new Set([...String(text).matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((t) => SKILL_LIKE.test(t)))];

const missingSkills = (names) => names.filter((name) => !fixture.skills.includes(name));

describe('the content checks can fail', () => {
  it('gatePhrases finds each gate', () => {
    expect(gatePhrases('Ask the user, then wait for CONFIRM')).toHaveLength(3);
    expect(gatePhrases('Return ready: false with the question in blocker.')).toEqual([]);
  });

  it('handoffs finds a git action and an MCP name', () => {
    const found = handoffs('Then git push the branch and call mcp__sf-api-context.');
    expect(found).toContain(String(/\bgit (commit|push|checkout|add|worktree|switch|branch|merge|rebase)\b/));
    expect(found).toContain(String(/mcp__/));
    expect(handoffs('Do not commit or push.')).toEqual([]);
  });

  it('privatePaths finds a sibling worktree path', () => {
    const found = privatePaths('cd ../repo-worktrees/x');
    expect(found).toContain(String(/\.\.\//));
    expect(found).toContain(String(/-worktrees/));
    expect(privatePaths('force-app/main/default/classes')).toEqual([]);
  });

  it('skillMentions reports a skill the lock does not have', () => {
    const mentions = skillMentions('Load `platform-made-up-generate` and `platform-soql-query`, then run `sf project deploy start`.');
    expect(mentions).toEqual(['platform-made-up-generate', 'platform-soql-query']);
    expect(missingSkills(mentions)).toEqual(['platform-made-up-generate']);
  });
});

describe('Salesforce pack agents', () => {
  for (const name of AGENTS) {
    describe(name, () => {
      it('exists with name, description and tools, and its name matches the file', () => {
        expect(existsSync(`${DIR}${name}.md`)).toBe(true);
        const meta = frontmatter(read(name));
        expect(meta).not.toBeNull();
        expect(meta.name).toBe(name);
        expect(meta.description).toBeTruthy();
        expect(meta.tools).toBeTruthy();
      });

      it('has no memory, model or color key', () => {
        const meta = frontmatter(read(name));
        for (const key of ['memory', 'model', 'color']) expect(Object.hasOwn(meta, key), key).toBe(false);
      });

      it('has Read, Grep, Glob, Bash and Skill, and no MCP tool', () => {
        const list = tools(name);
        for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'Skill']) expect(list, tool).toContain(tool);
        expect(list.filter((t) => t.startsWith('mcp__'))).toEqual([]);
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

      it('names skills, all of them in the pinned sf-skills tag', () => {
        const text = read(name);
        const named = namedSkills(text);
        expect(named.length).toBeGreaterThan(0);
        expect(missingSkills(named)).toEqual([]);
        expect(missingSkills(skillMentions(text))).toEqual([]);
      });

      it('has no gate phrase', () => {
        expect(gatePhrases(read(name))).toEqual([]);
      });

      it('has no handoff file, git action or MCP name', () => {
        expect(handoffs(read(name))).toEqual([]);
      });

      it('has no path or org identity', () => {
        expect(privatePaths(read(name))).toEqual([]);
      });
    });
  }

  it('gives the architect, tester and code reviewer no Write or Edit', () => {
    for (const name of READ_ONLY) {
      expect(tools(name), name).not.toContain('Write');
      expect(tools(name), name).not.toContain('Edit');
    }
  });

  it('has the tester and code reviewer name every verdict field and severity', () => {
    for (const name of VERDICTS) {
      const text = read(name);
      for (const field of ['approved', 'findings', 'checked', 'severity', 'where', 'observed', 'fix', 'repeats']) {
        expect(text, `${name}: ${field}`).toContain(`\`${field}\``);
      }
      for (const word of ['blocker', 'major', 'minor']) expect(text, `${name}: ${word}`).toContain(word);
    }
  });

  it('gives the builders Write and Edit', () => {
    for (const name of BUILDERS) {
      expect(tools(name), name).toContain('Write');
      expect(tools(name), name).toContain('Edit');
    }
  });

  it('has sf-architect choose from the Builders section and name every DESIGN field', () => {
    const text = read('sf-architect');
    expect(text).toContain('Builders');
    expect(text).toContain('goes to the OmniStudio builder when one is listed, else to `developer`');
    for (const field of ['ready', 'blocker', 'needs_owner', 'builder', 'resources', 'design', 'test_plan', 'done_when', 'approach']) {
      expect(text, field).toContain(`\`${field}\``);
    }
  });

  it('has the builders name every BUILD field', () => {
    for (const name of BUILDERS) {
      const text = read(name);
      for (const field of ['complete', 'summary', 'files', 'commands', 'problem']) {
        expect(text, `${name}: ${field}`).toContain(`\`${field}\``);
      }
    }
  });

  it('pins the fixture to the tag the pack installs', () => {
    expect(fixture.source).toBe(BLOCK_DEFAULTS.skills.source);
    expect(fixture.tag).toBe(BLOCK_DEFAULTS.skills.tag);
  });

  it('has sf-admin generate Flows and permission sets and test them, never retrieve or hand-build a Flow', () => {
    const text = read('sf-admin');
    for (const skill of ['automation-flow-generate', 'platform-permission-set-generate', 'platform-apex-test-generate']) {
      expect(skillMentions(text), skill).toContain(skill);
    }
    expect(text).not.toMatch(/retrieve start --metadata Flow/);
    expect(text).not.toMatch(/Flow Builder/);
  });

  it("has sf-developer follow the test checklist and never seed data", () => {
    const text = read('sf-developer');
    expect(skillMentions(text)).toContain('platform-apex-test-generate');
    expect(skillMentions(text)).toContain('platform-soql-query');
    expect(text).toContain('200');
    expect(text).toContain('negative');
    expect(text).toContain('null');
    expect(text).not.toContain('platform-data-manage');
  });

  describe('sf-agentforce', () => {
    const text = () => read('sf-agentforce');

    it('loads the agentforce skills', () => {
      for (const skill of ['agentforce-generate', 'agentforce-test']) expect(skillMentions(text()), skill).toContain(skill);
      expect(namedSkills(text())).toEqual(expect.arrayContaining(['agentforce-generate', 'agentforce-test', 'platform-apex-generate', 'platform-apex-test-generate', 'automation-flow-generate']));
    });

    it('builds and validates the bundle, writes the eval spec outside the package folders, and keeps test definitions out', () => {
      for (const s of [
        'sf agent validate authoring-bundle',
        'sf agent generate authoring-bundle --no-spec',
        'tests/',
        '-eval.json',
        'AiEvaluationDefinition',
        'string_assertion',
        'bot_response_rating',
        '@InvocableVariable',
        'AgentforceEmployeeAgent',
        'aiAuthoringBundles/',
        '<bundleType>AGENT</bundleType>',
        '200',
        'negative',
        'null',
      ]) {
        expect(text(), s).toContain(s);
      }
    });

    it('never publishes, activates or creates agent tests, and never names --version-number', () => {
      const lines = text().split('\n').filter((l) => /agent (publish|activate|test create|test run)/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).toMatch(/never/i);
      expect(text()).not.toContain('--version-number');
    });

    it('names the activate flag as `--version N` on short lines', () => {
      expect(text()).toContain('takes `--version N`');
      const lines = text().split('\n').filter((l) => l.includes('--version'));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(100);
      expect(text()).not.toContain('--version-number');
    });
  });

  it('has sf-tester dry-run the story\'s tests, check coverage, Jest and Code Analyzer', () => {
    const text = read('sf-tester');
    expect(skillMentions(text)).toContain('platform-apex-test-run');
    expect(skillMentions(text)).toContain('dx-code-analyzer-run');
    for (const s of ['RunSpecifiedTests', '--dry-run', 'UNABLE_TO_LOCK_ROW', 'salesforce.test', 'salesforce.coverage', '75', '90', 'sf code-analyzer run', 'Jest']) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain('platform-data-manage');
  });

  it('has sf-tester never deploy for real, and target another org only on the dry run', () => {
    const lines = read('sf-tester').split('\n');
    const deploys = lines.filter((l) => /deploy start/.test(l));
    expect(deploys.length).toBeGreaterThan(0);
    for (const line of deploys) expect(line).toContain('--dry-run');
    for (const line of lines.filter((l) => l.includes('--target-org'))) {
      expect(line.includes('--dry-run') || line.includes('salesforce.test'), line).toBe(true);
    }
  });

  describe('sf-tester and Agentforce', () => {
    const text = () => read('sf-tester');
    const lines = () => text().split('\n');

    it('previews each case in a new session with simulated actions, from the authoring bundle', () => {
      const start = lines().filter((l) => l.includes('sf agent preview start'));
      expect(start.length).toBeGreaterThan(0);
      for (const l of start) {
        expect(l).toContain('--authoring-bundle');
        expect(l).toContain('--simulate-actions');
      }
      for (const s of ['sf agent preview send', 'sf agent preview end', 'aiAuthoringBundles/', 'tests/<Api>-eval.json', '.sfdx/agents/<Api>/sessions/<id>/traces/', 'action definition name']) {
        expect(text(), s).toContain(s);
      }
    });

    it('single-quotes the utterance and never pastes it into double quotes', () => {
      const send = lines().filter((l) => l.includes('sf agent preview send'));
      expect(send.length).toBeGreaterThan(0);
      for (const l of send) {
        expect(l).toContain("-u '<utterance>'");
        expect(l).not.toContain('"<utterance>"');
      }
      expect(text()).toContain("'\\''");
    });

    it('blocks on routing, notes the outcome as minor, and re-runs a failed case once', () => {
      const t = text();
      expect(t).toMatch(/blocker \(`agent routing`\)/);
      expect(t).toMatch(/minor \(`agent routing flaky`\)/);
      expect(t).toMatch(/minor \(`agent outcome`\)/);
      expect(t).toMatch(/once more in a new session/);
    });

    it('never publishes, activates or runs agent tests in an org', () => {
      const found = lines().filter((l) => /agent (publish|activate|test run-eval|test create|test run)/.test(l));
      expect(found.length).toBeGreaterThan(0);
      for (const l of found) expect(l, l).toMatch(/never/i);
    });

    it('loads no agentforce-test skill', () => {
      expect(namedSkills(text())).not.toContain('agentforce-test');
      expect(skillMentions(text())).not.toContain('agentforce-test');
    });
  });

  it('has sf-code-reviewer run Code Analyzer and review every area, mapping verdicts to severities', () => {
    const text = read('sf-code-reviewer');
    expect(skillMentions(text)).toContain('dx-code-analyzer-run');
    for (const s of ['LWC', 'Flow', 'metadata', 'OmniStudio', 'Agent Script', 'CHANGES REQUIRED', 'WARNINGS', 'sf code-analyzer run', '`with sharing`', 'WITH USER_MODE', 'SOQL injection']) {
      expect(text, s).toContain(s);
    }
    expect(text.split('\n').filter((l) => /deploy start/.test(l))).toEqual([]);
  });
});

describe('the tester and the org baseline', () => {
  const texts = () => [['sf-tester', read('sf-tester')], ['traits/tester.md', readFileSync(path.join(TRAITS_DIR, 'tester.md'), 'utf8')]];

  it('reads the saved baseline with `foreman sf baseline` and calls a listed failure inherited', () => {
    for (const [name, text] of texts()) {
      for (const s of ['foreman sf baseline', 'inherited', 'testOrg', 'inherited test failure', 'failing']) expect(text, `${name}: ${s}`).toContain(s);
    }
  });

  it('reads only the baselines that predate the story branch, with `foreman sf baseline --story`', () => {
    for (const [name, text] of texts()) expect(text, name).toContain('foreman sf baseline --story');
  });

  it('never refreshes the baseline: --refresh appears only in a "never" sentence', () => {
    for (const [name, text] of texts()) {
      const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.includes('--refresh'));
      expect(sentences.length, name).toBeGreaterThan(0);
      for (const sentence of sentences) expect(sentence, name).toMatch(/\bnever\b/i);
    }
  });

  it('keeps the baseline lines free of a target org or a deploy', () => {
    for (const [name, text] of texts()) {
      for (const line of text.split('\n').filter((l) => l.includes('foreman sf baseline'))) {
        expect(line, name).not.toContain('--target-org');
        expect(line, name).not.toContain('deploy start');
      }
    }
  });
});

describe('Salesforce pack defaults', () => {
  it('wire sf-tester as the tester and sf-code-reviewer as the third reviewer', () => {
    const roles = defaults(undefined).roles;
    expect(roles.tester.agent).toBe('foreman:sf-tester');
    expect(roles.reviewers[2]).toEqual({ name: 'code', agent: 'foreman:sf-code-reviewer' });
  });

  it('name only agents that have a file', () => {
    const roles = defaults(undefined).roles;
    expect(roles.builders.agentforce.agent).toBe('foreman:sf-agentforce');
    const agents = [roles.architect, roles.tester, ...Object.values(roles.builders), ...roles.reviewers]
      .map((r) => r.agent)
      .filter((a) => a.startsWith('foreman:'));
    expect(agents.length).toBeGreaterThan(0);
    for (const agent of agents) expect(existsSync(`${DIR}${agent.slice('foreman:'.length)}.md`), agent).toBe(true);
  });
});

describe('Salesforce pack traits', () => {
  const trait = (name) => readFileSync(path.join(TRAITS_DIR, `${name}.md`), 'utf8');

  it('are exactly all, security and tester', () => {
    expect(readdirSync(TRAITS_DIR).sort()).toEqual(['all.md', 'security.md', 'tester.md']);
  });

  for (const name of ['all', 'security', 'tester']) {
    it(`${name}.md is non-empty, with no gate, handoff, path or unknown skill`, () => {
      const text = trait(name);
      expect(text.trim().length).toBeGreaterThan(0);
      expect(gatePhrases(text)).toEqual([]);
      expect(handoffs(text)).toEqual([]);
      expect(privatePaths(text)).toEqual([]);
      expect(missingSkills(skillMentions(text))).toEqual([]);
    });
  }

  it("security.md has the security reviewer's six checks", () => {
    const text = trait('security');
    for (const s of ['CRUD', 'FLS', '`with sharing`', 'USER_MODE', 'SOQL injection', 'guest', 'Named Credential']) expect(text, s).toContain(s);
  });

  it("tester.md has the dry-run org, the story's tests, coverage and lock errors", () => {
    const text = trait('tester');
    for (const s of ['salesforce.test', 'RunSpecifiedTests', 'UNABLE_TO_LOCK_ROW', 'floor', 'target']) expect(text, s).toContain(s);
  });

  it('all.md has the never-sfdx and no-login rules', () => {
    const text = trait('all');
    expect(text).toContain('`sfdx`');
    expect(text).toContain('org login');
  });

  it('reach each role through resolveTraits, every role under 4 KB', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'foreman-sf-traits-'));
    const { traits, errors } = resolveTraits({ root, config: { pack: 'salesforce', ...defaults(undefined) } });
    expect(errors).toEqual([]);
    const all = trait('all').trim();
    expect(traits.tester).toBe(`${all}\n\n${trait('tester').trim()}`);
    expect(traits.security).toBe(`${all}\n\n${trait('security').trim()}`);
    for (const role of ['code', 'architect', 'developer', 'admin']) expect(traits[role], role).toBe(all);
    for (const [role, text] of Object.entries(traits)) expect(Buffer.byteLength(text), role).toBeLessThan(4096);
  });
});

describe('the checks the Salesforce agents run', () => {
  const flat = (name) => read(name).replace(/\s+/g, ' ');

  for (const name of BUILDERS) {
    it(`has ${name} run the quick checks, starting a long run and waiting for it, and leave the full suite to the tester`, () => {
      const text = flat(name);
      expect(text).toContain('`foreman checks --changed --quick`');
      expect(text).toContain('`foreman checks --changed --quick --start`');
      expect(text).toContain('`foreman checks --wait <id>`');
      expect(text).toMatch(/leave the full suite to the tester/i);
      expect(text).toContain('`foreman checks --changed`');
      expect(text).toMatch(/runs the full checks in the build/);
      expect(text).not.toContain('--reuse');
    });
  }

  it('has sf-tester run every check fresh, never reusing a record', () => {
    const text = flat('sf-tester');
    expect(text).toContain('`foreman checks --changed`');
    expect(text).toContain('`foreman checks --changed --start`');
    expect(text).toContain('never `--reuse`');
    expect(text).not.toContain('foreman checks --changed --reuse');
  });

  it('has sf-code-reviewer read the newest recorded run with --reuse, not claim it is the tester\'s', () => {
    const text = flat('sf-code-reviewer');
    expect(text).toContain('prints the newest recorded run of this exact tree');
    expect(text).not.toContain("prints the tester's recorded run");
    expect(text).toContain('`foreman checks --changed --reuse`');
    expect(text).toContain('`foreman checks --changed --reuse --start`');
    expect(text).toContain('`foreman checks --wait <id>`');
  });

  it('has sf-architect not run the checks, and only read the last record with foreman checks --recorded', () => {
    const text = flat('sf-architect');
    expect(text).toContain('`foreman checks --recorded`');
    expect(text).toMatch(/do not run the checks/i);
    expect(text).toMatch(/never starts a run/);
    expect(text).not.toContain('--reuse');
    expect(text).not.toContain('--start');
    expect(text).not.toContain('foreman checks --wait');
  });

  for (const name of AGENTS) {
    it(`has ${name} told that Foreman denies a hand run of a check`, () => {
      expect(read(name)).toContain("Foreman denies a check's command run by hand, so run the brief's checks only through `foreman checks`.");
    });
  }
});
