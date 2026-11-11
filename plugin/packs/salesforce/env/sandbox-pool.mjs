// The Salesforce sandbox-pool slot environment: each slot builds in its own sandbox, the one
// salesforce.build lists at the slot's place (layout().slotOrg). It takes no options.
//
// prepare(n, path) runs, in order, and throws a short message on any refusal or failure:
//
//   1. the lease: the slot's build org, or a refusal when it has none
//   2. the identity check: the org must be a sandbox, and the org ID salesforce.orgs gives it.
//      Production is never a target. Nothing else runs after a refusal.
//   3. target-org set in the worktree's own .sf/config.json, never globally
//   4. a check that source tracking is on in the org
//   5. the clean-up, only when the slot has a story: when the last story built in that org
//      was not this one and its pull request did not merge (it was parked, rejected or
//      stopped), the org gets the base branch's version back. A merged story's deploys stay,
//      which is what keeps a stage-1 release on a build org that also takes stage 1. What the
//      story left is found from the first of three sources:
//        a. its branch, when it has commits over the base: Foreman builds the reverse delta from
//           the branch head to the base with sfdx-git-delta
//        b. its leftover branch (leftover/<slot>-<id>-<date>, made by the supervisor when the
//           story failed before its commit), newest since the story took the org: the same delta
//           from that head
//        c. the org's own source tracking: what changed in the org after the revision the record
//           holds, restored from the base where the base has it and removed where it does not
//           (only types on an allow-list)
//      With none of the three, prepare refuses and the old record stays.
//      The delta is built in a temporary worktree of the base, so the slot's worktree is never
//      touched. Before deploying, Foreman lists each type it would delete and drops what the org
//      does not hold (a story that only ran dry-run deploys left nothing to delete); a folder of
//      Report, Dashboard, Document or EmailTemplate is listed under its folder type. The rest is
//      deployed as post-destructive changes, then Foreman checks the org no longer lists it. With
//      nothing left to deploy it deploys nothing, records the new story and answers 'up'.
//   6. source tracking reset, so changes already on the org (and the clean-up's own) are not
//      taken for the builder's
//   7. the record: the org's last story is now the slot's story, written before prepare returns
//      and so before the session's first deploy, with the org's tracking revision after the
//      reset. A failed clean-up keeps the old record, so the next prepare tries again. A
//      prepare with no story leaves the record alone, so the next prepare that has one still
//      cleans up after the last story.
//
// It answers 'reset' when the clean-up deployed something, else 'up'. Records live in
// <stateDir>/salesforce/orgs/<org ID, 15 characters>.json as
// { alias, orgId, slot, story, branch, since, revision, at }: since is when the story first took
// the org, revision is the org's highest SourceMember RevisionCounter (left out when unknown).
//
// Every sf call runs through the isolated sf home (isolation.mjs); git and gh run with the
// real HOME, where their credentials are. A message names only aliases, org IDs, branches,
// metadata types and members, and sf's own error message: never an sf result. A failed deploy's
// message also names the first five failed components and the problem Salesforce gave, and counts
// the rest, read through deploy-result.mjs, which copies no user or job ID.

import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSh } from '../../../lib/engine/worktree.mjs';
import { layout } from '../config.mjs';
import { isolatedSh, orgQuery, sfHome } from '../isolation.mjs';
import { componentFailureCount, summary } from '../deploy-result.mjs';
import { runSf } from '../sf.mjs';

export const requires = { env: [], tools: ['sf', 'git', 'gh'] };

const NAME = 'env adapter sandbox-pool';
const TRACKING_QUERY = 'SELECT Id FROM SourceMember LIMIT 1';
const REVISION_QUERY = 'SELECT RevisionCounter FROM SourceMember ORDER BY RevisionCounter DESC LIMIT 1';
const TRACKING_OFF = /INVALID_TYPE|SourceMember.*not supported/i;
const FETCH_TRIES = 3;
const DEPLOY_WAIT_MINUTES = 30;
// The types a tracking clean-up may delete from an org. Flow and RecordType are left out, as
// steps/sf-delta.mjs treats them by hand; so are Profile and Settings, which are never deleted.
const REMOVABLE = new Set([
  'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent', 'LightningComponentBundle', 'AuraDefinitionBundle', 'StaticResource', 'CustomObject', 'CustomField',
  'CustomTab', 'CustomLabel', 'CustomMetadata', 'CustomPermission', 'FlexiPage', 'Layout', 'PermissionSet', 'ValidationRule', 'LightningMessageChannel',
]);

// A member with no '/' of one of these types is a folder, and the org lists folders under the
// folder type, never under the type itself.
const FOLDER_TYPES = new Map([
  ['Dashboard', 'DashboardFolder'],
  ['Document', 'DocumentFolder'],
  ['EmailTemplate', 'EmailFolder'],
  ['Report', 'ReportFolder'],
]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// The five XML entities decoded in one pass, so `A&amp;lt;B` is `A&lt;B`, never `A<B`.
const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ENTITIES[e]);

const ESCAPES = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '&': '&amp;' };
const escapeXml = (s) => String(s).replace(/[<>"'&]/g, (c) => ESCAPES[c]);

// A package.xml (or destructiveChanges.xml) holding `types` ({ type: [members] }), the reverse
// of manifestTypes.
const manifestXml = (types, version) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
    ...Object.entries(types).map(([name, members]) => `  <types>\n${members.map((m) => `    <members>${escapeXml(m)}</members>`).join('\n')}\n    <name>${escapeXml(name)}</name>\n  </types>`),
    `  <version>${escapeXml(version)}</version>`,
    '</Package>',
    '',
  ].join('\n');

const isRevision = (v) => Number.isInteger(v) && v >= 0;

// { type: [members] } from a package.xml or destructiveChanges.xml, with the five XML entities
// decoded in members and names, so they are real component names; '*' is skipped. A missing
// file is empty.
export function manifestTypes(file) {
  let xml = '';
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const [, block] of xml.matchAll(/<types>([\s\S]*?)<\/types>/g)) {
    const raw = /<name>\s*([^<]+?)\s*<\/name>/.exec(block)?.[1];
    if (!raw) continue;
    const name = unescapeXml(raw);
    const members = [...block.matchAll(/<members>\s*([^<]+?)\s*<\/members>/g)].map((m) => unescapeXml(m[1])).filter((m) => m !== '*');
    if (members.length) out[name] = [...(out[name] ?? []), ...members];
  }
  return out;
}

// The story the supervisor gave slot n, from <stateDir>/slots/w<n>.json, the file
// lib/engine/state.mjs keeps (readSlot). It is read here rather than imported: state.mjs loads
// the config defaults, which load the pack registry, which loads this file.
function currentStory(stateDir, n) {
  const slot = readJson(join(stateDir, 'slots', `w${n}.json`));
  const id = isObject(slot) && isObject(slot.story) ? slot.story.id : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

const MAX_NAMED = 5;
const fullNames = (result) => (Array.isArray(result) ? result : isObject(result) ? [result] : []).filter(isObject).map((e) => e.fullName);

export function create(options = {}, ctx = {}) {
  const { adapter, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${NAME}: unknown option ${unknown.join(', ')}`);

  const { root, stateDir, config = {}, sh = defaultSh, env: baseEnv = process.env, homedir = os.homedir() } = ctx;
  const l = layout(config?.salesforce, config);
  if (l.build.mode !== 'pool' || l.build.aliases.length === 0) throw new Error(`${NAME}: salesforce.build must name one or more sandboxes`);
  const iso = isolatedSh(sh, baseEnv, sfHome(baseEnv, homedir), homedir);
  const remote = config.remote ?? 'origin';
  const baseBranch = config.baseBranch ?? 'main';
  const branchPrefix = config.branchPrefix ?? '';

  const recordFile = (orgId) => join(stateDir, 'salesforce', 'orgs', `${id15(orgId)}.json`);
  const git = (args) => sh('git', args, { cwd: root }) ?? {};
  const gitOut = (args) => {
    const r = git(args);
    return r.status === 0 ? String(r.stdout ?? '').trim() : null;
  };

  const checkIdentity = (org) => {
    const q = orgQuery(iso, org.alias);
    if (!q.ok) throw new Error(`could not check ${org.alias}: ${q.error.message}`);
    const records = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : [];
    const record = isObject(records[0]) ? records[0] : {};
    if (record.IsSandbox !== true) throw new Error(`${org.alias} is not a sandbox; production is never a target`);
    if (id15(record.Id) !== id15(org.orgId)) throw new Error(`${org.alias} is org ${id15(record.Id)}, not ${org.orgId}`);
  };

  const merged = (branch) => {
    const r = sh('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '1', '--json', 'number'], { cwd: root }) ?? {};
    if (r.status !== 0) return false;
    try {
      const list = JSON.parse(String(r.stdout ?? ''));
      return Array.isArray(list) && list.length > 0;
    } catch {
      return false;
    }
  };

  const fetchBase = () => {
    for (let i = 0; i < FETCH_TRIES; i++) {
      if (git(['fetch', '--quiet', remote, baseBranch]).status === 0) return;
    }
  };

  const headOf = (branch) =>
    gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]) ?? gitOut(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}^{commit}`]);

  // What the org lists of `types` ({ type: [members] }), as a Set of `${type}\u0000${member}`. One
  // list call per type and folder, in manifest order. `what` is 'before' or 'after' the deploy.
  const heldIn = (org, types, what) => {
    const groups = new Map();
    for (const [type, members] of Object.entries(types)) {
      for (const member of members) {
        const folder = member.includes('/') ? member.split('/')[0] : undefined;
        const listType = !member.includes('/') && FOLDER_TYPES.has(type) ? FOLDER_TYPES.get(type) : type;
        const key = `${listType}\u0000${folder ?? ''}`;
        if (!groups.has(key)) groups.set(key, { type, listType, folder, members: [] });
        groups.get(key).members.push(member);
      }
    }
    const held = new Set();
    for (const { type, listType, folder, members } of groups.values()) {
      const list = runSf(iso, ['org', 'list', 'metadata', '--metadata-type', listType, '--target-org', org.alias, ...(folder ? ['--folder', folder] : [])]);
      if (!list.ok) {
        throw new Error(what === 'before' ? `could not list what ${org.alias} holds before the clean-up: ${list.error.message}` : `could not confirm the clean-up in ${org.alias}: ${list.error.message}`);
      }
      const present = new Set(fullNames(list.result));
      for (const m of members) if (present.has(m)) held.add(`${type}\u0000${m}`);
    }
    return held;
  };

  // `removed` without what the org does not hold, in its order; types left with no members go.
  const heldOnly = (org, removed) => {
    const held = heldIn(org, removed, 'before');
    const kept = {};
    for (const [type, members] of Object.entries(removed)) {
      const some = members.filter((m) => held.has(`${type}\u0000${m}`));
      if (some.length) kept[type] = some;
    }
    return kept;
  };

  const sameTypes = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // The <version> of a manifest, or '' when the file or the tag is missing.
  const manifestVersion = (file) => {
    try {
      return /<version>\s*([^<]+?)\s*<\/version>/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
    } catch {
      return '';
    }
  };

  // Deploys `packageXml`, with `destructiveXml` as post-destructive changes when `kept`
  // ({ type: [members] }) has members, then checks the org no longer lists what `kept` names.
  const deployAndConfirm = (org, tree, packageXml, destructiveXml, kept) => {
    const deletes = Object.keys(kept).length > 0;
    const deploy = runSf(
      iso,
      ['project', 'deploy', 'start', '--manifest', packageXml, ...(deletes ? ['--post-destructive-changes', destructiveXml] : []), '--test-level', 'NoTestRun', '--target-org', org.alias, '--wait', String(DEPLOY_WAIT_MINUTES)],
      { cwd: tree, timeoutMs: (DEPLOY_WAIT_MINUTES + 1) * 60_000, keepResult: true },
    );
    if (!deploy.ok) {
      const failures = summary(deploy.result).failures.filter((f) => f.kind === 'component');
      const named = failures.slice(0, MAX_NAMED).map((f) => `${f.name}: ${f.message}`);
      const total = componentFailureCount(deploy.result);
      const more = total > MAX_NAMED ? `; and ${total - MAX_NAMED} more` : '';
      throw new Error(`the clean-up deploy to ${org.alias} failed: ${deploy.error.message}${named.length ? `; ${named.join('; ')}` : ''}${more}`);
    }
    if (!deletes) return true;

    const left = [...heldIn(org, kept, 'after')][0];
    if (left !== undefined) {
      const [type, name] = left.split('\u0000');
      throw new Error(`${org.alias} still holds ${type} ${name} after the clean-up`);
    }
    return true;
  };

  // The head of the newest leftover branch the story made in slot `slot` since it took the org.
  const leftoverHead = (record, slot) => {
    const listed = gitOut(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads/leftover/']);
    if (!listed) return null;
    const story = String(record.story).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^leftover/${slot}-${story}-\\d{8}(?:-\\d+)?$`);
    const since = Date.parse(record.since ?? record.at);
    for (const line of listed.split('\n')) {
      const [name, date] = line.split('\t');
      if (!pattern.test(name ?? '')) continue;
      if (!Number.isNaN(since) && Date.parse(date) < since) continue;
      return headOf(name);
    }
    return null;
  };

  // What the org changed since `rev`, as the base's version of each member (restore) and the
  // members the base does not have (remove). Null when nothing changed.
  const trackedChanges = (org, rev) => {
    const q = runSf(iso, ['data', 'query', '--use-tooling-api', '--query', `SELECT MemberType, MemberName, IsNameObsolete FROM SourceMember WHERE RevisionCounter > ${rev}`, '--target-org', org.alias]);
    if (!q.ok) throw new Error(`could not read source tracking in ${org.alias}: ${q.error.message}`);
    if (!isObject(q.result) || !Array.isArray(q.result.records)) throw new Error(`could not read source tracking in ${org.alias}: no list of changes`);
    const seen = new Map();
    for (const row of q.result.records) {
      if (!isObject(row) || typeof row.MemberType !== 'string' || typeof row.MemberName !== 'string') continue;
      seen.set(`${row.MemberType}\u0000${row.MemberName}`, row);
    }
    return [...seen.values()];
  };

  // Deploys the base version of what `record`'s story changed. True when a deploy ran.
  const cleanUp = (org, record, n) => {
    if (merged(record.branch)) return false;
    fetchBase();
    const base = gitOut(['rev-parse', '--verify', `${remote}/${baseBranch}^{commit}`]);
    if (!base) throw new Error(`could not read ${remote}/${baseBranch}`);

    let from = null;
    const head = headOf(record.branch);
    if (head) {
      const count = Number.parseInt(gitOut(['rev-list', '--count', `${base}..${head}`]) ?? '', 10);
      if (Number.isNaN(count) || count >= 1) from = head;
    }
    if (!from) from = leftoverHead(record, /^w[1-9]\d*$/.test(record.slot) ? record.slot : `w${n}`);
    let rows = null;
    if (!from) {
      if (!isRevision(record.revision)) {
        throw new Error(
          `cannot tell what ${record.story} left in ${org.alias}: no commits on ${record.branch}, no leftover branch, no tracking mark. Clean ${org.alias} by hand, then delete salesforce/orgs/${id15(org.orgId)}.json in the state folder`,
        );
      }
      rows = trackedChanges(org, record.revision);
      if (!rows.length) return false;
    }

    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'foreman-sf-clean-'));
    const tree = join(tmp, 'tree');
    const out = join(tmp, 'delta');
    try {
      fs.mkdirSync(out);
      if (git(['worktree', 'add', '--detach', tree, base]).status !== 0) throw new Error(`could not check out ${remote}/${baseBranch} for the clean-up of ${org.alias}`);

      const packageXml = join(out, 'package', 'package.xml');
      const destructiveXml = join(out, 'destructiveChanges', 'destructiveChanges.xml');
      let removed;
      let kept;
      if (from) {
        const delta = runSf(iso, ['sgd', 'source', 'delta', '--from', from, '--to', base, '--output-dir', out, '--generate-delta'], { cwd: tree });
        if (!delta.ok) throw new Error(`could not build the clean-up delta for ${org.alias}: ${delta.error.message}`);
        const changed = manifestTypes(packageXml);
        removed = manifestTypes(destructiveXml);
        if (!Object.keys(changed).length && !Object.keys(removed).length) return false;
        kept = heldOnly(org, removed);
        if (!Object.keys(changed).length && !Object.keys(kept).length) return false;
        if (!sameTypes(kept, removed)) {
          const version = manifestVersion(destructiveXml) || manifestVersion(packageXml);
          if (!version) throw new Error(`could not read the API version of the clean-up delta for ${org.alias}`);
          fs.writeFileSync(destructiveXml, manifestXml(kept, version));
        }
      } else {
        const project = readJson(join(tree, 'sfdx-project.json'));
        const paths = (isObject(project) && Array.isArray(project.packageDirectories) ? project.packageDirectories : []).map((d) => (isObject(d) ? d.path : undefined)).filter((p) => typeof p === 'string' && p);
        if (!paths.length) throw new Error(`could not read the package folders of ${remote}/${baseBranch} for the clean-up of ${org.alias}`);
        const listed = runSf(iso, ['project', 'generate', 'manifest', ...paths.flatMap((p) => ['--source-dir', p]), '--type', 'package', '--output-dir', join(tmp, 'base')], { cwd: tree });
        if (!listed.ok) throw new Error(`could not list the components of ${remote}/${baseBranch} for the clean-up of ${org.alias}: ${listed.error.message}`);
        const baseFile = join(tmp, 'base', 'package.xml');
        const inBase = new Set(Object.entries(manifestTypes(baseFile)).flatMap(([type, members]) => members.map((m) => `${type}\u0000${m}`)));
        const version = manifestVersion(baseFile);
        if (!version) throw new Error(`could not list the components of ${remote}/${baseBranch} for the clean-up of ${org.alias}: no API version`);

        const restore = {};
        removed = {};
        for (const row of rows) {
          const type = row.MemberType;
          const name = row.MemberName;
          if (inBase.has(`${type}\u0000${name}`)) (restore[type] ??= []).push(name);
          else if (row.IsNameObsolete !== true && REMOVABLE.has(type)) (removed[type] ??= []).push(name);
        }
        if (!Object.keys(restore).length && !Object.keys(removed).length) return false;
        kept = heldOnly(org, removed);
        if (!Object.keys(restore).length && !Object.keys(kept).length) return false;
        fs.mkdirSync(join(out, 'package'), { recursive: true });
        fs.mkdirSync(join(out, 'destructiveChanges'), { recursive: true });
        fs.writeFileSync(packageXml, manifestXml(restore, version));
        fs.writeFileSync(destructiveXml, manifestXml(kept, version));
      }
      return deployAndConfirm(org, tree, packageXml, destructiveXml, kept);
    } finally {
      git(['worktree', 'remove', '--force', tree]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };

  const env = (n) => ({ FOREMAN_SLOT: `w${n}` });

  const prepare = (n, path) => {
    const org = l.slotOrg(n);
    if (!org) throw new Error(`slot w${n} has no build org in salesforce.build`);

    checkIdentity(org);

    const set = runSf(iso, ['config', 'set', 'target-org', org.alias], { cwd: path });
    if (!set.ok) throw new Error(`could not set target-org ${org.alias} in ${path}: ${set.error.message}`);

    const tracking = runSf(iso, ['data', 'query', '--use-tooling-api', '--query', TRACKING_QUERY, '--target-org', org.alias]);
    if (!tracking.ok) {
      if (TRACKING_OFF.test(`${tracking.error.name} ${tracking.error.message}`)) throw new Error(`source tracking is off in ${org.alias}`);
      throw new Error(`could not check source tracking in ${org.alias}: ${tracking.error.message}`);
    }

    const current = currentStory(stateDir, n);
    const file = recordFile(org.orgId);
    const record = readJson(file);
    const cleaned = current && isObject(record) && record.story !== current && typeof record.branch === 'string' && record.branch ? cleanUp(org, record, n) : false;

    const reset = runSf(iso, ['project', 'reset', 'tracking', '--no-prompt', '--target-org', org.alias], { cwd: path });
    if (!reset.ok) throw new Error(`could not reset source tracking in ${org.alias}: ${reset.error.message}`);

    if (current) {
      const now = new Date().toISOString();
      const resume = isObject(record) && record.story === current;
      const since = resume ? (record.since ?? record.at ?? now) : now;
      let revision = resume && isRevision(record.revision) ? record.revision : undefined;
      if (revision === undefined) {
        const q = runSf(iso, ['data', 'query', '--use-tooling-api', '--query', REVISION_QUERY, '--target-org', org.alias]);
        if (!q.ok) throw new Error(`could not read the source tracking revision in ${org.alias}: ${q.error.message}`);
        const rows = isObject(q.result) && Array.isArray(q.result.records) ? q.result.records : null;
        if (rows && rows.length === 0) revision = 0;
        else if (rows && isObject(rows[0]) && isRevision(rows[0].RevisionCounter)) revision = rows[0].RevisionCounter;
      }
      writeJsonAtomic(file, {
        alias: org.alias,
        orgId: org.orgId,
        slot: `w${n}`,
        story: current,
        branch: `${branchPrefix}${String(current).toLowerCase()}`,
        since,
        ...(revision === undefined ? {} : { revision }),
        at: now,
      });
    }
    return cleaned ? 'reset' : 'up';
  };

  return { env, prepare };
}
