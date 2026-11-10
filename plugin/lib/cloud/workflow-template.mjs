// The GitHub Actions workflow `foreman cloud actions init` writes to
// .github/workflows/foreman.yml. Each job builds at most one story end to end with
// `foreman cloud tick`, which syncs the state branch around the run.
//
//   actionsWorkflow({ config, versions? }) -> the YAML text
//   workflowSecrets(config) -> { token, signIn, keys }
//                                       the repository secrets it reads: FOREMAN_GH_TOKEN, the two
//                                       Claude sign-ins (either will do), and cloud.envVars without
//                                       the sign-ins and GH_TOKEN, de-duplicated
//
// config.cloud.actions.cron is the schedule; config.cloud.envVars are the project's keys,
// passed from repository secrets of the same names. The validated config only allows
// variable names and plain cron fields, so nothing here needs YAML escaping. The dispatch
// input reaches the shell through an environment variable, never inside the command.

import { CLAUDE_CODE_VERSION, FOREMAN_SOURCE, foremanVersion } from './versions.mjs';

const SIGN_IN = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const TOKEN = 'FOREMAN_GH_TOKEN';

export function workflowSecrets(config) {
  const keys = [...new Set((config?.cloud?.envVars ?? []).filter((n) => !SIGN_IN.includes(n) && n !== 'GH_TOKEN'))];
  return { token: TOKEN, signIn: [...SIGN_IN], keys };
}

export function actionsWorkflow({ config, versions = {} }) {
  const cron = config.cloud?.actions?.cron ?? '*/30 * * * *';
  const foreman = versions.foreman ?? foremanVersion();
  const claudeCode = versions.claudeCode ?? CLAUDE_CODE_VERSION;
  const { keys } = workflowSecrets(config);
  const secret = (name, from = name) => `          ${name}: \${{ secrets.${from} }}`;

  return `# Foreman: builds the next story, one per job (\`foreman cloud tick\`).
# Written by \`foreman cloud actions init\`; run it again with --force to rewrite this file.
# Secrets: FOREMAN_GH_TOKEN, and ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN${keys.length ? `, plus ${keys.join(', ')}` : ''}.
name: Foreman

on:
  schedule:
    - cron: '${cron}'
  workflow_dispatch:
    inputs:
      story:
        description: 'A story to build next (optional)'
        required: false
        type: string

concurrency:
  group: foreman
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 300
    env:
      FOREMAN_VERSION: 'v${foreman}'
      CLAUDE_CODE_VERSION: '${claudeCode}'
    steps:
      - name: Check out the project
        uses: actions/checkout@v5
        with:
          token: \${{ secrets.FOREMAN_GH_TOKEN }}
          persist-credentials: false
          fetch-depth: 0

      - name: Set up Node
        uses: actions/setup-node@v5
        with:
          node-version: 22
          package-manager-cache: false

      - name: Install Claude Code
        run: npm install --global "@anthropic-ai/claude-code@\${CLAUDE_CODE_VERSION}"

      - name: Fetch Foreman
        env:
${secret('GH_TOKEN', 'FOREMAN_GH_TOKEN')}
        run: |
          gh repo clone ${FOREMAN_SOURCE} "$RUNNER_TEMP/foreman" -- --depth 1 --branch "$FOREMAN_VERSION"
          echo "$RUNNER_TEMP/foreman/plugin/bin" >> "$GITHUB_PATH"

      - name: Build one story
        id: tick
        env:
          FOREMAN_PLUGIN_DIR: \${{ runner.temp }}/foreman/plugin
${[secret('GH_TOKEN', 'FOREMAN_GH_TOKEN'), ...SIGN_IN.map((n) => secret(n)), ...keys.map((n) => secret(n))].join('\n')}
          STORY: \${{ inputs.story }}
        run: foreman cloud tick \${STORY:+--story "$STORY"}

      - name: Save the state
        if: \${{ always() && steps.tick.outcome != 'skipped' }}
        env:
${secret('GH_TOKEN', 'FOREMAN_GH_TOKEN')}
        run: foreman cloud sync
`;
}
