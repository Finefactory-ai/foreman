// The Salesforce skills the pack's agents use, installed the way the official `npx skills` CLI
// installs them, so either tool can read what the other wrote:
//
//   .agents/skills/<name>/      the skill's files, copied from the source at the pinned tag
//   .claude/skills/<name>       a relative symlink to ../../.agents/skills/<name>
//   skills-lock.json            { version: 1, skills: { <name>: { source, sourceType, ref,
//                               commit, skillPath, computedHash } } }, sorted, 2-space indented.
//                               commit is Foreman's own field, the commit the tag pointed at;
//                               the CLI does not write it.
//
// computedHash is the CLI's: SHA-256 over every regular file in the skill folder, sorted by
// relative path with localeCompare, each as its '/' path then its bytes. Folders named .git or
// node_modules, and anything that is neither a file nor a folder, are left out.
//
// Foreman owns skills-lock.json: installSkills replaces the skills it lists and removes the ones
// a new tag drops, and refuses to overwrite a skill folder it did not install. When a skill
// folder that skills-lock.json does not list already exists, installSkills refuses, and the
// reason names the clashing path, .claude/skills/<name> first, else .agents/skills/<name>:
// `<path> is not from <source>; move it or remove it`. Several clashes give `<paths> are not
// from <source>; move them or remove them`.
//
// A source URL holding a user name, a token or a query string is refused before any git call, and
// the reason (CREDENTIALS_REASON) does not repeat it. When the tag now points at a different commit
// than the lock recorded for the same source and tag, the result carries movedFrom, the old commit,
// so the caller can warn: tags are meant not to move. movedFrom comes only from a lock entry whose
// commit is a full hex commit id (40 to 64 lowercase hex characters); any other commit value is
// treated as no commit; movedFromLock(lock, { source, tag, commit }) is that decision on its own,
// with no git. Nothing is copied into the plugin. Every helper takes its fs (and sh) from
// the caller; none throws.

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKIPPED = new Set(['.git', 'node_modules']);
const LOCK_FILE = 'skills-lock.json';
const LS_REMOTE_TIMEOUT_MS = 60_000;
const CLONE_TIMEOUT_MS = 300_000;
const MAX_NAMED = 5;
// A full commit id, SHA-1 or SHA-256, as rev-parse prints it.
const COMMIT = /^[0-9a-f]{40,64}$/;

export const CREDENTIALS_REASON = 'salesforce.skills.source must not hold a user name or token; use a git credential helper instead';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const named = (names) => `${names.slice(0, MAX_NAMED).join(', ')}${names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : ''}`;

// True for an https:// URL with a user name or token before the host, or with a query string,
// which can carry a token (?access_token=...). An @ after the host does not count. A regex, not
// new URL, so it never throws.
export const hasCredentials = (source) => typeof source === 'string' && /^https:\/\/(?:[^/?#]*@|[^?#]*\?)/i.test(source);

// The URL git clones for `source`: owner/repo on GitHub, or an https:// or file:// URL or an
// absolute path as it is. null for anything else, so nothing that git could read as an option
// ever reaches it, and null for an https URL holding a user name, a token or a query string.
export function gitUrl(source) {
  if (typeof source !== 'string' || source.startsWith('-') || /\s/.test(source)) return null;
  if (hasCredentials(source)) return null;
  if (OWNER_REPO.test(source)) return `https://github.com/${source}.git`;
  if (/^(https|file):\/\/\S+$/.test(source) || path.isAbsolute(source)) return source;
  return null;
}

export const sourceType = (source) => (typeof source === 'string' && OWNER_REPO.test(source) ? 'github' : 'git');

export function hashSkillDir(dir, fs) {
  const files = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) walk(path.join(abs, entry.name), relPath);
      } else if (entry.isFile()) {
        files.push(relPath);
      }
    }
  };
  walk(dir, '');
  files.sort((a, b) => a.localeCompare(b));
  const hash = crypto.createHash('sha256');
  for (const relPath of files) {
    hash.update(relPath);
    hash.update(fs.readFileSync(path.join(dir, ...relPath.split('/'))));
  }
  return hash.digest('hex');
}

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();

// The skill names a markdown file's frontmatter lists under `skills:`, unique and in order.
export function namedSkills(text) {
  const front = String(text ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!front) return [];
  const lines = front[1].split(/\r?\n/);
  const at = lines.findIndex((line) => /^skills:/.test(line));
  if (at < 0) return [];
  let items = [];
  const rest = lines[at].slice('skills:'.length).trim();
  if (rest) {
    items = rest.replace(/^\[(.*)\]$/, '$1').split(',');
  } else {
    for (const line of lines.slice(at + 1)) {
      const m = line.match(/^\s+-\s*(.*)$/);
      if (!m) break;
      items.push(m[1]);
    }
  }
  return [...new Set(items.map(unquote).filter(Boolean))];
}

// skills-lock.json in `root`: { missing: true }, { error }, or { lock } for a version 1 lock.
export function readLock(root, fs) {
  let text;
  try {
    text = String(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    return { error: `could not read ${LOCK_FILE}` };
  }
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return { error: `${LOCK_FILE} is not valid JSON` };
  }
  if (!isObject(lock) || lock.version !== 1) return { error: `${LOCK_FILE} is not a version 1 skills lock` };
  return { lock };
}

const exists = (fs, p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Copies folders and regular files only: no .git, no node_modules, no symlinks.
function copyDir(fs, from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) copyDir(fs, src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
  }
}

// The skill folders at skills/<name>/ that hold a SKILL.md, sorted.
function skillsIn(fs, repo) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(repo, 'skills'), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        return fs.lstatSync(path.join(repo, 'skills', name, 'SKILL.md')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function writeSkills({ root, source, tag, commit, fs, repo, names, managed }) {
  const agents = path.join(root, '.agents', 'skills');
  const claude = path.join(root, '.claude', 'skills');
  const removed = managed.filter((name) => !names.includes(name));
  for (const name of removed) {
    fs.rmSync(path.join(agents, name), { recursive: true, force: true });
    fs.rmSync(path.join(claude, name), { recursive: true, force: true });
  }
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });
  const lock = { version: 1, skills: {} };
  for (const name of names) {
    const real = path.join(agents, name);
    fs.rmSync(real, { recursive: true, force: true });
    copyDir(fs, path.join(repo, 'skills', name), real);
    const link = path.join(claude, name);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(path.join('..', '..', '.agents', 'skills', name), link, 'dir');
    lock.skills[name] = {
      source,
      sourceType: sourceType(source),
      ref: tag,
      commit,
      skillPath: `skills/${name}/SKILL.md`,
      computedHash: hashSkillDir(real, fs),
    };
  }
  fs.writeFileSync(path.join(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return removed;
}

// The commit the lock recorded for `source` at `tag` when it differs from `commit` (the tag
// moved), else undefined: the first entry of lock.skills with the same source and ref whose
// commit is a full commit id. No git, no fs.
export function movedFromLock(lock, { source, tag, commit }) {
  if (!isObject(lock) || !isObject(lock.skills)) return undefined;
  return Object.values(lock.skills).find((entry) => isObject(entry) && entry.source === source && entry.ref === tag && typeof entry.commit === 'string' && COMMIT.test(entry.commit) && entry.commit !== commit)?.commit;
}

function install({ root, source, tag, sh, fs, tmpDir }) {
  if (hasCredentials(source)) return { ok: false, reason: CREDENTIALS_REASON };
  const url = gitUrl(source);
  if (!url) return { ok: false, reason: 'salesforce.skills.source must be owner/repo, an https:// or file:// URL, or an absolute path' };
  if (typeof tag !== 'string' || !TAG.test(tag)) return { ok: false, reason: 'salesforce.skills.tag is not a tag name' };

  const found = sh('git', ['ls-remote', '--tags', '--', url, `refs/tags/${tag}`], { timeout: LS_REMOTE_TIMEOUT_MS }) ?? {};
  if (found.status !== 0) return { ok: false, reason: `could not reach ${source}` };
  if (!String(found.stdout ?? '').trim()) return { ok: false, reason: `${source} has no tag ${tag}` };

  const tmp = fs.mkdtempSync(path.join(tmpDir, 'foreman-skills-'));
  try {
    const repo = path.join(tmp, 'repo');
    const clone = sh('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, '--', url, repo], { timeout: CLONE_TIMEOUT_MS }) ?? {};
    if (clone.status !== 0) return { ok: false, reason: `could not clone ${source} at tag ${tag}` };
    const head = sh('git', ['-C', repo, 'rev-parse', 'HEAD'], {}) ?? {};
    const commit = String(head.stdout ?? '').trim();
    if (head.status !== 0 || !COMMIT.test(commit)) return { ok: false, reason: `could not read the commit of ${source} at tag ${tag}` };

    const names = skillsIn(fs, repo);
    if (!names.length) return { ok: false, reason: `no skills under skills/ at tag ${tag}` };
    const badNames = names.filter((name) => !SKILL_NAME.test(name));
    if (badNames.length) return { ok: false, reason: `${source} at tag ${tag} has skill folders that are not skill names: ${named(badNames)}` };

    const old = readLock(root, fs);
    if (old.error) return { ok: false, reason: `${old.error}; fix or delete it` };
    const managed = old.lock && isObject(old.lock.skills) ? Object.keys(old.lock.skills) : [];
    const movedFrom = movedFromLock(old.lock, { source, tag, commit });
    const badManaged = managed.filter((name) => !SKILL_NAME.test(name));
    if (badManaged.length) return { ok: false, reason: `${LOCK_FILE} names skills that are not skill names: ${named(badManaged)}; fix or delete it` };

    const conflicts = [];
    for (const name of names) {
      if (managed.includes(name)) continue;
      const claude = path.join('.claude', 'skills', name);
      const agents = path.join('.agents', 'skills', name);
      if (exists(fs, path.join(root, claude))) conflicts.push(claude);
      else if (exists(fs, path.join(root, agents))) conflicts.push(agents);
    }
    if (conflicts.length === 1) return { ok: false, reason: `${conflicts[0]} is not from ${source}; move it or remove it` };
    if (conflicts.length) return { ok: false, reason: `${named(conflicts)} are not from ${source}; move them or remove them` };

    const removed = writeSkills({ root, source, tag, commit, fs, repo, names, managed });
    return { ok: true, commit, installed: names, removed, ...(movedFrom ? { movedFrom } : {}) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Installs the skills at `tag` from `source` into `root`. { ok: true, commit, installed, removed }
// plus movedFrom when the tag moved since the lock was written, or { ok: false, reason }.
// Nothing is written into the project until every check has passed.
export function installSkills({ root, source, tag, sh, fs, tmpDir = os.tmpdir() }) {
  try {
    return install({ root, source, tag, sh, fs, tmpDir });
  } catch (err) {
    return { ok: false, reason: `could not install the skills: ${err?.code ?? err?.message ?? String(err)}` };
  }
}
