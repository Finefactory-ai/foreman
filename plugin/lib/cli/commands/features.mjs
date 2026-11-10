// `foreman features on|off <name> [--team]`: shorthand for `foreman settings set
// features.<name> true|false`. With no arguments it lists the switches.

import { parseArgs } from 'node:util';
import { changeSetting } from '../../settings/change.mjs';
import { REGISTRY } from '../../settings/registry.mjs';
import settings, { report } from './settings.mjs';

const EXIT_USAGE = 64;
const SWITCHES = REGISTRY.filter((e) => e.group === 'features' && e.type === 'boolean').map((e) => e.name.slice('features.'.length));
const USAGE = 'usage: foreman features [on|off <name> [--team]]\n';

export default {
  name: 'features',
  summary: 'turn a feature switch on or off (features on|off <name> [--team])',

  async run(args, ctx) {
    const { stdout, stderr } = ctx;
    if (args.length === 0) return settings.run(['list', '--group', 'features'], ctx);
    let parsed;
    try {
      parsed = parseArgs({ args, options: { team: { type: 'boolean' } }, allowPositionals: true, strict: true });
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const [state, given, ...extra] = parsed.positionals;
    if (!['on', 'off'].includes(state) || !given || extra.length) {
      stderr.write(USAGE);
      return EXIT_USAGE;
    }
    const key = given.startsWith('features.') ? given.slice('features.'.length) : given;
    if (!SWITCHES.includes(key)) {
      stderr.write(`unknown feature: ${given} (use ${SWITCHES.join(', ')})\n`);
      return 1;
    }
    const result = changeSetting({ root: ctx.root, env: ctx.env }, { name: `features.${key}`, value: state === 'on', layer: parsed.values.team ? 'team' : 'local' });
    return report(result, { stdout, stderr });
  },
};
