// The values foreman.config.json gets when the file says nothing. `withDefaults` resolves a
// validated file in three layers, each merged over the one before:
//
//   1. Foreman's defaults (DEFAULTS below)
//   2. the defaults of the pack the file names with `pack`, if any (plugin/packs/index.mjs)
//   3. the project's file
//
// Plain objects merge key by key, the later layer's value wins, and arrays replace rather than
// join. A few blocks replace as a whole at every layer, because inheriting half of a default
// would be wrong: a project that names its own builders must not also get `developer`, an
// adapter's options belong to that adapter alone, and a project's `ship` replaces the pack's
// as it replaces Foreman's. The pack's own block is not one of them: the project's values win
// key by key over the pack's defaults for it. A file without `pack` gets layers 1 and 3 only.
// `session` has no Foreman default; a pack may set session.extraTools or session.mcpServers,
// and a project's list replaces the pack's. Code reads a missing session.mcpServers as none
// and a missing session.userSettings as false (engine/session-scope.mjs, session.mjs). A pack's
// defaults() that throws passes through here; loadConfig turns it into a config error.
//
// A pack's defaults(block, project) also gets a read-only view of the project folder when
// withDefaults is given `project: { root, fs }`: { root, fs, file }, where file is a copy of the
// project's raw config. Without one, project is undefined and the pack gives its folder-free
// defaults.

import { PACKS } from '../../packs/index.mjs';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULTS = deepFreeze({
  version: 1,
  baseBranch: 'main',
  remote: 'origin',
  branchPrefix: 'story/',
  stateDir: '.foreman',
  envFile: '.env.local',
  // Foreman's own keys (lib/engine/foreman-keys.mjs); never linked into a slot, unlike envFile.
  foremanEnvFile: '.env.foreman',
  slots: 1,
  workers: 1,
  rounds: 3,
  install: { run: 'npm ci', when: 'package-lock.json' },
  checks: [],
  generated: [],
  // Files a story never claims (lib/engine/file-locks.mjs), as globs; every `generated` path is
  // left out too. A project's list replaces this one, as arrays do.
  fileLocks: { ignore: ['CHANGELOG.md'] },
  roles: {
    architect: { agent: 'foreman:architect' },
    builders: { developer: { agent: 'foreman:builder', use: 'everything' } },
    tester: { agent: 'foreman:tester' },
    reviewers: [
      { name: 'compliance', agent: 'foreman:compliance-reviewer' },
      { name: 'security', agent: 'foreman:security-reviewer' },
    ],
  },
  resources: {},
  stories: { adapter: 'markdown', dir: 'stories' },
  env: { adapter: 'none' },
  ship: { steps: ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'], ci: { required: [] } },
  notify: { adapter: 'none' },
  console: { adapter: 'dashboard', host: '127.0.0.1', port: 4317 },
  watchdog: { quietMinutes: 30, buildMinutes: 120 },
  // Where run state lives: plain files in stateDir, or a git branch checked out there
  // (lib/state-store/branch.mjs).
  state: { store: 'files', branch: 'foreman-state' },
  // Running in the cloud (lib/cloud/): the project's key variables written to envFile at
  // start, the wait before picking again when the backlog is empty (container), and the
  // GitHub Actions schedule (`foreman cloud actions init`).
  cloud: { envVars: [], idleMinutes: 10, actions: { cron: '*/30 * * * *' } },
  // The on/off switches; lib/settings/registry.mjs describes each.
  features: {
    learnTraits: true,
    followUps: true,
    followUpsOfFollowUps: false,
    autoCreateFollowUps: false,
    dependsOnProposals: true,
    autoApplyDependsOn: false,
    productionGuard: true,
    watchRollback: true,
    mergeableRecheck: true,
    notifications: true,
    costMetrics: true,
    keepAwake: true,
    jiraComments: true,
    jiraCommentDetail: 'summary',
    jiraTransitions: true,
    salesforceComments: true,
    salesforceStatuses: true,
  },
  // Self-learning: lib/settings/registry.mjs describes each.
  learning: { auto: true, apply: true, model: 'haiku', skillModel: 'sonnet', window: 5, maxPerRole: 8, maxSkills: 10, maxEvaluating: 2, maxPerDay: 3, maxUsdPerDay: 2, redact: [] },
  // What sessions do when the Console API key runs out of credit: switch to the subscription,
  // or pause (lib/engine/claude-fallback.mjs).
  claude: { fallback: 'subscription' },
});

// Exported so the settings editor knows which blocks a file replaces as a whole.
export const WHOLE = new Set(['roles.builders', 'resources', 'stories', 'env', 'ship', 'notify', 'console']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function merge(base, file, path) {
  if (!isPlain(base) || !isPlain(file) || WHOLE.has(path)) return clone(file);
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(file)])) {
    if (key === '__proto__') continue;
    const here = path ? `${path}.${key}` : key;
    out[key] = Object.hasOwn(file, key) ? merge(base[key], file[key], here) : clone(base[key]);
  }
  return out;
}

// The old top-level `keepAwake` (deprecated) is read as the team value of features.keepAwake,
// unless the file sets that too; the result never has the old key.
function upgrade(raw) {
  if (!isPlain(raw) || !Object.hasOwn(raw, 'keepAwake')) return raw;
  const { keepAwake, ...rest } = raw;
  if (isPlain(rest.features) && Object.hasOwn(rest.features, 'keepAwake')) return rest;
  return { ...rest, features: { ...(isPlain(rest.features) ? rest.features : {}), keepAwake } };
}

// Does not mutate `raw`, and the result shares nothing with DEFAULTS or the pack's defaults.
// A pack name not in `packs` adds no layer; validate reports it.
export function withDefaults(raw, { packs = PACKS, project } = {}) {
  const upgraded = upgrade(raw);
  const name = isPlain(upgraded) ? upgraded.pack : undefined;
  const pack = typeof name === 'string' && Object.hasOwn(packs, name) ? packs[name] : null;
  if (!pack) return merge(DEFAULTS, upgraded, '');
  const view = isPlain(project) && typeof project.root === 'string' ? { root: project.root, fs: project.fs, file: clone(upgraded) } : undefined;
  const layer = pack.defaults ? (pack.defaults(clone(upgraded[pack.name]), view) ?? {}) : {};
  return merge(merge(DEFAULTS, layer, ''), upgraded, '');
}
