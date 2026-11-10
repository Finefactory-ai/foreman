// The production block inside the sf wrapper. Deployments to production are blocked, and once
// salesforce.orgs marks a production org "production": true and it is signed in to the isolated
// sf home, the Bash guard (guard.mjs) cannot hold that alone: it reads only the Bash text, so a
// launcher with flags (`nice -n 5 sf ...`), a script, an npm script, or a default org written to
// .sf/config.json with the Write tool all get past it. Every sf and sfdx call a session makes
// runs through the wrapper (isolation.mjs), so the wrapper runs this check first, through
// sf-prod-check.mjs, whenever a production org is marked. The guard shares these rules, so both
// layers count commands the same way.
//
// The rule is an allow-list (the owner's ruling of 2026-10-25). Against a marked production org
// sf may run only the commands in PROD_ALLOWED: reads, record changes, describe and schema
// commands, the org lists, retrieves, Apex logs, user and permission-set commands, and scratch
// org create and delete with production as the Dev Hub; a record change only without
// -t/--use-tooling-api, since that writes metadata. Every other command that names
// production, or reaches it through a default org, is refused: deploys, `org display`, `org
// open`, `api request`, anonymous Apex, `package *`, `org create sandbox`, every legacy `force:*`
// alias, and any command the list does not name.
//
//   PROD_ALLOWED         the allowed sf v2 command ids (CLI 2.150.6), each { id, devHubOnly?,
//                        tooling? }. devHubOnly: production may be named only as the value of a
//                        dev-hub spelling. tooling: the record changes that take
//                        -t/--use-tooling-api
//   allowedEntry(cmd)    the entry whose id words equal `cmd`'s as a set, with the same length
//                        (sf's flexibleTaxonomy runs `sf list org`), or null
//   TARGET_SPELLINGS, DEVHUB_SPELLINGS, DEVOPS_SPELLINGS
//                        every spelling sf 2.150.6 accepts for target-org (-o, --target-org, -u,
//                        --u, --targetusername), target-dev-hub, and devops-center-username (-c,
//                        counted only on `project deploy pipeline` commands). Each is read as
//                        `flag value`, `flag=value` and, for one letter, `-ovalue`
//   DEVHUB_COMMANDS      the ids that take target-dev-hub, whose dev-hub default sf reads
//   isProductionName(production, text)
//                        the marked org `text` names: an alias exactly, or an org ID (18 or 15
//                        characters) by its first 15 characters
//   namesProduction(texts, isProd, { skipDevHub })
//                        the first production org any argument word names, or null. It reads
//                        every word, not only flag values, so no spelling slips past: each word
//                        not starting with -, the part after the first = of one that does, and
//                        the part after the first two characters of a longer single-dash word.
//                        skipDevHub skips the values of the dev-hub spellings
//   commandWords(args)   sf's command words: those before the first flag, split at colons
//   deploys(cmd), exposes(cmd), deployEndpoint(words), toolingWrite(cmd, words)
//                        whether a command deploys (as the guard counts it, in any order), prints
//                        or hands out credentials or calls the API directly, names a deploy
//                        endpoint, or is a record change that writes Tooling API objects (given -t,
//                        any long spelling of use-tooling-api, such as --use-tooling-api or the
//                        deprecated --usetoolingapi, with or without =..., or --flags-dir, which
//                        could add it out of sight), which changes metadata outside a deploy. They pick
//                        the reason and decide when an unknown target fails closed; an allowed
//                        command that names a deploy endpoint (a Tooling MetadataContainer record,
//                        say) is also checked as a deploy, and a Tooling write as a metadata change
//   plainlyAllowed(args) whether sf runs `args` against production without a file read: an
//                        allowed entry, not Dev Hub only, naming no deploy endpoint and no Tooling
//                        write. sf-prod-check.mjs uses it when the check itself fails
//   prodReason({ args, env, cwd, home, production, fs })
//                        why sf must not run `args`, or null. An allowed command runs without a
//                        file read. Any other is refused when an argument word names production
//                        (by alias, org ID, a username, or another alias in the home's
//                        .sfdx/alias.json whose <username>.json login holds a marked org ID), or
//                        when its target does. The targets are the target spellings' values (and
//                        -c on pipeline commands, and the dev-hub spellings' unless the entry is
//                        devHubOnly; a pipeline deploy with no -c or --devops-center-username is
//                        refused, since its org is not the target-org default), or, with none
//                        given, the default sf uses, in its order:
//                        SF_TARGET_ORG, SFDX_DEFAULTUSERNAME or SFDX_TARGET_ORG; else target-org
//                        (or the legacy defaultusername) in .sf/config.json or
//                        .sfdx/sfdx-config.json at the project root (the nearest folder with
//                        sfdx-project.json); else the same files in the home. A Dev Hub command
//                        with no dev-hub spelling also reads the dev-hub default the same way
//                        (SF_TARGET_DEV_HUB, SFDX_DEFAULTDEVHUBUSERNAME, target-dev-hub,
//                        defaultdevhubusername). --flags-dir, which can name the org out of
//                        sight, is refused with any command that is not plainly allowed; so is a
//                        deploy, Tooling write or credential command whose target it cannot
//                        resolve. Any other command it cannot tie to production runs.
//
// A reason names an org by its alias in salesforce.orgs, or its 15-character ID, never by a
// username. With no production org marked, the wrapper has no check and this never runs.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const SF_PROD_CHECK = fileURLToPath(new URL('./sf-prod-check.mjs', import.meta.url));

// The only commands that may target a marked production org.
export const PROD_ALLOWED = Object.freeze(
  [
    // reads
    'data:query',
    'data:search',
    'data:get:record',
    'data:export:tree',
    'data:export:bulk',
    'data:export:resume',
    'data:bulk:results',
    // record changes: the owner allows changes that are not deploys (story sessions' guard still
    // denies them). tooling: with -t or --use-tooling-api these write Tooling API objects
    // (CustomField, Flow, ValidationRule), which are metadata, so they are allowed only without it
    // (see toolingWrite)
    { id: 'data:create:record', tooling: true },
    { id: 'data:update:record', tooling: true },
    { id: 'data:delete:record', tooling: true },
    'data:upsert:bulk',
    'data:upsert:resume',
    'data:import:tree',
    'data:import:bulk',
    'data:import:resume',
    'data:delete:bulk',
    'data:delete:resume',
    'data:update:bulk',
    'data:update:resume',
    // describe and schema
    'sobject:describe',
    'sobject:list',
    'schema:generate:field',
    'schema:generate:sobject',
    'schema:generate:platformevent',
    'schema:generate:tab',
    // lists
    'org:list',
    'org:list:limits',
    'org:list:metadata',
    'org:list:metadata-types',
    // retrieve
    'project:retrieve:start',
    'project:retrieve:preview',
    // Apex logs
    'apex:list:log',
    'apex:get:log',
    'apex:tail:log',
    // users and permission sets
    'org:create:user',
    'org:assign:permset',
    'org:assign:permsetlicense',
    'org:list:users',
    // Dev Hub use: production only as the dev hub
    { id: 'org:create:scratch', devHubOnly: true },
    { id: 'org:delete:scratch', devHubOnly: true },
  ].map((e) => Object.freeze(typeof e === 'string' ? { id: e } : { ...e })),
);

export const ALLOWED_SUMMARY =
  'queries, searches, record gets and exports; record changes; sobject describe/list and schema generate; ' +
  'org list, limits, metadata and metadata types; project retrieve start/preview; Apex log list/get/tail; ' +
  'user and permission-set commands; scratch org create/delete on a production Dev Hub';

export const TARGET_SPELLINGS = Object.freeze(['-o', '--target-org', '-u', '--u', '--targetusername']);
export const DEVHUB_SPELLINGS = Object.freeze(['-v', '--target-dev-hub', '--targetdevhubusername', '--target-hub-org']);
// Counted only on `project deploy pipeline` commands: elsewhere -c means code coverage or
// ignore conflicts.
export const DEVOPS_SPELLINGS = Object.freeze(['-c', '--devops-center-username']);

// The ids that take target-dev-hub in 2.150.6, apart from org:create:scratch (on the allow-list).
export const DEVHUB_COMMANDS = Object.freeze([
  'org:create:snapshot',
  'org:delete:snapshot',
  'org:get:snapshot',
  'org:list:snapshot',
  'package:convert',
  'package:create',
  'package:delete',
  'package:list',
  'package:update',
  'package:push-upgrade:abort',
  'package:push-upgrade:list',
  'package:push-upgrade:report',
  'package:push-upgrade:schedule',
  'force:package:push-upgrade:list',
  'package:version:create',
  'package:version:create:list',
  'package:version:create:report',
  'package:version:delete',
  'package:version:displayancestry',
  'package:version:displaydependencies',
  'package:version:list',
  'package:version:promote',
  'package:version:report',
  'package:version:retrieve',
  'package:version:update',
]);

// With `deploy`, the words of a command that deploys: `project deploy start|validate|quick|resume`,
// `deploy metadata`, `force:source:deploy` and `force:mdapi:deploy`. DevOps Center's
// `devops promote` and `devops promotion complete|validate` deploy to a pipeline stage's org,
// and the last stage is production, so they count as deploys too.
const DEPLOY_WORDS = ['start', 'validate', 'quick', 'resume', 'metadata', 'source', 'mdapi'];
// With `agent`, the words of a command that changes an agent in the org.
const AGENT_WORDS = ['publish', 'create', 'activate', 'deactivate'];
// Where sf reads a default org, and a default dev hub, with no flag given.
const ORG_DEFAULTS = { env: ['SF_TARGET_ORG', 'SFDX_DEFAULTUSERNAME', 'SFDX_TARGET_ORG'], keys: ['target-org', 'defaultusername'] };
const DEVHUB_DEFAULTS = { env: ['SF_TARGET_DEV_HUB', 'SFDX_DEFAULTDEVHUBUSERNAME'], keys: ['target-dev-hub', 'defaultdevhubusername'] };
const CONFIGS = [
  ['.sf', 'config.json'],
  ['.sfdx', 'sfdx-config.json'],
];
const ORG_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
// The Metadata API's REST deploy and SOAP endpoints, and the Tooling API's deploy containers.
// Not `*Member`: GroupMember and other ordinary objects end that way.
export const DEPLOY_ENDPOINT = /deployRequest|\/services\/Soap\/m\/|MetadataContainer|ContainerAsyncRequest/i;

const START = 'foreman: sf refused:';
const PROD = (alias) =>
  `${START} this deploys to ${alias}, a production org marked "production": true in salesforce.orgs; Foreman never deploys to production. Against production Foreman runs only: ${ALLOWED_SUMMARY}.`;
const TOOLING = (alias) =>
  `${START} this changes metadata in ${alias}, a production org marked "production": true in salesforce.orgs, through the Tooling API: a record change with --use-tooling-api (or flags from --flags-dir) writes fields, flows and other metadata. Deployments and metadata changes to production are blocked. Change records without --use-tooling-api.`;
const EXPOSE = (alias) =>
  `${START} this prints or hands out the credentials of ${alias}, a production org marked "production": true in salesforce.orgs, or calls its API directly, so Foreman does not run it. Query, describe or retrieve with sf instead.`;
const NOT_ALLOWED = (alias) =>
  `${START} ${alias} is a production org marked "production": true in salesforce.orgs, and this command is not one Foreman allows against production. Against production Foreman runs only: ${ALLOWED_SUMMARY}. Deployments to production are blocked.`;
const UNKNOWN = `${START} Foreman could not tell which org this runs against, and a production org is signed in, so it does not run. Use the slot org: give no target, or its alias with -o.`;
const FLAGS_DIR = `${START} --flags-dir with a command Foreman does not allow against production: the flags there can name a production org Foreman cannot see. Give the flags on the command line.`;

const isText = (v) => typeof v === 'string' && v.length > 0;
const id15 = (v) => (typeof v === 'string' ? v.slice(0, 15) : '');

// Whether the words of `id` equal `cmd` as a set, with the same length.
function sameWords(id, cmd) {
  const parts = id.split(':');
  return parts.length === cmd.length && parts.every((p) => cmd.includes(p)) && cmd.every((w) => parts.includes(w));
}

export function allowedEntry(cmd) {
  const words = Array.isArray(cmd) ? cmd.map(String) : [];
  return PROD_ALLOWED.find((entry) => sameWords(entry.id, words)) ?? null;
}

// Whether `cmd` is a Dev Hub command, by its id or a legacy `force:` alias of it
// (`force:package:version:create`).
function devHubCommand(cmd) {
  const bare = cmd.filter((w) => w !== 'force');
  return DEVHUB_COMMANDS.some((id) => sameWords(id, cmd) || sameWords(id, bare));
}

export function isProductionName(production, text) {
  if (!isText(text) || !Array.isArray(production)) return null;
  const isId = ORG_ID.test(text);
  return production.find((o) => o && ((isText(o.alias) && o.alias === text) || (isId && isText(o.orgId) && id15(o.orgId) === id15(text)))) ?? null;
}

const ONE_LETTER_DEVHUB = DEVHUB_SPELLINGS.filter((f) => f.length === 2);

export function namesProduction(texts, isProd, { skipDevHub = false } = {}) {
  const words = Array.isArray(texts) ? texts.map(String) : [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const candidates = [];
    if (!word.startsWith('-')) candidates.push(word);
    else if (skipDevHub && DEVHUB_SPELLINGS.includes(word)) {
      // the dev hub's value: the next word, unless it is a flag
      if (words[i + 1] !== undefined && !words[i + 1].startsWith('-')) i += 1;
    } else {
      const eq = word.indexOf('=');
      if (eq !== -1 && !(skipDevHub && DEVHUB_SPELLINGS.includes(word.slice(0, eq)))) candidates.push(word.slice(eq + 1));
      if (!word.startsWith('--') && word.length > 2 && !(skipDevHub && ONE_LETTER_DEVHUB.some((f) => word.startsWith(f)))) {
        // sf reads one-letter flags run together (-goacme-main is -g -o acme-main), so every
        // tail of the word may be a value: try each one.
        const body = eq === -1 ? word : word.slice(0, eq);
        for (let k = 2; k < body.length; k += 1) candidates.push(body.slice(k));
      }
    }
    for (const text of candidates) {
      // A comma-separated list (an org list, say) names every org in it.
      for (const part of String(text).split(',')) {
        const hit = part ? isProd(part) : null;
        if (hit) return hit;
      }
    }
  }
  return null;
}

export function commandWords(args) {
  const out = [];
  for (const a of args) {
    if (String(a).startsWith('-')) break;
    out.push(...String(a).split(':'));
  }
  return out;
}

export function deploys(cmd) {
  const has = (...parts) => parts.every((p) => cmd.includes(p));
  return (
    (has('deploy') && DEPLOY_WORDS.some((w) => has(w))) ||
    has('delete', 'source') ||
    has('source', 'push') ||
    has('org', 'delete') ||
    has('org', 'refresh') ||
    (has('package') && (has('install') || has('uninstall'))) ||
    pushesUpgrade(cmd) ||
    (has('agent') && AGENT_WORDS.some((w) => has(w))) ||
    has('community', 'publish') ||
    (has('devops') && (has('promote') || has('promotion')))
  );
}

// package push-upgrade schedule pushes package code into orgs named by org ID in a list or a
// file Foreman cannot see, so while a production org is marked it is refused whatever it names.
export function pushesUpgrade(cmd) {
  return cmd.includes('package') && cmd.includes('push-upgrade');
}

export function exposes(cmd) {
  const has = (...parts) => parts.every((p) => cmd.includes(p));
  return (
    (has('display') && (has('org') || has('user'))) ||
    (has('open') && (has('org') || has('source'))) ||
    has('password', 'generate') ||
    (has('auth') && cmd.some((w) => w.startsWith('show-'))) ||
    has('api', 'request')
  );
}

export function deployEndpoint(words) {
  return words.some((w) => DEPLOY_ENDPOINT.test(String(w)));
}

const givesFlagsDir = (words) => words.some((w) => w === '--flags-dir' || w.startsWith('--flags-dir='));
// A long flag's name with its dashes and hyphens dropped, lower-cased: --use-tooling-api,
// --usetoolingapi (the CLI's deprecated alias) and any later spelling of it all give
// 'usetoolingapi', so a new alias fails closed.
const longName = (w) => (w.startsWith('--') ? w.split('=')[0].replace(/-/g, '').toLowerCase() : null);
// -t, and any single-dash word starting -t, fails closed: no other flag on these commands is -t.
const usesTooling = (words) => words.some((w) => longName(w) === 'usetoolingapi' || (w.startsWith('-t') && !w.startsWith('--')));

export function toolingWrite(cmd, words) {
  const texts = (Array.isArray(words) ? words : []).map(String);
  return allowedEntry(cmd)?.tooling === true && (usesTooling(texts) || givesFlagsDir(texts));
}

export function plainlyAllowed(args) {
  const words = (Array.isArray(args) ? args : []).map(String);
  const cmd = commandWords(words);
  const entry = allowedEntry(cmd);
  return Boolean(entry && !entry.devHubOnly && !deployEndpoint(words) && !toolingWrite(cmd, words));
}

// Each value given to one of `flags`, or null for a flag given no value.
function flagValues(args, flags) {
  const values = [];
  args.forEach((word, i) => {
    const next = args[i + 1];
    for (const flag of flags) {
      if (word === flag) values.push(isText(next) && !next.startsWith('-') ? next : null);
      else if (word.startsWith(`${flag}=`)) values.push(word.slice(flag.length + 1));
      else if (flag.length === 2 && word.startsWith(flag) && !word.startsWith('--')) values.push(word.slice(2));
      else continue;
      break;
    }
  });
  return values;
}

// The parsed JSON in `file`: undefined when there is no file, null when it cannot be read.
function readJson(fs, file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err?.code === 'ENOENT' ? undefined : null;
  }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// The nearest folder at or above `cwd` holding sfdx-project.json, as sf finds its project, or null.
function projectRoot(cwd, fs) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'sfdx-project.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

// The defaults `keys` name in `dir`'s config files, with null for a file it cannot read.
function configTargets(dir, fs, keys) {
  const out = [];
  for (const parts of CONFIGS) {
    const config = readJson(fs, path.join(dir, ...parts));
    if (config === null) out.push(null);
    else if (config) for (const key of keys) if (isText(config[key])) out.push(config[key]);
  }
  return out;
}

// The default sf uses with no flag, in sf's order: the environment, then the project's config,
// then the home's. Every value at the first level that has one, since more than one name there
// may be read. `which` is ORG_DEFAULTS or DEVHUB_DEFAULTS.
function defaultTargets(env, cwd, home, fs, which) {
  const fromEnv = which.env.map((name) => env?.[name]).filter(isText);
  if (fromEnv.length) return fromEnv;
  const root = projectRoot(cwd, fs);
  const local = root ? configTargets(root, fs, which.keys) : [];
  if (local.length) return local;
  return isText(home) ? configTargets(home, fs, which.keys) : [];
}

// The production org `value` names, false when it names another org whose login is in the home,
// or null when it cannot tell.
function resolve(value, { home, production, fs, aliases }) {
  if (!isText(value)) return null;
  const direct = isProductionName(production, value);
  if (direct) return direct;
  if (aliases === null || !isText(home)) return null;
  const username = isText(aliases?.[value]) ? aliases[value] : value;
  if (username.includes('/') || username.includes('\\') || username === '.' || username === '..') return null;
  const login = readJson(fs, path.join(home, '.sfdx', `${username}.json`));
  if (!login || !isText(login.orgId)) return null;
  return production.find((o) => id15(o.orgId) === id15(login.orgId)) ?? false;
}

export function prodReason({ args, env, cwd, home, production, fs }) {
  const marked = (Array.isArray(production) ? production : []).filter((o) => o && isText(o.orgId));
  if (!marked.length) return null;
  const words = (Array.isArray(args) ? args : []).map(String);
  const cmd = commandWords(words);
  // An allowed command runs, unless it names a deploy endpoint (a Tooling MetadataContainer
  // record, say), which is checked as a deploy, or writes Tooling API objects, which is checked
  // as a metadata change.
  if (plainlyAllowed(words)) return null;
  const entry = allowedEntry(cmd);

  const deploying = deploys(cmd) || deployEndpoint(words);
  const tooling = toolingWrite(cmd, words);
  const exposing = exposes(cmd);
  const why = deploying ? PROD : tooling ? TOOLING : exposing ? EXPOSE : NOT_ALLOWED;
  const refuse = (org) => why(org.alias || id15(org.orgId));
  if (givesFlagsDir(words)) return FLAGS_DIR;
  if (pushesUpgrade(cmd)) return refuse(marked[0]);

  const file = isText(home) ? readJson(fs, path.join(home, '.sfdx', 'alias.json')) : undefined;
  const ctx = { home, production: marked, fs, aliases: file === null ? null : (file?.orgs ?? {}) };
  const devHubOnly = entry?.devHubOnly === true;
  const named = namesProduction(words, (text) => resolve(text, ctx) || null, { skipDevHub: devHubOnly });
  if (named) return refuse(named);

  const pipeline = ['project', 'deploy', 'pipeline'].every((w) => cmd.includes(w));
  // A pipeline deploy runs against its DevOps Center org, which sf does not take from the
  // target-org default, so with none given it is refused.
  if (pipeline && deploying && !flagValues(words, DEVOPS_SPELLINGS).length) return UNKNOWN;
  const given = flagValues(words, pipeline ? [...TARGET_SPELLINGS, ...DEVOPS_SPELLINGS] : TARGET_SPELLINGS);
  const devHubs = flagValues(words, DEVHUB_SPELLINGS);
  const values = [...given, ...(devHubOnly ? [] : devHubs)];
  if (!given.length) values.push(...defaultTargets(env, cwd, home, fs, ORG_DEFAULTS));
  if (!devHubs.length && devHubCommand(cmd)) values.push(...defaultTargets(env, cwd, home, fs, DEVHUB_DEFAULTS));
  const resolved = values.map((value) => resolve(value, ctx));
  const prod = resolved.find((r) => r);
  if (prod) return refuse(prod);
  if ((deploying || tooling || exposing) && (!resolved.length || resolved.some((r) => r === null))) return UNKNOWN;
  // A name that is not in the sf home is unknown to sf as well, so it cannot reach production.
  // But when the home's alias file cannot be read, no alias can be tied to an org, so a command
  // off the allow-list that names any target does not run.
  if (!entry && ctx.aliases === null && resolved.some((r) => r === null)) return UNKNOWN;
  return null;
}
