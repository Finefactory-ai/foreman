// One story session: the only place that builds, starts and reads `claude -p "/foreman:story
// <id> [mode]"`. The supervisor decides when; this file knows how.
//
//   command(...)   the program, its arguments, its environment and the files it reads (pure)
//   logPath(...)   where a session's transcript goes: <stateDir>/logs/<slot>-<time>.log, or
//                  <slot>-<time>-2.log and on when a session of the slot started in that second
//   start(...)     writes those files, then spawns it detached in the slot's worktree, output
//                  to the log
//   result(log)    how it ended, from the log (classify.mjs)
//
// The session prints stream-json (one JSON event per line, `--verbose` being required for
// it), so the log carries the cost, turns and time of the run as well as its final message;
// session-log.mjs reads them. Every event is a write to the log, which keeps its mtime moving
// while the session works: the supervisor's watchdog counts that as activity.
//
// Anything not in the allowed tools is denied; session.extraTools adds names (such as MCP
// tools), keeping only those TOOL_NAME accepts. Sessions keep their transcripts, so the
// supervisor can read each agent's token use from them, and session-files.mjs deletes that
// session's files when it ends; the log is the record. The artifacts console needs the
// ArtifactData tool, which a headless session gets only with the VS Code entrypoint; no other
// console gets either. pluginDir, when given, alone decides the plugin folder: a non-empty string is
// passed as --plugin-dir, null or '' passes nothing, whatever FOREMAN_PLUGIN_DIR says (the
// supervisor works it out, plugin-copy.mjs sessionPlugin). Left out (undefined), a
// FOREMAN_PLUGIN_DIR in baseEnv, when set, is passed as --plugin-dir.
//
// A lean session: it loads Foreman, the plugins and MCP servers it is given, and nothing else of
// the owner's own Claude Code set-up. `--setting-sources project,local` leaves out the user
// settings (their hooks, plugins, skills, agents and MCP servers), `--strict-mcp-config` every
// MCP server not in --mcp-config, and --settings sets claudeMdExcludes to the user's CLAUDE.md
// (<CLAUDE_CONFIG_DIR or $HOME/.claude>/CLAUDE.md, with its imports) and autoMemoryEnabled to
// false. The sign-in is unchanged. config session.userSettings: true loads the user settings,
// CLAUDE.md and memory again; --strict-mcp-config stays either way.
//
// ScheduleWakeup and CronCreate are denied (--disallowedTools, right after --strict-mcp-config,
// never last: the flag takes every argument up to the next option, and --allowedTools must stay
// last). A wake-up still scheduled when the session prints its result keeps `claude -p` alive
// until it fires, 30 to 60 minutes later (FM-368). The Workflow's own completion wakes the
// session, so the wake-up adds nothing. A deny wins over an allow, so session.extraTools cannot
// bring them back.
//
// scope is what the session is given (session-scope.mjs, worked out once at start): its
// settings (the carried user settings and enabledPlugins) and its mcpServers, passed as
// --mcp-config with a file of {"mcpServers": ...} when there are any. --mcp-config takes every
// argument after it, so --strict-mcp-config follows it.
//
// packSession is what the project's pack adds (pack-session.mjs): its env goes over the base
// and slot environment (the FOREMAN_* keys still win) and its pathPrefix goes first on PATH.
// --settings is the lean keys, then the scope's settings, then the pack's, merged in that
// order (mergeSettings: objects key by key, arrays joined once each, otherwise the later one
// wins), so the pack's isolation settings always reach the session. It goes just before
// --allowedTools, which takes every argument after it, and is left out when empty.
//
// Both flags get a file path, never the JSON: the settings can hold the user's env and
// apiKeyHelper, and the MCP config the servers' env and headers, which anyone on the machine
// could read on the claude argv. command() returns them as `files`, { path, text } for each
// flag it passes (settings first, then MCP): <stateDir>/session-config/<slot>-settings.json and
// <slot>-mcp.json, one pair per slot. start() writes them with mode 600 before it spawns, and
// spawns nothing when one cannot be written. They stay when the session ends; the slot's next
// session writes over them, and a slot runs one session at a time.
//
// command() also returns `envFile`, { path, text }: the session's environment, less SESSION_KEYS
// (ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN: a project's checks do not need the Claude
// sign-in, and the file stays on disk), as one JSON object,
// <stateDir>/session-config/<slot>-env.json (session-env.mjs), taken after every change to env.
// The `env` the claude session itself gets keeps them. It is not in `files`, which names only what a flag passes. start() writes it, mode 600
// like the others, after them and before it spawns. `foreman checks` reads it to run the
// project's checks in the session's own environment, whatever the calling shell has set; the
// anchor guard denies an agent's plain ways of writing it.
//
// fileKeys is what the supervisor read from Foreman's own keys file (.env.foreman,
// foreman-keys.mjs sessionKeys). Only ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are taken
// from it, and only where baseEnv has no value for them; no other name reaches a session. With
// no fileKeys the command is exactly as it was.
//
// useSubscription: the platform credits ran out and the run moved to the subscription
// (claude-fallback.mjs). ANTHROPIC_API_KEY is then taken out after every merge, so neither the
// base environment, the keys file, the slot environment nor a pack can bring it back, and
// Claude Code uses CLAUDE_CODE_OAUTH_TOKEN or the login on this computer. Off, the command is
// exactly as without it.
//
// testCores is this session's share of the machine's cores for its test runs, from
// testCoreShare(cores, slots): the cores split evenly between the slots that may build at once,
// at least 2 each, a cores or slots value that is not a positive whole number counting as 1. As a
// positive whole number it becomes FOREMAN_TEST_CORES among the FOREMAN_* keys, so neither the
// base environment, the slot environment nor a pack can change it; Foreman's own test config
// and a project's test runner can read it. Without it the command is exactly as before, and a
// FOREMAN_TEST_CORES in baseEnv passes through.
//
// pluginRoot is the plugin folder the session loads (the supervisor's own, resolved). As a
// non-empty string it becomes FOREMAN_PLUGIN_ROOT among the FOREMAN_* keys, so no other
// environment can change it; the `foreman` CLI compares its own folder with it at the start of a
// session and warns when a shell alias or another copy runs instead (foreman-command.mjs).
// Without it the command is exactly as before, and a FOREMAN_PLUGIN_ROOT in baseEnv passes through.

import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { classifySession } from './classify.mjs';
import { writeSecretFile } from './env-text.mjs';
import { TOOL_NAME } from '../config/validate.mjs';
import { SESSION_KEYS, withSessionKeys } from './foreman-keys.mjs';
import { sessionEnvPath } from './session-env.mjs';

const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'ToolSearch', 'Workflow(foreman:pipeline)'];

// Session timers: a pending one keeps the session alive after its result (FM-368).
const DENIED_TOOLS = ['ScheduleWakeup', 'CronCreate'];

const artifactsConsole = (config) => config?.console?.adapter === 'artifacts';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Plain objects merge key by key, arrays join with each item once, and otherwise the later
// layer wins.
function mergeSettings(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!isObject(layer)) continue;
    for (const [key, value] of Object.entries(layer)) {
      const had = out[key];
      if (isObject(had) && isObject(value)) out[key] = mergeSettings(had, value);
      else if (Array.isArray(had) && Array.isArray(value)) out[key] = [...new Set([...had, ...value])];
      else out[key] = isObject(value) ? mergeSettings(value) : Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

const positiveWhole = (v) => Number.isInteger(v) && v > 0;

// Where a slot's session reads its settings ('settings') or MCP config ('mcp') from.
const configFile = (stateDir, slot, kind) => join(stateDir, 'session-config', `${slot}-${kind}.json`);

// The cores each slot's test runs may use: an even split, at least 2.
export function testCoreShare(cores, slots) {
  const c = positiveWhole(cores) ? cores : 1;
  const s = positiveWhole(slots) ? slots : 1;
  return Math.max(2, Math.floor(c / s));
}

export function command({ id, mode = '', config, slot, n, root, stateDir, supervisorPid, envAdapter, baseEnv = {}, packSession = null, fileKeys = {}, useSubscription = false, scope = null, testCores, pluginDir, pluginRoot }) {
  const artifacts = artifactsConsole(config);
  const env = {
    ...withSessionKeys(baseEnv, fileKeys),
    ...(envAdapter?.env(n) ?? {}),
    ...(isObject(packSession?.env) ? packSession.env : {}),
    FOREMAN_RUN: '1',
    FOREMAN_PROJECT_DIR: root,
    FOREMAN_STATE_DIR: stateDir,
    FOREMAN_SLOT: slot,
    FOREMAN_STORY: id,
    FOREMAN_SUPERVISOR_PID: String(supervisorPid),
    ...(positiveWhole(testCores) ? { FOREMAN_TEST_CORES: String(testCores) } : {}),
    ...(typeof pluginRoot === 'string' && pluginRoot ? { FOREMAN_PLUGIN_ROOT: pluginRoot } : {}),
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
  if (useSubscription) delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (artifacts) env.CLAUDE_CODE_ENTRYPOINT = 'claude-vscode';
  const prefix = Array.isArray(packSession?.pathPrefix) ? packSession.pathPrefix : [];
  if (prefix.length) env.PATH = [...prefix, env.PATH].filter(Boolean).join(delimiter);
  // Filtered again here: pack defaults are merged after validate() and never checked.
  const extra = Array.isArray(config?.session?.extraTools)
    ? config.session.extraTools.filter((t) => typeof t === 'string' && TOOL_NAME.test(t))
    : [];
  const tools = [...TOOLS, ...(artifacts ? ['ArtifactData'] : []), ...extra];
  const prompt = `/foreman:story ${id}${mode ? ` ${mode}` : ''}`;
  // A plugin folder named by --plugin-dir wins over an installed copy of the same name.
  const pluginFolder = pluginDir === undefined ? baseEnv.FOREMAN_PLUGIN_DIR : pluginDir;
  const plugin = pluginFolder ? ['--plugin-dir', pluginFolder] : [];
  const userSettings = config?.session?.userSettings === true;
  const dir = baseEnv.CLAUDE_CONFIG_DIR || (baseEnv.HOME && join(baseEnv.HOME, '.claude'));
  const lean = userSettings ? {} : { ...(dir ? { claudeMdExcludes: [join(dir, 'CLAUDE.md')] } : {}), autoMemoryEnabled: false };
  const merged = mergeSettings(lean, scope?.settings ?? {}, packSession?.settings ?? {});
  const mcpServers = isObject(scope?.mcpServers) ? scope.mcpServers : {};
  const files = [];
  const settings = [];
  if (Object.keys(merged).length) {
    const path = configFile(stateDir, slot, 'settings');
    files.push({ path, text: JSON.stringify(merged) });
    settings.push('--settings', path);
  }
  const mcp = [];
  if (Object.keys(mcpServers).length) {
    const path = configFile(stateDir, slot, 'mcp');
    files.push({ path, text: JSON.stringify({ mcpServers }) });
    mcp.push('--mcp-config', path);
  }
  const sources = userSettings ? [] : ['--setting-sources', 'project,local'];
  // config session.model: the model of the story session itself (the orchestrator). The flag
  // beats ANTHROPIC_MODEL and the carried user settings; the roles' own models are unaffected.
  const model = typeof config?.session?.model === 'string' && config.session.model ? ['--model', config.session.model] : [];
  return {
    cmd: 'claude',
    args: ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', ...model, ...sources, ...mcp, '--strict-mcp-config', '--disallowedTools', ...DENIED_TOOLS, ...plugin, ...settings, '--allowedTools', ...tools],
    env,
    files,
    envFile: { path: sessionEnvPath(stateDir, slot), text: JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_KEYS.includes(k)))) },
  };
}

// A name already there (a session of the slot that started in the same second) gets -2, -3, so
// two sessions never share a transcript.
export function logPath({ stateDir, slot, now = new Date(), taken = existsSync }) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = (n) => join(stateDir, 'logs', `${slot}-${stamp}${n > 1 ? `-${n}` : ''}.log`);
  let n = 1;
  while (taken(name(n))) n++;
  return name(n);
}

// Detached, so the supervisor can stop the whole session (its process group) at once. The files
// are written first, the env file last, so a write that fails leaves no log open and starts no
// session.
export function start({ cmd, args, env, cwd, logFile, files = [], envFile, spawn = nodeSpawn }) {
  for (const { path, text } of files) writeSecretFile(path, text, 0o600);
  if (envFile) writeSecretFile(envFile.path, envFile.text, 0o600);
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    return spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  } finally {
    closeSync(fd);
  }
}

export const result = (logText) => classifySession(logText);
