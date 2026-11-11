// The set-up model: every step of making Foreman ready on a project, as data. `foreman setup`
// and `foreman doctor` read it, so the wording that helps the owner lives here and nowhere
// else. Each step is
//
//   { id, area, title, why, hint,
//     applies(config) -> bool,       whether the step is part of this project's set-up
//     optional?(config) -> bool,     whether the project can go without it
//     checks: [names],               the doctor checks that always run when the step applies;
//                                    a check that runs only sometimes (a pack's, a configured
//                                    command's, one per org) is tied to its step by its own
//                                    `step` (lib/engine/doctor-checks.mjs)
//     inputs: [...] | (config) => [...],
//                                    each { kind: 'key' | 'config' | 'choice', name,
//                                    configPath?, required?: bool | (config) => bool (default
//                                    true), options?, validate?: (value) => null | reason }
//     actions: [{ id, label }],      'check' (Test it) on every step
//     guide: [{ id?, text, click?, check? }], what the owner does, in order; `click` is the
//                                    path of screens and buttons, such as ['Setup', 'Apps']. `id`,
//                                    unique in its step, lets an error point at one entry
//                                    (sf-orgs: lib/setup/salesforce.mjs ERRORS) or a screen show
//                                    some entries only (cloud-runner: CLOUD_SCREEN.guides).
//                                    `check` is the name, or the name prefix, of the doctor check
//                                    that verifies a follow-up done only in Salesforce's Setup
//     more,                          the step's page or section of the user guide on
//                                    finefactory.ai: DOCS_URL + '#<guide id>' (the site forwards
//                                    old guide ids) or DOCS_URL + '<page>/', or null
//     form?,                         plain data the page draws the step's own form from; only
//                                    the project step has one (lib/setup/project.mjs)
//     signin?,                       plain data for the Claude sign-in screen, on the
//                                    claude-signin step only (lib/setup/claude.mjs SIGNIN)
//     jira?,                         plain data for a Jira screen, one part of
//                                    lib/setup/jira-screen.mjs JIRA_SCREEN: app on jira-app,
//                                    signin on jira-signin, filter on jira-site
//     notify?,                       plain data for the notifications screen, on the
//                                    notifications step only (lib/setup/notify-screen.mjs
//                                    NOTIFY_SCREEN)
//     salesforce?,                   plain data for the Salesforce org sign-in screen, on the
//                                    sf-orgs step only (lib/setup/salesforce-screen.mjs SF_SCREEN)
//     gearset?,                      plain data for the Gearset screen, on the sf-gearset step
//                                    only (lib/setup/gearset-screen.mjs GEARSET_SCREEN)
//     cloud? }                       plain data for the Cloud runner screen, on the cloud-runner
//                                    step only (lib/setup/cloud-screen.mjs CLOUD_SCREEN)
//
// `hint` is the step's own short fix wording, for a result that names none. The order of
// STEPS is the order `foreman setup next` walks them, and the Set up tab's wizard too: the Jira
// steps go app keys, sign-in, then site and filter. No step holds a key's value: inputs name
// keys, and lib/setup/status.mjs says only whether each is set.
//
// AREAS are the groups the dashboard's checklist shows, in order, each { id, title }; every
// step's area is one of them. offAreas(config, { sfdx }) lists the parts of an area that are off
// for this project (SWITCHES: Jira, the Salesforce pack, Gearset), each { id, area, title, line,
// turnOn: { label, step, choice? } }: the line says why it is off (OFF_WORDS), and turnOn opens
// the step that turns it on, with the form choice to make there, if any. A part that cannot be
// turned on here (the pack without sfdx-project.json, Gearset without the pack) is not listed. The
// dashboard opens a step's `more` in a new tab, and `foreman setup next` prints it.

import { requirements } from '../engine/doctor-checks.mjs';
import { SCOPES } from '../jira/auth.mjs';
import { SIGNIN } from './claude.mjs';
import { JIRA_SCREEN } from './jira-screen.mjs';
import { NOTIFY_SCREEN } from './notify-screen.mjs';
import { SF_SCREEN } from './salesforce-screen.mjs';
import { GEARSET_SCREEN } from './gearset-screen.mjs';
import { CLOUD_SCREEN } from './cloud-screen.mjs';
import { checkShape, stepForKey } from './keys.mjs';
import { PROJECT_FORM } from './project.mjs';

// What the dashboard and `foreman dashboard` say when the project has no config yet.
export const SETUP_FIRST = 'Finish set-up first: this project has no working foreman.config.json yet. Open Set up on this page to make one.';
export const RUN_SETUP = 'This project has no foreman.config.json yet. Run `foreman setup` to set Foreman up here, step by step.';

// The user guide lives on the website, not in the plugin; each step's `more` is an address in it.
export const DOCS_URL = 'https://finefactory.ai/apps/foreman/docs/';

const CHECK = Object.freeze({ id: 'check', label: 'Test it' });
const CALLBACK = 'http://localhost:8765/callback';
const SF_HOME_ENV = 'HOME="${FOREMAN_SF_HOME:-$HOME/.config/foreman/sf-home}" SF_USE_GENERIC_UNIX_KEYCHAIN=true';
const SF_LOGIN = `${SF_HOME_ENV} sf org login jwt --alias <alias> --username <user> --jwt-key-file <key file> --client-id <consumer key> --instance-url https://test.salesforce.com`;
const SF_DEV_HUB_LOGIN = `${SF_HOME_ENV} sf org login web --alias <dev hub alias> --instance-url https://login.salesforce.com`;
const SF_DEV_HUB_LOGOUT = `${SF_HOME_ENV} sf org logout --target-org <dev hub alias> --no-prompt`;

const isText = (v) => typeof v === 'string' && v.length > 0;
const code = (list) => list.map((s) => `\`${s}\``);
const and = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list.join(''));

// Validators: null when the value is fine, else the reason in plain words. Each caps the length
// before any regex runs.
const MAX_VALUE = 4096;
const MAX_EMAIL = 320;
const filled = (v) => {
  if (!isText(v) || v.trim().length === 0) return 'is empty';
  return v.length > MAX_VALUE ? `is too long: ${MAX_VALUE} characters at most` : null;
};
const oneWord = (v) => filled(v) ?? (/\s/.test(v) ? 'has spaces in it; paste the value only' : null);
const startsWith = (prefix, what) => (v) => oneWord(v) ?? (v.startsWith(prefix) ? null : `does not look like ${what}: it starts with ${prefix}`);
const email = (v) =>
  filled(v) ?? (v.length > MAX_EMAIL ? `is too long for an email address: ${MAX_EMAIL} characters at most` : /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v) ? null : 'is not an email address');
const host = (v) => filled(v) ?? (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v) ? null : 'is not a host name; give only the host, such as acme.atlassian.net, with no https://');
const oneOf = (options) => (v) => (options.includes(v) ? null : `must be one of ${options.join(', ')}`);

const NOTIFIERS = ['none', 'email-resend'];
const isJira = (config) => config?.stories?.adapter === 'jira';
const isSalesforce = (config) => config?.pack === 'salesforce';
const notifier = (config) => config?.notify?.adapter;
const resend = (config) => notifier(config) === 'email-resend';

// The keys the project's adapters and pack ask for that no other step explains.
function projectKeys(config) {
  if (!config) return [];
  return requirements(config).env.filter((name) => stepForKey(name) === 'project-keys');
}

const always = () => true;

export const AREAS = Object.freeze([
  { id: 'project', title: 'The project' },
  { id: 'claude', title: 'Claude' },
  { id: 'github', title: 'GitHub' },
  { id: 'stories', title: 'Where stories come from' },
  { id: 'notify', title: 'Notifications' },
  { id: 'salesforce', title: 'Salesforce' },
  { id: 'cloud', title: 'Running in the cloud' },
].map((area) => Object.freeze(area)));

export const STEPS = Object.freeze([
  {
    id: 'project',
    area: 'project',
    title: 'This project',
    why: 'Foreman reads foreman.config.json to know your project: its name, the checks that must pass and how a story ships.',
    hint: 'fix what the doctor names in foreman.config.json',
    applies: always,
    checks: ['config', 'local settings'],
    inputs: [{ kind: 'config', name: 'project.name', configPath: 'project.name', validate: filled }],
    actions: [CHECK],
    guide: [
      { text: 'Run `/foreman:init` in Claude Code to write foreman.config.json, or fix what the doctor names in it.' },
      { text: 'Change a setting on this machine only with `foreman settings set <name> <value>`.' },
    ],
    more: DOCS_URL + 'set-up-tab/',
    form: PROJECT_FORM,
  },
  {
    id: 'claude-code',
    area: 'claude',
    title: 'Claude Code',
    why: 'Foreman runs its agents in Claude Code, through the foreman plugin.',
    hint: 'install Claude Code and the foreman plugin',
    applies: always,
    checks: ['claude on PATH', 'plugin installed and enabled', 'plugin fresh', 'foreman command', 'workflows'],
    inputs: [],
    actions: [CHECK],
    guide: [
      { text: 'Install Claude Code, then open a new terminal so `claude` is on the PATH.' },
      { text: 'In Claude Code, add the Foreman marketplace and install the plugin with `/plugin install foreman@foreman`, as the user guide shows.' },
      { text: 'Workflows need a paid Claude plan or the API. On Pro, turn them on in `/config`.' },
    ],
    more: DOCS_URL + '#install',
  },
  {
    id: 'claude-signin',
    area: 'claude',
    title: 'Claude sign-in',
    why: 'The agents need a Claude sign-in. A Console API key is billed per token; a subscription is for your own projects only.',
    hint: 'set ANTHROPIC_API_KEY or run `claude auth login`',
    applies: always,
    checks: ['claude sign-in'],
    inputs: [
      { kind: 'key', name: 'ANTHROPIC_API_KEY', required: false, validate: startsWith('sk-ant-', 'a Console API key') },
      { kind: 'key', name: 'CLAUDE_CODE_OAUTH_TOKEN', required: false, validate: (v) => checkShape('CLAUDE_CODE_OAUTH_TOKEN', v) },
    ],
    actions: [CHECK],
    guide: [
      { text: 'Make a Console API key and add it as ANTHROPIC_API_KEY. Selling Foreman, or running it for others, needs one.', click: ['console.anthropic.com', 'API Keys', 'Create Key'] },
      { text: 'Or, for your own projects, run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN to the token it prints, or sign in with `claude auth login`.' },
    ],
    more: DOCS_URL + '#install',
    signin: SIGNIN,
  },
  {
    id: 'github',
    area: 'github',
    title: 'GitHub',
    why: 'Foreman pushes each story to a branch, opens a pull request and merges it through the GitHub CLI.',
    hint: 'sign in with `gh auth login`',
    applies: always,
    checks: ['git remote', 'gh signed in', 'branch protection'],
    inputs: [],
    actions: [CHECK],
    guide: [
      { text: 'Push the project to GitHub, so git has the remote Foreman pushes to (`origin` unless the config says otherwise).' },
      { text: 'Run `gh auth login` and sign in to the account that can push to this repository.' },
      { text: 'Turn on branch protection for the base branch, so only checked pull requests reach it.', click: ['GitHub', 'Settings', 'Branches', 'Add branch protection rule'] },
    ],
    more: DOCS_URL + '#release-safety',
  },
  {
    id: 'tools',
    area: 'project',
    title: 'Tools and checks',
    why: "The project's own checks, and the tools its adapters need, must work on this machine.",
    hint: 'install the tools the doctor names',
    applies: always,
    checks: ['tools'],
    inputs: [],
    actions: [CHECK],
    guide: [
      { text: 'Install each tool the doctor names, then open a new terminal.' },
      { text: 'Make each check in foreman.config.json that runs always pass on this machine.' },
    ],
    more: DOCS_URL + 'set-up-tab/',
  },
  {
    id: 'project-keys',
    area: 'project',
    title: 'Project keys',
    why: "Some of the project's adapters need keys of their own. Foreman reads them from the env file or the environment, by name only.",
    hint: 'add the keys the doctor names to the env file',
    applies: always,
    optional: (config) => projectKeys(config).length === 0,
    checks: ['env variables', 'foreman keys file', 'foreman keys placement'],
    inputs: (config) => [
      ...projectKeys(config).map((name) => ({ kind: 'key', name, validate: oneWord })),
      { kind: 'key', name: 'FOREMAN_DASHBOARD_TOKEN', required: false, validate: (v) => checkShape('FOREMAN_DASHBOARD_TOKEN', v) },
    ],
    actions: [CHECK],
    guide: [
      { text: 'Add each key the doctor names to the env file (envFile in foreman.config.json, .env.local by default). Keep that file out of git.' },
    ],
    more: DOCS_URL + 'set-up-tab/',
  },
  {
    id: 'jira-app',
    area: 'stories',
    title: 'Jira app',
    why: 'Foreman signs in to Jira Cloud through an OAuth app of your own, made once per project.',
    hint: 'add JIRA_CLIENT_ID and JIRA_CLIENT_SECRET to .env.foreman',
    applies: isJira,
    checks: ['jira app keys'],
    inputs: [
      { kind: 'key', name: 'JIRA_CLIENT_ID', validate: oneWord },
      { kind: 'key', name: 'JIRA_CLIENT_SECRET', validate: oneWord },
    ],
    actions: [CHECK],
    guide: [
      { text: 'At developer.atlassian.com, under My apps, create an OAuth 2.0 integration.', click: ['developer.atlassian.com', 'My apps', 'Create', 'OAuth 2.0 integration'] },
      { text: `Under Permissions, add the Jira API with the scopes ${and(code(SCOPES))}. offline_access gives Foreman a refresh token.`, click: ['Permissions', 'Jira API', 'Add', 'Configure'] },
      { text: `Under Authorization, set the callback URL to \`${CALLBACK}\`.`, click: ['Authorization', 'OAuth 2.0 (3LO)', 'Configure'] },
      { text: "Under Settings, copy the client ID and the secret into JIRA_CLIENT_ID and JIRA_CLIENT_SECRET in .env.foreman, Foreman's own keys file at the project's root. It stays out of git and out of the story workspaces.", click: ['Settings'] },
    ],
    more: DOCS_URL + '#signing-in-to-jira',
    jira: JIRA_SCREEN.app,
  },
  {
    id: 'jira-signin',
    area: 'stories',
    title: 'Jira sign-in',
    why: 'Foreman reads and moves your Jira issues as you, through a sign-in kept on this machine.',
    hint: 'sign in with `foreman jira login`',
    applies: isJira,
    checks: ['jira signed in', 'jira sign-in age'],
    inputs: [],
    actions: [CHECK, { id: 'jira-login', label: 'Sign in to Jira' }],
    guide: [
      { text: 'Run `foreman jira login`. It opens the consent page in your browser; on a machine with no browser, add `--paste`.' },
      { text: 'Approve access to your Jira site. Run it again when the doctor says the sign-in is old.' },
    ],
    more: DOCS_URL + '#signing-in-to-jira',
    jira: JIRA_SCREEN.signin,
  },
  {
    id: 'jira-site',
    area: 'stories',
    title: 'Jira site and filter',
    why: 'Foreman picks its stories from your Jira site, with a JQL filter.',
    hint: 'fix stories.site and stories.jql in foreman.config.json',
    applies: isJira,
    // 'jira options' runs only when the stories block is wrong, and 'jira transitions' only
    // with transition names; both are tied to this step by their own step.
    checks: ['jira JQL'],
    inputs: [
      { kind: 'config', name: 'stories.site', configPath: 'stories.site', validate: host },
      { kind: 'config', name: 'stories.jql', configPath: 'stories.jql', validate: filled },
    ],
    actions: [CHECK],
    guide: [
      { text: "Set stories.site to your Jira site's host, such as acme.atlassian.net." },
      { text: "Set stories.jql to the filter that finds Foreman's stories, such as `project = ACME AND labels = foreman ORDER BY Rank`." },
    ],
    more: DOCS_URL + '#stories-from-jira',
    jira: JIRA_SCREEN.filter,
  },
  {
    id: 'notifications',
    area: 'notify',
    title: 'Notifications',
    why: 'Foreman can email you when a story ships, fails or needs an answer.',
    hint: 'add the Resend keys, or set notify.adapter to none',
    applies: always,
    optional: (config) => !notifier(config) || notifier(config) === 'none',
    checks: [],
    inputs: [
      { kind: 'choice', name: 'notify.adapter', configPath: 'notify.adapter', options: NOTIFIERS, validate: oneOf(NOTIFIERS) },
      { kind: 'key', name: 'RESEND_API_KEY', required: resend, validate: startsWith('re_', 'a Resend API key') },
      { kind: 'key', name: 'RESEND_FROM_EMAIL', required: (config) => resend(config) && !config?.notify?.from, validate: email },
      { kind: 'key', name: 'FOREMAN_NOTIFY_EMAIL', required: false, validate: email },
    ],
    actions: [CHECK],
    guide: [
      { text: 'Make a Resend API key and add it as RESEND_API_KEY in .env.foreman.', click: ['resend.com', 'API Keys', 'Create API key'] },
      { text: 'Verify a sending domain at Resend, then set RESEND_FROM_EMAIL (or notify.from) to an address on it.', click: ['resend.com', 'Domains', 'Add domain'] },
      { text: 'Or set notify.adapter to none to go without email.' },
    ],
    more: DOCS_URL + '#set-up',
    notify: NOTIFY_SCREEN,
  },
  {
    id: 'sf-tools',
    area: 'salesforce',
    title: 'Salesforce CLI',
    why: 'The Salesforce pack deploys and tests through the Salesforce CLI and a few of its plugins.',
    hint: 'install or update the Salesforce CLI and its plugins',
    applies: isSalesforce,
    checks: ['salesforce tools', 'salesforce plugin', 'salesforce telemetry'],
    inputs: [],
    actions: [CHECK],
    guide: [
      { text: 'Install the Salesforce CLI (`sf`), then the plugins the doctor names, such as sfdx-git-delta and the code analyzer.' },
      { text: 'Turn the CLI telemetry off: set SF_DISABLE_TELEMETRY=true in the env file.' },
    ],
    more: DOCS_URL + 'salesforce-set-up/',
  },
  {
    id: 'sf-layout',
    area: 'salesforce',
    title: 'Salesforce environments',
    why: 'Foreman needs to know your sandboxes: which ones build stories, which ones take releases, and the production branch it must never merge into.',
    hint: 'fix the salesforce block in foreman.config.json',
    applies: isSalesforce,
    checks: ['salesforce layout', 'salesforce test level', 'salesforce production branch', 'salesforce workflows', 'salesforce ci', 'salesforce CONFIRM_PROD'],
    inputs: [
      { kind: 'config', name: 'salesforce.orgs', configPath: 'salesforce.orgs' },
      { kind: 'config', name: 'salesforce.stages', configPath: 'salesforce.stages' },
    ],
    actions: [CHECK],
    guide: [
      { text: 'List each sandbox under salesforce.orgs by its alias and org ID, then name the build sandboxes and the release stages.' },
      { text: 'Set salesforce.productionBranch to the branch that deploys to production. Foreman never merges into it.' },
      {
        id: 'release',
        text: 'To release through Gearset, set salesforce.release to "gearset", give the last stage a sandbox and a branch of its own, and set salesforce.productionBranch. The Gearset step then appears.',
      },
    ],
    more: DOCS_URL + 'salesforce-set-up/',
  },
  {
    id: 'sf-orgs',
    area: 'salesforce',
    title: 'Salesforce org sign-in',
    why: "Story sessions see only the sandboxes signed in to Foreman's own sf home, never your other orgs.",
    hint: "sign each org in to Foreman's sf home",
    applies: isSalesforce,
    checks: ['salesforce sf isolation'],
    inputs: [],
    actions: [CHECK, { id: 'sf-key', label: 'Make the key' }, { id: 'sf-connect', label: 'Connect an org' }],
    guide: [
      { id: 'certificate', text: "Make Foreman's key with Make the key on this page, or upload a key and certificate you already have, then download the certificate. The key stays on this computer." },
      { id: 'app', text: "In the sandbox's Setup, make a new External Client App named Foreman, with your email as its contact and Distribution State Local.", click: ['Setup', 'Apps', 'External Client Apps', 'External Client App Manager', 'New External Client App'] },
      {
        id: 'oauth',
        text: 'Turn on OAuth. Set the callback URL to `http://localhost:1717/OauthRedirect`: Salesforce needs one, Foreman does not use it. Add the scopes Manage user data via APIs (api) and Perform requests at any time (refresh_token, offline_access). Under Flow Enablement, tick Enable JWT Bearer Flow and upload the certificate you downloaded, then press Create.',
        click: ['New External Client App', 'API (Enable OAuth Settings)', 'Enable OAuth'],
      },
      {
        id: 'policies',
        text: 'Press Edit and open the Policies tab. Under OAuth Policies, in Plugin Policies, set Permitted Users to "Admin approved users are pre-authorized" and press OK. Under App Policies, add the profile or permission set of the user Foreman signs in as, then Save.',
        click: ['External Client App Manager', 'Foreman', 'Edit', 'Policies', 'OAuth Policies'],
      },
      {
        id: 'consumer-key',
        text: "Open the app's Settings tab, then OAuth Settings, and press Consumer Key and Secret. Salesforce emails you a code to confirm it is you. Copy the Consumer Key only: Foreman does not need the secret.",
        click: ['External Client App Manager', 'Foreman', 'Settings', 'OAuth Settings', 'Consumer Key and Secret'],
      },
      { id: 'connect', text: `Connect each org in salesforce.orgs with Connect an org: its alias from the config, the username, the consumer key and the login URL (https://test.salesforce.com for a sandbox). Or sign it in to Foreman's own sf home yourself: \`${SF_LOGIN}\`` },
      { id: 'dev-hub', text: `Scratch mode only (salesforce.build.scratch): sign the Dev Hub in with the Salesforce CLI's own app, not with Connect an org or \`sf org login jwt\`. sf cannot make a scratch org through a Dev Hub signed in by JWT. Run \`${SF_DEV_HUB_LOGIN}\` and sign in in the browser it opens. If the Dev Hub is signed in by JWT already, sign it out first with \`${SF_DEV_HUB_LOGOUT}\`.` },
      {
        id: 'source-tracking',
        text: 'Once, in the production org, which you open yourself (Foreman never connects to it): turn on source tracking for Developer and Developer Pro sandboxes, then refresh each build sandbox. Or turn it on in one sandbox alone, with no refresh, in that sandbox\'s Sandbox Settings.',
        click: ['Setup', 'Dev Hub', 'Enable Source Tracking in Developer and Developer Pro Sandboxes'],
        check: 'salesforce source tracking',
      },
      { id: 'sf-home', text: 'FOREMAN_SF_HOME must be an absolute path if you set it: `~` is not expanded there.' },
    ],
    more: null,
    salesforce: SF_SCREEN,
  },
  {
    id: 'sf-skills',
    area: 'salesforce',
    title: 'Salesforce skills',
    why: "The pack's agents use the pinned Salesforce skills, installed in the project.",
    hint: 'run `foreman sf skills`',
    applies: isSalesforce,
    checks: ['salesforce skills lock', 'salesforce skills named'],
    inputs: [],
    actions: [CHECK, { id: 'sf-skills', label: 'Install the skills' }],
    guide: [
      { text: 'Run `foreman sf skills` to install the pinned Salesforce skills.' },
      { text: 'Commit skills-lock.json, .agents/skills and .claude/skills.' },
    ],
    more: DOCS_URL + 'salesforce-set-up/',
  },
  {
    id: 'sf-gearset',
    area: 'salesforce',
    title: 'Gearset',
    why: 'With release gearset, Gearset promotes each story through your stages, and Foreman follows it through the Gearset API.',
    hint: 'add GEARSET_API_TOKEN to .env.foreman',
    applies: (config) => isSalesforce(config) && config?.salesforce?.release === 'gearset',
    checks: ['salesforce gearset token', 'salesforce gearset branch', 'salesforce gearset merge method', 'salesforce gearset environments', 'salesforce gearset ci job'],
    inputs: [
      { kind: 'key', name: 'GEARSET_API_TOKEN', validate: oneWord },
      { kind: 'config', name: 'salesforce.gearset.pipelineId', configPath: 'salesforce.gearset.pipelineId', required: false },
    ],
    actions: [CHECK],
    guide: [
      { text: 'In Gearset, create an API access token and add it as GEARSET_API_TOKEN in .env.foreman.', click: ['Gearset', 'My account', 'Team security', 'Access token management'] },
      { text: 'Pick the pipeline that promotes this repo, and save it. Without one, Foreman looks through every pipeline the token sees.' },
      { text: 'Make each stage org the target of a Gearset environment that is not production.' },
      { text: "Turn on the CI job of each stage's environment: Gearset deploys every promotion through it.", click: ['Gearset', 'Pipelines', '<pipeline>', '<environment>', 'Edit CI job'] },
      { text: "Set a test level such as RunLocalTests on each CI job, then confirm it here: the Gearset API cannot show a CI job's test level." },
    ],
    more: null,
    gearset: GEARSET_SCREEN,
  },
  {
    id: 'cloud-runner',
    area: 'cloud',
    title: 'Cloud runner',
    why: 'Foreman can build with your laptop off: in GitHub Actions, one story per scheduled job, or in a container that runs all the time.',
    hint: 'set the runner up on this screen',
    applies: always,
    optional: always,
    // Its doctor checks run only when the workflow or .env.runner is there (lib/engine/doctor-cloud.mjs).
    checks: [],
    inputs: [],
    actions: [CHECK, { id: 'cloud-secrets', label: 'Set the secrets' }, { id: 'cloud-runner-file', label: 'Write the runner file' }],
    guide: [
      { id: 'state-branch', text: 'Keep the run state on a branch (`"state": { "store": "branch" }`), since nothing on an Actions runner outlives its job. Commit foreman.config.json.' },
      { id: 'workflow', text: 'Write the workflow, `.github/workflows/foreman.yml`, then commit and push it. It runs every 30 minutes (`cloud.actions.cron`), and from the Actions tab.' },
      {
        id: 'token',
        text: 'Make a GitHub token for the runner: a classic token with the `repo` scope, or a fine-grained one for this repository with Contents and Pull requests read and write, and Actions and Commit statuses read. Pushes made with it start CI.',
        click: ['GitHub', 'Settings', 'Developer settings', 'Personal access tokens'],
      },
      { id: 'secrets', text: "Paste the token and press Set the secrets. Foreman checks it, then sets FOREMAN_GH_TOKEN, your Claude sign-in and each name in `cloud.envVars` as the repository's Actions secrets with `gh`, from the keys saved on the other steps." },
      { id: 'runner-file', text: 'Paste the token and press Write the runner file. Foreman writes `.env.runner` (mode 600, kept out of git) with the repository, the token, your Claude sign-in, the dashboard token and the project\'s keys.' },
      { id: 'docker-run', text: 'Copy `.env.runner` to your server and start the runner with the docker run line shown here. Open its dashboard through an SSH tunnel to port 4317.' },
    ],
    more: DOCS_URL + '#run-in-the-cloud',
    cloud: CLOUD_SCREEN,
  },
].map((step) => Object.freeze(step)));

// What the checklist says about a part that is off; {title} and {why} are filled in.
export const OFF_WORDS = Object.freeze({ turnOn: 'Turn on', line: '{title}: off, because {why}.' });

const release = (config) => config?.salesforce?.release;

export const SWITCHES = Object.freeze([
  {
    id: 'jira',
    area: 'stories',
    title: 'Jira',
    on: isJira,
    available: always,
    why: (config) => (config?.stories?.adapter === 'markdown' ? 'stories come from markdown files' : 'stories come from another source'),
    turnOn: { step: 'project', choice: { field: 'source', value: 'jira' } },
  },
  {
    id: 'salesforce',
    area: 'salesforce',
    title: 'Salesforce',
    on: isSalesforce,
    available: (config, ctx) => ctx?.sfdx === true,
    why: () => 'the Salesforce pack is not on for this project',
    turnOn: { step: 'project', choice: { field: 'pack', value: 'salesforce' } },
  },
  {
    id: 'gearset',
    area: 'salesforce',
    title: 'Gearset',
    on: (config) => release(config) === 'gearset',
    available: isSalesforce,
    why: (config) => `releases go through ${release(config) === 'ci' ? 'your CI' : 'the Salesforce CLI'}`,
    turnOn: { step: 'sf-layout' },
  },
].map((s) => Object.freeze({ ...s, turnOn: Object.freeze({ ...s.turnOn, ...(s.turnOn.choice ? { choice: Object.freeze({ ...s.turnOn.choice }) } : {}) }) })));

export function offAreas(config, { sfdx } = {}) {
  if (!config) return [];
  return SWITCHES.filter((s) => s.available(config, { sfdx }) && !s.on(config)).map((s) => ({
    id: s.id,
    area: s.area,
    title: s.title,
    line: OFF_WORDS.line.replace('{title}', s.title).replace('{why}', s.why(config)),
    turnOn: { label: OFF_WORDS.turnOn, step: s.turnOn.step, ...(s.turnOn.choice ? { choice: { ...s.turnOn.choice } } : {}) },
  }));
}

const BY_ID = new Map(STEPS.map((step) => [step.id, step]));

export const stepById = (id) => BY_ID.get(id);

// A resolved step (lib/setup/status.mjs resolveStep) without its functions, safe to print as JSON.
export function serializeStep(resolved) {
  const plain = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v !== 'function'));
  return {
    ...plain(resolved),
    inputs: (Array.isArray(resolved.inputs) ? resolved.inputs : []).map(plain),
  };
}
