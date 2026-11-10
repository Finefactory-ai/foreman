// `foreman config check` tells you whether the project's foreman.config.json is valid.
// `foreman config show` prints it with the defaults filled in.

import { loadConfig } from '../../config/load.mjs';
import { resolveTraits } from '../../engine/traits.mjs';

const EXIT_INVALID = 1;
const EXIT_USAGE = 64;

function printErrors(errors, stdout) {
  for (const { path, message } of errors) stdout.write(path ? `${path}: ${message}\n` : `${message}\n`);
}

export default {
  name: 'config',
  summary: 'check or show the project config (config check | config show)',

  async run(args, { root, stdout, stderr }) {
    const sub = args[0];
    if (sub !== 'check' && sub !== 'show') {
      stderr.write('usage: foreman config <check|show>\n  check  validate foreman.config.json\n  show   print the config with defaults\n');
      return EXIT_USAGE;
    }
    const { config, errors, warnings: deprecated = [] } = loadConfig(root);
    if (errors.length) {
      printErrors(errors, stdout);
      return EXIT_INVALID;
    }
    if (sub === 'show') {
      stdout.write(`${JSON.stringify(config, null, 2)}\n`);
      return 0;
    }
    const { errors: traitErrors, warnings } = resolveTraits({ root, config });
    for (const w of [...deprecated, ...warnings]) stdout.write(`warning: ${w}\n`);
    if (traitErrors.length) {
      for (const e of traitErrors) stdout.write(`${e}\n`);
      return EXIT_INVALID;
    }
    stdout.write('ok\n');
    return 0;
  },
};
