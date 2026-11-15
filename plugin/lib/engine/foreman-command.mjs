// Whether `foreman` inside a story session is the plugin's own CLI. A story session runs the
// plugin's bin/foreman, but Claude Code's Bash tool sources the user's shell set-up, so a shell
// alias or function named `foreman`, or another `foreman` earlier on PATH, can beat it: the run's
// steps (ship, checks, decide, story) then use other code than its agents and skills. Two places
// look, `foreman doctor` (the 'foreman command' check) and the CLI itself inside a session, and
// both say it in the same words.
//
// Pure apart from the `fs` it is given (default node:fs); nothing here throws.
//
//   FIX_HINT         what to do about it: guard the user's alias or function with FOREMAN_RUN
//   updateHint(id)   what to do when `foreman` is an installed plugin copy: update it with
//                    `claude plugin update <id>`
//   overrideText({ found, expected, foundVersion, expectedVersion })
//                    the sentence: `foreman` in story sessions runs <found>, not the plugin's CLI
//                    at <expected>; a version given (a non-empty string) is added as
//                    ` (Foreman <version>)` after its path
//   readType({ status, stdout, stderr }, { env })
//                    reads the answer of `<shell> -ic 'type foreman'`: { kind: 'alias' },
//                    { kind: 'function' }, { kind: 'file', path }, { kind: 'missing' },
//                    { kind: 'failed', reason } or { kind: 'unknown' }. It uses the first stdout
//                    line that starts with `foreman is ` (an interactive shell may print other
//                    lines first) and never returns an alias or function body, which could hold
//                    a secret. The failed reason is the first stderr line, with secrets blanked
//                    (the values of the named secrets in `env`, then anything that looks like
//                    one), cut to 120 characters.
//   selfCheck({ env, self, fs, now, home })
//                    the CLI's own check, run first in every `foreman` call of a story session
//                    (FOREMAN_RUN=1). `self` is the plugin folder the CLI runs from, and
//                    FOREMAN_PLUGIN_ROOT the one the supervisor gave the session. When they are
//                    two places, it adds one warn event on the slot (state.mjs addEvent) and
//                    returns its text, once per session: the marker
//                    <stateDir>/slots/<slot>/plugin-check holds the supervisor, story and folder
//                    it last warned about. The text names both copies' versions (from their
//                    .claude-plugin/plugin.json) and, after the supervisor's, its commit
//                    (FOREMAN_PLUGIN_LABEL, left out when it only repeats the version). It does nothing, and returns null, when a variable it
//                    needs is missing, when the state folder is not there (it never creates it),
//                    when `self` is inside FOREMAN_PROJECT_DIR (Foreman building its own repo runs
//                    its worktree's plugin on purpose), when FOREMAN_SLOT is not a plain name
//                    (letters, digits, `_` or `-`), so the marker cannot land outside
//                    <stateDir>/slots, or on any error. It writes nothing outside
//                    the state folder. The text ends with FIX_HINT, except when `self` is an
//                    installed copy listed in <CLAUDE_CONFIG_DIR or home/.claude>/plugins/
//                    installed_plugins.json (user scope, or project scope under
//                    FOREMAN_PROJECT_DIR; it reads only that file): then it ends with
//                    updateHint(<its id>), the same words as doctor. `home` stands in for the
//                    home folder in tests.

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedCopies, ownCopy, samePlace } from './plugin-copy.mjs';
import { redact as redactNamed } from '../secrets/redact.mjs';
import { addEvent, redact as redactLooksSecret } from './state.mjs';

export const FIX_HINT = 'wrap it in `if [[ -z "$FOREMAN_RUN" ]]; then … fi` in your shell start-up file (such as ~/.zshrc), so story sessions run the plugin\'s own foreman';

export const updateHint = (id) => `update it with \`claude plugin update ${id}\``;

const versioned = (place, version) => (nonEmpty(version) ? `${place} (Foreman ${version})` : place);

export function overrideText({ found, expected, foundVersion, expectedVersion }) {
  return `\`foreman\` in story sessions runs ${versioned(found, foundVersion)}, not the plugin's CLI at ${versioned(expected, expectedVersion)}, so the run's steps use other code than its agents`;
}

const lines = (text) => (typeof text === 'string' ? text.split('\n') : []);

const REASON_MAX = 120;

const cleanReason = (line, env) => {
  const one = redactLooksSecret(redactNamed(line, { env })).replace(/\s+/g, ' ').trim();
  return one.length > REASON_MAX ? `${one.slice(0, REASON_MAX - 1)}…` : one;
};

export function readType({ status, stdout, stderr } = {}, { env = {} } = {}) {
  const line = lines(stdout).map((l) => l.trim()).find((l) => l.startsWith('foreman is '));
  if (line) {
    const rest = line.slice('foreman is '.length);
    if (/^an alias\b|^aliased\b/.test(rest)) return { kind: 'alias' };
    if (/^a shell function\b|^a function\b/.test(rest)) return { kind: 'function' };
    const hashed = /^hashed \((.+)\)$/.exec(rest);
    if (hashed) return { kind: 'file', path: hashed[1] };
    if (rest.startsWith('/')) return { kind: 'file', path: rest };
    return { kind: 'unknown' };
  }
  if (status !== 0 && status !== undefined && status !== null) {
    if (/not found|could not find/i.test(`${stdout ?? ''}\n${stderr ?? ''}`)) return { kind: 'missing' };
    const first = lines(stderr).map((l) => l.trim()).find(Boolean);
    return { kind: 'failed', reason: first ? cleanReason(first, env) : `exit ${status}` };
  }
  return { kind: 'unknown' };
}

const nonEmpty = (v) => typeof v === 'string' && v !== '';

// Whether `dir` is `root` or a folder inside it.
function inside(root, dir) {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function selfCheck({ env, self, fs = nodeFs, now = new Date(), home = os.homedir() } = {}) {
  try {
    if (env?.FOREMAN_RUN !== '1') return null;
    const { FOREMAN_PLUGIN_ROOT: expected, FOREMAN_STATE_DIR: stateDir, FOREMAN_SLOT: slot } = env;
    if (!nonEmpty(expected) || !nonEmpty(stateDir) || !nonEmpty(slot) || !nonEmpty(self)) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(slot)) return null;
    if (!fs.existsSync(stateDir)) return null;
    if (samePlace(self, expected, { fs })) return null;
    if (nonEmpty(env.FOREMAN_PROJECT_DIR) && inside(env.FOREMAN_PROJECT_DIR, self)) return null;
    const key = `${env.FOREMAN_SUPERVISOR_PID ?? ''}|${env.FOREMAN_STORY ?? ''}|${path.resolve(self)}`;
    const folder = path.join(stateDir, 'slots', slot);
    const marker = path.join(folder, 'plugin-check');
    let held = null;
    try {
      held = String(fs.readFileSync(marker, 'utf8'));
    } catch {
      // no marker yet
    }
    if (held === key) return null;
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(marker, key);
    const story = env.FOREMAN_STORY ? `${env.FOREMAN_STORY}: ` : '';
    const foundVersion = ownCopy({ pluginDir: self, fs })?.version ?? null;
    const v = ownCopy({ pluginDir: expected, fs })?.version ?? null;
    const label = nonEmpty(env.FOREMAN_PLUGIN_LABEL) && env.FOREMAN_PLUGIN_LABEL !== `v${v}` ? env.FOREMAN_PLUGIN_LABEL : null;
    const expectedVersion = v && label ? `${v} ${label}` : (v ?? label ?? null);
    const pluginsDir = path.join(nonEmpty(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, '.claude'), 'plugins');
    const copy = installedCopies({ pluginsDir, root: env.FOREMAN_PROJECT_DIR, fs }).find((c) => samePlace(c.path, self, { fs, home }));
    const fix = copy ? updateHint(copy.id) : FIX_HINT;
    const text = `${story}${overrideText({ found: path.join(self, 'bin', 'foreman'), expected: path.join(path.resolve(expected), 'bin', 'foreman'), foundVersion, expectedVersion })}; ${fix}.`;
    addEvent(stateDir, text, 'warn', now, slot);
    return text;
  } catch {
    return null;
  }
}
