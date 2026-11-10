// Env files as text, shared by the cloud runner (cloud/env-file.mjs) and Foreman's own keys
// (foreman-keys.mjs). It imports neither.
//
//   parseEnvFile(file, fs)              the file as Node's parseEnv reads it, or {} when it is
//                                       missing or cannot be read
//   serialize(name, value)              one `NAME=value` line that parseEnv reads back exactly,
//                                       or null when no quoting can
//   keptLines(text, names)              the file's lines without the variables in `names` (a Set),
//                                       each cut where Node's parser says it ends; every other
//                                       line, comments and blank lines included, is kept
//   writeSecretFile(file, text, mode, fs)
//                                       writes a tmp file with a random name next to it with
//                                       `mode` (600 unless given), renames it over the file and
//                                       sets the mode again, so the file is never readable by
//                                       others, even for a moment; when anything fails the tmp
//                                       file is removed and the old file is left as it was

import { randomBytes } from 'node:crypto';
import nodeFs from 'node:fs';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';

const LINE_NAME = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=.*)$/s;

export function parseEnvFile(file, fs = nodeFs) {
  if (!file) return {};
  try {
    return { ...parseEnv(String(fs.readFileSync(file, 'utf8'))) };
  } catch {
    return {};
  }
}

export function serialize(name, value) {
  for (const quote of ["'", '"', '`']) {
    const line = `${name}=${quote}${value}${quote}`;
    try {
      const back = parseEnv(`${line}\n`);
      if (back[name] === value && Object.keys(back).length === 1) return line;
    } catch {
      // try the next quote
    }
  }
  return null;
}

// The index of the last line of the variable that starts at line i: the variable is renamed
// to a probe name no file has, and the shortest run of lines from i that parseEnv reads to the
// same value is the variable. A line parseEnv reads no value from is a variable of one line.
function span(lines, i) {
  const [, prefix, , tail] = lines[i].match(LINE_NAME);
  const probe = `FOREMAN_CUT_${randomBytes(6).toString('hex')}`;
  const rest = [prefix + probe + tail, ...lines.slice(i + 1)];
  const v = parseEnv(rest.join('\n'))[probe];
  if (v === undefined) return i;
  for (let k = 0; k < rest.length; k++) {
    if (parseEnv(rest.slice(0, k + 1).join('\n'))[probe] === v) return i + k;
  }
  return i;
}

// The file's lines without the variables in `names`. A quoted value may run over several
// lines, and a line inside it may look like NAME=, so each variable is cut where Node's parser
// says it ends. The lines between variables are always kept, and so is every line of a kept
// variable's value.
export function keptLines(text, names) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_NAME);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const e = span(lines, i);
    if (!names.has(m[2])) out.push(...lines.slice(i, e + 1));
    i = e;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export function writeSecretFile(file, text, mode = 0o600, fs = nodeFs) {
  fs.mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, mode);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
