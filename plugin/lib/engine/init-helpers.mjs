// Helpers for `foreman init`: look at a project and suggest a config, and write the config plus
// the small files that go with it. Everything takes the project root and reads the disk directly.
//
// detect() first asks each pack, in name order, whether the project is its own; the first claim
// (true or a plain JSON-safe object) adds pack and its findings, and a pack that throws or gives
// any other answer is reported in found.packErrors, never passed on.
// detect() also says which story source the project looks like: found.storySourceHint is
// 'markdown' when a stories folder holds story notes, else 'unknown' (ask: markdown or Jira).
// writeInit() checks the config as loadConfig will read it, then the stories block with its
// adapter's own option check, so a Jira block ({ adapter: 'jira', site, jql, ownerLabel,
// transitions }) is refused before it is written.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig } from '../config/load.mjs';
import { checkOptions as checkJiraOptions } from '../adapters/stories/jira.mjs';
import { checkOptions as checkSalesforceOptions } from '../adapters/stories/salesforce.mjs';
import { checkOptions as checkMarkdownOptions } from '../adapters/stories/markdown.mjs';
import { PACKS, packNames } from '../../packs/index.mjs';

const STORY_OPTION_CHECKS = { markdown: checkMarkdownOptions, jira: checkJiraOptions, salesforce: checkSalesforceOptions };

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const readText = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
};
const readJson = (root, rel) => {
  try {
    return JSON.parse(readText(root, rel));
  } catch {
    return null;
  }
};

const unquote = (s) => {
  const t = s.replace(/\s+#.*$/, '').trim();
  const m = /^(["'])(.*)\1$/.exec(t);
  return m ? m[2] : t;
};

// Job names in a GitHub workflow: each job's `name:` if set, else its key. A small line reader,
// not a YAML parser: it finds the top-level `jobs:` block and its 2-space-indented keys.
export function parseWorkflowJobs(text) {
  const names = [];
  let inJobs = false;
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!inJobs) {
      if (/^jobs:\s*(#.*)?$/.test(line)) inJobs = true;
      continue;
    }
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const key = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line);
    if (key) {
      current = { key: key[1], name: null };
      names.push(current);
      continue;
    }
    const name = /^ {4}name:\s*(.+)$/.exec(line);
    if (name && current && current.name === null) current.name = unquote(name[1]);
  }
  return names.map((j) => j.name || j.key);
}

function ciJobs(root) {
  const dir = path.join(root, '.github', 'workflows');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return [];
  }
  const jobs = files.flatMap((f) => parseWorkflowJobs(fs.readFileSync(path.join(dir, f), 'utf8')));
  return [...new Set(jobs)];
}

function pyprojectName(text) {
  let inProject = false;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) inProject = section[1].trim() === 'project';
    else if (inProject) {
      const m = /^\s*name\s*=\s*(.+)$/.exec(line);
      if (m) return unquote(m[1]) || null;
    }
  }
  return null;
}

const hasStoryFiles = (dirAbs) => {
  try {
    return fs.readdirSync(dirAbs).some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
};

function findStories(root) {
  for (const rel of ['stories', 'docs/stories']) {
    const abs = path.join(root, rel);
    let files = [];
    try {
      files = fs.readdirSync(abs).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    const isStory = files.some((f) => /^---\r?\n(?:[\s\S]*?\r?\n)?id:/.test(fs.readFileSync(path.join(abs, f), 'utf8')));
    if (isStory) return rel;
  }
  return null;
}

function realGitRemote(root) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const errorOf = (name, err) => ({ pack: name, message: err?.message ?? String(err) });

const NOT_OBJECT = 'detect must return an object or null';

// What a detect() answer means: null (no claim), { findings }, or { message } for a bad answer.
function judge(result) {
  if (result === null || result === undefined || result === false) return null;
  if (result === true) return { findings: {} };
  if (typeof result === 'object' || typeof result === 'function') {
    let then;
    try {
      then = result.then;
    } catch {
      return { message: NOT_OBJECT };
    }
    if (typeof then === 'function') {
      // A promise is never awaited, so keep its rejection from going unhandled.
      try {
        then.call(result, undefined, () => {});
      } catch {}
      return { message: NOT_OBJECT };
    }
  }
  let proto;
  try {
    proto = typeof result === 'object' && !Array.isArray(result) ? Object.getPrototypeOf(result) : undefined;
  } catch {
    return { message: NOT_OBJECT };
  }
  if (proto !== Object.prototype && proto !== null) return { message: NOT_OBJECT };
  try {
    JSON.stringify(result);
  } catch (err) {
    return { message: `detect must return a JSON-safe object (${err.message})` };
  }
  return { findings: result };
}

// Asks each pack's detect(root), in name order. The first `true` or plain JSON-safe object
// claims the project; anything else except null, undefined or false is reported in errors and
// the next pack is asked:
// { claim: { name, findings, pack } | null, errors: [{ pack, message }] }.
function askPacks(root, packs) {
  const errors = [];
  for (const name of packNames(packs)) {
    const pack = packs[name];
    if (typeof pack?.detect !== 'function') continue;
    let result;
    try {
      result = pack.detect(root);
    } catch (err) {
      errors.push(errorOf(name, err));
      continue;
    }
    const verdict = judge(result);
    if (verdict === null) continue;
    if (verdict.message) {
      errors.push({ pack: name, message: verdict.message });
      continue;
    }
    return { claim: { name, findings: verdict.findings, pack }, errors };
  }
  return { claim: null, errors };
}

// The partial config the claiming pack's defaults give, or null when it has none or they throw
// (reported in errors). Its ship steps replace the core list; when it has its own checks, the
// suggestion leaves checks out, so the pack's apply through the defaults layer.
function packDefaults(claim, errors, root) {
  if (typeof claim.pack.defaults !== 'function') return null;
  try {
    return claim.pack.defaults(undefined, { root, fs }) ?? null;
  } catch (err) {
    errors.push(errorOf(claim.name, err));
    return null;
  }
}

const stepsOf = (partial) => {
  const steps = partial?.ship?.steps;
  return Array.isArray(steps) && steps.length && steps.every((s) => typeof s === 'string') ? steps : null;
};

const checksOf = (partial) => {
  const checks = partial?.checks;
  const ok = (c) => c !== null && typeof c === 'object' && !Array.isArray(c) && typeof c.run === 'string' && c.run.length > 0;
  return Array.isArray(checks) && checks.length && checks.every(ok) ? checks : null;
};

export function detect(root, { gitRemote = realGitRemote, packs = PACKS } = {}) {
  const { claim, errors: packErrors } = askPacks(root, packs);
  const partial = claim ? packDefaults(claim, packErrors, root) : null;
  const steps = stepsOf(partial);
  const packChecks = checksOf(partial);
  const pkg = readJson(root, 'package.json');
  const pyproject = readText(root, 'pyproject.toml');
  const makefile = readText(root, 'Makefile');
  const checks = [];
  let install;
  let name = null;

  if (pkg) {
    const scripts = pkg.scripts ?? {};
    if (scripts.check) checks.push({ run: 'npm run check', when: 'always' });
    else if (scripts.test) checks.push({ run: 'npm test', when: 'always' });
    if (exists(root, 'package-lock.json')) install = { run: 'npm ci', when: 'package-lock.json', creates: 'node_modules' };
    else if (exists(root, 'pnpm-lock.yaml')) install = { run: 'pnpm install --frozen-lockfile', when: 'pnpm-lock.yaml', creates: 'node_modules' };
    else if (exists(root, 'yarn.lock')) install = { run: 'yarn install --frozen-lockfile', when: 'yarn.lock', creates: 'node_modules' };
    if (typeof pkg.name === 'string' && pkg.name) name = pkg.name;
  }
  if (pyproject !== null) {
    const uv = exists(root, 'uv.lock');
    checks.push({ run: uv ? 'uv run pytest' : 'pytest', when: 'always' });
    install ??= uv ? { run: 'uv sync', when: 'uv.lock' } : { run: 'pip install -e .', when: 'pyproject.toml' };
    name ??= pyprojectName(pyproject);
  }
  const make = makefile !== null && /^test:/m.test(makefile);
  if (!checks.length && make) checks.push({ run: 'make test', when: 'always' });

  const jobs = ciJobs(root);
  const storiesDir = findStories(root);
  const suggested = {
    version: 1,
    project: { name: name || path.basename(path.resolve(root)) },
    ...(claim ? { pack: claim.name } : {}),
    ...(install ? { install } : {}),
    ...(packChecks ? {} : { checks }),
    stories: { adapter: 'markdown', dir: storiesDir ?? 'stories' },
    ship: { steps: steps ?? ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'], ci: { required: jobs } },
  };
  return {
    suggested,
    found: {
      node: pkg !== null,
      python: pyproject !== null,
      make: makefile !== null,
      ciJobs: jobs,
      hasStories: storiesDir !== null,
      storiesDir,
      storySourceHint: storiesDir ? 'markdown' : 'unknown',
      hasClaudeMd: exists(root, 'CLAUDE.md'),
      gitRemote: gitRemote(root),
      ...(claim ? { pack: claim.name, packFindings: claim.findings } : {}),
      ...(packErrors.length ? { packErrors } : {}),
    },
  };
}

const EXAMPLE_STORY = `---
id: S-1
title: Try Foreman on a small change
status: todo
depends_on: []
---

## What

Add one line to the README saying this project is built with Foreman.

## Done when

The README has the line and the project's checks pass.

## Progress notes

_Newest first._
`;

const stateEntry = (config) => `${(config.stateDir ?? '.foreman').replace(/^\/+|\/+$/g, '')}/`;

// The stories block of the resolved config (defaults merged in), through its adapter's option
// check: [] or [message].
function storyErrors(resolved) {
  const { adapter, ...options } = resolved.stories ?? {};
  const check = Object.hasOwn(STORY_OPTION_CHECKS, adapter) ? STORY_OPTION_CHECKS[adapter] : null;
  if (!check) return [`stories.adapter: unknown story source: ${adapter}`];
  try {
    check(options);
    return [];
  } catch (err) {
    return [err.message];
  }
}

// Whether a markdown stories folder lands outside the project. A config may name one (a notes
// vault), but Foreman never writes its example story there.
function outsideRoot(root, dir) {
  const rel = path.relative(path.resolve(root), path.resolve(root, dir));
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

// Writes the config and its companions. Returns { ok, lines, errors }. It refuses, writing
// nothing, any config loadConfig would refuse (so what it writes always loads), a stories block
// its adapter refuses, and an example story whose folder is outside the project. `packs` stands
// in for the real pack registry, for tests.
export function writeInit(root, config, { force = false, marketplace = 'foreman', example = true, packs } = {}) {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const loaded = loadConfig(root, { readFile: () => text, ...(packs ? { packs } : {}) });
  const errors = loaded.config ? storyErrors(loaded.config) : loaded.errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
  // Only a markdown source has a folder to put an example story in.
  const makeExample = loaded.config !== null && example && (loaded.config.stories?.adapter ?? 'markdown') === 'markdown';
  // Read only once loadConfig accepted it: before that, config may be null or not an object.
  const storiesDir = makeExample ? (config.stories?.dir ?? 'stories') : null;
  if (!errors.length && makeExample && outsideRoot(root, storiesDir)) {
    errors.push(`stories.dir: ${storiesDir} is outside the project, so Foreman will not put an example story there; use a folder inside the project, or turn the example story off`);
  }
  if (errors.length) return { ok: false, lines: [], errors };
  const configPath = path.join(root, CONFIG_FILE);
  if (fs.existsSync(configPath) && !force) {
    return { ok: false, lines: [], errors: [`${CONFIG_FILE} already exists; pass --force to overwrite it`] };
  }
  const settingsPath = path.join(root, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
    } catch {
      return { ok: false, lines: [], errors: ['.claude/settings.json is not valid JSON; fix it and run again'] };
    }
  }

  const lines = [];
  fs.writeFileSync(configPath, text);
  lines.push(`wrote ${CONFIG_FILE}`);

  const plugin = `foreman@${marketplace}`;
  const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  settings.enabledPlugins = { ...enabled, [plugin]: true };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  lines.push(`enabled ${plugin} in .claude/settings.json`);

  const entry = stateEntry(config);
  const ignorePath = path.join(root, '.gitignore');
  const old = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const bare = entry.slice(0, -1);
  const covered = old.split(/\r?\n/).some((l) => [bare, entry, `/${bare}`, `/${entry}`].includes(l.trim()));
  if (covered) lines.push(`.gitignore already ignores ${entry}`);
  else {
    fs.writeFileSync(ignorePath, `${old === '' || old.endsWith('\n') ? old : `${old}\n`}${entry}\n`);
    lines.push(`added ${entry} to .gitignore`);
  }

  if (makeExample) {
    const abs = path.resolve(root, storiesDir);
    if (hasStoryFiles(abs)) lines.push(`kept existing stories in ${storiesDir}/`);
    else {
      fs.mkdirSync(abs, { recursive: true });
      fs.writeFileSync(path.join(abs, 'S-1.md'), EXAMPLE_STORY);
      lines.push(`created example story ${storiesDir}/S-1.md`);
    }
  }
  return { ok: true, lines, errors: [] };
}
