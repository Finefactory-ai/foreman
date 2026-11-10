// The "salesforce workflows" doctor check: CI must not deploy the branches Foreman merges into
// to an org off the list. It reads `.github/workflows/*.yml` and `*.yaml` as plain text, with a
// small line reader and no YAML library, and runs no sf and no git.
//
// The rules:
//   - The branches are the ones Foreman merges into: the pull request target and each stage's
//     branch. The production branch and every other branch are ignored.
//   - A workflow counts when its push trigger runs on one of those branches. A push with no
//     branch filter counts as every branch, and so do an `on:` the reader cannot place and an
//     empty filter (`branches:` or `branches: []`); `branches` takes the last matching pattern
//     (`!pat` negates), `branches-ignore` runs unless a pattern matches, and a push filtered
//     only by tags never runs on a branch. `**` matches anything, `*` anything but `/`, and a
//     pattern holding `?`, `+` or `[` is read on the safe side.
//   - In each of its jobs, every `run:` script is read for sf, sfdx and `@salesforce/cli`
//     (as run by npx) deploys (`project deploy start|validate|quick`, `force:source:deploy`,
//     `force:mdapi:deploy`), and a job that calls
//     a local reusable workflow (`uses: ./.github/workflows/<f>`) has that file's jobs read too,
//     one level deep.
//   - A deploy's target is its last `-o`, `--target-org`, `-u`, `--u` or `--targetusername`; with none,
//     it is the alias of the job's one `org login` (or `auth:`) when the file sets no default
//     org (flags may sit between `config set` and `target-org`). A value glued to a short
//     flag (`-oacme-dev1`) cannot be read. A deploy passes only when its target is an alias in salesforce.orgs that is not
//     marked "production": true; deployments to production are blocked, so a deploy to a
//     marked alias fails though it is listed. A target that cannot be read (`${{ secrets.X }}`,
//     `$VAR`, a command, or missing) fails.
//   - The detail names only the file and the branches: never an alias, a secret's name, a job
//     or the file's contents.
//
// The same reader answers a second question, for the pack's defaults and the "salesforce ci"
// doctor check: does any workflow run on a pull request into the PR target? A workflow counts
// when its `pull_request` or `pull_request_target` trigger runs on that branch, read like a push
// filter (an empty filter, or an `on:` the reader cannot place, counts as every branch). A file
// that cannot be read, or a folder that cannot, is not "no CI": the pack then keeps `ci`. The
// detail names only file names and branches.
//
// Known limits:
//   - doctor cannot see where a CI secret or a login's username really points:
//     `--alias acme-dev1 --username ${{ secrets.X }}` followed by `-o acme-dev1` passes. Init's
//     production question covers that.
//   - `uses:` actions, composite actions and remote reusable workflows are not read.
//   - deploys inside repo scripts are not seen (`run: ./scripts/deploy.sh`, `npm run deploy`),
//     since script files are not read.
//   - push-style commands such as `sfdx force:source:push` are not counted as deploys.
//   - a lone `&` splits commands, except inside a redirect (`2>&1`, `&>log`).
//   - job `if:` conditions are ignored, so such a job counts as running.
//   - `pull_request`, `workflow_dispatch` and other triggers are not Foreman merges and are
//     ignored by the deploy check.
//   - for pull requests, `paths`, `paths-ignore` and `types` filters and a job's `if:` are ignored,
//     so such a workflow counts as running.

import path from 'node:path';

const ok = (detail = '') => ({ ok: true, level: 'error', detail });
const fail = (detail) => ({ ok: false, level: 'error', detail });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_NAMED = 5;
const WORKFLOW_FILE = /\.ya?ml$/;
const LOCAL_CALL = './.github/workflows/';
const EVERY_BRANCH = Object.freeze({ branches: null, ignore: null, tagsOnly: false });
const UNSAFE = /[?+[]/;
const DEPLOY_STEPS = new Set(['start', 'validate', 'quick']);
const OLD_DEPLOYS = new Set(['force:source:deploy', 'force:mdapi:deploy']);
const TARGET_FLAGS = ['-o', '--target-org', '-u', '--u', '--targetusername'];
const ALIAS_FLAGS = ['-a', '--alias', '--setalias'];
const DEFAULT_ORG = /SF_TARGET_ORG|SFDX_DEFAULTUSERNAME|config\s+set\b[^\n]*\btarget-org|config:set\b[^\n]*\bdefaultusername/;
const SF_PACKAGE = /^@salesforce\/cli(@\S*)?$/;

const indentOf = (line) => line.length - line.trimStart().length;
const isSignificant = (line) => line.trim() !== '' && !line.trimStart().startsWith('#');
const dropComment = (value) => value.replace(/(^|\s)#.*$/, '').trim();

// A scalar without its quotes. An unquoted value loses a trailing comment.
function unquote(raw) {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    let out = '';
    for (let i = 1; i < v.length; i += 1) {
      if (q === "'" && v[i] === "'" && v[i + 1] === "'") { out += "'"; i += 1; continue; }
      if (q === '"' && v[i] === '\\' && i + 1 < v.length) { out += v[i + 1]; i += 1; continue; }
      if (v[i] === q) return out;
      out += v[i];
    }
    return out;
  }
  return dropComment(v);
}

// The significant lines after `at` that sit deeper than `indent`, as indexes, ending at the first
// significant line that does not.
function childLines(lines, at, indent) {
  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!isSignificant(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) break;
    out.push(i);
  }
  return out;
}

// A list value: a flow list, a block list of `- x` lines (deeper than the key, or at its indent),
// or one scalar. Null when it cannot be read, such as a flow list over several lines.
function listValue(lines, at, keyIndent, inline) {
  const v = dropComment(inline);
  if (v.startsWith('{') || (v.startsWith('[') && !v.endsWith(']'))) return null;
  if (v.startsWith('[')) {
    const body = v.replace(/^\[/, '').replace(/\]$/, '');
    return body.split(',').map(unquote).filter((x) => x !== '');
  }
  if (v !== '') return [unquote(v)];
  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!isSignificant(line)) continue;
    const n = indentOf(line);
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (n < keyIndent || (n === keyIndent && !item)) break;
    if (item) out.push(unquote(item[1]));
  }
  return out;
}

const KEY = /^\s*(?:"([^"]*)"|'([^']*)'|([^\s#'"][^:#]*?))\s*:(?:\s+(.*)|\s*)$/;
function keyOf(line) {
  const m = KEY.exec(line);
  return m ? { key: m[1] ?? m[2] ?? m[3], rest: (m[4] ?? '').trim() } : null;
}

// The filter of the `event` trigger (push, pull_request or pull_request_target), or null when the
// workflow has no such trigger.
function readEvent(lines, event) {
  const at = lines.findIndex((line) => /^(on|"on"|'on'|true)\s*:/.test(line));
  if (at < 0) return null;
  const inline = dropComment(lines[at].replace(/^[^:]*:/, ''));
  if (inline !== '') return new RegExp(`\\b${event}\\b`).test(inline) ? EVERY_BRANCH : null;

  const children = childLines(lines, at, 0);
  if (!children.length) {
    const items = listValue(lines, at, 0, '');
    if (items.includes(event)) return EVERY_BRANCH;
    if (items.length && items.every((item) => /^[a-z_]+$/.test(item))) return null;
    return EVERY_BRANCH;
  }
  const indent = indentOf(lines[children[0]]);
  let eventAt = -1;
  for (const i of children) {
    if (indentOf(lines[i]) !== indent) continue;
    if (new RegExp(`^\\s*-\\s*['"]?${event}['"]?\\s*$`).test(dropComment(lines[i]))) return EVERY_BRANCH;
    const k = keyOf(lines[i]);
    if (k && k.key === event) {
      if (k.rest !== '' && dropComment(k.rest) !== '') return EVERY_BRANCH;
      eventAt = i;
      break;
    }
  }
  if (eventAt < 0) return null;

  const filters = childLines(lines, eventAt, indent);
  if (!filters.length) return EVERY_BRANCH;
  const filterIndent = indentOf(lines[filters[0]]);
  const found = {};
  for (const i of filters) {
    if (indentOf(lines[i]) !== filterIndent) continue;
    const k = keyOf(lines[i]);
    if (k && ['branches', 'branches-ignore', 'tags', 'tags-ignore'].includes(k.key) && !Object.hasOwn(found, k.key)) {
      found[k.key] = listValue(lines, i, filterIndent, k.rest);
    }
  }
  for (const key of Object.keys(found)) {
    if (Array.isArray(found[key]) && !found[key].length) found[key] = null;
  }
  if (Object.values(found).includes(null)) return EVERY_BRANCH;
  const hasBranches = Object.hasOwn(found, 'branches') || Object.hasOwn(found, 'branches-ignore');
  return {
    branches: found.branches ?? null,
    ignore: found['branches-ignore'] ?? null,
    tagsOnly: !hasBranches && (Object.hasOwn(found, 'tags') || Object.hasOwn(found, 'tags-ignore')),
  };
}

// Every `run:` value in `body` (line indexes of one job), joined with newlines.
function scriptOf(lines, body) {
  const parts = [];
  const last = body.length ? body[body.length - 1] : -1;
  for (let i = body.length ? body[0] : 0; i <= last; i += 1) {
    const m = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const column = m[1].length + (m[2]?.length ?? 0);
    const value = m[3];
    const block = /^([|>])[-+0-9]*\s*(#.*)?$/.exec(value);
    if (!block) {
      const v = unquote(value);
      if (v !== '') parts.push(v);
      continue;
    }
    const taken = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > column)) {
      taken.push(lines[j]);
      j += 1;
    }
    while (taken.length && taken[taken.length - 1].trim() === '') taken.pop();
    const cut = Math.min(...taken.filter((l) => l.trim() !== '').map(indentOf));
    const text = taken.map((l) => (l.trim() === '' ? '' : l.slice(cut)));
    if (text.length) parts.push(block[1] === '>' ? text.filter((l) => l !== '').join(' ') : text.join('\n'));
    i = j - 1;
  }
  return parts.join('\n');
}

function readJobs(lines) {
  const at = lines.findIndex((line) => /^jobs\s*:\s*(#.*)?$/.test(line));
  if (at < 0) return [];
  const all = childLines(lines, at, 0);
  if (!all.length) return [];
  const indent = indentOf(lines[all[0]]);
  const jobs = [];
  for (const i of all) {
    if (indentOf(lines[i]) !== indent) continue;
    const k = keyOf(lines[i]);
    if (!k || k.key === '') continue;
    const body = childLines(lines, i, indent);
    const childIndent = body.length ? indentOf(lines[body[0]]) : -1;
    let uses = null;
    for (const b of body) {
      if (indentOf(lines[b]) !== childIndent) continue;
      const u = /^\s*uses\s*:\s*(.*)$/.exec(lines[b]);
      if (u) { uses = unquote(u[1]) || null; break; }
    }
    jobs.push({ id: k.key, uses, script: scriptOf(lines, body) });
  }
  return jobs;
}

// The push trigger, the pull request triggers (pull_request and pull_request_target, one filter
// each, none when the workflow has neither) and the jobs of a workflow file. It never throws; a
// file it cannot parse counts as running on every pull request.
export function parseWorkflow(text) {
  try {
    const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];
    const pullRequest = ['pull_request', 'pull_request_target'].map((event) => readEvent(lines, event)).filter((f) => f !== null);
    return { push: readEvent(lines, 'push'), pullRequest, jobs: readJobs(lines) };
  } catch {
    return { push: null, pullRequest: [EVERY_BRANCH], jobs: [] };
  }
}

function glob(pattern) {
  const body = pattern.split(/(\*\*|\*)/).map((part) => {
    if (part === '**') return '.*';
    if (part === '*') return '[^/]*';
    return part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }).join('');
  return new RegExp(`^${body}$`);
}

// Whether a push to `branch` runs the workflow.
export function pushRunsOn(push, branch) {
  if (!isObject(push) || push.tagsOnly) return false;
  if (Array.isArray(push.branches)) {
    let hit = false;
    for (const p of push.branches) {
      const negated = p.startsWith('!');
      const pattern = negated ? p.slice(1) : p;
      if (UNSAFE.test(pattern)) {
        if (!negated) hit = true;
        continue;
      }
      if (glob(pattern).test(branch)) hit = !negated;
    }
    return hit;
  }
  if (Array.isArray(push.ignore)) return !push.ignore.some((p) => !UNSAFE.test(p) && glob(p).test(branch));
  return true;
}

// Whether a pull request into `branch` runs the workflow (pull_request or pull_request_target).
export function runsOnPullRequest(wf, branch) {
  return Array.isArray(wf?.pullRequest) && wf.pullRequest.some((f) => pushRunsOn(f, branch));
}

// The commands of a script, each a list of words. Separators are newline, ;, &&, || and |, and
// a lone & that runs a command in the background, all outside quotes. An & next to a redirect
// (`2>&1`, `>&2`, `<&0`, `&>log`) is part of the word. An unquoted word starting with # ends
// the command.
function commandsOf(script) {
  const text = script.replace(/\\\r?\n/g, ' ');
  const commands = [];
  let words = [];
  let word = null;
  let quote = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; word = word ?? ''; continue; }
    if (c === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) { word = (word ?? '') + c; continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|') { endCommand(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    if (c === '#' && word === null) {
      while (i + 1 < text.length && text[i + 1] !== '\n') i += 1;
      endCommand();
      continue;
    }
    word = (word ?? '') + c;
  }
  endCommand();
  return commands;
}

// The value of the last of `flags` in `words`, as `flag value` or `flag=value`: undefined when
// none is there, null when the value is missing or glued to a short flag (`-oacme-dev1`).
function flagValue(words, flags) {
  let value;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (flags.includes(w)) value = words[i + 1] ?? null;
    else {
      const flag = flags.find((f) => w.startsWith(`${f}=`));
      if (flag) value = w.slice(flag.length + 1);
      else if (flags.some((f) => /^-[A-Za-z]$/.test(f) && w.startsWith(f))) value = null;
    }
  }
  return value;
}

const readable = (v) => (typeof v === 'string' && v !== '' && !v.startsWith('-') && !/[$`]|\{\{/.test(v) ? v : null);

// The sf deploys in a job's script, each { target }, null when the target cannot be read.
// `fileText` is the whole workflow, read for a default org set elsewhere in it.
export function deploysIn(script, fileText) {
  const deploys = [];
  const logins = [];
  for (const words of commandsOf(String(script ?? ''))) {
    const at = words.findIndex((w) => ['sf', 'sfdx'].includes(w.split('/').pop()) || SF_PACKAGE.test(w));
    if (at < 0) continue;
    const rest = words.slice(at + 1);
    const isDeploy = (rest[0] === 'project' && rest[1] === 'deploy' && DEPLOY_STEPS.has(rest[2])) || OLD_DEPLOYS.has(rest[0]);
    const isLogin = (rest[0] === 'org' && rest[1] === 'login') || /^(force:)?auth:/.test(rest[0] ?? '');
    if (isDeploy) deploys.push(flagValue(rest, TARGET_FLAGS));
    else if (isLogin) logins.push(readable(flagValue(rest, ALIAS_FLAGS)));
  }
  const fallback = logins.length === 1 && !DEFAULT_ORG.test(String(fileText ?? '')) ? logins[0] : null;
  return deploys.map((value) => ({ target: value === undefined ? fallback : readable(value) }));
}

const named = (items) => `${items.slice(0, MAX_NAMED).join('; ')}${items.length > MAX_NAMED ? ` and ${items.length - MAX_NAMED} more` : ''}`;
const display = (name) => `.github/workflows/${name}`;
const UNREADABLE = 'could not read .github/workflows';
const KINDS = {
  unlisted: 'deploys to an org not in salesforce.orgs',
  unreadable: 'deploys to a target doctor cannot read; give --target-org an alias from salesforce.orgs',
  production: 'deploys to a production org; Foreman never deploys to production',
};

// The workflow files of the project, `*.yml` and `*.yaml` sorted by name: { files: [{ name, text }] },
// or { error } when the folder or a file cannot be read. A missing folder holds no files.
// It never throws.
export function readWorkflowFiles(root, fs) {
  try {
    const dir = path.join(root, '.github', 'workflows');
    let names;
    try {
      names = fs.readdirSync(dir).map(String).filter((n) => WORKFLOW_FILE.test(n)).sort();
    } catch (err) {
      return err?.code === 'ENOENT' ? { files: [] } : { error: UNREADABLE };
    }
    const files = [];
    for (const name of names) {
      try {
        files.push({ name, text: String(fs.readFileSync(path.join(dir, name), 'utf8')) });
      } catch {
        return { error: `could not read ${display(name)}` };
      }
    }
    return { files };
  } catch {
    return { error: UNREADABLE };
  }
}

// The workflow files that run on a pull request into `branch`: { names, error }. A folder or file
// that cannot be read gives the error and no names. It never throws.
export function pullRequestWorkflows(root, branch, fs) {
  try {
    const listed = readWorkflowFiles(root, fs);
    if (listed.error) return { names: [], error: UNREADABLE };
    return { names: listed.files.filter((f) => runsOnPullRequest(parseWorkflow(f.text), branch)).map((f) => f.name), error: null };
  } catch {
    return { names: [], error: UNREADABLE };
  }
}

// The doctor result for a project with no CI on pull requests, or the files that are CI. `config` is
// the resolved config, `l` the block's layout().
export function pullRequestCiCheck(config, l, ctx) {
  const into = l?.prInto ?? 'main';
  const steps = Array.isArray(config?.ship?.steps) ? config.ship.steps : [];
  const minutes = config?.ship?.ci?.timeoutMinutes ?? 30;
  const r = pullRequestWorkflows(ctx?.root, into, ctx?.fs);
  if (r.error) return { ok: false, level: 'warn', detail: r.error };
  if (r.names.length) return ok(`CI on pull requests: ${r.names.slice(0, MAX_NAMED).join(', ')}${r.names.length > MAX_NAMED ? ` and ${r.names.length - MAX_NAMED} more` : ''}`);
  if (steps.includes('ci')) {
    return {
      ok: false,
      level: 'warn',
      detail: `ship.steps has ci, but no CI runs on pull requests into ${into}: the ci step will wait ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} and then fail every release`,
    };
  }
  return ok(`no CI runs on pull requests into ${into}; sf-validate is the check`);
}

// The doctor result for the project's workflows against `l`, the block's layout().
export function workflowsCheck(l, ctx) {
  const orgs = isObject(l?.orgs) ? l.orgs : {};
  const stages = Array.isArray(l?.stages) ? l.stages : [];
  const branches = [...new Set([l?.prInto, ...stages.map((s) => s?.branch)].filter((b) => typeof b === 'string' && b !== ''))];
  const dir = path.join(ctx.root, '.github', 'workflows');
  const read = (name) => String(ctx.fs.readFileSync(path.join(dir, name), 'utf8'));
  const listed = readWorkflowFiles(ctx.root, ctx.fs);
  if (listed.error) return fail(listed.error);
  const { files } = listed;
  if (!files.length) return ok('no workflows');

  const problems = new Map();
  const deployed = new Set();
  let count = 0;
  const judge = (name, text, jobs, on) => {
    for (const job of jobs) {
      for (const { target } of deploysIn(job.script, text)) {
        count += 1;
        for (const b of on) deployed.add(b);
        const listed = target !== null && Object.hasOwn(orgs, target);
        const production = listed && isObject(orgs[target]) && orgs[target].production === true;
        if (listed && !production) continue;
        const kind = target === null ? 'unreadable' : production ? 'production' : 'unlisted';
        const key = `${name}\0${kind}`;
        if (!problems.has(key)) problems.set(key, { name, kind, on: new Set() });
        for (const b of on) problems.get(key).on.add(b);
      }
    }
  };

  for (const { name, text } of files) {
    const wf = parseWorkflow(text);
    const on = branches.filter((b) => pushRunsOn(wf.push, b));
    if (!on.length) continue;
    for (const job of wf.jobs) {
      judge(name, text, [job], on);
      const called = typeof job.uses === 'string' && job.uses.startsWith(LOCAL_CALL) ? job.uses.slice(LOCAL_CALL.length) : null;
      if (!called || !/^[^/\\]+\.ya?ml$/.test(called)) continue;
      let calledText;
      try {
        calledText = read(called);
      } catch {
        continue;
      }
      judge(called, calledText, parseWorkflow(calledText).jobs, on);
    }
  }

  if (problems.size) {
    const order = (set) => branches.filter((b) => set.has(b)).join(', ');
    return fail(named([...problems.values()].map((p) => `${display(p.name)} on ${order(p.on)}: ${KINDS[p.kind]}`)));
  }
  if (!count) return ok(`no workflow deploys ${branches.join(', ')}`);
  return ok(`${count} ${count === 1 ? 'deploy' : 'deploys'} on ${branches.filter((b) => deployed.has(b)).join(', ')}, all to orgs in salesforce.orgs`);
}
