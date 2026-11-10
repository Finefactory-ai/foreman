import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { actionsWorkflow, workflowSecrets } from './workflow-template.mjs';
import { CLAUDE_CODE_VERSION, FOREMAN_SOURCE, foremanVersion } from './versions.mjs';
import { withDefaults } from '../config/defaults.mjs';

const cfg = (cloud = {}) => withDefaults({ version: 1, project: { name: 'P' }, state: { store: 'branch' }, cloud });
const PINS = { foreman: '0.5.0', claudeCode: '2.1.292' };

// The first line that starts with `head` (after any `- `) and the lines indented deeper
// than it, as one block of text.
function block(text, head) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimStart().replace(/^- /, '').startsWith(head));
  if (start === -1) return '';
  const indent = lines[start].search(/\S/);
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    out.push(line);
  }
  return out.join('\n').trimEnd();
}

describe('actionsWorkflow', () => {
  it('matches the snapshot for the default config', async () => {
    await expect(actionsWorkflow({ config: cfg({ envVars: ['RESEND_API_KEY'] }), versions: PINS })).toMatchFileSnapshot('../../../test/fixtures/cloud/foreman.yml');
  });

  it('is plain YAML: two-space indents, no tabs, a trailing newline, and only known top-level keys', () => {
    const text = actionsWorkflow({ config: cfg(), versions: PINS });
    expect(text).not.toMatch(/\t/);
    expect(text.endsWith('\n')).toBe(true);
    for (const line of text.split('\n')) expect(line.search(/\S|$/) % 2).toBe(0);
    const top = text.split('\n').filter((l) => /^[a-z]/.test(l)).map((l) => l.split(':')[0]);
    expect(top).toEqual(['name', 'on', 'concurrency', 'permissions', 'jobs']);
  });

  it('runs on the schedule from config and by hand, with an optional story', () => {
    const text = actionsWorkflow({ config: cfg({ actions: { cron: '0 */2 * * 1-5' } }), versions: PINS });
    expect(block(text, 'schedule:')).toContain("- cron: '0 */2 * * 1-5'");
    const dispatch = block(text, 'workflow_dispatch:');
    expect(dispatch).toMatch(/story:\n\s+description: .+\n\s+required: false\n\s+type: string/);
  });

  it('runs one Foreman job at a time, never cancelling one in progress, for at most 300 minutes', () => {
    const text = actionsWorkflow({ config: cfg(), versions: PINS });
    expect(block(text, 'concurrency:')).toBe('concurrency:\n  group: foreman\n  cancel-in-progress: false');
    expect(text).toMatch(/^ {4}timeout-minutes: 300$/m);
  });

  it('pins Claude Code and Foreman, and fetches Foreman from its repository at the tag', () => {
    const text = actionsWorkflow({ config: cfg(), versions: PINS });
    expect(text).toContain("CLAUDE_CODE_VERSION: '2.1.292'");
    expect(text).toContain("FOREMAN_VERSION: 'v0.5.0'");
    expect(text).toContain('npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
    expect(text).toContain(`gh repo clone ${FOREMAN_SOURCE} "$RUNNER_TEMP/foreman" -- --depth 1 --branch "$FOREMAN_VERSION"`);
    expect(text).not.toMatch(/@latest|claude-code(?!@\$)/);
  });

  it('uses the defaults when no versions are given', () => {
    const text = actionsWorkflow({ config: cfg() });
    expect(text).toContain(`CLAUDE_CODE_VERSION: '${CLAUDE_CODE_VERSION}'`);
    expect(text).toContain(`FOREMAN_VERSION: 'v${foremanVersion()}'`);
  });

  it('checks out with the Foreman token, keeps no credentials in the checkout, and fetches the whole history', () => {
    const checkout = block(actionsWorkflow({ config: cfg(), versions: PINS }), 'name: Check out the project');
    expect(checkout).toContain('uses: actions/checkout@v5');
    expect(checkout).toContain('token: ${{ secrets.FOREMAN_GH_TOKEN }}');
    expect(checkout).toContain('persist-credentials: false');
    expect(checkout).toContain('fetch-depth: 0');
  });

  it('passes the sign-ins, the GitHub token and the named project keys as secrets, and nothing else', () => {
    const text = actionsWorkflow({ config: cfg({ envVars: ['RESEND_API_KEY', 'SUPABASE_URL'] }), versions: PINS });
    const tick = block(text, 'name: Build one story');
    const secrets = [...tick.matchAll(/^\s+([A-Z_0-9]+): \$\{\{ secrets\.([A-Z_0-9]+) \}\}$/gm)].map((m) => `${m[1]}=${m[2]}`);
    expect(secrets).toEqual(['GH_TOKEN=FOREMAN_GH_TOKEN', 'ANTHROPIC_API_KEY=ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN=CLAUDE_CODE_OAUTH_TOKEN', 'RESEND_API_KEY=RESEND_API_KEY', 'SUPABASE_URL=SUPABASE_URL']);
  });

  it('never puts the dispatch input into the shell command itself', () => {
    const text = actionsWorkflow({ config: cfg(), versions: PINS });
    for (const line of text.split('\n').filter((l) => /\brun:/.test(l))) expect(line).not.toContain('${{');
    expect(text).toContain('STORY: ${{ inputs.story }}');
  });

  it('runs the tick, then saves the state even when the tick was cancelled', () => {
    const text = actionsWorkflow({ config: cfg(), versions: PINS });
    expect(block(text, 'name: Fetch Foreman')).toContain('echo "$RUNNER_TEMP/foreman/plugin/bin" >> "$GITHUB_PATH"');
    expect(text).toContain('run: foreman cloud tick ${STORY:+--story "$STORY"}');
    const save = block(text, 'name: Save the state');
    expect(save).toContain("if: ${{ always() && steps.tick.outcome != 'skipped' }}");
    expect(save).toContain('cloud sync');
    expect(text.indexOf('name: Build one story')).toBeLessThan(text.indexOf('name: Save the state'));
  });

  it('reads no more than it needs from the built-in token', () => {
    expect(block(actionsWorkflow({ config: cfg(), versions: PINS }), 'permissions:')).toBe('permissions:\n  contents: read');
  });

  it('versions.mjs reads the plugin version', () => {
    const plugin = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    expect(foremanVersion()).toBe(plugin.version);
  });
});

describe('workflowSecrets', () => {
  it("names exactly the secrets the YAML's header line and its secrets. references name", () => {
    for (const envVars of [[], ['RESEND_API_KEY'], ['RESEND_API_KEY', 'SUPABASE_URL', 'RESEND_API_KEY', 'GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']]) {
      const config = cfg({ envVars });
      const names = workflowSecrets(config);
      expect(names.token).toBe('FOREMAN_GH_TOKEN');
      expect(names.signIn).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
      const text = actionsWorkflow({ config, versions: PINS });
      const header = text.split('\n').find((l) => l.startsWith('# Secrets: '));
      const inHeader = header.match(/[A-Z][A-Z0-9_]+/g);
      expect(inHeader).toEqual([names.token, ...names.signIn, ...names.keys]);
      const referenced = [...new Set([...text.matchAll(/secrets\.([A-Z_0-9]+)/g)].map((m) => m[1]))];
      expect(referenced.sort()).toEqual([names.token, ...names.signIn, ...names.keys].sort());
    }
    expect(workflowSecrets(cfg({ envVars: ['RESEND_API_KEY', 'GH_TOKEN', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY'] })).keys).toEqual(['RESEND_API_KEY']);
  });
});
