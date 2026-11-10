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
//      stopped), the org gets the base branch's version back. Foreman builds the reverse delta from that story's head to the
//      base with sfdx-git-delta, in a temporary worktree of the base so the slot's worktree is
//      never touched, deploys it with the added components as post-destructive changes, then
//      checks the org no longer lists them. A merged story's deploys stay, which is what keeps
//      a stage-1 release on a build org that also takes stage 1.
//   6. source tracking reset, so changes already on the org (and the clean-up's own) are not
//      taken for the builder's
//   7. the record: the org's last story is now the slot's story, written before prepare returns
//      and so before the session's first deploy. A failed clean-up keeps the old record, so
//      the next prepare tries again. A prepare with no story leaves the record alone, so the
//      next prepare that has one still cleans up after the last story.
//
// It answers 'reset' when the clean-up deployed something, else 'up'. Records live in
// <stateDir>/salesforce/orgs/<org ID, 15 characters>.json as { alias, orgId, story, branch, at }.
//
// Every sf call runs through the isolated sf home (isolation.mjs); git and gh run with the
// real HOME, where their credentials are. A message names only aliases, org IDs, branches,
// metadata types and members, and sf's own error message: never an sf result.

import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { defaultSh } from '../../../lib/engine/worktree.mjs';
import { layout } from '../config.mjs';
import { isolatedSh, orgQuery, sfHome } from '../isolation.mjs';
import { runSf } from '../sf.mjs';

export const requires = { env: [], tools: ['sf', 'git', 'gh'] };

const NAME = 'env adapter sandbox-pool';
const TRACKING_QUERY = 'SELECT Id FROM SourceMember LIMIT 1';
const TRACKING_OFF = /INVALID_TYPE|SourceMember.*not supported/i;
const FETCH_TRIES = 3;
const DEPLOY_WAIT_MINUTES = 30;

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

  // Deploys the base version of what `record`'s story changed. True when a deploy ran.
  const cleanUp = (org, record) => {
    if (merged(record.branch)) return false;
    fetchBase();
    const base = gitOut(['rev-parse', '--verify', `${remote}/${baseBranch}^{commit}`]);
    if (!base) throw new Error(`could not read ${remote}/${baseBranch}`);
    const head = headOf(record.branch);
    if (!head) return false;

    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'foreman-sf-clean-'));
    const tree = join(tmp, 'tree');
    const out = join(tmp, 'delta');
    try {
      fs.mkdirSync(out);
      if (git(['worktree', 'add', '--detach', tree, base]).status !== 0) throw new Error(`could not check out ${remote}/${baseBranch} for the clean-up of ${org.alias}`);
      const delta = runSf(iso, ['sgd', 'source', 'delta', '--from', head, '--to', base, '--output-dir', out, '--generate-delta'], { cwd: tree });
      if (!delta.ok) throw new Error(`could not build the clean-up delta for ${org.alias}: ${delta.error.message}`);

      const packageXml = join(out, 'package', 'package.xml');
      const destructiveXml = join(out, 'destructiveChanges', 'destructiveChanges.xml');
      const changed = manifestTypes(packageXml);
      const removed = manifestTypes(destructiveXml);
      if (!Object.keys(changed).length && !Object.keys(removed).length) return false;

      const deploy = runSf(
        iso,
        ['project', 'deploy', 'start', '--manifest', packageXml, '--post-destructive-changes', destructiveXml, '--test-level', 'NoTestRun', '--target-org', org.alias, '--wait', String(DEPLOY_WAIT_MINUTES)],
        { cwd: tree, timeoutMs: (DEPLOY_WAIT_MINUTES + 1) * 60_000 },
      );
      if (!deploy.ok) throw new Error(`the clean-up deploy to ${org.alias} failed: ${deploy.error.message}`);

      // One list call per type and folder, in manifest order.
      const groups = new Map();
      for (const [type, members] of Object.entries(removed)) {
        for (const member of members) {
          const folder = member.includes('/') ? member.split('/')[0] : undefined;
          const key = `${type}\u0000${folder ?? ''}`;
          if (!groups.has(key)) groups.set(key, { type, folder, members: [] });
          groups.get(key).members.push(member);
        }
      }
      for (const { type, folder, members } of groups.values()) {
        const list = runSf(iso, ['org', 'list', 'metadata', '--metadata-type', type, '--target-org', org.alias, ...(folder ? ['--folder', folder] : [])]);
        if (!list.ok) throw new Error(`could not confirm the clean-up in ${org.alias}: ${list.error.message}`);
        const present = new Set(fullNames(list.result));
        const left = members.find((m) => present.has(m));
        if (left !== undefined) throw new Error(`${org.alias} still holds ${type} ${left} after the clean-up`);
      }
      return true;
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
    const cleaned = current && isObject(record) && record.story !== current && typeof record.branch === 'string' && record.branch ? cleanUp(org, record) : false;

    const reset = runSf(iso, ['project', 'reset', 'tracking', '--no-prompt', '--target-org', org.alias], { cwd: path });
    if (!reset.ok) throw new Error(`could not reset source tracking in ${org.alias}: ${reset.error.message}`);

    if (current) {
      writeJsonAtomic(file, { alias: org.alias, orgId: org.orgId, story: current, branch: `${branchPrefix}${String(current).toLowerCase()}`, at: new Date().toISOString() });
    }
    return cleaned ? 'reset' : 'up';
  };

  return { env, prepare };
}
