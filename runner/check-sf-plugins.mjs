// Proves the Salesforce image holds each plugin runner/Dockerfile pins, at the pinned version.
// The image workflow runs it on the Actions host (Node 20), on the output of
// `sf plugins --core --json` from the image:
//
//   node runner/check-sf-plugins.mjs <plugins.json>
//
// Matching names alone proves nothing: sf ships its own core @salesforce/plugin-agent, at an
// older version, so a list without the pinned one still has that name. An entry counts only
// with the exact name and the exact version. Exits 0 when every pin is there; otherwise says
// which are not on stderr and exits 1. A missing or unreadable file argument prints a one-line
// usage or `cannot read` message and exits 1. Node built-ins only.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PINS = {
  '@salesforce/plugin-agent': 'SF_PLUGIN_AGENT_VERSION',
  '@salesforce/plugin-code-analyzer': 'CODE_ANALYZER_VERSION',
  'sfdx-git-delta': 'SGD_VERSION',
};

// { package name: version } from the Dockerfile's ARG lines, which stay the one source.
export function pins(dockerfileText) {
  const out = {};
  for (const [name, argName] of Object.entries(PINS)) {
    const m = String(dockerfileText).match(new RegExp(`^ARG ${argName}=(\\S+)$`, 'm'));
    if (!m) throw new Error(`runner/Dockerfile has no ARG ${argName}=<version>`);
    out[name] = m[1];
  }
  return out;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The JSON in `text`: all of it, or from the first line that starts with "[" or "{" and parses
// (sf can print warning lines first).
function parseJson(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  const whole = tryParse(trimmed);
  if (whole !== undefined) return whole;
  const lines = trimmed.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    if (!/^[[{]/.test(lines[i])) continue;
    const rest = tryParse(lines.slice(i).join('\n'));
    if (rest !== undefined) return rest;
  }
  return undefined;
}

// The `name@version` of each wanted plugin with no entry of that exact name and version.
export function missing(text, wanted) {
  const parsed = parseJson(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.result) ? parsed.result : null;
  if (!list) return ['sf printed no plugin list'];
  return Object.entries(wanted)
    .filter(([name, version]) => !list.some((p) => p?.name === name && p?.version === version))
    .map(([name, version]) => `${name}@${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: node runner/check-sf-plugins.mjs <plugins.json>\n');
    process.exit(1);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write(`cannot read ${file}\n`);
    process.exit(1);
  }
  const wanted = pins(readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8'));
  const gone = missing(text, wanted);
  if (gone.length) {
    process.stderr.write(`not in sf plugins: ${gone.join(', ')}\n`);
    process.exit(1);
  }
}
