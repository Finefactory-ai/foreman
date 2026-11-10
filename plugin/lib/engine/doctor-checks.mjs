// The checks behind `foreman doctor`. `buildChecks(config, ctx)` returns a list of
// { name, step, run(ctx) -> { ok, level: 'error' | 'warn', detail, fix? } }. Every check runs;
// none stops the others. A check that is not ok at level 'error' fails the doctor; at level
// 'warn' it only advises.
//
// `step` is the set-up step the check belongs to (lib/setup/steps.mjs). Every result that is
// not ok carries fix: { step, hint, action? }: a short plain hint, and the step that fixes it.
// buildChecks passes every check through withFix (lib/setup/fix.mjs), so fix.step is the
// check's own step unless the result names another: the env check names the step that owns
// the first missing key (lib/setup/keys.mjs). A pack check with no step belongs to 'project'.
//
// ctx: { root, env, sh(cmd, args, opts?) -> { status, stdout, stderr }, fs, sourceRoot,
//        pluginsDir, configErrors?, localWarnings?, fetch?, now?, packs?, platform?, home?,
//        uid?, loadavg?, cores?, alive? }. loadavg (os.loadavg), cores
// (os.availableParallelism()) and alive (supervisor-pid.mjs defaultAlive) stand in for the machine
// in the 'machine load' check's tests. platform (process.platform), home (the user's home folder) and uid are where
// the 'background service' check looks for the service (service.mjs); with no platform it
// finds no service manager. It warns when the service starts a Node that is not there any more
// (an upgrade removed it), one that is there but does not start (`node --version` through ctx.sh,
// as after a Homebrew upgrade replaced a library it needs; node-path.mjs probeNode), in that
// order, or another copy of Foreman. With a config, 'stray processes' counts
// the supervisors, hook runs and `foreman learn` or `notify` runs that are not this run's
// (strays.mjs), in temp folders or this project's folders and over 10 minutes
// old, from ps and lsof through ctx.sh (ctx.strayRoots stands in for the temp folders in
// tests): ok when there are none or ps cannot run, else a warn with their count and memory, a
// note that a run kept in a temp folder counts as one too, and the hint
// `foreman doctor --end-strays`. It never ends one.
//
// 'macOS privacy prompts' (tools step, only when ctx.platform is darwin) is ok either way; with the
// background service installed it says that launchd starts the run, so macOS asks on behalf of
// node when something reaches a private folder, that Foreman never needs one, and to answer
// Don't Allow. Story sessions are kept off such folders (scan-guard.mjs).
//
// With a config, 'story sessions' (tools step) lists the story sessions running (`ps` and each
// one's folder through ctx.sh; live-sessions.mjs) and warns when one slot folder has two, naming
// the slot, the stories, the pids and a `kill <pid>` for each session but the oldest. Both edit
// the same worktree and both are paid for. ok when none does, or 'could not list the running
// processes' when ps cannot run. It never ends one.
//
// With a config, 'last interrupt' (tools step) reads last-interrupt in the state folder
// (signal-source.mjs), written by the supervisor when a signal stops the run: ok when there is
// none or it is over 7 days old; ok, naming the time, for a plain interrupt (Ctrl-C, kill or a
// closed terminal); a warn naming the story, the slot and the command when a story session's agent
// had just run a kill command, which a story session must never do (kill-guard.mjs).
//
// With a config, 'owner claims' (project step) lists the owner's claims in the state folder
// (locks.mjs) and warns for each whose story is done, retired or missing from the story source's
// list (scheduler.mjs ownerClaimFate), naming the story ids only. It reads the list from the
// cache (the source's cacheOnly), so it never calls Jira or sf, and it removes nothing: the run
// clears them on its first tick (supervisor.mjs sweepOwnerClaims). ok with no owner claims
// (reading no stories), 'could not read the stories' when the source cannot be opened or its list
// cannot be read (a missing stories folder), and ok when the list is empty, since an empty list
// says nothing.
//
// With a config, 'stale control' (project step) looks for what a run left that nothing will settle
// (stale-control.mjs): a build-next request in control.json already handled, and a
// supervisor-adopted.json whose voucher process is gone (ctx.pidExists stands in for the process
// check in tests). ok when there is none. Outside a story session it clears them, with one event,
// and says `cleared ...`; with FOREMAN_RUN=1 it clears nothing and only warns. A voucher whose
// process lives is never removed.
//
// With a config, 'machine load' (tools step) looks at the machine while a run is going
// (runningSupervisor for the state folder): ok, 'no run going', when none is, or a pid file is
// left by a run that died; ok with the 1-minute load and the cores when the load is at most twice
// the cores; else a warn naming the five busiest processes by CPU (`ps -Ao pid=,pcpu=,comm=`, on
// macOS and Linux, or 'could not list the processes'), with the hint to run fewer stories at once
// with `foreman workers <n>`. It is a warn only, never an error. The env check reads
// variable NAMES only; it never loads the envFile into the environment and never puts a value
// into a result.
//
// `config` is the resolved config (lib/settings/load.mjs loadResolved): the team's file with
// this machine's local settings on top. Each local value that is ignored is a warning of its
// own under "local settings". With the Jira story source, the checks in doctor-jira.mjs run too.
// When the config names a pack (plugin/packs/index.mjs), its steps and env adapters count in
// what the doctor requires, and its own checks run after the Jira ones. A pack env adapter that
// reuses a core adapter's name fails the doctor, as it fails openEnvAdapter, and then no env
// adapter counts in what the doctor requires. ctx.packs stands in for the real pack registry in
// tests.
//
// Foreman's own keys (foreman-keys.mjs) belong in config `foremanEnvFile` (.env.foreman), which
// no slot gets, not in the envFile, which every slot links. With a config, 'foreman keys file'
// checks git ignores that file (adding the .gitignore line when git says no, except inside a
// story session, FOREMAN_RUN=1, where it only warns) and that only its owner can read it;
// 'foreman keys placement' warns, by name, about any of Foreman's keys still in the envFile.
// The env check counts the names in the envFile, Foreman's names in .env.foreman and the
// environment, and says which file each missing name belongs in.
//
// With a config, 'check commands on PATH' (tools step) takes the first word of every configured
// check's `run` and its `quick` (any `when`), skipping leading NAME=value words and any word that
// is not a plain name (a path or a substitution), and asks the shell `command -v` for each once.
// It warns, never fails, naming the ones not found: a story session runs the checks with the PATH
// the run started with (plus a pack's folders), not the PATH an agent's own shell has, so a
// supervisor started without a login shell can lack a tool the checks need. ok when all are found
// or there is nothing to look for.
//
// With a config, 'merged code tested' says which step of the release tests the code merged with
// the base (a step marked testsMergedCode), or that merge-main runs the checks on it, and warns
// when neither applies.
//
// With a config, 'role agents' (project step) warns, never fails, when a role names an agent it
// cannot find: roles.architect, each roles.builders entry, roles.tester and each reviewer. An
// entry with no agent string is skipped (config validation reports it). A `foreman:<n>` agent
// must be agents/<n>.md in the plugin folder (ctx.sourceRoot); an agent of another plugin
// (`<other>:<n>`) is not checked; a plain `<n>` must be <root>/.claude/agents/<n>.md, or, only
// with session.userSettings true, <home>/.claude/agents/<n>.md. A name outside letters, digits,
// `_`, `.` and `-`, or `.` or `..`, counts as missing and builds no path, so it never probes
// outside the folder. A missing builder adds that the architect can still pick it and its build
// fails.
//
// With a config, the Cloud runner step's checks (doctor-cloud.mjs) run when their files are
// there: the Actions workflow and its secrets, and the container's .env.runner.
//
// With a config, three checks report on self-learning (learning-health.mjs), ok or warn only:
// 'learning' says whether it is on (learning.auto, learning.apply), the items in force and on
// trial, and the rollbacks and refusals of the last 7 days, and warns when learning.jsonl cannot
// be read; 'learning caps', only with learning.auto on, warns at each cap reached; 'learned
// skills and pack tags', only when skills-lock.json reads cleanly with a skill in it and a learned
// skill is in force, warns about each learned skill whose version in force names a pack skill
// that moved to another tag or commit, or left the lock. They print ids, skill names, tags and
// short commits, never a learned item's text.
//
// With a config, 'story session scope' (Claude Code step) checks what story sessions load
// (session-scope.mjs): an error when session.mcpServers names a server the project's .mcp.json
// does not define, or .mcp.json cannot be read, saying when that server is defined only in the
// user's ~/.claude.json; else a warning when a session.extraTools entry mcp__<server>__... names
// a server session.mcpServers does not; else ok, saying what sessions leave out unless
// session.userSettings is true.
//
// With a config, 'agent models' (Claude Code step) looks at the newest run record that ended in
// the last 7 days and has its agents (run-record.mjs; ctx.now stands in for the clock). Its
// modelMismatches name each agent that ran on another model family than its role is set to: a
// warn with the story, the end time and those texts, never an error. ok when the newest session
// has none, or when no session in the last 7 days recorded its agents. Only the newest session
// decides, so the warning clears once a later session runs on the right models.

import os from 'node:os';
import path from 'node:path';
import { resolveTraits } from './traits.mjs';
import { jiraChecks } from './doctor-jira.mjs';
import { cloudChecks } from './doctor-cloud.mjs';
import { signInCheck } from './claude-signin.mjs';
import { addIgnoreLine, foremanEnvName, foremanEnvPath, foremanKeysIn, isForemanKey, isIgnored, projectEnvName, projectEnvPath } from './foreman-keys.mjs';
import { stepsFor } from '../adapters/ship/registry.mjs';
import { envAdaptersFor } from './env-adapter.mjs';
import { PACKS, packFor } from '../../packs/index.mjs';
import * as emailResend from '../adapters/notify/email-resend.mjs';
import { parsePluginList } from './plugin-list.mjs';
import { copyWarning, installedCopies, ownCopy, sessionPlugin } from './plugin-copy.mjs';
import { withFix } from '../setup/fix.mjs';
import { stepForKey } from '../setup/keys.mjs';
import { stateDir } from './paths.mjs';
import { claims } from './locks.mjs';
import { openStorySource } from './story-source.mjs';
import { ownerClaimFate } from './scheduler.mjs';
import { readRuns } from './run-record.mjs';
import { FOREMAN_BIN, openService } from './service.mjs';
import { defaultAlive, isStopped, pidExists, runningSupervisor } from './supervisor-pid.mjs';
import { clearStaleControl, staleControl, staleParts } from './stale-control.mjs';
import { findStrays, straysText } from './strays.mjs';
import { foldersText, killText, listStorySessions, planLive } from './live-sessions.mjs';
import { readInterrupt } from './signal-source.mjs';
import { slotIds, worktreeOf } from './worktree.mjs';
import { currentItems, readLedger } from './learning-store.mjs';
import { learnerSpentToday } from './learner.mjs';
import { learningStatus, movedPackSkills } from './learning-health.mjs';
import { readLock } from '../../packs/salesforce/skills.mjs';
import { DEFAULTS } from '../config/defaults.mjs';
import { MCP_NAME, projectMcpServers, userMcpServer } from './session-scope.mjs';
import { ENGINE_CLI } from './review-engine.mjs';
import { likelyHomebrew, probeNode } from './node-path.mjs';

export { parsePluginList };

const NOTIFIERS = { 'email-resend': emailResend };

// `fix` is { hint, step?, action? }; an ok result never carries one.
const ok = (detail = '') => ({ ok: true, level: 'error', detail });
const fail = (detail, fix) => ({ ok: false, level: 'error', detail, ...(fix ? { fix } : {}) });
const warn = (detail, fix) => ({ ok: false, level: 'warn', detail, ...(fix ? { fix } : {}) });
const hint = (text) => ({ hint: text });

const AGENT_NAME = /^[A-Za-z0-9_.-]+$/;

// [label, agent] for every role that names an agent as a non-empty string.
function roleAgentPairs(roles) {
  const pairs = [];
  if (roles?.architect) pairs.push(['roles.architect', roles.architect.agent]);
  for (const [key, builder] of Object.entries(roles?.builders ?? {})) pairs.push([`roles.builders.${key}`, builder?.agent]);
  if (roles?.tester) pairs.push(['roles.tester', roles.tester.agent]);
  (Array.isArray(roles?.reviewers) ? roles.reviewers : []).forEach((r, i) => pairs.push([`roles.reviewers.${r?.name ?? i}`, r?.agent]));
  return pairs.filter(([, agent]) => typeof agent === 'string' && agent !== '');
}

function roleAgentsResult(config, ctx) {
  const userDir = config.session?.userSettings === true ? path.join(ctx.home ?? os.homedir(), '.claude', 'agents') : null;
  const usable = (n) => AGENT_NAME.test(n) && n !== '.' && n !== '..';
  const missing = [];
  for (const [label, agent] of roleAgentPairs(config.roles)) {
    const colon = agent.indexOf(':');
    const plugin = colon === -1 ? null : agent.slice(0, colon);
    const n = colon === -1 ? agent : agent.slice(colon + 1);
    if (plugin !== null && plugin !== 'foreman') continue;
    if (plugin === 'foreman') {
      if (!usable(n) || !ctx.fs.existsSync(path.join(ctx.sourceRoot, 'agents', `${n}.md`))) missing.push({ label, text: `${label} names ${agent} (no agents/${n}.md in Foreman)` });
    } else if (!usable(n) || !(ctx.fs.existsSync(path.join(ctx.root, '.claude', 'agents', `${n}.md`)) || (userDir && ctx.fs.existsSync(path.join(userDir, `${n}.md`))))) {
      missing.push({ label, text: `${label} names ${agent} (no .claude/agents/${n}.md in the project)` });
    }
  }
  if (!missing.length) return ok();
  const tail = missing.some((m) => m.label.startsWith('roles.builders.')) ? '; the architect can still pick that builder and its build fails' : '';
  return warn(`not found: ${missing.map((m) => m.text).join('; ')}${tail}`, hint('point that role\'s agent at one that exists, or remove it from roles in foreman.config.json'));
}

const uniq = (list) => [...new Set(list)];

// Variable names in an env file: `NAME=...` or `export NAME=...` lines. Values are dropped here.
export function namesInEnvFile(fs, file) {
  let text;
  try {
    text = String(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const names = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.push(m[1]);
  }
  return names;
}

// What the configured adapters, ship steps and pack declare they need: { env: [...], tools: [...] }.
export function requirements(config, { packs = PACKS } = {}) {
  const env = [];
  const tools = [];
  const add = (r) => {
    env.push(...(r?.env ?? []));
    tools.push(...(r?.tools ?? []));
  };
  const notify = config.notify ?? { adapter: 'none' };
  const notifier = Object.hasOwn(NOTIFIERS, notify.adapter) ? NOTIFIERS[notify.adapter] : null;
  if (notifier) add(notifier.requiresFor ? notifier.requiresFor(notify) : notifier.requires);
  const envOptions = config.env ?? { adapter: 'none' };
  let envAdapters;
  try {
    envAdapters = envAdaptersFor(config, packs);
  } catch {
    envAdapters = {}; // an unknown pack or a clash is the doctor's business, not a quiet pick
  }
  const envAdapter = Object.hasOwn(envAdapters, envOptions.adapter) ? envAdapters[envOptions.adapter] : null;
  if (envAdapter) add(envAdapter.requiresFor ? envAdapter.requiresFor(envOptions) : envAdapter.requires);
  try {
    for (const step of stepsFor(config, { packs })) {
      tools.push(...(step.needs ?? []));
      add(step.requires);
    }
  } catch {
    // an unknown step is the config check's business
  }
  try {
    add(packFor(config, packs)?.requires);
  } catch {
    // an unknown pack is the config check's business
  }
  return { env: uniq(env), tools: uniq(tools) };
}

const sourceVersion = (ctx) => {
  try {
    return JSON.parse(ctx.fs.readFileSync(path.join(ctx.sourceRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
};

// The installed foreman entry from `claude plugin list`, preferring an enabled one.
// Returns { entry } or { failed: true }.
function installedPlugin(ctx) {
  const r = ctx.sh('claude', ['plugin', 'list']);
  if (r.status !== 0) return { failed: true };
  const found = parsePluginList(r.stdout).filter((p) => p.name === 'foreman');
  return { entry: found.find((p) => p.enabled) ?? found[0] ?? null };
}

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const short = (commit) => String(commit).slice(0, 7);

// One moved pack skill in words.
function movedLine({ id, name, was, now }) {
  const head = `${id} names ${name}, learned at ${was.ref}`;
  if (!now) return `${head}, no longer in skills-lock.json`;
  if (now.ref !== was.ref) return `${head}, now ${now.ref}`;
  return `${head} (${short(was.commit)}), the tag now points at ${short(now.commit)}`;
}

// The self-learning checks (see the header). The ledger and the lock are read once, here,
// because which checks run depends on them.
function learningChecks(config, ctx, add) {
  const learning = { ...DEFAULTS.learning, ...(config.learning ?? {}) };
  const now = typeof ctx.now === 'function' ? ctx.now() : new Date();
  let dir;
  let ledger;
  try {
    dir = stateDir(ctx.root, config, ctx.env);
    ledger = readLedger(dir);
  } catch {
    add('learning', 'project', () => warn('could not read learning.jsonl', hint('check that learning.jsonl in the state folder is a readable file')));
    return;
  }
  let spentToday = null;
  try {
    spentToday = learnerSpentToday(dir, now);
  } catch {
    // reported by the caps check
  }
  const status = learningStatus({ learning, ledger, spentToday: spentToday ?? 0, now });
  add('learning', 'project', () => {
    const state = status.auto
      ? status.apply ? 'on' : 'on, but the agents use none of it (learning.apply is false)'
      : status.apply ? 'off (learning.auto is false)' : 'off (learning.auto and learning.apply are false)';
    return ok(`${state}; ${status.active} active, ${status.evaluating} evaluating; last 7 days: ${status.rolledBack7d} rolled back, ${status.refused7d} refused`);
  });
  if (status.auto) {
    add('learning caps', 'project', () => {
      if (spentToday === null) return warn('could not read learner.jsonl, so the spend cap is unknown', hint('check that learner.jsonl in the state folder is a readable file'));
      if (!status.caps.length) return ok();
      const said = status.caps.map((c) => (c.label === 'learner spend today' ? `${c.label} ${usd(c.n)} of ${usd(c.max)}` : `${c.label} ${c.n} of ${c.max}`));
      return warn(`reached: ${said.join(', ')}`, hint('raise the limit with `foreman settings` (learning group), or undo an item with `foreman learning undo <id>`'));
    });
  }
  let lockSkills;
  try {
    lockSkills = readLock(ctx.root, ctx.fs).lock?.skills;
  } catch {
    lockSkills = undefined;
  }
  const hasLockSkill = lockSkills !== null && typeof lockSkills === 'object' && !Array.isArray(lockSkills) && Object.keys(lockSkills).length > 0;
  const hasLearnedSkill = [...currentItems(ledger).values()].some((i) => i.kind === 'skill' && i.v > 0);
  if (hasLockSkill && hasLearnedSkill) {
    add('learned skills and pack tags', 'project', () => {
      const moved = movedPackSkills(ledger, lockSkills);
      if (!moved.length) return ok();
      return warn(moved.map(movedLine).join('; '), hint('read it with `foreman learning show <id>` and undo it with `foreman learning undo <id>` if it no longer fits'));
    });
  }
}

const LEFT_OUT = 'story sessions leave out your user-level CLAUDE.md, auto memory, hooks, skills, agents and plugins; set session.userSettings to true to load them';

// The 'agent models' check (see the header).
function agentModels(config, ctx) {
  const now = typeof ctx.now === 'function' ? ctx.now() : new Date();
  let runs;
  try {
    runs = readRuns(stateDir(ctx.root, config, ctx.env));
  } catch {
    runs = [];
  }
  const since = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const last = runs
    .filter((r) => Array.isArray(r.agents) && Date.parse(r.endedAt) >= since)
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
    .at(-1);
  if (!last) return ok("no story session in the last 7 days recorded its agents' models");
  const texts = Array.isArray(last.modelMismatches) ? last.modelMismatches.map((m) => m?.text).filter((t) => typeof t === 'string') : [];
  if (!texts.length) return ok(`the agents of ${last.story}'s session ran on the models their roles are set to`);
  const ended = new Date(last.endedAt).toISOString().slice(0, 16).replace('T', ' ');
  return warn(
    `in ${last.story}'s session (ended ${ended} UTC): ${texts.join('; ')}`,
    hint("check the roles' models with `foreman settings list --group models`, and that the plugin fresh check is ok: story sessions must load this copy of Foreman"),
  );
}

// The 'story session scope' check (see the header).
function sessionScopeResult(config, ctx) {
  const session = config.session ?? {};
  const names = Array.isArray(session.mcpServers) ? session.mcpServers.filter((n) => typeof n === 'string' && MCP_NAME.test(n)) : [];
  const addIt = hint('add it to .mcp.json');
  if (names.length) {
    const found = projectMcpServers({ root: ctx.root, fs: ctx.fs });
    if (found.error) return fail(`could not read .mcp.json: ${found.error}`, addIt);
    const missing = names.filter((n) => !Object.hasOwn(found.servers, n) || found.servers[n] === null || typeof found.servers[n] !== 'object');
    if (missing.length) {
      const said = missing.map((name) => (userMcpServer({ name, root: ctx.root, env: ctx.env ?? {}, homedir: ctx.home ?? os.homedir(), fs: ctx.fs })
        ? `${name} (defined only at user level in ~/.claude.json; story sessions do not load it)`
        : name));
      return fail(`session.mcpServers names ${said.join(', ')}, which .mcp.json does not define`, addIt);
    }
  }
  const tools = Array.isArray(session.extraTools) ? session.extraTools.filter((t) => typeof t === 'string') : [];
  const unloaded = uniq(tools.map((t) => t.match(/^mcp__(.+?)__/)?.[1]).filter((server) => server && !names.includes(server)));
  if (unloaded.length) {
    return warn(`session.extraTools names tools of ${unloaded.join(', ')}, which story sessions do not load`, hint('name the server in session.mcpServers'));
  }
  return ok(session.userSettings === true ? '' : LEFT_OUT);
}

// The five busiest processes by CPU, from ps: 'node (pid 101, 250.0% CPU), ...'.
function busiest(sh) {
  let r;
  try {
    r = sh('ps', ['-Ao', 'pid=,pcpu=,comm=']);
  } catch {
    r = null;
  }
  const rows = [];
  if (r?.status === 0) {
    for (const line of String(r.stdout ?? '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(.+)$/);
      if (m) rows.push({ pid: m[1], cpu: Number(m[2]), pcpu: m[2], comm: m[3].trim() });
    }
  }
  if (!rows.length) return 'could not list the processes';
  rows.sort((a, b) => b.cpu - a.cpu);
  return rows.slice(0, 5).map((p) => `${path.basename(p.comm)} (pid ${p.pid}, ${p.pcpu}% CPU)`).join(', ');
}

// The 'machine load' check (see the header).
function machineLoad(config, ctx) {
  const dir = stateDir(ctx.root, config, ctx.env);
  if (runningSupervisor(dir, { alive: ctx.alive ?? defaultAlive }) === null) return ok('no run going');
  const cores = ctx.cores ?? os.availableParallelism();
  const load = (ctx.loadavg ?? os.loadavg)()[0];
  if (load <= 2 * cores) return ok(`load ${load.toFixed(1)} on ${cores} cores`);
  return warn(
    `load ${load.toFixed(1)} on ${cores} cores during the run, over twice the cores; busiest: ${busiest(ctx.sh)}`,
    hint('run fewer stories at once with `foreman workers <n>`, or end what else is busy'),
  );
}

// The 'story sessions' check (see the header): a slot folder with two story sessions running.
function storySessions(config, ctx) {
  if (!config) return ok();
  const dir = stateDir(ctx.root, config, ctx.env);
  const list = listStorySessions({ sh: ctx.sh, platform: ctx.platform, readlink: ctx.fs.readlinkSync });
  if (list === null) return ok('could not list the running processes');
  const folders = Object.fromEntries(slotIds(config).map((slot, i) => [slot, worktreeOf(dir, i + 1)]));
  const { doubles } = planLive({ list, folders });
  if (!doubles.length) return ok();
  const extras = doubles.flatMap((d) => d.extra);
  const text = doubles.map((d) => foldersText({ slot: d.slot, sessions: [d.kept, ...d.extra] })).join('; ');
  return warn(`${text}; ${doubles.length > 1 ? 'they' : 'both'} edit the same worktree, and each is paid for`, hint(`end the newer ${extras.length > 1 ? 'ones' : 'one'} with ${killText(extras)}`));
}

// The 'last interrupt' check (see the header).
const INTERRUPT_KEPT_MS = 7 * 24 * 3_600_000;
const utcMinute = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
function lastInterrupt(config, ctx) {
  const rec = readInterrupt(stateDir(ctx.root, config, ctx.env));
  const now = typeof ctx.now === 'function' ? ctx.now() : new Date();
  if (!rec || now.getTime() - Date.parse(rec.at) > INTERRUPT_KEPT_MS) return ok();
  if (rec.story && rec.slot && rec.command) {
    return warn(
      `the run was stopped at ${utcMinute(rec.at)} by a signal from ${rec.story}'s session in ${rec.slot}, which had just run \`${rec.command}\``,
      hint("start it again with `foreman run`; a story session must never stop the run, so report that command (Foreman's Bash guard should refuse it)"),
    );
  }
  return ok(`the run was interrupted (Ctrl-C, kill or a closed terminal) at ${utcMinute(rec.at)}`);
}

// The 'owner claims' check (see the header).
function ownerClaimsResult(config, ctx) {
  const owned = claims(stateDir(ctx.root, config, ctx.env)).filter((c) => c.by === 'owner');
  if (!owned.length) return ok();
  let list;
  try {
    list = openStorySource({ root: ctx.root, config, env: ctx.env, cacheOnly: true }).list();
  } catch {
    return ok('could not read the stories');
  }
  const left = owned.map((c) => [c.id, ownerClaimFate(c.id, list)]).filter(([, fate]) => fate);
  if (!left.length) return ok();
  const named = left.map(([id, fate]) => `${id} (${fate === 'gone' ? 'not in the story source' : fate})`).join(', ');
  return warn(`${left.length} owner claim${left.length > 1 ? 's' : ''} on finished stories: ${named}`, hint('start the run with `foreman run`; it clears them on its first tick'));
}

// See the header: clears what is stale, or only names it inside a story session.
function staleControlResult(config, ctx) {
  const dir = stateDir(ctx.root, config, ctx.env);
  const alive = ctx.pidExists ?? pidExists;
  const stale = staleControl(dir, { alive });
  if (!stale.nextStory && !stale.adopted) return ok();
  if (ctx.env?.FOREMAN_RUN === '1') {
    return warn(staleParts(stale).join('; '), hint('run `foreman doctor` outside a story session, or `foreman run`; either clears it'));
  }
  const { cleared } = clearStaleControl(dir, { alive, now: typeof ctx.now === 'function' ? ctx.now() : new Date() });
  return ok(cleared.length ? `cleared ${cleared.join('; ')}` : '');
}

export function buildChecks(config, ctx) {
  const packs = ctx.packs ?? PACKS;
  const checks = [];
  const add = (name, step, run) => checks.push({ name, step, run });

  add('config', 'project', () => {
    const errors = (ctx.configErrors ?? []).map((e) => (e.path ? `${e.path}: ${e.message}` : e.message));
    if (config) {
      // Pack traits come from the plugin's own folder through ctx.fs, so a doctor test with a
      // fake fs sees none. This check reads only `errors`, which pack files never raise. A
      // doctor test that ever asserts pack trait sizes must serve the pack's traitsDir through
      // its fs.
      const traits = resolveTraits({ root: ctx.root, config, readFile: ctx.fs.readFileSync, exists: ctx.fs.existsSync });
      errors.push(...traits.errors);
    }
    if (!config && errors.length === 0) errors.push('the config could not be loaded');
    return errors.length ? fail(errors.join('; '), hint('fix what it names in foreman.config.json')) : ok();
  });

  if (config) {
    const local = ctx.localWarnings ?? [];
    if (!local.length) add('local settings', 'project', () => ok());
    for (const w of local) add('local settings', 'project', () => warn(w, hint('change or remove that setting with `foreman settings`')));
    add('git remote', 'github', () => {
      const remote = config.remote ?? 'origin';
      return ctx.sh('git', ['remote', 'get-url', remote]).status === 0
        ? ok()
        : fail(`git has no remote named ${remote}`, hint(`add the remote with \`git remote add ${remote} <url>\``));
    });
    add('gh signed in', 'github', () => (ctx.sh('gh', ['auth', 'status']).status === 0 ? ok() : fail('run `gh auth login`', hint('sign in with `gh auth login`'))));

    const ownName = foremanEnvName(config);
    add('foreman keys file', 'project-keys', () => {
      const ignore = isIgnored({ root: ctx.root, file: ownName, sh: ctx.sh });
      if (ignore === 'unknown') return warn(`could not ask git whether ${ownName} is ignored`, hint(`check that \`git check-ignore ${ownName}\` works in this project`));
      // Inside a story session it writes nothing; a line already there that git overrides is the owner's to fix.
      if (ignore === 'not-ignored' && (ctx.env?.FOREMAN_RUN === '1' || !addIgnoreLine(ctx.root, ownName, ctx.fs))) {
        return warn(`${ownName} is not ignored by git`, hint(`add ${ownName} to .gitignore`));
      }
      const added = ignore === 'not-ignored' ? `added ${ownName} to .gitignore` : '';
      let mode = null;
      try {
        mode = ctx.fs.statSync(foremanEnvPath(ctx.root, config)).mode;
      } catch {
        // no file yet
      }
      if (mode !== null && mode & 0o077) {
        return warn([added, `${ownName} can be read by other users; run chmod 600 ${ownName}`].filter(Boolean).join('; '), hint(`run \`chmod 600 ${ownName}\``));
      }
      return ok(added);
    });
    add('foreman keys placement', 'project-keys', () => {
      const names = foremanKeysIn(projectEnvPath(ctx.root, config), ctx.fs);
      return names.length
        ? warn(`move ${names.join(', ')} to ${ownName}: agents can read ${projectEnvName(config)}; run \`foreman keys migrate\``, hint('run `foreman keys migrate` from the project\'s folder'))
        : ok();
    });
  }

  const engines = [...new Set((config?.roles?.reviewers ?? []).map((r) => r?.engine?.name).filter(Boolean))];
  for (const name of engines) {
    const cli = ENGINE_CLI[name];
    add(`review engine ${name}`, 'claude-code', () => (cli && ctx.sh(cli, ['--version']).status === 0
      ? ok()
      : warn(`\`${cli ?? name} --version\` failed; reviews with that engine fall back to the Claude reviewer`, hint(`install the ${name} CLI (\`${cli ?? name}\`) and sign in, then open a new terminal`))));
  }

  add('claude on PATH', 'claude-code', () => (ctx.sh('claude', ['--version']).status === 0
    ? ok()
    : fail('`claude --version` failed; install Claude Code', hint('install Claude Code, then open a new terminal'))));

  checks.push(signInCheck(config));

  const listHint = hint('check that `claude plugin list` works in this project');
  add('plugin installed and enabled', 'claude-code', () => {
    const found = installedPlugin(ctx);
    if (found.failed) return warn('could not read `claude plugin list`', listHint);
    if (!found.entry) return fail('the foreman plugin is not installed for this project', hint('install it with `claude plugin install foreman@foreman`'));
    if (!found.entry.enabled) return fail(`the foreman plugin is installed (${found.entry.version}) but disabled`, hint('turn it on with `claude plugin enable foreman@foreman`'));
    return ok();
  });

  add('plugin fresh', 'claude-code', () => {
    const update = hint('update it with `claude plugin update foreman@foreman`');
    const found = installedPlugin(ctx);
    if (found.failed) return warn('could not read `claude plugin list`, so freshness is unknown', listHint);
    if (!found.entry) return warn('no installed foreman plugin to compare', hint('install it with `claude plugin install foreman@foreman`'));
    // An installed copy elsewhere is not the code the supervisor runs; its sessions load this source instead.
    const copy = sessionPlugin({ pluginDir: ctx.sourceRoot, root: ctx.root, copies: installedCopies({ pluginsDir: ctx.pluginsDir, root: ctx.root, fs: ctx.fs }), fs: ctx.fs }).copy;
    if (copy) return warn(copyWarning({ copy, own: ownCopy({ pluginDir: ctx.sourceRoot, fs: ctx.fs }) }), update);
    if (found.entry.readFrom) return ok();
    const source = sourceVersion(ctx);
    if (!source) return warn(`installed version is ${found.entry.version}; could not read this source's version`, hint('reinstall the plugin if this repeats'));
    if (found.entry.version !== source) {
      return warn(`installed plugin is ${found.entry.version}, this source is ${source}; run \`claude plugin update\` (releases must bump version in plugin/.claude-plugin/plugin.json)`, update);
    }
    // sourceRoot is the plugin folder; a git checkout of Foreman has its repo root one level up.
    const repoRoot = ctx.repoRoot ?? path.dirname(ctx.sourceRoot);
    if (!ctx.fs.existsSync(path.join(repoRoot, '.git'))) return ok();
    const log = ctx.sh('git', ['log', '-1', '--format=%ct'], { cwd: repoRoot });
    const committed = Number(String(log.stdout).trim());
    const cache = path.join(ctx.pluginsDir, 'cache', found.entry.market, found.entry.name, found.entry.version);
    let installedAt;
    try {
      installedAt = ctx.fs.statSync(cache).mtimeMs;
    } catch {
      return warn(`could not find the installed copy at ${cache}`, hint('reinstall the plugin'));
    }
    if (log.status !== 0 || !Number.isFinite(committed) || committed <= 0) return warn('could not read this source\'s last commit time', hint('check that git works in the Foreman source'));
    return committed * 1000 > installedAt ? warn('installed plugin copy is older than this source; bump the version or reinstall', hint('bump the version or reinstall the plugin')) : ok();
  });

  if (!config) return checks.map(withFix);

  for (const check of config.checks ?? []) {
    if (check.when !== 'always') continue;
    add(`check: ${check.run}`, 'tools', () => {
      const r = ctx.sh('sh', ['-c', check.run]);
      return r.status === 0 ? ok() : fail(`exited ${r.status}`, hint(`run \`${check.run}\` and make it pass`));
    });
  }

  add('check commands on PATH', 'tools', () => {
    const words = [];
    for (const check of config.checks ?? []) {
      for (const command of [check.run, check.quick]) {
        if (typeof command !== 'string') continue;
        const word = command.trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
        if (word && /^[\w.-]+$/.test(word) && !words.includes(word)) words.push(word);
      }
    }
    const missing = words.filter((w) => ctx.sh('sh', ['-c', `command -v ${w}`]).status !== 0);
    if (!missing.length) return ok();
    return warn(`not found on this shell's PATH: ${missing.join(', ')}; story sessions run the checks with the PATH the run starts with (plus a pack's folders), not the agent shell's`, hint('install them, or start `foreman run` from a shell whose PATH has them'));
  });

  add('merged code tested', 'project', () => {
    let by;
    try {
      by = stepsFor(config, { packs }).find((s) => s.testsMergedCode === true);
    } catch (err) {
      return warn(`could not read ship.steps: ${err?.message ?? err}`, hint('fix ship.steps in foreman.config.json'));
    }
    if (by) return ok(`${by.name} tests the merged code at release`);
    if ((config.checks ?? []).length > 0) return ok('no CI step: Foreman runs the checks on the merged code at release when the base branch brought in new commits');
    return warn('no CI step and no checks: code merged at release is not tested', hint('add checks to foreman.config.json, or a ci step to ship.steps'));
  });

  add('role agents', 'project', () => roleAgentsResult(config, ctx));

  const needs = requirements(config, { packs });

  add('env variables', 'project-keys', () => {
    if (!needs.env.length) return ok();
    const have = new Set([
      ...namesInEnvFile(ctx.fs, projectEnvPath(ctx.root, config)),
      ...foremanKeysIn(foremanEnvPath(ctx.root, config), ctx.fs),
      ...Object.keys(ctx.env ?? {}),
    ]);
    const missing = needs.env.filter((n) => !have.has(n));
    if (!missing.length) return ok();
    const groups = [
      [missing.filter(isForemanKey), foremanEnvName(config)],
      [missing.filter((n) => !isForemanKey(n)), projectEnvName(config)],
    ].filter(([names]) => names.length);
    return fail(`missing: ${groups.map(([names, file]) => `${names.join(', ')} (set in ${file} or the environment)`).join('; ')}`, {
      step: stepForKey(missing[0]),
      hint: `add ${groups.map(([names, file]) => `${names.join(', ')} to ${file}`).join(' and ')} or the environment`,
    });
  });

  if (config.stories?.adapter === 'jira') checks.push(...jiraChecks(config, ctx));
  if (config.pack !== undefined) {
    let pack = null;
    try {
      pack = packFor(config, packs);
      if (pack.doctorChecks) checks.push(...pack.doctorChecks(config, ctx));
    } catch (err) {
      const detail = err?.message ?? String(err);
      add(`pack ${config.pack}`, 'project', () => fail(detail, hint('fix `pack` in foreman.config.json, or update Foreman')));
    }
    if (pack?.envAdapters) {
      try {
        envAdaptersFor(config, packs);
      } catch (err) {
        const detail = err?.message ?? String(err);
        add(`pack ${pack.name} env adapters`, 'project', () => fail(detail, hint('update Foreman or the pack')));
      }
    }
  }

  add('tools', 'tools', () => {
    const missing = needs.tools.filter((t) => /^[\w.-]+$/.test(t) && ctx.sh('sh', ['-c', `command -v ${t}`]).status !== 0);
    return missing.length ? fail(`not on PATH: ${missing.join(', ')}`, hint(`install ${missing.join(', ')}, then open a new terminal`)) : ok();
  });

  if (config.env?.adapter === 'docker') {
    add('docker compose', 'tools', () => (ctx.sh('docker', ['compose', 'version']).status === 0
      ? ok()
      : fail('docker compose is not installed', hint('install Docker with its compose plugin'))));
  }

  add('branch protection', 'github', () => {
    const base = config.baseBranch ?? 'main';
    const r = ctx.sh('gh', ['api', `repos/{owner}/{repo}/branches/${base}/protection`]);
    if (r.status === 0) return ok();
    if (/404|not found|not protected/i.test(`${r.stderr} ${r.stdout}`)) return warn('branch protection is off', hint(`turn branch protection on for ${base}`));
    if (/upgrade to github pro|make this repository public/i.test(`${r.stderr} ${r.stdout}`)) {
      return warn('branch protection is not available on this repository\'s GitHub plan (private repo on the free plan)', hint('upgrade the GitHub plan or make the repository public to protect the branch'));
    }
    return warn('could not check branch protection', hint('check that `gh` is signed in and can read the repository'));
  });

  // Vercel makes a preview deployment of every pushed branch. Foreman pushes one branch per
  // story, so each story would use two deployments (the preview and the production one).
  const statusContext = config.ship?.['deploy-github']?.statusContext;
  const onVercel = ctx.fs.existsSync(path.join(ctx.root, 'vercel.json')) || String(statusContext ?? '').toLowerCase() === 'vercel';
  if (onVercel) {
    add('vercel story previews', 'tools', () => {
      const pattern = `${config.branchPrefix ?? 'story/'}*`;
      const snippet = JSON.stringify({ git: { deploymentEnabled: { [pattern]: false } } });
      const previews = hint(`turn off story branch previews in vercel.json: ${snippet}`);
      const why = `Add this to vercel.json: ${snippet}. Without it, every story makes two deployments (a preview of its branch and the production one after the merge), which uses up a small plan's daily allowance; Vercel then refuses production deployments.`;
      let json;
      try {
        json = JSON.parse(String(ctx.fs.readFileSync(path.join(ctx.root, 'vercel.json'), 'utf8')));
      } catch (e) {
        return warn(e?.code === 'ENOENT' ? `vercel.json not found. ${why}` : `could not read vercel.json. ${why}`, previews);
      }
      return json?.git?.deploymentEnabled?.[pattern] === false ? ok() : warn(`vercel.json does not turn off previews for ${pattern} branches. ${why}`, previews);
    });
  }

  checks.push(...cloudChecks(config, ctx));

  add('background service', 'tools', () => {
    const dir = stateDir(ctx.root, config, ctx.env);
    const svc = openService({ platform: ctx.platform, home: ctx.home, uid: ctx.uid, env: ctx.env, sh: ctx.sh, fs: ctx.fs, config, root: ctx.root, dir });
    if (!svc || (ctx.platform === 'linux' && !svc.available())) return ok('no service manager on this computer');
    if (!svc.installed()) {
      return warn('not installed: the factory stops when the terminal or session that started it closes, and after a reboot', hint('run `foreman service install`'));
    }
    const info = svc.info();
    if (info?.node && !ctx.fs.existsSync(info.node)) {
      return warn(`the service starts Node from ${info.node}, which is not there any more (was Node upgraded?)`, hint('run `foreman service install` again'));
    }
    const p = info?.node ? probeNode(info.node, ctx.sh) : { ok: true };
    if (!p.ok) {
      const brew = likelyHomebrew(info.node, p.cause) ? '. A Homebrew upgrade of Node or of a library it needs (such as simdjson) is the likely cause' : '';
      return warn(`the service starts Node from ${info.node}, which does not start: ${p.cause}${brew}`, hint('reinstall Node (`brew reinstall node` with Homebrew), then run `foreman service install` again'));
    }
    const bin = info?.bin;
    if (bin && bin !== FOREMAN_BIN) return warn(`the service runs Foreman from ${bin}, not this copy`, hint('run `foreman service install` again'));
    const st = svc.status();
    if (st.running) return ok(`runs as a service (${svc.label}${st.pid ? `, pid ${st.pid}` : ''})`);
    if (isStopped(dir)) return ok(`installed (${svc.label}), stopped with \`foreman stop\``);
    return warn(`installed (${svc.label}) but not running; see ${svc.log}`, hint('run `foreman run`, or read the log'));
  });

  // Only on macOS: a run that launchd starts is the one macOS asks about, on behalf of node.
  if (ctx.platform === 'darwin') {
    add('macOS privacy prompts', 'tools', () => {
      const dir = stateDir(ctx.root, config, ctx.env);
      const svc = openService({ platform: ctx.platform, home: ctx.home, uid: ctx.uid, env: ctx.env, sh: ctx.sh, fs: ctx.fs, config, root: ctx.root, dir });
      if (!svc || !svc.installed()) return ok();
      return ok(
        'the run is started by launchd, so macOS asks on behalf of node when something in it reaches a private folder (Desktop, Documents, Photos, network volumes). Foreman never needs them: answer Don\'t Allow to any "node would like to access" prompt.',
      );
    });
  }

  add('stray processes', 'tools', () => {
    const r = findStrays({
      root: ctx.root,
      dir: stateDir(ctx.root, config, ctx.env),
      sh: ctx.sh,
      platform: ctx.platform,
      readlink: ctx.fs.readlinkSync,
      ...(ctx.strayRoots ? { roots: ctx.strayRoots } : {}),
    });
    if (!r.listed) return ok('could not list the running processes');
    if (!r.strays.length) return ok();
    return warn(`${straysText(r)}; tests or manual checks left them, and they slow the run. A run kept in a temp folder counts as one too`, hint('end them with `foreman doctor --end-strays`'));
  });

  add('machine load', 'tools', () => machineLoad(config, ctx));

  add('story sessions', 'tools', () => storySessions(config, ctx));

  add('last interrupt', 'tools', () => lastInterrupt(config, ctx));

  add('owner claims', 'project', () => ownerClaimsResult(config, ctx));

  add('stale control', 'project', () => staleControlResult(config, ctx));

  learningChecks(config, ctx, add);

  add('story session scope', 'claude-code', () => sessionScopeResult(config, ctx));

  add('agent models', 'claude-code', () => agentModels(config, ctx));

  add('workflows', 'claude-code', () =>
    warn('Claude Code workflows need a paid plan or the API; on Pro, turn them on in /config. Doctor cannot detect this.', hint('on Pro, turn workflows on in `/config` in Claude Code')));

  return checks.map(withFix);
}
