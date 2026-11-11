// The isolated sf home. With the Salesforce pack on, story sessions never see the owner's own sf
// logins: Foreman keeps an sf home of its own (FOREMAN_SF_HOME, default
// ~/.config/foreman/sf-home) holding only the orgs in salesforce.orgs, and writes `sf` and `sfdx`
// wrappers into <home>/.foreman/bin. Each session starts with that folder first on its PATH,
// FOREMAN_SF_HOME set, SF_DISABLE_TELEMETRY=true and the salesforce-development plugin turned off
// (it cannot see the orgs in this home, so it would deny every deploy).
//
// salesforce.orgs is the allow-list (alias -> { orgId, production? }): the build orgs, the stage
// orgs, in scratch mode the Dev Hub, and any org marked "production": true, which never deploys
// but may be the target of the commands on the production allow-list (prod-block.mjs);
// checkConfig in config.mjs refuses any other org in it. allowList reads it through layout() in
// config.mjs. Deployments to production are blocked: a production org may be
// signed in here only when salesforce.orgs marks it, and the wrapper, the guard and the release
// steps refuse every deploy to it.
//
// The wrapper sets HOME to the isolated home, SF_USE_GENERIC_UNIX_KEYCHAIN=true (without it sf
// cannot reach the macOS keychain from another home and saves no login), SF_DISABLE_TELEMETRY
// and SF_DATA_DIR (the owner's real sf data dir, where user plugins such as code-analyzer and
// sfdx-git-delta live; with only HOME changed they would vanish), then execs the real sf found
// at start. With FOREMAN_SF_HOME unset it refuses to run. When salesforce.orgs marks a
// production org, the wrapper unsets SF_TEMP_SHOW_SECRETS (in this CLI the one switch that
// un-redacts tokens in `org list`, `org list auth`, `org list users`, `org display` and
// `org resume scratch`), then runs the production check (prod-block.mjs), which refuses any
// command off the production allow-list that would reach it, however sf was started: by a
// launcher, a script or an npm script, in any target spelling, or through a default org in
// SF_TARGET_ORG or .sf/config.json. With none marked, the wrapper does neither.
//
//   setUp({ config, env, fs, sh, homedir })  the pack's prepareSessions hook: writes the wrappers
//                                            and checks the home; never throws. Its session
//                                            settings also deny the Read tool on keyRoot(homedir)
//   keyRoot(homedir)                         ~/.config/foreman/sf, where the sign-in keys live
//   homeVerdict({ home, block, list, query, scratch, hub })
//                                            whether the home holds only allow-listed sandboxes,
//                                            production orgs salesforce.orgs marks, and in
//                                            scratch mode the story scratch orgs `scratch` records
//                                            that the Dev Hub lists as active (`hub`, called only
//                                            when the home holds one)
//   activeScratchQuery(sh, devHub, ids)      the Dev Hub's ActiveScratchOrg rows for those org IDs
//   aliasStray({ home, block, list, alias }) why the doctor must not query `alias`, from the
//                                            home's `sf org list` alone, or null; no sf call
//   listedEntry(list, alias)                 the home's `sf org list` entry for `alias`, or null; no
//                                            sf call
//   isolatedSh(sh, env, home, homedir)       Foreman's own sf calls: the real sf, isolated HOME;
//                                            its sfHome is the home, for runSf's cool-downs
//
// FOREMAN_SF_HOME must be an absolute path; a relative one is refused, never resolved.
//
// Scratch mode (env/scratch.mjs) adds each story's own scratch org, for that story only: the
// records in <FOREMAN_STATE_DIR>/salesforce/scratch (scratch-orgs.mjs) name it by org ID, or by
// its exact username while it is still being made, and its server must say it is a sandbox. A
// record counts only when it names the configured Dev Hub, and that Dev Hub must list the org
// (by its 15-character org ID) as an active scratch org, so a record a session wrote cannot
// allow-list a QA or UAT sandbox. Once its story closes, the record goes with the org; an org
// left with no record is a stray.
// Outside scratch mode the records are ignored, so a pool project's home never widens.
//
// A stray org (not in salesforce.orgs) is refused from `sf org list` alone, before any query,
// so no sf call ever targets it. A reason names an org by its alias, or its org ID: never by
// its username. Its logout hint is runnable as printed: it sets HOME and
// SF_USE_GENERIC_UNIX_KEYCHAIN=true as the wrapper does, and for an org with no usable alias it
// leaves a placeholder for the username and says how to find it. Foreman runs `sf org login jwt` only from the set-up connect route
// (setup.mjs connectOrg), into this home, and logs out at once any org that is not a sandbox,
// unless salesforce.orgs marks it "production": true with that org ID. It never touches ~/.sf or
// ~/.sfdx.

import path from 'node:path';
import { ALIAS, layout } from './config.mjs';
import { SF_PROD_CHECK } from './prod-block.mjs';
import { readScratchOrgs } from './scratch-orgs.mjs';
import { runSf } from './sf.mjs';

export const SF_PLUGIN = 'salesforce-development@salesforce';
export const SESSION_SETTINGS = Object.freeze({ enabledPlugins: Object.freeze({ [SF_PLUGIN]: false }) });

const MARKER = '# foreman sf wrapper';
const ORG_QUERY = 'SELECT Id, IsSandbox FROM Organization';
const LIST_ARGS = ['org', 'list', '--all', '--skip-connection-status'];
const GROUPS = ['nonScratchOrgs', 'sandboxes', 'scratchOrgs', 'devHubs', 'other'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');
const message = (err) => err?.message ?? String(err);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The folder that holds each project's Salesforce sign-in key (setup.mjs keyPaths). Story sessions
// are denied the Read tool on it (setUp).
export const keyRoot = (homedir) => path.join(homedir, '.config', 'foreman', 'sf');

export function sfHome(env, homedir) {
  return isText(env?.FOREMAN_SF_HOME) ? env.FOREMAN_SF_HOME : path.join(homedir, '.config', 'foreman', 'sf-home');
}

// Why `home` cannot be the isolated sf home, or null. A relative FOREMAN_SF_HOME (often a `~`
// nobody expanded, from a .env file or a CI env block) would land the wrappers and the logins
// under the working directory, and no session could put that bin folder on its PATH.
export function homeProblem(env, home) {
  if (path.isAbsolute(home)) return null;
  return isText(env?.FOREMAN_SF_HOME) ? `FOREMAN_SF_HOME must be an absolute path, not ${env.FOREMAN_SF_HOME}` : `the isolated sf home must be an absolute path, not ${home}`;
}

export const binDir = (home) => path.join(home, '.foreman', 'bin');

// Where oclif keeps sf's data, user plugins included.
export function dataDir(env, homedir) {
  return env?.SF_DATA_DIR || path.join(env?.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), 'sf');
}

export function isolatedEnv(env, home, homedir) {
  return { ...env, HOME: home, SF_USE_GENERIC_UNIX_KEYCHAIN: 'true', SF_DISABLE_TELEMETRY: 'true', SF_DATA_DIR: dataDir(env, homedir) };
}

// sfHome names the home to runSf, which keeps its cool-down records there.
export function isolatedSh(sh, env, home, homedir) {
  const iso = (cmd, args, opts) => sh(cmd, args, { ...opts, env: isolatedEnv(env, home, homedir) });
  iso.sfHome = home;
  return iso;
}

function isWrapper(fs, file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(200);
    const n = fs.readSync(fd, buf, 0, 200, 0);
    return buf.subarray(0, n).toString('utf8').includes(MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

// The first sf on PATH that is an executable file and not a Foreman wrapper, skipping skipDir
// and relative PATH entries. null when there is none.
export function findRealSf(env, fs, skipDir) {
  const skip = path.resolve(skipDir);
  for (const dir of String(env?.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || path.resolve(dir) === skip) continue;
    const file = path.join(dir, 'sf');
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      continue;
    }
    if (!isWrapper(fs, file)) return file;
  }
  return null;
}

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

// With `production` ({ alias, orgId } for each org marked "production": true) not empty, the
// wrapper first runs the production check (prod-block.mjs) with `node`, and stops when it refuses.
export function wrapperScript({ realSf, dataDir: data, production = [], node = process.execPath, check = SF_PROD_CHECK }) {
  const marked = production.map(({ alias, orgId }) => ({ alias, orgId }));
  return [
    '#!/bin/sh',
    MARKER,
    'if [ -z "$FOREMAN_SF_HOME" ]; then',
    "  echo 'foreman: FOREMAN_SF_HOME is not set; refusing to run sf with your own logins' >&2",
    '  exit 1',
    'fi',
    `export HOME="$FOREMAN_SF_HOME" SF_USE_GENERIC_UNIX_KEYCHAIN=true SF_DISABLE_TELEMETRY=true SF_DATA_DIR=${quote(data)}`,
    ...(marked.length ? ['unset SF_TEMP_SHOW_SECRETS', `${quote(node)} ${quote(check)} ${quote(JSON.stringify(marked))} "$@" || exit 1`] : []),
    `exec ${quote(realSf)} "$@"`,
    '',
  ].join('\n');
}

// The orgs salesforce.orgs names, each { alias, orgId, production? }, once each, skipping any
// without an org ID; production: true only on an org marked so. checkConfig keeps that list to
// the orgs a step uses, plus the marked production orgs. In scratch mode that includes the Dev
// Hub, so a production Dev Hub in the home is accepted only when it is marked.
export function allowList(block) {
  return Object.entries(layout(block).orgs)
    .filter(([, org]) => isText(org.orgId))
    .map(([alias, org]) => ({ alias, orgId: org.orgId, ...(org.production === true ? { production: true } : {}) }));
}

// Every org in the `sf org list` result, once each: by username, or by org ID without one.
function listed(result) {
  const seen = new Set();
  const out = [];
  for (const group of GROUPS) {
    for (const e of isObject(result) && Array.isArray(result[group]) ? result[group] : []) {
      if (!isObject(e)) continue;
      const key = isText(e.username) ? `u:${e.username}` : `i:${e.orgId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

const validAlias = (e) => typeof e.alias === 'string' && ALIAS.test(e.alias);
const nameOf = (e) => (validAlias(e) ? e.alias : isText(e.orgId) ? e.orgId : 'an org with no org ID');

// sf's message with each listed username replaced by the org's name: sf often names the org it
// could not reach by the username it was given.
function withoutUsernames(text, entries) {
  let out = String(text);
  for (const e of entries) if (isText(e.username)) out = out.replaceAll(e.username, nameOf(e));
  return out;
}

// Every word holding an @ (a username, or an auth file named after one) becomes "an org".
const scrub = (text) => String(text).replace(/\S+@\S+/g, 'an org');

const listReason = (home, list) => `could not list the orgs in the isolated sf home ${home}: ${scrub(list?.error?.message ?? 'no answer')}`;

// Why the home must not hold `strays`, with a logout line for each that runs as printed.
function strayReason(home, strays) {
  const sf = `HOME=${home} SF_USE_GENERIC_UNIX_KEYCHAIN=true sf`;
  const held = strays.map((e) => `${nameOf(e)} (${isText(e.orgId) ? e.orgId : 'no org ID'})`).join(', ');
  const logout = strays.map((e) => `${sf} org logout --target-org ${validAlias(e) ? e.alias : `<the username of ${nameOf(e)}>`} --no-prompt`).join(', then ');
  const find = strays.some((e) => !validAlias(e)) ? `; find each username with ${sf} org list` : '';
  return `the isolated sf home ${home} holds ${held}, not in salesforce.orgs; sign ${strays.length === 1 ? 'it' : 'them'} out there: ${logout}${find}`;
}

// The story scratch orgs `scratch` (scratch-orgs.mjs records) adds, in scratch mode only: by
// org ID for a record that has one, never over a configured org, and by exact username for a
// 'creating' record that has none yet. A record naming another Dev Hub adds nothing.
function scratchAllowed(block, allowed, scratch) {
  const byUser = new Map();
  const { build } = layout(block);
  if (build.mode !== 'scratch' || !Array.isArray(scratch)) return byUser;
  for (const r of scratch) {
    if (!isObject(r) || !isText(r.alias) || r.devHub !== build.devHub) continue;
    if (isText(r.orgId)) {
      if (!allowed.has(id15(r.orgId))) allowed.set(id15(r.orgId), { alias: r.alias, orgId: r.orgId, scratch: true });
    } else if (isText(r.username)) byUser.set(r.username, { alias: r.alias, orgId: null, scratch: true });
  }
  return byUser;
}

export function homeVerdict({ home, block, list, query, scratch = [], hub }) {
  if (!list?.ok) return { ok: false, reason: listReason(home, list) };
  const allowed = new Map(allowList(block).map((a) => [id15(a.orgId), a]));
  const byUser = scratchAllowed(block, allowed, scratch);
  const wanted = (e) => allowed.get(id15(e.orgId)) ?? (isText(e.username) ? byUser.get(e.username) : undefined);
  const entries = listed(list.result);

  const strays = entries.filter((e) => !wanted(e));
  if (strays.length) return { ok: false, reason: strayReason(home, strays) };

  let production = 0;
  let scratchOrgs = 0;
  // The story scratch orgs found, each { name, id: its 15-character org ID }, for the Dev Hub.
  const onHub = [];
  for (const e of entries) {
    const name = nameOf(e);
    const want = wanted(e);
    const target = validAlias(e) ? e.alias : e.username;
    if (!isText(target)) return { ok: false, reason: `could not check ${name} in the isolated sf home: it has no alias or username` };
    const r = query(target);
    if (!r?.ok) return { ok: false, reason: `could not check ${name} in the isolated sf home: ${withoutUsernames(r?.error?.message ?? 'no answer', entries)}` };
    const records = isObject(r.result) && Array.isArray(r.result.records) ? r.result.records : [];
    const record = isObject(records[0]) ? records[0] : null;
    const notSandbox = { ok: false, reason: `${name} in the isolated sf home is not a sandbox and salesforce.orgs does not mark it "production": true; deployments to production are blocked` };
    if (want.scratch === true) {
      if (!record || record.IsSandbox !== true) return { ok: false, reason: `${name} in the isolated sf home is a story's scratch org, but its server says it is not a sandbox` };
      // Checked as an org ID, which also keeps it safe in the Dev Hub's SOQL.
      const sid = id15(record.Id);
      if (!/^[A-Za-z0-9]{15}$/.test(sid)) return { ok: false, reason: `${name} in the isolated sf home is a story's scratch org, but its server gave no org ID` };
      onHub.push({ name, id: sid });
      scratchOrgs += 1;
      // A 'creating' record has no org ID yet: its username matched it.
      if (!isText(want.orgId)) continue;
    } else if (want.production === true) {
      if (record?.IsSandbox === true) return { ok: false, reason: `${name} is marked "production": true in salesforce.orgs, but its server says it is a sandbox` };
      if (!record || record.IsSandbox !== false) return notSandbox;
      production += 1;
    } else if (!record || record.IsSandbox !== true) return notSandbox;
    if (id15(record.Id) !== id15(want.orgId)) return { ok: false, reason: `${name} is org ${id15(record.Id)}, not ${want.orgId}` };
  }
  if (onHub.length) {
    const devHub = layout(block).build.devHub;
    const r = typeof hub === 'function' ? hub([...new Set(onHub.map((o) => o.id))]) : null;
    if (!r?.ok) return { ok: false, reason: `could not check the story scratch orgs on the Dev Hub ${devHub}: ${scrub(withoutUsernames(r?.error?.message ?? 'no answer', entries))}` };
    const rows = isObject(r.result) && Array.isArray(r.result.records) ? r.result.records : [];
    const active = new Set(rows.filter(isObject).map((x) => id15(x.ScratchOrg)));
    const missing = onHub.find((o) => !active.has(o.id));
    if (missing) return { ok: false, reason: `${missing.name} in the isolated sf home is a story's scratch org, but ${devHub} has no active scratch org ${missing.id}` };
  }
  if (!entries.length) return { ok: true, detail: 'no orgs signed in yet' };
  if (!production && !scratchOrgs) return { ok: true, detail: `${plural(entries.length, 'org')}, all allow-listed sandboxes` };
  const sandboxes = entries.length - production - scratchOrgs;
  const parts = [`${sandboxes} allow-listed sandbox${sandboxes === 1 ? '' : 'es'}`];
  if (scratchOrgs) parts.push(plural(scratchOrgs, 'story scratch org'));
  if (production) parts.push(`${production} production (connected; deployments blocked)`);
  return { ok: true, detail: `${plural(entries.length, 'org')}: ${parts.join(', ')}` };
}

// Why the doctor must not query `alias`: the home's `sf org list` maps it to an org ID not in
// salesforce.orgs, or the list failed, so where it points is unknown. null when the alias is
// allow-listed or not in the list. Pure: it makes no sf call.
export function aliasStray({ home, block, list, alias }) {
  if (!list?.ok) return listReason(home, list);
  const entry = listed(list.result).find((e) => e.alias === alias);
  if (!entry) return null;
  const allowed = new Set(allowList(block).map((a) => id15(a.orgId)));
  return allowed.has(id15(entry.orgId)) ? null : strayReason(home, [entry]);
}

// The home's `sf org list` entry for `alias`, or null when the list failed or holds none. Pure:
// it makes no sf call.
export function listedEntry(list, alias) {
  if (list?.ok !== true) return null;
  return listed(list.result).find((e) => e.alias === alias) ?? null;
}

// `sf org list` through `sh`, which contacts no org, and the Organization query for `target`, as
// runSf answers them.
export const listOrgs = (sh) => runSf(sh, LIST_ARGS);
export const orgQuery = (sh, target, opts) => runSf(sh, ['data', 'query', '--query', ORG_QUERY, '--target-org', target], opts);
// The Dev Hub's ActiveScratchOrg rows for `ids`, 15-character org IDs homeVerdict has checked.
export const activeScratchQuery = (sh, devHub, ids) =>
  runSf(sh, ['data', 'query', '--query', `SELECT ScratchOrg FROM ActiveScratchOrg WHERE ScratchOrg IN (${ids.map((i) => `'${i}'`).join(', ')})`, '--target-org', devHub]);

// The pack's prepareSessions hook. Never throws.
export function setUp({ config, env, fs, sh, homedir }) {
  try {
    const home = sfHome(env, homedir);
    const problem = homeProblem(env, home);
    if (problem) return { ok: false, reason: problem };
    const bin = binDir(home);
    const realSf = findRealSf(env, fs, bin);
    if (!realSf) return { ok: false, reason: 'sf is not on PATH, so Foreman cannot set up the isolated sf home; install the Salesforce CLI' };
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      // mkdir's mode does not reach a home that already exists
      fs.chmodSync(home, 0o700);
      fs.mkdirSync(bin, { recursive: true });
    } catch (err) {
      return { ok: false, reason: `could not create the isolated sf home ${home}: ${message(err)}` };
    }
    const production = allowList(config?.salesforce).filter((org) => org.production === true);
    const script = wrapperScript({ realSf, dataDir: dataDir(env, homedir), production });
    try {
      for (const name of ['sf', 'sfdx']) {
        const file = path.join(bin, name);
        fs.writeFileSync(file, script, { mode: 0o755 });
        fs.chmodSync(file, 0o755);
      }
    } catch (err) {
      return { ok: false, reason: `could not write the sf wrappers in ${bin}: ${message(err)}` };
    }
    const iso = isolatedSh(sh, env, home, homedir);
    const scratch = readScratchOrgs(env?.FOREMAN_STATE_DIR);
    const hub = (ids) => activeScratchQuery(iso, layout(config?.salesforce).build.devHub, ids);
    const verdict = homeVerdict({ home, block: config?.salesforce, list: listOrgs(iso), query: (target) => orgQuery(iso, target), scratch, hub });
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    return {
      ok: true,
      session: {
        env: { FOREMAN_SF_HOME: home, SF_DISABLE_TELEMETRY: 'true' },
        pathPrefix: [bin],
        // `//` is an absolute path in a permission rule; a deny beats --allowedTools Read, and
        // Read rules cover Grep and Glob too.
        settings: { enabledPlugins: { [SF_PLUGIN]: false }, permissions: { deny: [`Read(/${keyRoot(homedir)}/**)`] } },
      },
    };
  } catch (err) {
    return { ok: false, reason: `could not set up the isolated sf home: ${message(err)}` };
  }
}
