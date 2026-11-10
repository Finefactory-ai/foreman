// Which Foreman plugin a story session loads, and the words for when the installed copy is not
// the code the supervisor runs. Claude Code loads the installed plugin copy (a cache folder under
// <CLAUDE_CONFIG_DIR>/plugins) into a session; that copy can be older than the Foreman code the
// supervisor runs, so a fix to the plugin does not reach the sessions. `--plugin-dir <folder>`
// wins over an installed copy of the same name (checked against a real `claude -p`), so the
// supervisor passes its own plugin folder (code-version.mjs PLUGIN_DIR, the code its restart
// watches) whenever the installed copy is elsewhere. No settings are changed.
//
// Pure apart from the `fs` it is given (default node:fs); nothing here throws, and nothing scans
// the disk: the only file read is <pluginsDir>/installed_plugins.json. A missing or non-string
// path gets the plain answer each function lists below.
//
//   installedCopies({ pluginsDir, root, fs })
//                        [{ id, scope, path, version }] for every `foreman@<market>` in
//                        installed_plugins.json whose scope is 'user' or whose projectPath is
//                        `root` or a folder inside it (the slot worktrees); entries with no
//                        string installPath are dropped; a root that is not a string matches no
//                        project entry; a missing, unreadable or non-JSON file,
//                        or one with no `plugins` object, gives []
//   samePlace(a, b, { fs, home })
//                        whether two folder paths are one place: a leading ~/ is expanded with
//                        `home`, a trailing slash dropped, then the real path is taken when it
//                        can be (macOS /var is /private/var)
//   ownCopy({ pluginDir, fs })
//                        { path, version } of the supervisor's own plugin folder; version from
//                        .claude-plugin/plugin.json, or null; the whole answer is null when
//                        pluginDir is not a non-empty string
//   sessionPlugin({ pluginDir, root, copies, fs, home })
//                        { dir, why, copy }. dir is the folder to pass as --plugin-dir, or null
//                        for nothing. why is 'own-repo' (pluginDir is inside the project: Foreman
//                        building its own repo), 'not-installed' (no installed copy: the cloud
//                        runner), 'differs' (copy is an installed copy elsewhere) or null.
//                        FOREMAN_PLUGIN_DIR plays no part: the supervisor decides. All three are
//                        null when pluginDir is not a string.
//   copyWarning({ copy, own })
//                        the sentence the supervisor logs at start and `foreman doctor` shows
//   initPluginWarning({ id, init, expected, fs, home })
//                        a sentence when a session's init event shows Foreman loaded from
//                        somewhere other than `expected`, or not at all; null when it matches
//                        or when the init has no plugins list (an older CLI); also null when
//                        expected is not a string

import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Whether `dir` is `root` or a folder inside it.
function within(root, dir) {
  if (typeof root !== 'string' || !root || typeof dir !== 'string' || !dir) return false;
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function installedCopies({ pluginsDir, root, fs = nodeFs } = {}) {
  try {
    const file = JSON.parse(String(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8')));
    if (!isObject(file?.plugins)) return [];
    const out = [];
    for (const [id, entries] of Object.entries(file.plugins)) {
      if (id.split('@')[0] !== 'foreman' || !Array.isArray(entries)) continue;
      for (const e of entries) {
        if (!isObject(e) || typeof e.installPath !== 'string' || !e.installPath) continue;
        const mine = e.scope === 'user' || (typeof e.projectPath === 'string' && e.projectPath !== '' && within(root, e.projectPath));
        if (!mine) continue;
        out.push({ id, scope: e.scope, path: e.installPath, version: typeof e.version === 'string' ? e.version : null });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function samePlace(a, b, { fs = nodeFs, home = os.homedir() } = {}) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const real = (p) => {
    const s = String(p);
    const resolved = path.resolve(s === '~' || s.startsWith('~/') ? path.join(home, s.slice(1)) : s);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  };
  return real(a) === real(b);
}

export function ownCopy({ pluginDir, fs = nodeFs } = {}) {
  if (typeof pluginDir !== 'string' || !pluginDir) return null;
  let version = null;
  try {
    const v = JSON.parse(String(fs.readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'))).version;
    if (typeof v === 'string' && v) version = v;
  } catch {
    // no readable plugin.json
  }
  return { path: path.resolve(pluginDir), version };
}

export function sessionPlugin({ pluginDir, root, copies = [], fs = nodeFs, home = os.homedir() } = {}) {
  if (typeof pluginDir !== 'string' || !pluginDir) return { dir: null, why: null, copy: null };
  const list = Array.isArray(copies) ? copies : [];
  const copy = list.find((c) => !samePlace(c?.path, pluginDir, { fs, home })) ?? null;
  const why = within(root, pluginDir) ? 'own-repo' : list.length === 0 ? 'not-installed' : copy ? 'differs' : null;
  return { dir: why ? path.resolve(pluginDir) : null, why, copy };
}

export function copyWarning({ copy, own } = {}) {
  const label = own?.label && own.label !== `v${own.version}` ? ` (${own.label})` : '';
  return `The installed Foreman plugin is ${copy?.version ?? '?'} (${copy?.path ?? '?'}), but this Foreman is ${own?.version ?? '?'}${label} (${own?.path ?? '?'}); story sessions load this one with --plugin-dir.`;
}

export function initPluginWarning({ id, init, expected, fs = nodeFs, home = os.homedir() } = {}) {
  if (typeof expected !== 'string' || !expected) return null;
  if (!init || !Array.isArray(init.plugins)) return null;
  const p = init.plugins.find((x) => x?.name === 'foreman');
  if (!p) return `${id}: its session loaded no Foreman plugin.`;
  if (samePlace(p.path, expected, { fs, home })) return null;
  return `${id}: its session loaded Foreman${p.version ? ` ${p.version}` : ''} from ${p.path || '?'}, not this run's code at ${path.resolve(expected)}.`;
}
