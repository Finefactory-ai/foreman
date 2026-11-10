// `foreman traits add <role> <text...>` appends a paragraph to .claude/foreman/traits/<role>.md.
// The role is `all` or a role named in the config.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../config/load.mjs';
import { roleNames, TRAITS_DIR } from '../../engine/traits.mjs';

const USAGE = 'usage: foreman traits add <role> <text...>\n';

export default {
  name: 'traits',
  summary: 'add a project trait to a role (traits add <role> <text...>)',

  async run(args, { root, stderr }) {
    const [sub, role, ...words] = args;
    const text = words.join(' ').trim();
    if (sub !== 'add' || !role || !text) {
      stderr.write(USAGE);
      return 1;
    }
    const { config, errors } = loadConfig(root);
    if (errors.length) {
      stderr.write(`${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
      return 1;
    }
    const known = ['all', ...roleNames(config)];
    if (!known.includes(role)) {
      stderr.write(`unknown role ${role}; known roles: ${known.join(', ')}\n`);
      return 1;
    }
    const dir = join(root, TRAITS_DIR);
    const file = join(dir, `${role}.md`);
    mkdirSync(dir, { recursive: true });
    const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const lead = old === '' ? '' : old.endsWith('\n\n') ? '' : old.endsWith('\n') ? '\n' : '\n\n';
    appendFileSync(file, `${lead}${text}\n`);
    return 0;
  },
};
