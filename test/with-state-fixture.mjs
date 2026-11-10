// Helpers the withState tests share (with-state.test.mjs, with-state-clones.test.mjs): output
// streams that keep what is written, and a shell that records each git subcommand it runs.

import { sh } from './state-repos.mjs';

export const io = () => {
  const out = { stdout: '', stderr: '' };
  return { out, stdout: { write: (s) => { out.stdout += s; } }, stderr: { write: (s) => { out.stderr += s; } } };
};

// A shell that records each git subcommand (the first argument after the -c options).
export function recording(log) {
  return (cmd, args, opts) => {
    if (cmd === 'git') {
      const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c');
      log.push(`git ${sub}`);
    }
    return sh(cmd, args, opts);
  };
}
