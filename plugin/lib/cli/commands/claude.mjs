// `foreman claude use-key`: after the platform credits ran out and the run moved to the
// subscription (engine/claude-fallback.mjs), go back to the Console API key from the next story.
// It refuses, and changes nothing, when no ANTHROPIC_API_KEY is in the environment or in
// Foreman's own keys file (.env.foreman). It reads whether the key is there, never its value.
//
//   foreman claude use-key
//
// Exits 0 with one line when the sessions use the key (again, or already); 1 with the reason on
// stderr otherwise, and with the usage for anything else. A story session cannot run it on the
// run's project (engine/run-guard.mjs).

import { useKey } from '../../engine/claude-fallback.mjs';
import { sessionKeys } from '../../engine/foreman-keys.mjs';
import { openProject } from './console-shared.mjs';

const USAGE = 'usage: foreman claude use-key\n';
const isSet = (v) => typeof v === 'string' && v !== '';

export default {
  name: 'claude',
  summary: 'go back to the Console API key after the credits ran out (claude use-key)',

  async run(args, { root, env, stdout, stderr, now }) {
    if (args.length !== 1 || args[0] !== 'use-key') {
      stderr.write(USAGE);
      return 1;
    }
    const project = openProject({ root, env, stderr });
    if (!project) return 1;
    const hasKey = isSet(env?.ANTHROPIC_API_KEY) || isSet(sessionKeys({ root, config: project.config }).ANTHROPIC_API_KEY);
    const r = useKey(project.dir, { now: (now ?? (() => new Date()))(), hasKey });
    (r.ok ? stdout : stderr).write(`${r.line}\n`);
    return r.ok ? 0 : 1;
  },
};
