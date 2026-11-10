// What a story session loads besides Foreman. The supervisor calls sessionScope once at start,
// before any session, and passes the scope to session.command; a refusal stops the run.
//
// A story session runs with `--setting-sources project,local` and `--strict-mcp-config`
// (session.mjs), so it loads none of the user-level settings, hooks, plugins, skills or agents,
// and no MCP server it is not given. This file works out what it is given:
//
//   { ok: true, scope: { settings, mcpServers } }
//   { ok: false, reason }        a pack Foreman cannot use, a server .mcp.json does not
//                                define, or a .mcp.json it cannot read; it never throws
//
// `settings` goes into the session's --settings:
//   - the CARRY keys of the user's <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json that the
//     project's .claude/settings.json and .claude/settings.local.json do not set
//     (carryUserSettings): the model, effort, attribution, permissions, sandbox and sign-in,
//     which add no context but decide how the session runs. Left out with session.userSettings
//     on, since the session then reads the user settings itself.
//   - enabledPlugins: every plugin the project or local settings enable (and the user's, with
//     session.userSettings on) set to false, except Foreman and the plugins the pack's
//     sessionNeeds names, which are true. A Foreman enabled only in the user's settings is
//     set to true too, so it still loads.
// `mcpServers` goes into the session's --mcp-config: the pack's sessionNeeds.mcpServers, then
// the servers session.mcpServers names, as the project's .mcp.json defines them (those win).
//
// session.userSettings (default false) on means the session also loads the user settings,
// CLAUDE.md and memory; it still gets the strict MCP config and the enabledPlugins above.
//
// sessionScope is pure given its fs; userMcpServer is for the doctor's wording only.

import nodeFs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { PACKS, packFor } from '../../packs/index.mjs';
import { MCP_NAME } from '../config/validate.mjs';

export { MCP_NAME };

// The user-level settings that decide how a session runs and its sign-in. None adds context.
export const CARRY = [
  'model', 'effortLevel', 'modelSettings', 'alwaysThinkingEnabled', 'attribution', 'includeCoAuthoredBy', 'env', 'permissions', 'sandbox',
  'apiKeyHelper', 'forceLoginMethod', 'forceLoginOrgUUID', 'awsAuthRefresh', 'awsCredentialExport', 'skipDangerousModePermissionPrompt',
];

const PLUGIN_ID = /^[^@\s]+@[^@\s]+$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlain = (v) => isObject(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const message = (err) => err?.message ?? String(err);
const sets = (layer, key) => isObject(layer) && Object.hasOwn(layer, key) && layer[key] !== undefined;

// The CARRY keys of `user` a session would get from the user settings today. Project and local
// outrank user, so a key either sets is left to them; in an object (env, permissions, sandbox,
// attribution, modelSettings) that goes sub-key by sub-key. An array sub-key (permissions.allow
// and the like) is always carried, because Claude Code joins arrays across the layers.
export function carryUserSettings({ user = {}, project = {}, local = {} }) {
  const out = {};
  for (const key of CARRY) {
    if (!sets(user, key)) continue;
    const value = user[key];
    if (isPlain(value)) {
      const kept = {};
      for (const [sub, v] of Object.entries(value)) {
        if (Array.isArray(v) || (!sets(project?.[key], sub) && !sets(local?.[key], sub))) kept[sub] = v;
      }
      if (Object.keys(kept).length) out[key] = kept;
    } else if (!sets(project, key) && !sets(local, key)) {
      out[key] = value;
    }
  }
  return out;
}

export function configDir(env, homedir) {
  return env?.CLAUDE_CONFIG_DIR || join(homedir, '.claude');
}

// The settings file as a plain object; {} when it is missing, unreadable, not JSON or not an
// object, as Claude Code itself ignores invalid settings in -p.
export function readSettingsFile(fs, file) {
  try {
    const v = JSON.parse(String(fs.readFileSync(file, 'utf8')));
    return isPlain(v) ? v : {};
  } catch {
    return {};
  }
}

// The servers in <root>/.mcp.json: { servers }, none for a missing file, or { error }.
export function projectMcpServers({ root, fs }) {
  let text;
  try {
    text = String(fs.readFileSync(join(root, '.mcp.json'), 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return { servers: {} };
    return { error: message(err) };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { error: message(err) };
  }
  if (!isObject(json)) return { error: 'not a JSON object' };
  if (json.mcpServers === undefined) return { servers: {} };
  if (!isObject(json.mcpServers)) return { error: 'mcpServers is not an object' };
  return { servers: json.mcpServers };
}

// Whether `name` is an MCP server of the user's own Claude Code set-up (~/.claude.json, or
// .claude.json in CLAUDE_CONFIG_DIR), for all projects or for this one.
export function userMcpServer({ name, root, env = process.env, homedir = os.homedir(), fs = nodeFs }) {
  const file = env?.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir, '.claude.json');
  try {
    const json = JSON.parse(String(fs.readFileSync(file, 'utf8')));
    const has = (servers) => isObject(servers) && Object.hasOwn(servers, name);
    return has(json?.mcpServers) || has(json?.projects?.[root]?.mcpServers);
  } catch {
    return false;
  }
}

// The pack's sessionNeeds as { plugins, mcpServers }, or { why } when Foreman cannot use it.
function needsOf(needs) {
  if (needs === undefined || needs === null) return { plugins: [], mcpServers: {} };
  if (!isPlain(needs)) return { why: 'sessionNeeds is not an object' };
  const { plugins = [], mcpServers = {} } = needs;
  if (!Array.isArray(plugins) || !plugins.every((p) => typeof p === 'string' && PLUGIN_ID.test(p))) return { why: 'sessionNeeds.plugins is not a list of name@market ids' };
  if (!isPlain(mcpServers)) return { why: 'sessionNeeds.mcpServers is not an object' };
  for (const [name, def] of Object.entries(mcpServers)) {
    if (!MCP_NAME.test(name)) return { why: `sessionNeeds.mcpServers names ${name}, which is not a server name` };
    if (!isPlain(def)) return { why: `sessionNeeds.mcpServers.${name} is not an object` };
  }
  return { plugins: [...plugins], mcpServers: { ...mcpServers } };
}

const enabledIds = (settings) => (isObject(settings?.enabledPlugins) ? Object.keys(settings.enabledPlugins).filter((id) => settings.enabledPlugins[id] === true) : []);
const nameOf = (id) => id.split('@')[0];

function scopeOf({ config, root, env, homedir, fs, packs }) {
  const userSettings = config?.session?.userSettings === true;
  const user = readSettingsFile(fs, join(configDir(env, homedir), 'settings.json'));
  const project = readSettingsFile(fs, join(root, '.claude', 'settings.json'));
  const local = readSettingsFile(fs, join(root, '.claude', 'settings.local.json'));

  let pack;
  let needs;
  try {
    pack = packFor(config, packs);
    needs = needsOf(pack?.sessionNeeds);
  } catch (err) {
    return { ok: false, reason: `pack ${pack?.name ?? config?.pack}: ${message(err)}` };
  }
  if (needs.why) return { ok: false, reason: `pack ${pack.name}: ${needs.why}` };

  const packPlugins = new Set(needs.plugins);
  const wanted = (id) => nameOf(id) === 'foreman' || packPlugins.has(id);
  const enabledPlugins = {};
  for (const id of [...enabledIds(project), ...enabledIds(local), ...(userSettings ? enabledIds(user) : [])]) enabledPlugins[id] = wanted(id);
  for (const id of enabledIds(user)) if (nameOf(id) === 'foreman') enabledPlugins[id] = true;
  for (const id of packPlugins) enabledPlugins[id] = true;

  const settings = {
    ...(userSettings ? {} : carryUserSettings({ user, project, local })),
    ...(Object.keys(enabledPlugins).length ? { enabledPlugins } : {}),
  };

  // Filtered here: pack defaults are merged after validate() and never checked.
  const names = Array.isArray(config?.session?.mcpServers) ? config.session.mcpServers.filter((n) => typeof n === 'string' && MCP_NAME.test(n)) : [];
  const named = {};
  if (names.length) {
    const found = projectMcpServers({ root, fs });
    if (found.error) return { ok: false, reason: `could not read .mcp.json: ${found.error}` };
    const missing = names.filter((n) => !Object.hasOwn(found.servers, n) || !isObject(found.servers[n]));
    if (missing.length) return { ok: false, reason: `session.mcpServers names ${missing.join(', ')}, which .mcp.json does not define` };
    for (const n of names) named[n] = found.servers[n];
  }
  return { ok: true, scope: { settings, mcpServers: { ...needs.mcpServers, ...named } } };
}

export function sessionScope({ config, root, env = process.env, homedir = os.homedir(), fs = nodeFs, packs = PACKS }) {
  try {
    return scopeOf({ config, root, env, homedir, fs, packs });
  } catch (err) {
    return { ok: false, reason: message(err) };
  }
}
