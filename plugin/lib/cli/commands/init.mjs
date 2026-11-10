// `foreman init detect` prints a suggested config and what was found, as one JSON line.
// `foreman init write [--answers] [--force] [--from <file>] [--marketplace <name>] [--no-example]`
// takes a config (stdin, or --from) and writes it with the plugin setting, .gitignore entry and
// example story. With --answers it takes the Set up page's "This project" answers instead
// ({ name, source, dir?, site?, jql?, check?, ci? }) and makes them into the config the page
// makes (lib/setup/project.mjs projectConfig), so set-up with no browser writes the same file.
// The /foreman:init skill drives both.

import fs from 'node:fs';
import path from 'node:path';
import { detect, writeInit } from '../../engine/init-helpers.mjs';
import { PACKS } from '../../../packs/index.mjs';
import { projectConfig } from '../../setup/project.mjs';

const USAGE = 'usage: foreman init detect\n       foreman init write [--answers] [--force] [--from <file>] [--marketplace <name>] [--no-example]\n';

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

export function makeInitCommand({ packs = PACKS } = {}) {
  return {
    name: 'init',
    summary: 'set Foreman up in this project (init detect, init write)',

    async run(args, { root, cwd, stdout, stderr, readStdin = () => fs.readFileSync(0, 'utf8') }) {
      const [sub, ...rest] = args;
      if (sub === 'detect') {
        stdout.write(`${JSON.stringify(detect(root, { packs }))}\n`);
        return 0;
      }
      if (sub !== 'write') {
        stderr.write(USAGE);
        return 1;
      }
      const answers = rest.includes('--answers');
      const what = answers ? 'answers' : 'config';
      let raw;
      try {
        const from = option(rest, '--from');
        raw = from ? fs.readFileSync(path.resolve(cwd ?? root, from), 'utf8') : readStdin();
      } catch (e) {
        stderr.write(`cannot read ${what}: ${e.message}\n`);
        return 1;
      }
      let config;
      try {
        config = JSON.parse(raw);
      } catch {
        stderr.write(`${answers ? 'answers are' : 'config is'} not valid JSON\n`);
        return 1;
      }
      if (answers) {
        const made = projectConfig(detect(root, { packs }), config);
        if (!made.ok) {
          stderr.write(`${made.errors.join('\n')}\n`);
          return 1;
        }
        config = made.config;
      }
      const result = writeInit(root, config, {
        force: rest.includes('--force'),
        marketplace: option(rest, '--marketplace') ?? 'foreman',
        example: !rest.includes('--no-example'),
        packs,
      });
      if (!result.ok) {
        stderr.write(`${result.errors.join('\n')}\n`);
        return 1;
      }
      stdout.write(`${result.lines.join('\n')}\n`);
      return 0;
    },
  };
}

export default makeInitCommand();
