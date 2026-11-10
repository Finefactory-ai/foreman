// Finds, reads and checks a project's foreman.config.json. It returns { config, errors,
// warnings, file } and never throws: a missing file, broken JSON and a file that fails
// validation each come back as errors with `config: null`. A valid file comes back with the
// defaults merged in, and `warnings` says what in it is deprecated. `packs` stands in for the
// real pack registry (plugin/packs/index.mjs), for tests. The pack's defaults also get the project
// folder to read (config/defaults.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { withDefaults } from './defaults.mjs';
import { configWarnings, validate } from './validate.mjs';

export const CONFIG_FILE = 'foreman.config.json';

export function loadConfig(root, { readFile = fs.readFileSync, packs } = {}) {
  const file = path.join(root, CONFIG_FILE);
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { config: null, errors: [{ path: '', message: `no ${CONFIG_FILE} in ${root}` }], file };
    return { config: null, errors: [{ path: '', message: `cannot read ${file}: ${err?.message ?? err}` }], file };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { config: null, errors: [{ path: '', message: `${file} is not valid JSON: ${err.message}` }], file };
  }

  const options = packs ? { packs } : {};
  const errors = validate(raw, options);
  if (errors.length) return { config: null, errors, file };
  let config;
  try {
    config = withDefaults(raw, { ...options, project: { root, fs } });
  } catch (err) {
    const name = typeof raw.pack === 'string' ? raw.pack : '';
    return { config: null, errors: [{ path: name, message: `the ${name} pack could not give its defaults: ${err?.message ?? err}` }], file };
  }
  return { config, errors: [], warnings: configWarnings(raw), file };
}
