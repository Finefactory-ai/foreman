// Runs before every test file: drops the variables Foreman reads from the shell, so a shell
// with FOREMAN_*, FACTORY_*, the Jira app keys or a Claude sign-in set cannot change a result. Tests that need
// one set it themselves.
// FOREMAN_DOCKER_IT and FOREMAN_BROWSER_IT are the opt-in switches for the real-Docker and
// real-browser tests, so both stay.
for (const key of Object.keys(process.env)) {
  if (key === 'FOREMAN_DOCKER_IT' || key === 'FOREMAN_BROWSER_IT') continue;
  if (/^(FOREMAN|FACTORY)_/.test(key) || /^JIRA_CLIENT_(ID|SECRET)$/.test(key)) delete process.env[key];
  if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/.test(key)) delete process.env[key];
}
