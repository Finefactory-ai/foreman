// What the run reads once at start, and the state every part of the supervisor shares: the
// config, the pack, the session scope and the plugin copy, the leash and the flags, then the
// sessions, the queued work, the counts, the story source, state.json, the notifier and the
// background jobs. A part of the supervisor (supervisor.mjs is the entry point and lists the
// parts): the root, evaluated first. It imports none of the other parts, which import what they
// share from it, and no part imports supervisor.mjs, which ends in `await main()`. Its code has
// side effects, in the order it is written. The paragraphs below were part of supervisor.mjs's
// header.
//
// Settings: the config is read with the local settings layer on top. `slots`, the console and
// keep-awake are read once, at start. Before every pick the config and the local layer are
// re-read when either file changed (live-settings.mjs), for `workers`, the watchdog limits and
// the switches this process acts on (costMetrics); `rounds` and the ship timeouts are read by
// `foreman workflow-args` and `foreman ship` themselves. live-settings.mjs says how --workers,
// `foreman workers` and a settings change to `workers` take turns. A slot picks a new story only
// while fewer than `workers` stories run across all slots; slots above the limit finish their
// story first. Work queued for a slot above the limit (a crash resume) is rehomed to any slot
// under it (slot-work.mjs rehome), with its claim, its locks and its folder: once the claim is
// known to be this factory's, the story's unfinished work is committed on its branch and the old
// folder is detached, so the new slot can check the branch out; the work then no longer carries
// where it came from, so a start that fails is retried as a plain resume (move-work.mjs).
// state.json's queued lists what waits.
//
// An invalid config at start stops the run. One that turns invalid while it runs does not: the
// stories are picked with the last good config (the settings in effect), live-settings.mjs logs
// one warning per reason, and this process records state.json's configProblem { since, reason }
// (the run:config item on Waiting on you and in `foreman status`) and sends one `config`
// notification. Each valid config is saved as <stateDir>/config.last-good.json
// (config-health.mjs), which `foreman status` and `foreman notify` read meanwhile. Every
// notification other than `config` re-reads the settings first (applySettings), so it goes out
// on the last good config even in the tick the file turned invalid, such as the outcome email of
// the session that broke it. A valid file clears the problem from the next pick; so does the run
// stopping.
//
// Node: every command this process starts (the learning tick, `foreman notify` and `learn`, the
// park watch, the health and config checks, the owner's answers) runs on NODE.node()
// (node-path.mjs nodeWatch), not simply the Node this process started on: on a Homebrew install
// that is the versioned keg, which can stop loading after `brew upgrade` replaces a library it
// needs.
// NODE.node() is this process's own Node while that starts, else one that does (the background
// service's, Homebrew's link, the PATH node). main() checks it once at start and the tick every
// minute (a `node --version`, through heldSpawnSync). When this process's Node stops starting
// and another does, one warn event says so and names the new Node, and the run restarts onto
// it like a restart on new code (see supervisor.mjs; a STOP wins over it): "Restarted onto Node <path>
// (<version>): <old> no longer starts." The sessions are handed over, never stopped, and
// startSupervisor (run.mjs) starts the next process on a Node that starts. When no Node starts
// there is one warn event and no restart, since it would fail. A learning tick that fails is
// checked against the same Node: if it cannot start, the event says that is a set-up problem
// (with the load error line, and Homebrew when likely) instead of "failed (exit 134)", and the
// Node is checked again at once. The dashboard runs in this process, so its children move to
// the new Node with the restart, within a minute.
//
// Packs: when the config names a pack with a prepareSessions hook (pack-session.mjs), it runs
// once at start, before any session; a refusal stops the run with its reason. What it hands back
// (environment, PATH folders, --settings) goes into every story session. --dry-run skips it.
//
// Session scope: every story session is lean (session.mjs): Foreman, the pack's plugins and the
// MCP servers session.mcpServers names, and none of the owner's user-level CLAUDE.md, memory,
// hooks, skills, agents or plugins unless session.userSettings is true. What it is given is
// worked out once at start (session-scope.mjs), from the user, project and local Claude Code
// settings and the project's .mcp.json as they are then; a refusal (a server .mcp.json does
// not define, a .mcp.json that cannot be read, a pack's sessionNeeds Foreman cannot use) stops
// the run with its reason. --dry-run skips it.
//
// Plugin copy: a story session loads the Foreman code this process runs (PLUGIN_DIR, the code the
// restart in supervisor.mjs's header watches), not whatever Claude Code has installed. At start it reads the installed
// copies (plugin-copy.mjs, from <config dir>/plugins/installed_plugins.json) and passes
// `--plugin-dir <PLUGIN_DIR>` to every session when an installed copy is elsewhere, when none is
// installed, or when the project is Foreman's own repo; when the installed copy is PLUGIN_DIR it
// passes nothing. FOREMAN_PLUGIN_DIR plays no part. Given --plugin-dir, a session also gets
// PLUGIN_DIR's bin first on its PATH, the installed copies elsewhere (SESSION_SHADOWED) off its PATH
// and turned off in its settings, and FOREMAN_PLUGIN_LABEL, the short commit (session.mjs), so its
// `foreman` command is this code's too. When an installed copy is elsewhere, one warn
// event at start (not after a restart) says so, the same sentence `foreman doctor` shows. A
// session's init event, read once from the head of its log, is then checked: a warn event on its
// slot says when it loaded Foreman from anywhere but PLUGIN_DIR, or not at all. A session kept
// across a restart is not checked again. A restart on new code moves the sessions too. Every
// session also gets FOREMAN_PLUGIN_ROOT, the resolved PLUGIN_DIR, whether or not --plugin-dir is
// passed: the `foreman` CLI warns on the slot when it runs from another folder (foreman-command.mjs).
//
// Secrets: this process loads neither the project's env file nor Foreman's own keys file
// (.env.foreman). Only the children that need keys load them (`foreman notify` and the
// dashboard's `foreman setup steps` do it themselves), so the Claude sessions never carry those
// keys in their environment. (The Jira refresher reads both files for its own client only.) At
// each session start the two Claude sign-in names (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)
// are read from .env.foreman and passed to that session where this process's environment has
// none; nothing else from it is, and .env.local is never read for them.

import fs from 'node:fs';
import os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextStory } from './pick.mjs';
import { backoffMs } from './scheduler.mjs';
import { mergedPrOfAsync, rolledBackAtOf } from './resume-close.mjs';
import { packFor } from '../../packs/index.mjs';
import { openStorySource, preferCachedStories, storyUpdate } from './story-source.mjs';
import { EXPIRED_MESSAGE } from '../jira/auth.mjs';
import { jiraEnv } from '../jira/cache.mjs';
import { foremanEnvName } from './foreman-keys.mjs';
import { creditRetryMs, retrySentence } from './credit-resume.mjs';
import { jiraRefresher } from '../jira/refresher.mjs';
import { SF_EXPIRED_MESSAGE, salesforceRefresher } from '../adapters/stories/salesforce-refresher.mjs';
import { loadResolved } from '../settings/load.mjs';
import { liveSettings } from './live-settings.mjs';
import { saveLastGood } from './config-health.mjs';
import { progressWatch } from './progress-watch.mjs';
import { cpuSampleMs, cpuWatch } from './session-cpu.mjs';
import { anchorEvent, anchorStep, anchorWaitOf, ownCheckout } from './anchor-pull.mjs';
import { codeVersionWatch, PLUGIN_DIR } from './code-version.mjs';
import { repeatGate } from './repeats.mjs';
import { projectRoot } from './paths.mjs';
import { openEnvAdapter } from './env-adapter.mjs';
import { preparePackSessions } from './pack-session.mjs';
import { configDir, sessionScope } from './session-scope.mjs';
import { installedCopies, sessionPlugin, shadowingCopies } from './plugin-copy.mjs';
import { openConsole } from './console.mjs';
import { accountChecks } from './account-checks.mjs';
import { backgroundJobs } from './background-jobs.mjs';
import { sessionRecords } from './session-records.mjs';
import { storyClaims } from './story-claims.mjs';
import { tickMs } from './wake.mjs';
import { renameWritten } from './read-cache.mjs';
import { pendingPrepares } from './slot-prepare.mjs';
import { slotIds } from './worktree.mjs';
import { runAsync } from './run-async.mjs';
import { heldSpawnSync, recordSyncChildren } from './loop-holds.mjs';
import { ownerCommands } from './owner-commands.mjs';
import { NODE_CHECK_MS, nodeWatch, serviceNodeOf, spawnSh } from './node-path.mjs';
import { IDLE_ENV, LEASH_ENV, leashOf, tempRoots } from './leash.mjs';
import {
  addEvent,
  readState,
  setLoop,
  setWorkers,
} from './state.mjs';

// Every synchronous child this process still runs is timed from here on, so a late wake can name it.
recordSyncChildren();

export const ROOT = projectRoot();
// Started again by startSupervisor after new code (see the header of supervisor.mjs); never passed to sessions.
export const RESTARTED = process.env.FOREMAN_RESTART === '1';
delete process.env.FOREMAN_RESTART;

// The project's config with the local settings layer on top, as it was at start; an invalid one
// stops the run. What it fixes for the run (slots, the console, the state folder) stays; the
// settings that apply at the next story come from `live` before each pick.
export const loaded = loadResolved(ROOT, { env: process.env });
if (!loaded.config) {
  for (const e of loaded.errors) console.error(`foreman.config.json${e.path ? ` ${e.path}` : ''}: ${e.message}`);
  process.exit(1);
}
export const CONFIG = loaded.config;
// The pack the config names (the config is already valid): asked when a story's last release was rolled back.
const PACK = packFor(CONFIG);
export const SLOT_IDS = slotIds(CONFIG);
// The state folder the config names (FOREMAN_STATE_DIR wins), passed on to every child so the
// sessions, `foreman notify` and the owner's commands all use the same one.
export const DIR = loaded.dir;
process.env.FOREMAN_PROJECT_DIR = ROOT;
process.env.FOREMAN_STATE_DIR = DIR;
// The leash (see the header of supervisor.mjs), read once; no session or child inherits it.
export const LEASH = leashOf({ dir: DIR, env: process.env, roots: tempRoots() });
delete process.env[LEASH_ENV];
delete process.env[IDLE_ENV];
export const LEASHED = LEASH.parent !== null || LEASH.idleMs !== null;
export const ARTIFACTS = CONFIG.console?.adapter === 'artifacts';
export const BASE_REF = `${CONFIG.remote}/${CONFIG.baseBranch}`;

export let envAdapter;
try {
  envAdapter = openEnvAdapter({ config: CONFIG, ctx: { root: ROOT, stateDir: DIR, config: CONFIG } });
} catch (err) {
  console.error(`foreman.config.json env: ${err.message}`);
  process.exit(1);
}

// The artifacts console is pushed by its own child (sync.mjs); a wrong setting stops the run
// here rather than failing quietly there.
if (ARTIFACTS) {
  try {
    openConsole({ config: CONFIG, ctx: { stateDir: DIR } });
  } catch (err) {
    console.error(`foreman.config.json console: ${err.message}`);
    process.exit(1);
  }
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
export const DRY = process.argv.includes('--dry-run');

// What the project's pack adds to every story session; a pack that cannot set it up stops the run.
export let PACK_SESSION = null;
if (!DRY) {
  const r = preparePackSessions({ config: CONFIG, env: process.env });
  if (!r.ok) {
    console.error(`Foreman cannot start: ${r.reason}`);
    process.exit(1);
  }
  PACK_SESSION = r.session;
}
// What every story session loads besides Foreman (session-scope.mjs); a refusal stops the run.
export let SESSION_SCOPE = null;
if (!DRY) {
  const s = sessionScope({ config: CONFIG, root: ROOT, env: process.env });
  if (!s.ok) {
    console.error(`Foreman cannot start: ${s.reason}`);
    process.exit(1);
  }
  SESSION_SCOPE = s.scope;
}
// Which plugin folder every story session loads (plugin-copy.mjs; see "Plugin copy" in the header).
const COPIES = installedCopies({ pluginsDir: join(configDir(process.env, os.homedir()), 'plugins'), root: ROOT });
export const SESSION_PLUGIN = sessionPlugin({ pluginDir: PLUGIN_DIR, root: ROOT, copies: COPIES });
// The installed copies elsewhere: a session given that folder keeps their bins off its PATH and turns them off.
export const SESSION_SHADOWED = SESSION_PLUGIN.dir ? shadowingCopies({ pluginDir: SESSION_PLUGIN.dir, copies: COPIES }) : [];
export const ONCE = process.argv.includes('--once');
export const MAX = Math.max(0, Number(arg('max', 0)) || 0);
// With nothing to build, stop with NOTHING_LEFT rather than wait on standby (`foreman cloud run`).
export const EXIT_WHEN_IDLE = process.argv.includes('--exit-when-idle');

// What the run before the restart left in state.json's `restart`, when this is a restart.
export const CARRIED = RESTARTED ? (readJson(join(DIR, 'state.json'), {}).restart ?? null) : null;
// The plugin code this process runs; a change to it restarts the run (see the header of supervisor.mjs).
// Asks git only when something it reads changed (code-version.mjs), so a tick runs no child.
export const CODE = DRY ? null : codeVersionWatch();
export const CODE_AT_START = CODE?.version() ?? null;

// The settings read fresh before each pick, and the config they come from (LIVE).
const live = liveSettings({ root: ROOT, dir: DIR, env: process.env, slots: SLOT_IDS.length });
export let LIVE = live.config ?? CONFIG;
// --workers when given, else the `workers` setting; capped at the slots.
const flagWorkers = Number(arg('workers', ''));
export const START = live.startWorkers(CARRIED?.workers ?? (Number.isInteger(flagWorkers) && flagWorkers >= 1 ? flagWorkers : null));
export let workers = START.workers;
export const workerChanges = []; // control.json worker changes since the last pick: { value, at }

export const ME = process.pid;
// The supervisor pids whose claims and locks this process holds as its own: its own and, after a
// restart on new code, those its adopted sessions' locks name (see the header of supervisor.mjs).
export const OWN = new Set([ME]);
export const TICK_MS = tickMs(process.env.FOREMAN_TICK_MS);
export const BACKOFF = backoffMs(process.env.FOREMAN_BACKOFF_MS);
const CREDIT_RETRY = creditRetryMs(process.env.FOREMAN_CREDIT_RETRY_MS);
const NODE_CHECK_TICKS = 12; // a minute at the real 5 s tick
export const HALT = join(DIR, 'HALT');
export const STOP = join(DIR, 'STOP');
const EXTRA = join(DIR, 'schema-stories.json');

// slot -> { child, pid, id, mode, startedAt, log, usedKey, holderPid, adopted, shipped, stop: null|'watchdog'|'outlived'|'skip'|'takeover'|'restart'|'interrupt', watchdog: why the watchdog stopped it (hung(): too-long, quiet, ceiling or ended-quiet; or 'ended-alive' from watch()) }.
// An adopted session (see the header of supervisor.mjs) has no child; holderPid is the supervisor pid its locks name.
// `shipped` is set once the watchdog has found the story settled or its pull request merged.
export const sessions = new Map();
export const preparing = pendingPrepares(); // slots whose folder or env adapter's prepare has not settled
export const loopChildren = new Set(); // the loop's own async children (answers, health, gh, the session close): ended when the run stops
export const slotChildrenOf = new Map(); // slot -> Set of the children preparing its folder (install, fetch)
export const slotChildren = (slot) => {
  if (!slotChildrenOf.has(slot)) slotChildrenOf.set(slot, new Set());
  return slotChildrenOf.get(slot);
};
// SIGKILL to each child's group (runAsync leads one for every child it starts).
export function endChildren(set) {
  for (const child of set ?? []) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
}
export const closing = new Map(); // slot -> the ended session whose files a child reads (see onExit)
const lookups = new Map(); // story id -> the promise of its merged pull request look-up
export const mergedFor = new WeakMap(); // queued work -> { pr } once the look-up for its resume is back
export const pickFetches = new Map(); // slot -> the story id whose base is being fetched
// The sessions in hand: running, or ended and being read (a held set counts both).
export const inHandSessions = () => [...sessions.values(), ...closing.values()];
export const work = []; // queued work: { slot: 'wN'|null, id, mode, resume?, from?, ranked? } (resume: an automatic resume after a session ended with no result; from: the slot it was in before, see rehome and reconcileStart; ranked: a start-up resume that yields to a higher-priority pick, see resumeYields)
export const crashes = new Map(); // story id -> crashes this run
export const signins = new Map(); // story id -> sign-in deaths in a row this run while the check passed
export const skipped = new Set(CARRIED?.skipped ?? []); // stories skipped by the owner this run
export const closedShipped = new Set(); // stories closed this run because they had shipped, kept out of the pick
export const answerFailures = new Map(); // decision id -> failedAnswer (answers.mjs): an answer that could not be applied, tried again after a growing wait or when the owner presses Retry
export const downs = new Map(); // slot -> environment failures in a row
export let finished = CARRIED?.finished ?? 0;
export let shipped = CARRIED?.shipped ?? 0;
export const resumed = new Set(Array.isArray(CARRIED?.resumed) ? CARRIED.resumed : []); // the stories start-up recovery queued this run, and the live sessions a fresh start adopted (asked-for.mjs)
export let resumedShipped = Number(CARRIED?.resumedShipped) || 0; // how many of them shipped
export let haltSeen = CARRIED?.haltSeen ?? false;
let configProblem = null; // { since, reason } while the run is on the last good config
let savedTeam = null; // the config last saved as the last good one
export const loopErrors = repeatGate();
export const progress = progressWatch();
export const cpu = cpuWatch({ sampleMs: cpuSampleMs(process.env.FOREMAN_CPU_SAMPLE_MS) }); // the progress watchdog's CPU sign of activity, sampled once a minute per slot

export const now = () => new Date();

// The project's story source, opened fresh each time from the settings in effect (LIVE), so a
// config edit is picked up at the next pick and a config that turned invalid keeps the last good one.
export const stories = () => openStorySource({ root: ROOT, config: LIVE, now });
// The picking rules over the source's stories.
export const pickStory = (opts = {}) => {
  const source = stories();
  return nextStory(source.list(), { idPattern: source.idPattern, ...opts });
};
// Records a change on one story: `fields.status` sets the status, `progress` is the dated note.
export const updateStory = (id, change) => stories().update(id, storyUpdate(change));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const event = (text, kind = 'info', slot = null) => addEvent(DIR, text, kind, now(), slot);
export const slotIndex = (slot) => SLOT_IDS.indexOf(slot);
// The slots with a story running: a session (adopted ones too) or a prepare not yet settled.
export const runningCount = () => SLOT_IDS.filter((s) => sessions.has(s) || closing.has(s) || preparing.has(s)).length;
export const branchOf = (id) => `${CONFIG.branchPrefix}${id.toLowerCase()}`;
// A gh or `git ls-remote` call that hangs would hold the loop with no end, so it gets 30 s, and
// SIGKILL because gh can ignore SIGTERM.
export const NET_LIMIT = { timeout: 30_000, killSignal: 'SIGKILL' };
export const sh = (cmd, args, opts = {}) => {
  const r = heldSpawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim() };
};
// Bringing new code into the checkout this run's plugin sits in (anchor-pull.mjs): git with no
// repository named by the environment, so the cwd decides, and the same limit as the other
// network-free-but-hangable calls.
const GIT_ENV = { ...process.env };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete GIT_ENV[key];
export const anchorSh = (cmd, args, opts = {}) => sh(cmd, args, { ...opts, env: GIT_ENV, ...NET_LIMIT });
export const OWN_CHECKOUT = !DRY && ownCheckout({ pluginDir: PLUGIN_DIR, root: ROOT, sh: anchorSh });
let anchorWarned = null; // the base sha the one warning was logged for
export const pullAnchor = guarded('bringing in new code', () => {
  const text = { remote: CONFIG.remote, baseBranch: CONFIG.baseBranch };
  const step = anchorStep({ root: ROOT, ...text, sh: anchorSh });
  const r = anchorEvent(step, anchorWarned, text);
  anchorWarned = r.warnedTo;
  if (r.event) event(r.event.text, r.event.kind);
  // The wait is kept in state.json for Waiting on you, written only when it changes.
  const w = anchorWaitOf(step, state().anchorWait ?? null, { ...text, at: now().toISOString() });
  if (w.changed) saveRun({ anchorWait: w.wait });
});
// The merged pull request of a story's branch, asked in a child of its own: a promise of its url
// (the branch when gh gives none), or null when none merged, when every one merged before the
// story's last rollback (none of it is live), or when gh cannot tell. It never rejects
// (resume-close.mjs). One look-up per story id at a time, so a caller that starts it and carries
// on next tick never starts a second.
export const rolledBackOf = (id) => rolledBackAtOf(PACK, { dir: DIR, story: id });
export const lookUpMerged = (id) => {
  if (!lookups.has(id)) {
    lookups.set(
      id,
      mergedPrOfAsync(branchOf(id), (args) => runAsync('gh', args, { cwd: ROOT, timeoutMs: 30_000, track: loopChildren }), { rolledBackAt: rolledBackOf(id) }).finally(() => lookups.delete(id)),
    );
  }
  return lookups.get(id);
};
// A story's status in the story source, or null when it cannot be read.
export function statusOf(id) {
  try {
    return stories().list().find((x) => x.id === id)?.status ?? null;
  } catch {
    return null;
  }
}
// What a story looks like in the source, { status, blockedBy }, or null when it is not listed or
// the source cannot be read. A slot records it when it goes held (see startWork).
export function heldSnapshot(id) {
  try {
    const s = stories().list().find((x) => x.id === id);
    return s ? { status: s.status, blockedBy: s.blockedBy ?? '' } : null;
  } catch {
    return null;
  }
}
export const git = (cwd, ...args) => sh('git', args, { cwd });

// The refresher of the stories' service, when they come from Jira or Salesforce Cases (not for
// --dry-run, which may wait). The const keeps its name: both have the same interface.
export const jira =
  DRY
    ? null
    : CONFIG.stories?.adapter === 'jira'
      ? jiraRefresher({
          stories: () => (LIVE.stories?.adapter === 'jira' ? LIVE.stories : CONFIG.stories),
          stateDir: DIR,
          env: jiraEnv(process.env, CONFIG.envFile ? resolve(ROOT, CONFIG.envFile) : undefined, resolve(ROOT, foremanEnvName(CONFIG))),
          now,
          writeBrief: (id, b) => stories().writeBrief?.(id, b),
          onLoginExpired: () => notify('paused', { reason: EXPIRED_MESSAGE }),
        })
      : CONFIG.stories?.adapter === 'salesforce'
        ? salesforceRefresher({
            stories: () => (LIVE.stories?.adapter === 'salesforce' ? LIVE.stories : CONFIG.stories),
            stateDir: DIR,
            root: ROOT,
            env: process.env,
            features: CONFIG.features,
            salesforceOrgs: CONFIG.salesforce?.orgs,
            now,
            onLoginExpired: () => notify('paused', { reason: SF_EXPIRED_MESSAGE }),
          })
        : null;
if (jira) preferCachedStories({ onQueued: () => jira.drain() });

// ── run-wide state ────────────────────────────────────────────────────────────────────────

export const state = () => readState(DIR);
// Through a temp file, as state.mjs writes, so the sync never reads half a file.
export function saveRun(patch) {
  const file = join(DIR, 'state.json');
  const text = JSON.stringify({ ...state(), ...patch });
  const tmp = `${file}.${ME}.tmp`;
  writeFileSync(tmp, text);
  renameWritten(tmp, file, text);
}
// The queued work, kept in state.json for status and the page when it changed.
let savedQueued = '';
export function saveQueued() {
  const queued = work.map((w) => ({ id: w.id, slot: w.slot ?? null, from: w.from ?? null, mode: w.mode ?? '', ranked: w.ranked === true }));
  const json = JSON.stringify(queued);
  if (json === savedQueued) return;
  savedQueued = json;
  saveRun({ queued });
}
// The stories skipped this run, kept in state.json for status and the page.
export function saveSkipped() {
  saveRun({ skipped: [...skipped] });
}
export const handled = () => state().handled ?? {};
export const markHandled = (key, at) => saveRun({ handled: { ...handled(), [key]: at } });

export const schemaExtra = () => readJson(EXTRA, []);
export function addSchemaStory(id) {
  const list = schemaExtra();
  if (!list.includes(id)) writeFileSync(EXTRA, JSON.stringify([...list, id]));
}

export const control = () => readJson(join(DIR, 'control.json'), {});

// The factory paused itself; a Resume pressed on the page after that clears it.
export function autoPaused() {
  const at = state().autoPausedAt;
  if (!at) return false;
  const resumeAt = control().resumeAt;
  if (resumeAt && resumeAt > at) {
    saveRun({ autoPausedAt: null, autoPauseReason: '', autoResumeAt: null });
    event('Resumed from the command centre.');
    return false;
  }
  return true;
}
// `resumeAt` (an ISO time) makes it a credit pause that tries again by itself (checkCredit); the
// stored reason stays plain, the notification says when. A pause already there is left as it is.
export function autoPause(reason, { resumeAt = null } = {}) {
  if (state().autoPausedAt) return;
  saveRun({ autoPausedAt: now().toISOString(), autoPauseReason: reason, autoResumeAt: resumeAt });
  setLoop(DIR, 'paused', reason);
  notify('paused', { reason: resumeAt ? `${reason} ${retrySentence(resumeAt, Date.now())}` : reason });
}

// ── email ───────────────────────────────────────────────────────────────────────────────────

// `foreman notify` loads the project's env file itself, so no --env-file here. It and `foreman
// learn` run in children of their own with a time limit (owner-commands.mjs), so neither holds
// the loop; notify() returns the send's promise, which nothing awaits (stop() sends its last
// email through owner.finish).
export const FOREMAN_BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));
// Every child runs on NODE.node(), a Node that starts (node-path.mjs; see the header).
export const NODE = nodeWatch({ execPath: process.execPath, serviceNode: serviceNodeOf({ config: CONFIG, root: ROOT, dir: DIR, env: process.env, fs }), env: process.env, fs, sh: spawnSh(heldSpawnSync), everyMs: Math.min(NODE_CHECK_MS, NODE_CHECK_TICKS * TICK_MS) });
export const owner = ownerCommands({ bin: FOREMAN_BIN, root: ROOT, event, node: () => NODE.node() });

export function notify(kind, fields = {}) {
  // A config that turned invalid since the last tick is recorded first (configProblem), so
  // `foreman notify` falls back to the last good config. configHealth() sends `config` itself.
  if (kind !== 'config') {
    try {
      applySettings();
    } catch {
      // the email goes out regardless
    }
  }
  return owner.notify(kind, { ...fields, stories: finished, shipped });
}

// ── background jobs ───────────────────────────────────────────────────────────────────────

// `foreman release watch`, the slot environment's sweep and the learning tick, none of which the loop waits on.
export const { parkWatch, startParkWatch, envSweep, startEnvSweep, sweepAtStop, learning } = backgroundJobs({ root: ROOT, dir: DIR, bin: FOREMAN_BIN, node: NODE, envAdapter, settings: () => LIVE, dry: DRY, once: ONCE, state, saveRun, event, guarded, now });

// ── the Claude account checks ─────────────────────────────────────────────────────────────

export const { runProbe, signInCheck, checkSignIn, creditCheck, checkCredit, subscriptionCheck, switchToSubscription, checkSubscription } = accountChecks({ root: ROOT, config: CONFIG, dir: DIR, creditRetryMs: CREDIT_RETRY, state, saveRun, event, notify, autoPause, guarded, signins, now });

// ── the schema token and claims ────────────────────────────────────────────────────────────

export const { holder, schemaFree, releaseToken, fileWaiters, keptOut, releaseClaim, moveHolds, claim, takeTokenFor } = storyClaims({ dir: DIR, config: CONFIG, own: OWN, me: ME, skipped, stories, event, now });

// A child-event handler: an exception here must never take the supervisor down.
export function guarded(what, fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      try {
        event(`Supervisor error in ${what}: ${String(err?.message ?? err).slice(0, 200)}`, 'warn');
      } catch {
        // nothing more to do
      }
      return undefined;
    }
  };
}

// ── what each session cost ───────────────────────────────────────────────────────────────────

export const { takeSpans, saveCheckpoint, dropCheckpoint, recordRun, projectsOf, forgetMark, sweepLeftSessionFiles, endSlotCheckJobs, sweepLeftCheckJobs } = sessionRecords({ dir: DIR, config: CONFIG, settings: () => LIVE, sessions, event, guarded, now });

export const STOP_WAIT_MS = 10_000;

// Re-reads the settings when a file changed, and sets the worker count for the next pick.
export function applySettings() {
  const step = live.beforePick({ current: workers, control: workerChanges.splice(0) });
  LIVE = step.config ?? LIVE;
  for (const e of step.events) event(e.text, e.kind);
  if (step.workers !== workers) {
    workers = step.workers;
    setWorkers(DIR, workers);
  }
  configHealth();
}

// Records whether the run is on the last good config (state.json configProblem, one `config`
// notification per episode, saved first because the notifier falls back to it) and saves each
// valid config as the last good one. The warning event itself comes from live-settings.mjs.
function configHealth() {
  const problem = live.problem;
  if (typeof problem === 'string' && problem !== configProblem?.reason) {
    const fresh = configProblem === null;
    configProblem = { since: configProblem?.since ?? now().toISOString(), reason: problem };
    saveRun({ configProblem });
    if (fresh) notify('config', { reason: problem });
  } else if (problem === null && configProblem) {
    configProblem = null;
    saveRun({ configProblem: null });
  }
  if (problem === null && live.team && live.team !== savedTeam) {
    saveLastGood(DIR, live.team);
    savedTeam = live.team;
  }
}

// The ending of a session counts toward the run's totals (stories ended, stories shipped).
export function countEnded(result, id) {
  finished++;
  if (result === 'shipped') shipped++;
  if (result === 'shipped' && resumed.has(id)) resumedShipped++;
}

// The halt this run has seen (set by the tick, cleared by "I've fixed it").
export function setHaltSeen(value) {
  haltSeen = value;
}

// At start: the config last saved as the last good one is the one in effect.
export function saveTeamAtStart() {
  savedTeam = live.team ?? loaded.team;
  saveLastGood(DIR, savedTeam);
}
