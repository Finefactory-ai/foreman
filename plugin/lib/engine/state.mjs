// The factory's live state, kept in .foreman/ on the owner's Mac (FOREMAN_STATE_DIR when set,
// so every slot's worktree writes to the anchor's copy) and sent to the project's console. The factory runs up to three slots (w1-w3) and each writer keeps to its own file:
//
//   state.json          the supervisor only: the loop, the worker count, recent results
//   slots/<slot>.json   one slot's session: its state, story, stage, heartbeat and result
//   slots/<slot>/agents the agent-events hook: which agents run in that slot, doing what
//   slots/<slot>/spans.jsonl  the same hook: each finished agent's start and stop, for the
//                       minutes per stage of the slot's current session (cleared per session)
//   events.jsonl        everyone appends one line at a time, tagged with the slot. The supervisor
//                       rotates it at 5 MB (rotateEvents) to events-<UTC stamp>.jsonl, which stays on
//                       this machine; the snapshot reads only the tail it shows (the last 40, topped
//                       up from the newest rotated file when the new log is short)
//
// A slot's session finds its slot in FOREMAN_SLOT (w1 when unset, as for /factory by hand).
//
//   node lib/engine/state.mjs loop <running|standby|paused|halted|stopped> [reason]
//   node lib/engine/state.mjs story-start <story id>
//   node lib/engine/state.mjs stage <stage> [detail]
//   node lib/engine/state.mjs story-end <shipped|ready-to-promote|blocked|failed|halted|deferred|held> [pr url] [note]
//   node lib/engine/state.mjs beat              the slot is alive (ship.mjs, while it waits)
//   node lib/engine/state.mjs next-request      prints a requested story id, or nothing
//   node lib/engine/state.mjs clear-agents
//   node lib/engine/state.mjs snapshot          prints what the page is sent
//
// The snapshot's stoppedBy is who stopped the run, or asked it to stop: the record in
// service-stopped, else STOP, else last-stop (the record the supervisor keeps once it has taken
// STOP, until the next fresh start) (console/stopper.mjs), plus `text`, the words status and the
// dashboard show ("ACME-9's session at 04:01 UTC"); null when there is none of them.
//
// The snapshot's queued lists the work the supervisor holds back for a slot ({ id, slot, from,
// mode, text }, see queuedOf): `text` says where it waits and which slot takes it next.
//
// The snapshot's backoffUntil is the ISO time picking is held for a backoff after failed sessions
// (state.json's backoffUntil, kept by the supervisor), only while that is in the future and the
// loop is not stopped, else null: the page's idle slots say "Picking held: backing off ...".
// ownerWaiting also passes state.json's answerFailures (owner answers the supervisor could not
// apply, with a Retry) to the Waiting on you list.
//
// A slot gets `checkWait` ({ since, text: "check queued: waiting for a free check slot" }) only while
// a live `foreman checks` run of it waits for a free check slot (check-slots.mjs checkWaits), so
// status and the dashboard show a queued check, not a quiet agent. The key is absent otherwise.
//
// The snapshot's fileWaits lists the stories kept out of the picker because a running story holds
// files or resources they need ({ id, on, text }, file-locks.mjs fileWaits): `text` is
// "ACME-2 waits for ACME-1: src/a.mjs". [] when none, or when the locks cannot be read.
//
// Each agent's file also holds what the command centre shows: `says` (plainWords: "Running the
// tests"), `raw` (a Bash call's command, redacted and cut) and `model` (read once from the
// agent's transcript, see applyHookEvent; the event for a finished agent names it). The snapshot adds each agent's `stage`, short
// `modelName` and a `modelNote` when it runs on another model family than its role is set to,
// and a review relay that has named its reviewer gets `relay` ({ reviewer, agent, engine });
// each slot gets `model` (its foreman's) and `finished` (its last 8 finished agents).
// modelMismatches compares a session's agents (the run record's rows) with their roles' models.
//
// Nothing here reads or prints a secret. Hook input is summarised by describe() and plainWords()
// and redacted before it is stored.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS } from '../config/defaults.mjs';
import { loadConfig } from '../config/load.mjs';
import { currentSlot, projectRoot, stateDir } from './paths.mjs';
import { buildOrder, nextStory, progress } from './pick.mjs';
import { isStoryId, openRequest } from './next-request.mjs';
import { decisionsDir, pending as pendingDecisions } from '../console/decisions.mjs';
import { openProjectStories } from './story-source.mjs';
import { readSignIn } from './claude-fallback.mjs';
import { alive } from './leash.mjs';
import { checkWaits } from './check-slots.mjs';
import { STOPPED_FILE, defaultAlive, readPid } from './supervisor-pid.mjs';
import { LAST_STOP, readStopRecord, stopperText } from '../console/stopper.mjs';
import { readText, readTailLines, renameWritten } from './read-cache.mjs';
import { claudeProjectsDir, findAgentTranscript, readModel, sessionPaths, sessionTranscript } from './session-files.mjs';

export const ROOT = projectRoot();
export const DIR = stateDir(ROOT, null);

export const WORKER = currentSlot();

const MAX_EVENTS = 40;
export const EVENTS_ROTATE_BYTES = 5 * 1024 * 1024;
const MAX_RECENT = 15;

const paths = (dir) => ({
  state: join(dir, 'state.json'),
  events: join(dir, 'events.jsonl'),
  control: join(dir, 'control.json'),
});
export const slotFile = (dir, slot) => join(dir, 'slots', `${slot}.json`);
const agentsDir = (dir, slot) => join(dir, 'slots', slot, 'agents');
const spansFile = (dir, slot) => join(dir, 'slots', slot, 'spans.jsonl');

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// Write through a temp file so a reader never sees half a file.
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
};

// Parsed from the cached text on every call, so each caller has an object of its own to change.
export function readState(dir = DIR) {
  try {
    const text = readText(paths(dir).state);
    if (text !== null) return JSON.parse(text);
  } catch {
    // a bad or unreadable file reads as the default
  }
  return { loop: { state: 'stopped', since: null, reason: '' }, workers: 1, recent: [] };
}

export function saveState(dir, state) {
  const file = paths(dir).state;
  const text = JSON.stringify(state);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameWritten(tmp, file, text);
}

export function readSlot(dir, slot) {
  const empty = { id: slot, state: 'idle', reason: '', parkedFor: null, since: null, story: null, lastBeat: null, result: null };
  return { ...empty, ...readJson(slotFile(dir, slot), {}), id: slot };
}

// Merges a change into one slot's file. `since` moves only when the state changes.
export function setSlot(dir, slot, patch, now = new Date()) {
  const was = readSlot(dir, slot);
  const next = { ...was, ...patch };
  if (patch.state && patch.state !== was.state) next.since = now.toISOString();
  writeJson(slotFile(dir, slot), next);
  return next;
}

export const beat = (dir, slot = WORKER, now = new Date()) => setSlot(dir, slot, { lastBeat: now.toISOString() }, now);

export function addEvent(dir, text, kind = 'info', now = new Date(), slot = null) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(paths(dir).events, JSON.stringify({ at: now.toISOString(), text, kind, slot }) + '\n');
}

// The log goes to events-<UTC stamp>.jsonl once it reaches `limit`; a name already taken gets
// -2, -3 and so on. Only the supervisor calls it, so two processes never race for a name. A
// process appending at that moment either writes to the renamed file or starts the new log; no
// line is lost. Returns the new name, or null when there was nothing to rotate. Never throws.
export function rotateEvents(dir, { limit = EVENTS_ROTATE_BYTES, now = new Date() } = {}) {
  try {
    const file = paths(dir).events;
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st || st.size < limit) return null;
    const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
    let name = `events-${stamp}Z.jsonl`;
    for (let n = 2; existsSync(join(dir, name)); n++) name = `events-${stamp}Z-${n}.jsonl`;
    renameSync(file, join(dir, name));
    return name;
  } catch {
    return null;
  }
}

const ROTATED = /^events-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d+))?\.jsonl$/;

// The rotated logs, newest first: by stamp, then by number (none counts as 1).
export function rotatedEventFiles(dir) {
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, m: ROTATED.exec(name) }))
    .filter((f) => f.m)
    .sort((a, b) => (a.m[1] === b.m[1] ? Number(b.m[2] ?? 1) - Number(a.m[2] ?? 1) : a.m[1] < b.m[1] ? 1 : -1))
    .map((f) => f.name);
}

// The newest MAX_EVENTS events, newest first, read from the end of the log. A log just rotated
// is short, so the newest rotated file fills the rest. A line that does not parse is left out.
function recentEvents(dir) {
  try {
    let lines = readTailLines(paths(dir).events, MAX_EVENTS);
    if (lines.length < MAX_EVENTS) {
      const [newest] = rotatedEventFiles(dir);
      if (newest) lines = [...readTailLines(join(dir, newest), MAX_EVENTS - lines.length), ...lines];
    }
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // one bad line does not empty the feed
      }
    }
    return events.reverse();
  } catch {
    return [];
  }
}

// ── what an agent is doing, in words ─────────────────────────────────────────────────────

const SECRET = [
  [/\b(sk|pk|rk|whsec|sb_secret|sb_publishable)_[A-Za-z0-9_-]{6,}/g, '•••'],
  [/\beyJ[A-Za-z0-9._-]{10,}/g, '•••'],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, '•••'],
  [/\b([A-Za-z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\\+"[^"]*"?|\S+)/gi, '$1=•••'],
  [/(Bearer\s+)\S+/gi, '$1•••'],
];
export const redact = (text) => SECRET.reduce((t, [re, to]) => t.replace(re, to), String(text));

const short = (text, n = 140) => {
  const one = redact(text).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};
const rel = (p, root) => (p ? relative(root, String(p)) || String(p) : '');

export function describe(tool, input = {}, root = ROOT) {
  switch (tool) {
    case 'Bash':
      return `$ ${short(input.command ?? '')}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `editing ${rel(input.file_path ?? input.notebook_path, root)}`;
    case 'Read':
      return `reading ${rel(input.file_path, root)}`;
    case 'Grep':
      return `searching for "${short(input.pattern ?? '', 60)}"`;
    case 'Glob':
      return `listing ${short(input.pattern ?? '', 60)}`;
    case 'Agent':
      return `starting ${input.subagent_type ?? 'an agent'}: ${short(input.description ?? '', 60)}`;
    case 'Workflow':
      return 'running the story pipeline';
    case 'Skill':
      return `following ${input.skill ?? 'a skill'}`;
    case 'ArtifactData':
      return 'updating your Waiting-on-you page';
    case 'ToolSearch':
      return 'loading a tool';
    case 'WebFetch':
    case 'WebSearch':
      return `looking up ${short(input.url ?? input.query ?? '', 80)}`;
    case 'ScheduleWakeup':
    case 'Monitor':
      return 'waiting for the pipeline';
    default:
      return tool ? `using ${tool}` : 'working';
  }
}

const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// A tool name in plain words: no mcp__server__ prefix, camelCase and underscores split.
function plainTool(tool) {
  if (typeof tool !== 'string' || !tool) return 'Working';
  let name = tool;
  if (name.startsWith('mcp__')) name = name.split('__').slice(2).join('__') || name;
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-\s]+/g, ' ').trim().toLowerCase();
  return words ? cap(words) : 'Working';
}

// What an agent is doing, for someone who does not read commands. Every text is redacted and cut.
export function plainWords(tool, input = {}, root = ROOT) {
  input ??= {};
  const file = (p) => rel(p, root) || 'a file';
  let text;
  switch (tool) {
    case 'Bash':
      text = short(input.description ?? '', 140) || 'Running a command';
      break;
    case 'Read':
      text = `Reading ${file(input.file_path)}`;
      break;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      text = `Editing ${file(input.file_path ?? input.notebook_path)}`;
      break;
    case 'Grep':
    case 'Glob':
      text = `Searching for ${short(input.pattern ?? '', 60)}`;
      break;
    case 'Agent': {
      const type = typeof input.subagent_type === 'string' ? input.subagent_type.slice(input.subagent_type.lastIndexOf(':') + 1) : '';
      text = `Starting ${type || 'an agent'}`;
      break;
    }
    case 'Workflow':
      text = 'Starting the story pipeline';
      break;
    case 'Skill':
      text = `Following ${input.skill ?? 'a skill'}`;
      break;
    case 'WebFetch':
    case 'WebSearch':
      text = `Looking up ${short(input.url ?? input.query ?? '', 80)}`;
      break;
    case 'ScheduleWakeup':
    case 'Monitor':
      text = 'Waiting for the pipeline';
      break;
    case 'StructuredOutput':
      text = 'Writing its report';
      break;
    case 'TodoWrite':
      text = 'Updating its to-do list';
      break;
    default:
      text = plainTool(tool);
  }
  return short(text);
}

// A Bash call's command as written (line breaks kept), redacted and cut at 500; null for any other tool.
export function rawCommand(tool, input = {}) {
  if (tool !== 'Bash') return null;
  const text = redact(input?.command ?? '');
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

const FAMILY = /(opus|sonnet|haiku|fable)/;
const familyOf = (id) => FAMILY.exec(String(id ?? '').toLowerCase())?.[1] ?? null;

// "Opus 5.5" from a model id such as claude-opus-5-5; an id it does not know is returned as it is
// (cut to 40); null for no model (or the synthetic one Claude Code writes for its own messages).
export function modelName(id) {
  if (typeof id !== 'string' || id === '' || id === '<synthetic>') return null;
  const bare = id.startsWith('claude-') ? id.slice('claude-'.length) : id;
  let m = /^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  m = /^(\d+)-(\d+)-(opus|sonnet|haiku)/.exec(bare);
  if (m) return `${cap(m[3])} ${m[1]}.${m[2]}`;
  return id.slice(0, 40);
}

// ── the hook side: one file per running agent ───────────────────────────────────────────

// Which stage each agent stands for, from the config's roles. A hook may name a plugin agent
// with or without its prefix (`foreman:tester` or `tester`), so both are keys.
export function stageMap(config) {
  const roles = config?.roles ?? DEFAULTS.roles;
  const map = {};
  const add = (agent, stage) => {
    if (typeof agent !== 'string' || !agent) return;
    const plain = agent.slice(agent.lastIndexOf(':') + 1);
    for (const key of [agent, plain, `foreman:${plain}`]) map[key] = stage;
  };
  add(roles.architect?.agent, 'architect');
  for (const builder of Object.values(roles.builders ?? {})) add(builder?.agent, 'build');
  add(roles.tester?.agent, 'test');
  for (const reviewer of roles.reviewers ?? []) add(reviewer?.agent, 'review');
  // The relay that hands a review to another CLI (engine/review-engine.mjs) is a review stage too.
  add('foreman:review-relay', 'review');
  return map;
}

// The project's stage map; the default roles' map when its config cannot be read, because
// status keeping must never fail.
export function stagesFor(root = ROOT) {
  try {
    return stageMap(loadConfig(root).config);
  } catch {
    return stageMap(null);
  }
}

// The model each agent's role is set to (roles.*.model), under the keys stageMap uses; null when
// the role sets none, or when two roles that share a key set different ones.
export function roleModels(config) {
  const roles = config?.roles ?? DEFAULTS.roles;
  const map = {};
  const add = (agent, model) => {
    if (typeof agent !== 'string' || !agent) return;
    const value = typeof model === 'string' && model ? model : null;
    const plain = agent.slice(agent.lastIndexOf(':') + 1);
    for (const key of [agent, plain, `foreman:${plain}`]) map[key] = key in map && map[key] !== value ? null : value;
  };
  add(roles.architect?.agent, roles.architect?.model);
  for (const builder of Object.values(roles.builders ?? {})) add(builder?.agent, builder?.model);
  add(roles.tester?.agent, roles.tester?.model);
  for (const reviewer of roles.reviewers ?? []) add(reviewer?.agent, reviewer?.model);
  add('foreman:review-relay', RELAY_MODEL);
  return map;
}

// The agents of a session (run-record rows { role, name, agent, model }) that ran on another model
// family than their role is set to, once each, in the order they came: [{ role, name, agent, set,
// ran, text }]. `models` is a roleModels map. An agent with no agent type (the orchestration), a
// role that sets no model (it runs on the session's), a key two roles disagree on, and a model
// that is unknown or synthetic are not compared.
export function modelMismatches(agents, models) {
  if (!Array.isArray(agents)) return [];
  const seen = new Set();
  const found = [];
  for (const row of agents) {
    if (typeof row?.agent !== 'string' || !row.agent || typeof row.model !== 'string' || row.model === '<synthetic>') continue;
    const set = models?.[row.agent] ?? null;
    const want = familyOf(set);
    const got = familyOf(row.model);
    if (!want || !got || want === got) continue;
    const key = `${row.agent}|${row.name}|${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ role: row.role, name: row.name, agent: row.agent, set, ran: row.model, text: `${row.name} (${row.agent}) is set to ${cap(want)} but ran on ${modelName(row.model)}` });
  }
  return found;
}

// The model the review relay runs on (workflows/pipeline.js sets the same; test/workflow.test.mjs
// checks the two match): it only copies text and runs foreman, so a cheap model does.
export const RELAY_MODEL = 'sonnet';

// The model the agent runs on, from the first assistant line of its transcript (the story
// session's own for the foreman); null when it cannot be found yet.
function modelOf(hook, projects) {
  try {
    const paths = sessionPaths(projects, hook.session_id);
    const file = hook.agent_id ? findAgentTranscript(paths, hook.agent_id) : sessionTranscript(paths, hook.session_id);
    return file ? readModel(file) : null;
  } catch {
    return null;
  }
}

export function applyHookEvent(dir, hook, now = new Date(), slot = WORKER, root = ROOT, stages = stagesFor(root), { projects = claudeProjectsDir(process.env) } = {}) {
  const agents = agentsDir(dir, slot);
  mkdirSync(agents, { recursive: true });
  const id = hook.agent_id || 'foreman';
  const role = hook.agent_type || 'foreman';
  const file = join(agents, `${id.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  const at = now.toISOString();
  const current = readSlot(dir, slot).story;
  const story = current?.id ?? null;
  // Any agent start, step or finish is activity for the watchdog. The agent files alone are
  // not enough: they are deleted when an agent finishes, so between two stages the newest one
  // left could be the foreman's pipeline call from long ago (seen on a real run: two slots
  // were stopped as quiet while their reviewers had just finished).
  beat(dir, slot, now);

  // An agent starting or finishing is also progress for the progress watchdog
  // (engine/progress-watch.mjs). A tool step moves the agent file's lastAt, which the build limit
  // (supervisor watch, scheduler hung stepAt) counts as progress, but it is not progressAt for
  // the progress watchdog.
  if (hook.hook_event_name === 'SubagentStart') {
    writeJson(file, { id, role, story, since: at, lastAt: at, doing: 'starting', says: 'Starting', tools: 0 });
    if (current) setSlot(dir, slot, { story: { ...current, progressAt: at, ...(stages[role] === 'test' ? { rounds: (current.rounds ?? 0) + 1 } : {}) } }, now);
    addEvent(dir, `${role} started${story ? ` on ${story}` : ''}`, 'agent', now, slot);
    return;
  }
  if (hook.hook_event_name === 'SubagentStop') {
    if (current) setSlot(dir, slot, { story: { ...current, progressAt: at } }, now);
    const was = readJson(file, null);
    rmSync(file, { force: true });
    if (was?.since) appendFileSync(spansFile(dir, slot), JSON.stringify({ id, role, since: was.since, until: at }) + '\n');
    const mins = was ? Math.max(1, Math.round((now - new Date(was.since)) / 60000)) : null;
    const ran = was ? modelName(was.model) : null;
    addEvent(dir, `${role} finished${was ? ` after ${mins} min, ${was.tools} steps${ran ? `, on ${ran}` : ''}` : ''}`, 'agent', now, slot);
    return;
  }
  if (hook.hook_event_name === 'PreToolUse') {
    const was = readJson(file, { id, role, story, since: at, tools: 0 });
    // The model is looked for until it is found, then never again.
    const model = typeof was.model === 'string' ? null : modelOf(hook, projects);
    const reviewer = typeof was.reviewer === 'string' ? null : relayReviewer(role, hook.tool_name, hook.tool_input);
    writeJson(file, {
      ...was,
      story: was.story ?? story,
      lastAt: at,
      doing: describe(hook.tool_name, hook.tool_input, root),
      says: plainWords(hook.tool_name, hook.tool_input, root),
      raw: rawCommand(hook.tool_name, hook.tool_input),
      ...(model ? { model } : {}),
      ...(reviewer ? { reviewer } : {}),
      tools: (was.tools ?? 0) + 1,
    });
  }
}

// Which reviewer a review relay (agents/review-relay.md) carries, read from its own steps: the
// prompt file it writes, `foreman-review-<reviewer>.md`, or the `--reviewer <name>` of the
// `foreman review --start` it runs. Only a relay's steps count, and the name is kept once found.
const RELAY_ROLE = 'review-relay';
const REVIEWER_FILE = /(?:^|[\\/])foreman-review-([a-z][a-z0-9-]*)\.md$/;
const REVIEWER_FLAG = /(?:^|\s)--reviewer(?:\s+|=)([a-z][a-z0-9-]*)(?=\s|$)/;
export function relayReviewer(role, tool, input = {}) {
  if (typeof role !== 'string' || role.slice(role.lastIndexOf(':') + 1) !== RELAY_ROLE || !input) return null;
  if (tool === 'Write' && typeof input.file_path === 'string') return REVIEWER_FILE.exec(input.file_path)?.[1] ?? null;
  if (tool === 'Bash' && typeof input.command === 'string' && /\bforeman\s+review\b/.test(input.command)) return REVIEWER_FLAG.exec(input.command)?.[1] ?? null;
  return null;
}

// Each reviewer the config runs through an engine (review-engine.mjs), by name, with its agent
// and `engine: { name, model }`, so the page can show a relay as the reviewer it carries.
export function reviewerEngines(config) {
  const out = {};
  const reviewers = config?.roles?.reviewers;
  if (!Array.isArray(reviewers)) return out;
  for (const r of reviewers) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.engine || typeof r.engine !== 'object') continue;
    out[r.name] = { agent: typeof r.agent === 'string' ? r.agent : null, engine: { name: r.engine.name ?? null, model: r.engine.model ?? null } };
  }
  return out;
}

// What the page shows for a relay that has named its reviewer: the reviewer, its agent (the
// badge and name come from it) and its engine, or null for the engine when the config sets none.
function relayOf(agent, engines, config) {
  if (typeof agent.reviewer !== 'string') return undefined;
  const known = engines[agent.reviewer];
  if (known) return { reviewer: agent.reviewer, agent: known.agent, engine: known.engine };
  const r = (config?.roles?.reviewers ?? []).find((x) => x && typeof x === 'object' && x.name === agent.reviewer);
  return { reviewer: agent.reviewer, agent: typeof r?.agent === 'string' ? r.agent : null, engine: null };
}

export function runningAgents(dir = DIR, slot = WORKER) {
  const agents = agentsDir(dir, slot);
  if (!existsSync(agents)) return [];
  return readdirSync(agents)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(agents, f), null))
    .filter(Boolean)
    .sort((a, b) => (a.role === 'foreman') - (b.role === 'foreman') || a.since.localeCompare(b.since));
}

// What ran in a slot's session and when: each finished agent's span, then each agent still
// running, counted up to now. The supervisor reads it when the session ends.
export function sessionSpans(dir, slot, now = new Date()) {
  let done = [];
  try {
    done = readFileSync(spansFile(dir, slot), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((s) => s && s.since && s.until)
      .map(({ role, since, until }) => ({ role, since, until }));
  } catch {
    // no agent finished yet
  }
  const running = runningAgents(dir, slot).map((a) => ({ role: a.role, since: a.since, until: now.toISOString() }));
  return [...done, ...running];
}

// The last 8 agents that finished in a slot's session, newest first, as { id, role, since, until }.
// Span lines from before the id was recorded are left out.
export function finishedAgents(dir, slot) {
  try {
    return readFileSync(spansFile(dir, slot), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((s) => s && s.id && s.since && s.until)
      .slice(-8)
      .reverse()
      .map(({ id, role, since, until }) => ({ id, role, since, until }));
  } catch {
    return [];
  }
}

export const clearSpans = (dir, slot) => rmSync(spansFile(dir, slot), { force: true });

// ── the loop and story side ──────────────────────────────────────────────────────────────

export function setLoop(dir, loopState, reason = '', now = new Date()) {
  const state = readState(dir);
  if (state.loop?.state === loopState && state.loop?.reason === reason) return;
  state.loop = { state: loopState, since: now.toISOString(), reason };
  saveState(dir, state);
  // Running and standby are news, not trouble.
  addEvent(dir, reason ? `Factory ${loopState}: ${reason}` : `Factory ${loopState}`, loopState === 'running' || loopState === 'standby' ? 'info' : 'warn', now);
}

export function startStory(dir, story, now = new Date(), slot = WORKER) {
  setSlot(dir, slot, { state: 'building', reason: '', parkedFor: null, result: null, story: { ...story, stage: 'architect', detail: '', startedAt: now.toISOString(), rounds: 0, committedAt: null } }, now);
  addEvent(dir, `Started ${story.id} · ${story.title}`, 'story', now, slot);
}

// The ship lock's wait shows as "Waiting to ship"; any other release step is building again.
const WAITING_FOR_LOCK = 'waiting for the ship lock';

export function setStage(dir, stage, detail = '', now = new Date(), slot = WORKER) {
  const was = readSlot(dir, slot);
  if (!was.story) return;
  const story = { ...was.story, stage, detail };
  // A new stage or detail is progress (engine/progress-watch.mjs); the same one again, such as
  // the wait for the ship lock reported every 20 seconds, is not.
  if (stage !== was.story.stage || detail !== was.story.detail) story.progressAt = now.toISOString();
  if (detail.startsWith('https://')) story.pr = detail;
  if (stage === 'commit' && !story.committedAt) story.committedAt = now.toISOString();
  const state = stage === 'release' && detail === WAITING_FOR_LOCK ? 'waiting' : was.state === 'waiting' ? 'building' : was.state;
  setSlot(dir, slot, { story, state }, now);
  // The wait is reported every 20 seconds; it goes in the feed once.
  if (!(detail === WAITING_FOR_LOCK && was.story.detail === WAITING_FOR_LOCK)) {
    addEvent(dir, `${story.id}: ${stage}${detail ? ` · ${short(detail, 100)}` : ''}`, 'stage', now, slot);
  }
}

// The learned items (`L-n` ids) the slot's story was given, kept on the story so the run record
// can say what it was exposed to. Each call adds to the list: a fix round asks for the args again.
// Nothing is written when the slot holds another story, or none.
export function noteLearned(dir, slot, storyId, ids, now = new Date()) {
  const cur = readSlot(dir, slot).story;
  if (cur?.id !== storyId || !ids?.length) return;
  const learned = [...new Set([...(cur.learned ?? []), ...ids])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  setSlot(dir, slot, { story: { ...cur, learned } }, now);
}

// The event kind of a story's end; any other result is a warn. An interrupted story was stopped
// with the run and resumes at the next start, so it is news, not a warning.
const EVENT_KIND = { shipped: 'good', 'ready-to-promote': 'good', interrupted: 'info' };

// The session records how its story ended; the supervisor moves it into the recent list.
// `cause` ('story' or 'environment') says, for a failed end only, whether the pipeline rejected the
// story or something around it failed (CI, a conflict, a test file that would not load); the
// supervisor reads it to decide whether the failure counts toward the three-miss pause.
export function endStory(dir, result, pr = '', note = '', now = new Date(), slot = WORKER, { cause = null } = {}) {
  const cur = readSlot(dir, slot).story;
  if (!cur) return;
  const done = { id: cur.id, title: cur.title, phase: cur.phase, result, pr: pr || cur.pr || '', note: short(note, 200), startedAt: cur.startedAt, endedAt: now.toISOString(), rounds: cur.rounds ?? 0, learned: cur.learned ?? [], slot };
  if (result === 'failed' && (cause === 'story' || cause === 'environment')) done.cause = cause;
  setSlot(dir, slot, { story: null, result: done }, now);
  addEvent(dir, `${cur.id} ${result}${note ? `: ${short(note, 100)}` : ''}`, EVENT_KIND[result] ?? 'warn', now, slot);
}

// metrics: { costUsd, minutes } of the session that ended, when known.
export function recordResult(dir, done, metrics = {}) {
  if (!done) return;
  done = { ...done };
  if (metrics.costUsd !== undefined) done.costUsd = metrics.costUsd;
  if (metrics.minutes !== undefined) done.minutes = metrics.minutes;
  const state = readState(dir);
  state.recent = [done, ...(state.recent ?? []).filter((r) => r.id !== done.id || r.endedAt !== done.endedAt)].slice(0, MAX_RECENT);
  saveState(dir, state);
}

// The current run's totals: started by the supervisor, added to as each session ends.
// `stories` keeps the ids, so a story resumed after a crash counts once.
const EMPTY_TOTALS = { since: null, stories: [], shipped: 0, costUsd: 0, minutes: 0 };
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

export function startTotals(dir, now = new Date()) {
  const state = readState(dir);
  state.totals = { ...EMPTY_TOTALS, since: now.toISOString() };
  saveState(dir, state);
}

export function addToTotals(dir, { story, result, costUsd, minutes }) {
  const state = readState(dir);
  const t = { ...EMPTY_TOTALS, ...state.totals };
  state.totals = {
    since: t.since,
    stories: story && !t.stories.includes(story) ? [...t.stories, story] : t.stories,
    shipped: t.shipped + (result === 'shipped' ? 1 : 0),
    costUsd: round(t.costUsd + (Number(costUsd) || 0), 4),
    minutes: round(t.minutes + (Number(minutes) || 0), 1),
  };
  saveState(dir, state);
}

function totalsOf(state) {
  const t = { ...EMPTY_TOTALS, ...state.totals };
  return { since: t.since, stories: Array.isArray(t.stories) ? t.stories.length : 0, shipped: t.shipped, costUsd: round(t.costUsd, 2), minutes: round(t.minutes, 1) };
}

export function setWorkers(dir, workers) {
  const state = readState(dir);
  state.workers = workers;
  saveState(dir, state);
}

// One slot's agents, or every slot's.
export function clearAgents(dir = DIR, slot = null) {
  const slots = slot ? [slot] : existsSync(join(dir, 'slots')) ? readdirSync(join(dir, 'slots')).filter((f) => /^w\d$/.test(f)) : [];
  for (const s of slots) rmSync(agentsDir(dir, s), { recursive: true, force: true });
}

// The page may ask for a story to be built next (control.json's nextStory and requestedAt). The
// request stays open until the story has started in a slot, or the picker says it cannot be built
// (next-request.mjs): the supervisor reads it with openNextRequest at every pick, and settles it
// once with settleNextRequest, which writes handledNextAt and the one event. A story that cannot
// start yet leaves it open, so it is tried first again. state.nextWait holds what the owner is
// shown when it keeps failing (setNextWait), and is kept only for the request that is open.
// takeNextRequest settles at once, for the `next-request` command.
export const openNextRequest = (dir) => openRequest(readJson(paths(dir).control, {}), readState(dir).handledNextAt);

// How is 'started' or 'refused'. False when the request was settled already.
export function settleNextRequest(dir, req, how, now = new Date()) {
  const state = readState(dir);
  if (state.handledNextAt === req.at) return false;
  state.handledNextAt = req.at;
  delete state.nextWait;
  saveState(dir, state);
  if (how === 'started') addEvent(dir, `You asked for ${req.id} next; starting it.`, 'info', now);
  else addEvent(dir, `You asked for ${short(req.id, 20)} next, but it cannot be built yet; the factory carries on in order.`, 'warn', now);
  return true;
}

export function setNextWait(dir, wait) {
  const state = readState(dir);
  if (wait) state.nextWait = wait;
  else delete state.nextWait;
  saveState(dir, state);
}

// The wait, only while it is for the request that is open now.
export function nextWaitOf(dir) {
  const wait = readState(dir).nextWait;
  const req = wait ? openNextRequest(dir) : null;
  return req && wait.at === req.at && wait.id === req.id ? wait : null;
}

export function takeNextRequest(dir, isBuildable, now = new Date()) {
  const req = openNextRequest(dir);
  if (!req) return '';
  if (!isStoryId(req.id) || !isBuildable(req.id)) {
    settleNextRequest(dir, req, 'refused', now);
    return '';
  }
  settleNextRequest(dir, req, 'started', now);
  return req.id;
}

export const isPaused = (dir = DIR) => readJson(paths(dir).control, {}).paused === true;

// ── what is waiting on the owner ─────────────────────────────────────────────────────────
// The files console keeps decisions in <dir>/decisions (lib/console/decisions.mjs): an item
// waits while it has no answer, urgent ones first, then oldest. Without that folder, the artifacts
// console's copy of its decisions page in <dir>/sync/decisions is read instead: an item waits when
// it has no answer and asks for one (input is not "none").

// Every open decision, raw, in the order they are shown: { source: 'files'|'copy', items,
// checkedAt }, or null when neither the decisions folder nor the copy is there. A copy item
// carries its id.
function openDecisions(dir, now = new Date()) {
  if (existsSync(decisionsDir(dir))) {
    const items = pendingDecisions(dir)
      .filter((item) => !item.answer && (item.kind === 'task' || item.options.length > 0))
      .sort((a, b) => (b.urgent === true) - (a.urgent === true));
    return { source: 'files', items, checkedAt: now.toISOString() };
  }
  const base = join(dir, 'sync', 'decisions');
  const docs = (collection) => {
    const folder = join(base, collection);
    if (!existsSync(folder)) return null;
    return Object.fromEntries(
      readdirSync(folder)
        .filter((f) => f.endsWith('.json'))
        .map((f) => [f.slice(0, -5), readJson(join(folder, f), {})]),
    );
  };
  const all = docs('items');
  const answers = docs('answers') ?? {};
  if (!all) return null;
  const items = Object.entries(all)
    .filter(([id, item]) => !answers[id] && item.input !== 'none')
    .sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99))
    .map(([id, item]) => ({ ...item, id }));
  let checkedAt = null;
  try {
    checkedAt = readJson(join(base, 'checked.json'), {}).at ?? null;
  } catch {
    // no stamp yet
  }
  return { source: 'copy', items, checkedAt };
}

export function waitingOnOwner(dir = DIR, now = new Date()) {
  const open = openDecisions(dir, now);
  if (!open) return null;
  const items =
    open.source === 'files'
      ? open.items.map((item) => ({ id: item.id, title: String(item.title).slice(0, 120), kind: item.kind, story: item.story, urgent: item.urgent === true }))
      : open.items.map((item) => ({ id: item.id, title: String(item.title ?? item.id).slice(0, 120), kind: item.kind === 'task' ? 'task' : 'decision' }));
  return { count: items.length, items: items.slice(0, 5), checkedAt: open.checkedAt };
}

// Everything waiting on the owner, in order (lib/console/waiting.mjs): { known, items,
// checkedAt, stranded }, known being whether a decisions source is there, checkedAt that source's
// stamp, stranded the stories left In Progress with nothing running them (waiting.mjs
// strandedStories). `stories` is the project's story list when the
// caller has it (null for none); left out, the project's story source is opened here, from the
// last good config while a run is on it (`env` names the state folder that says so). `loop`
// is state.json's loop when the caller has it; left out, it is read here. Never throws: a part
// that cannot be read is left out.
export async function ownerWaiting(dir = DIR, now = new Date(), { root = ROOT, slots, env = process.env, stories, idPattern, loop } = {}) {
  const { buildWaiting, strandedStories } = await import('../console/waiting.mjs');
  const safely = async (fn, fallback) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };
  const decisions = await safely(() => openDecisions(dir, now), null);
  if (stories === undefined) {
    try {
      const source = openProjectStories({ root, env, lastGood: true });
      stories = source.list();
      idPattern ??= source.idPattern;
    } catch {
      stories = [];
    }
  }
  stories ??= [];
  const count = await safely(() => {
    if (slots != null) return slots;
    try {
      return loadConfig(root).config?.slots ?? MAX_SLOTS;
    } catch {
      return MAX_SLOTS;
    }
  }, MAX_SLOTS);
  const slotList = await safely(() => Array.from({ length: count }, (_, i) => readSlot(dir, `w${i + 1}`)), []);
  const halt = await safely(() => {
    const file = join(dir, 'HALT');
    if (!existsSync(file)) return null;
    return {
      reason: redact(readFileSync(file, 'utf8')).trim().slice(0, 300) || 'A release failed.',
      at: statSync(file).mtime.toISOString(),
      fixProblem: readState(dir).fixProblem ?? null,
      held: slotList.filter((s) => s.state === 'held' && s.haltedBy && s.heldStory).map((s) => s.heldStory),
    };
  }, null);
  const titles = new Map(stories.map((s) => [s.id, s.title]));
  const parks = await safely(async () => {
    // parks.mjs imports this file, so it is loaded here, not at the top.
    const { readParks } = await import('./parks.mjs');
    return readParks(dir).map((p) => ({ ...p, title: titles.get(p.id) ?? '' }));
  }, []);
  if (loop === undefined) loop = await safely(() => readState(dir).loop ?? null, null);
  // A pause Foreman made itself, until a resume comes after it: the same test as the
  // supervisor's autoPaused() and cloud/tick.mjs.
  const autoPause = await safely(() => {
    const state = readState(dir);
    const control = readJson(paths(dir).control, {});
    if (!state.autoPausedAt || (control.resumeAt && control.resumeAt > state.autoPausedAt)) return null;
    // When it tries again by itself (a credit pause), if the time reads.
    const retryAt = typeof state.autoResumeAt === 'string' && !Number.isNaN(Date.parse(state.autoResumeAt)) ? state.autoResumeAt : null;
    return { at: state.autoPausedAt, reason: redact(String(state.autoPauseReason ?? '')), retryAt };
  }, null);
  const configProblem = await safely(() => readState(dir).configProblem ?? null, null);
  const stuck = await safely(() => readState(dir).stuck ?? null, null);
  const claudeSignIn = await safely(() => readSignIn(dir), null);
  const slow = await safely(() => readState(dir).slow ?? [], []);
  const restartPending = await safely(() => restartPendingOf(dir, readState(dir)), null);
  // The stray supervisors the run last counted (strays.mjs), those still running.
  const strays = await safely(() => {
    const s = readState(dir).strays;
    const live = (Array.isArray(s?.pids) ? s.pids : []).filter((pid) => Number.isInteger(pid) && pid > 1 && alive(pid));
    return live.length ? { count: live.length } : null;
  }, null);
  const nextWait = await safely(() => nextWaitOf(dir), null);
  const apiWait = await safely(() => readState(dir).apiWait ?? null, null);
  const envWait = await safely(() => readState(dir).envWait ?? null, null);
  const learningFailed = await safely(() => readState(dir).learningFailed ?? null, null);
  const anchorWait = await safely(() => readState(dir).anchorWait ?? null, null);
  const fileWait = await safely(async () => (await import('./file-locks.mjs')).topFileWait(dir, { stories, now }), null);
  const answerFailures = await safely(() => {
    const list = readState(dir).answerFailures;
    return Array.isArray(list) ? list : [];
  }, []);
  const items = await safely(() => buildWaiting({ decisions, stories, idPattern, slots: slotList, halt, parks, root, loop, autoPause, configProblem, stuck, slow, restartPending, claudeSignIn, strays, nextWait, apiWait, fileWait, learningFailed, answerFailures, anchorWait, envWait, now }), []);
  // The stories left In Progress that no live claim, slot or skip this run holds.
  const stranded = await safely(async () => {
    const { claims } = await import('./locks.mjs');
    const claimed = claims(dir).filter((c) => !c.stale).map((c) => c.id);
    const skipped = loop?.state === 'stopped' ? [] : (readState(dir).skipped ?? []);
    return strandedStories({ stories, claimed, slots: slotList, skipped: Array.isArray(skipped) ? skipped : [] });
  }, []);
  return { known: decisions !== null, items, checkedAt: decisions?.checkedAt ?? null, stranded };
}

// ── what the page receives ───────────────────────────────────────────────────────────────

// Who stopped the run or asked it to (see the header), or null.
export function stoppedByOf(dir) {
  const rec = readStopRecord(join(dir, STOPPED_FILE)) ?? readStopRecord(join(dir, 'STOP')) ?? readStopRecord(join(dir, LAST_STOP));
  return rec ? { ...rec, text: stopperText(rec) } : null;
}

// The supervisor's pending restart on new code ({ from, to, since }), or null: none for a stopped
// run, and none while supervisor.pid names a pid that is no longer a live supervisor (one killed
// with kill -9 while draining leaves restartPending in state.json). With no pid file it is still
// shown: the pid file never travels to another machine (supervisor-pid.mjs), and a clean exit
// clears restartPending itself. defaultAlive, not leash.mjs's kill-only alive, so a pid reused by
// another program (after a reboot) counts as dead, the same rule as runningSupervisor; its `ps`
// runs only while a restart is pending.
export function restartPendingOf(dir, state, { alive = defaultAlive } = {}) {
  const pending = state?.restartPending ?? null;
  if (!pending || state?.loop?.state === 'stopped') return null;
  const pid = readPid(dir);
  return pid !== null && !alive(pid) ? null : pending;
}

// The slots the page shows: up to the worker count, plus any slot above it still busy, out of
// the configured slots.
const BUSY = ['building', 'waiting', 'held', 'parked', 'down'];
const MAX_SLOTS = 8;
function shownSlots(dir, workers, slots) {
  const ids = [];
  for (let n = 1; n <= slots; n++) {
    const id = `w${n}`;
    if (n <= workers || BUSY.includes(readSlot(dir, id).state)) ids.push(id);
  }
  return ids;
}

// While more stories run than `workers` allows (workers was lowered while they ran), the
// { running, limit, text } that `foreman status` and the page show; null otherwise, and for a
// stopped run. A running story is a building slot (launch() sets it while the slot prepares) or
// one waiting for the ship lock; held, parked, down and idle slots run nothing. `slots` must
// hold every busy slot, which shownSlots does.
const RUNNING = ['building', 'waiting'];
export function drainingOf({ loop, workers, slots }) {
  if (loop?.state === 'stopped') return null;
  const running = slots.filter((s) => RUNNING.includes(s.state)).length;
  if (running <= workers) return null;
  return { running, limit: workers, text: `${running} running, limit ${workers}: draining` };
}

// The queued work, as [{ id, slot, from, mode, text }], for `foreman status` and the page: work
// the supervisor holds back for a slot to take (state.json's `queued`, which it keeps current).
// `from` is the slot the work was pinned to before it was rehomed to any slot under the worker
// count. [] for a stopped run, for anything that is not a list, and for items with no id. The
// slot number is read here, not through slot-work.mjs, which this file does not import.
const slotN = (slot) => {
  const m = typeof slot === 'string' ? /^w([1-9]\d*)$/.exec(slot) : null;
  return m ? Number(m[1]) : null;
};
export function queuedOf({ loop, queued, workers, slots }) {
  if (loop?.state === 'stopped' || !Array.isArray(queued)) return [];
  const idle = (slots ?? []).find((s) => (slotN(s?.id) ?? Infinity) <= workers && s.state === 'idle');
  return queued
    .filter((q) => q && typeof q.id === 'string')
    .map((q) => {
      const next = idle ? `${idle.id} takes it next` : 'the next slot under the worker count to free up takes it';
      const pinned = q.slot ?? null;
      const fromOver = q.from && (slotN(q.from) ?? Infinity) > workers ? q.from : null;
      const over = fromOver ?? (pinned !== null && (slotN(pinned) ?? Infinity) > workers ? pinned : null);
      // A start-up resume is ranked: it starts by priority, so no slot is named.
      let text = pinned ? `${q.id} queued for ${pinned}` : `${q.id} queued; ${next}`;
      if (over) text = `${q.id} queued for ${over}, which is over the worker count; ${next}`;
      if (q.ranked) text = `${q.id} queued to resume${fromOver ? ` (it was in ${fromOver}, over the worker count)` : ''}; it starts by priority when a slot under the worker count is free`;
      return { id: q.id, slot: pinned, from: q.from ?? null, mode: q.mode ?? '', text };
    });
}

// "Set to Opus, runs on Sonnet 5.5" when an agent runs on another model family than its role is
// set to; null when either is unknown or the families match.
function modelNote(setting, model) {
  const want = familyOf(setting);
  const got = familyOf(model);
  return want && got && want !== got ? `Set to ${cap(want)}, runs on ${modelName(model)}` : null;
}

// opts: { root, slots, env, models }. The slot count comes from the project's config when not given; with
// no readable config every slot up to the most a config allows is looked at. The stories come
// from the last good config while a run is on it (`env` names the state folder that says so).
export async function snapshot(dir = DIR, now = new Date(), stages = null, { root = ROOT, slots: slotCount, env = process.env, models = null, engines = null } = {}) {
  const { actionsFor } = await import('./scheduler.mjs');
  const { claims } = await import('./locks.mjs');
  // parks.mjs imports this file, so it is loaded here, not at the top.
  const { readParks } = await import('./parks.mjs');
  const { fileWaits } = await import('./file-locks.mjs');
  let config = null;
  if (stages == null || slotCount == null || models == null || engines == null) {
    try {
      config = loadConfig(root).config;
    } catch {
      // status keeping must never fail
    }
  }
  stages ??= stageMap(config);
  slotCount ??= config?.slots ?? MAX_SLOTS;
  models ??= roleModels(config);
  engines ??= reviewerEngines(config);
  const state = readState(dir);
  const workers = state.workers ?? 1;
  let waitsOfChecks = new Map();
  try {
    waitsOfChecks = checkWaits(dir);
  } catch {
    // status keeping must never fail
  }
  const slots = shownSlots(dir, workers, slotCount).map((id) => {
    const slot = readSlot(dir, id);
    const running = runningAgents(dir, id);
    const subagentStage = running.map((a) => stages[a.role]).find(Boolean);
    const story = slot.story ? { ...slot.story, stage: subagentStage ?? slot.story.stage } : null;
    const agents = running.map((a) => ({
      ...a,
      quietFor: Math.round((now - new Date(a.lastAt)) / 60000),
      stage: stages[a.role] ?? (a.role === 'foreman' ? (story?.stage ?? null) : null),
      modelName: modelName(a.model),
      modelNote: modelNote(models[a.role], a.model),
      ...(a.reviewer !== undefined ? { relay: relayOf(a, engines, config) } : {}),
    }));
    // The page needs neither the last result (it is in `recent`) nor the heartbeat.
    const shown = { ...slot };
    delete shown.result;
    delete shown.lastBeat;
    const lead = agents.find((a) => a.role === 'foreman');
    const checkWait = waitsOfChecks.get(id);
    return { ...shown, story, agents, model: lead?.modelName ?? null, finished: finishedAgents(dir, id), actions: actionsFor(slot), ...(checkWait ? { checkWait } : {}) };
  });

  let queue = { now: [], next: [], waiting: 0 };
  let counts = null;
  let titles = new Map();
  let allTitles = new Map();
  let list = null;
  let idPattern;
  try {
    const source = openProjectStories({ root, env, lastGood: true });
    list = source.list();
    idPattern = source.idPattern;
    allTitles = new Map(list.map((s) => [s.id, s.title]));
    const order = buildOrder(list, { idPattern });
    queue = {
      now: order.buildableNow.slice(0, 60),
      next: order.order.slice(0, 12),
      waiting: order.waiting.length,
      ownerTasks: order.ownerTasks.length,
      decisions: order.waiting.filter((w) => w.on.some((o) => o.startsWith('Waiting for your decision'))).length,
    };
    titles = new Map([...order.buildableNow, ...order.waiting].map((s) => [s.id, s.title]));
    const p = progress(list);
    // The command centre page still reads `byPhase` with `phase`; keep that shape until it moves.
    counts = { ...p, byPhase: p.byGroup.map((g) => ({ phase: g.group, name: g.name, done: g.done, total: g.total })) };
  } catch {
    // No config yet, or a story folder that is briefly unreadable (a synced folder mid-sync): the page keeps its last queue.
  }
  const control = readJson(paths(dir).control, {});
  // Releases that wait on someone (a promotion click, say): every check passed.
  let parked = [];
  try {
    parked = readParks(dir).map((p) => ({ id: p.id, title: allTitles.get(p.id) ?? '', step: p.step, reason: p.reason, pr: p.pr ?? null, parkedAt: p.parkedAt ?? null, lastCheck: p.lastCheck ? { at: p.lastCheck.at ?? null, outcome: p.lastCheck.outcome ?? null } : null }));
  } catch {
    // status keeping must never fail
  }
  let waitingOnFiles = [];
  try {
    waitingOnFiles = fileWaits(dir, { stories: list });
  } catch {
    // status keeping must never fail
  }
  const w = await ownerWaiting(dir, now, { root, slots: slotCount, env, stories: list ?? null, idPattern, loop: state.loop });
  const { headline, waitingCount } = await import('../console/waiting.mjs');
  // The count and the items are what the owner can act on now, a bundle of quick decisions
  // counting once; `later` counts the owner tasks still waiting on an open blocker; FYI items
  // are in neither. The headline reads the whole list, the loop and the slots shown here
  // (lib/console/waiting.mjs).
  const nowItems = w.items.filter((i) => i.group === 'now');
  const later = w.items.filter((i) => i.group === 'later').length;
  const waiting =
    !w.known && !w.items.length
      ? null
      : {
          count: waitingCount(w.items),
          later,
          items: nowItems.slice(0, 5),
          checkedAt: w.known ? w.checkedAt : now.toISOString(),
          headline: headline({ items: w.items, loop: state.loop, slots, stranded: w.stranded }),
        };
  return {
    waiting,
    updatedAt: now.toISOString(),
    loop: state.loop,
    workers,
    draining: drainingOf({ loop: state.loop, workers, slots }),
    queued: queuedOf({ loop: state.loop, queued: state.queued, workers, slots }),
    fileWaits: waitingOnFiles,
    slots,
    events: recentEvents(dir),
    recent: state.recent ?? [],
    totals: totalsOf(state),
    queue,
    progress: counts,
    ownerClaims: claims(dir)
      .filter((c) => c.by === 'owner')
      .map((c) => ({ id: c.id, title: allTitles.get(c.id) ?? '', at: c.at ?? null })),
    parked,
    fixProblem: state.fixProblem ?? null,
    // The progress watchdog's { kind, since, reason } while the run is not making progress
    // (the supervisor's checkProgress); a stopped run is never stuck.
    stuck: state.loop?.state === 'stopped' ? null : (state.stuck ?? null),
    // The watchdog's slow sessions (active, but a stage past watchdog.progressMinutes): an FYI only.
    slow: state.loop?.state === 'stopped' ? [] : Array.isArray(state.slow) ? state.slow : [],
    // The stories the owner skipped this run (the supervisor's skipped): none once it stops.
    skipped: state.loop?.state === 'stopped' ? [] : Array.isArray(state.skipped) ? state.skipped : [],
    // The supervisor's { from, to, since } until it restarts on new plugin code: no new story
    // starts meanwhile. A stopped run has none, and neither has one whose supervisor has died
    // (restartPendingOf).
    restartPending: restartPendingOf(dir, state),
    // The ISO time picking is held for a backoff after failed sessions (the supervisor's
    // backoffUntil), while that is in the future: the page's idle slots say so. None once it
    // stops.
    backoffUntil: state.loop?.state !== 'stopped' && Date.parse(state.backoffUntil) > now.getTime() ? state.backoffUntil : null,
    control: { paused: control.paused === true, handledNextAt: state.handledNextAt ?? null, handledWorkersAt: state.handled?.workers ?? null },
    stoppedBy: stoppedByOf(dir),
  };
}

// One story picked by the rules, from the project's story source.
function pickOne(opts) {
  const source = openProjectStories({ root: ROOT });
  return nextStory(source.list(), { idPattern: source.idPattern, ...opts });
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'loop') setLoop(DIR, rest[0], rest.slice(1).join(' '));
    else if (cmd === 'beat') beat(DIR);
    else if (cmd === 'story-start') {
      let s = null;
      try {
        s = pickOne({ id: rest[0] });
      } catch {
        // no config or unreadable stories: the story still starts, with no title
      }
      s ??= { id: rest[0], title: '', group: '', groupName: '' };
      startStory(DIR, { id: s.id, title: s.title, phase: s.group, phaseName: s.groupName });
    } else if (cmd === 'stage') setStage(DIR, rest[0], rest.slice(1).join(' '));
    else if (cmd === 'story-end') endStory(DIR, rest[0], rest[1] ?? '', rest.slice(2).join(' '));
    else if (cmd === 'clear-agents') clearAgents(DIR, process.env.FOREMAN_SLOT || null);
    else if (cmd === 'next-request') {
      const id = takeNextRequest(DIR, (want) => pickOne({ id: want, strict: true }) !== null);
      if (id) console.log(id);
    } else if (cmd === 'paused') process.exit(isPaused(DIR) ? 0 : 1);
    else if (cmd === 'snapshot') console.log(JSON.stringify(await snapshot(DIR), null, 2));
    else {
      console.error('usage: state.mjs loop|story-start|stage|story-end|beat|next-request|paused|clear-agents|snapshot');
      process.exit(2);
    }
  } catch (err) {
    // Status keeping must never stop the factory.
    console.error(`state.mjs: ${err.message}`);
  }
}
