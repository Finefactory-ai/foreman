// `foreman settings`: read and change the settings in the registry (lib/settings/registry.mjs).
//
//   settings list [--group g] [--json]     name, value, source, when it applies
//   settings get <name>                    the value in effect, as JSON
//   settings set <name> <value> [--team]   local by default; --team edits foreman.config.json
//   settings reset <name> [--team]         drops the local value (or, --team, the file's)
//
// The local layer is <stateDir>/settings.json, this machine only. A setting that does not apply
// to this project (the Jira ones with markdown stories) is hidden and cannot be set.

import { parseArgs } from 'node:util';
import { changeSetting, display, settingFor, settingsView, settingValue } from '../../settings/change.mjs';
import { GROUPS, parseValue } from '../../settings/registry.mjs';

const EXIT_USAGE = 64;
const USAGE = `usage: foreman settings list [--group <${GROUPS.join('|')}>] [--json]
       foreman settings get <name>
       foreman settings set <name> <value> [--team]
       foreman settings reset <name> [--team]
`;
const OPTIONS = { team: { type: 'boolean' }, group: { type: 'string' }, json: { type: 'boolean' } };

function list({ group, json }, ctx, { stdout, stderr }) {
  if (group !== undefined && !GROUPS.includes(group)) {
    stderr.write(`unknown group: ${group} (use ${GROUPS.join(', ')})\n`);
    return EXIT_USAGE;
  }
  const view = settingsView(ctx);
  if (view.error) {
    stderr.write(`${view.error}\n`);
    return 1;
  }
  for (const w of view.warnings) stderr.write(`warning: ${w}\n`);
  const rows = view.rows.filter((r) => group === undefined || r.group === group);
  if (json) {
    stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const nameWidth = Math.max(0, ...rows.map((r) => r.name.length));
  const valueWidth = Math.max(0, ...rows.map((r) => display(r.value).length));
  for (const r of rows) {
    stdout.write(`${r.name.padEnd(nameWidth)}  ${display(r.value).padEnd(valueWidth)}  ${`(${r.source})`.padEnd(9)}  ${r.applies}\n`);
  }
  return 0;
}

function get(name, ctx, { stdout, stderr }) {
  const result = settingValue(ctx, name);
  if (result.error) {
    stderr.write(`${result.error}\n`);
    return 1;
  }
  stdout.write(`${JSON.stringify(result.value)}\n`);
  return 0;
}

// Prints what changeSetting says; 1 on an error.
export function report(result, { stdout, stderr }) {
  if (result.error) {
    stderr.write(`${result.error}\n`);
    return 1;
  }
  for (const line of result.lines) stdout.write(`${line}\n`);
  return 0;
}

function set(name, text, team, ctx, io) {
  const { entry, error } = settingFor(name);
  if (error) return report({ error }, io);
  const parsed = parseValue(entry, text);
  if (parsed.error) return report({ error: `${name}: ${parsed.error}` }, io);
  return report(changeSetting(ctx, { name, value: parsed.value, layer: team ? 'team' : 'local' }), io);
}

export default {
  name: 'settings',
  summary: 'list, get, set or reset settings (settings list|get|set|reset [--team])',

  async run(args, { root, env, stdout, stderr }) {
    let parsed;
    try {
      parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const { values, positionals } = parsed;
    const [sub, name, ...rest] = positionals;
    const ctx = { root, env };
    const io = { stdout, stderr };
    if (sub === 'list' && name === undefined) return list(values, ctx, io);
    if (sub === 'get' && name && rest.length === 0) return get(name, ctx, io);
    if (sub === 'set' && name && rest.length) return set(name, rest.join(' '), values.team, ctx, io);
    if (sub === 'reset' && name && rest.length === 0) return report(changeSetting(ctx, { name, layer: values.team ? 'team' : 'local', reset: true }), io);
    stderr.write(USAGE);
    return EXIT_USAGE;
  },
};
