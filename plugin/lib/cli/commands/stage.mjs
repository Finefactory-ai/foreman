// `foreman stage <name> [detail...]` tells the command centre which stage the story is in.
// It never fails the caller: status keeping must not stop the factory. A name that is not a stage
// the page shows (the stage map's architect, build, test and review, and commit and release) records
// nothing: it writes `stage: unknown stage "<name>"; one of <the names, sorted>` to stderr and
// still returns 0.

import { loadConfig } from '../../config/load.mjs';
import { currentSlot, stateDir } from '../../engine/paths.mjs';
import { setStage, stageMap } from '../../engine/state.mjs';

export default {
  name: 'stage',
  summary: 'record the current stage of the story (stage <name> [detail...])',

  async run(args, { root, env, stdout, stderr, now }) {
    try {
      const [name, ...detail] = args;
      if (!name) {
        stderr.write('usage: foreman stage <name> [detail...]\n');
        return 0;
      }
      const { config, errors } = loadConfig(root);
      if (errors.length) {
        stderr.write(`${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n')}\n`);
        return 0;
      }
      const known = [...new Set([...Object.values(stageMap(config)), 'commit', 'release'])].sort();
      if (!known.includes(name)) {
        stderr.write(`stage: unknown stage "${name}"; one of ${known.join(', ')}\n`);
        return 0;
      }
      setStage(stateDir(root, config, env), name, detail.join(' '), (now ?? (() => new Date()))(), currentSlot(env));
    } catch (err) {
      stderr.write(`stage: ${err.message}\n`);
    }
    return 0;
  },
};
