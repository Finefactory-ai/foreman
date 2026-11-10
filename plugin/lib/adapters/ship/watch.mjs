// Ship step `watch`: after the deploy, keep an eye on production for a while. It runs the
// project's own command (a script that asks Vercel or Sentry for new runtime errors, or curls
// a health route) every `everySeconds` for `minutes`, once at the start and once at the end.
// Any non-zero exit, or a run longer than `timeoutSeconds`, stops the release with code 5 and
// writes HALT; with `ship.rollback` set, the runner also rolls production back
// (lib/engine/ship.mjs).
//
// The command runs with `sh -c` in the project root, with the env file's values loaded. Its
// output goes into the HALT reason, cut to the last 300 characters with secrets redacted.
//
// healthy() runs the command once, for `foreman health`.
//
// Options: config.ship.watch = { command (required), minutes = 10, everySeconds = 60,
// timeoutSeconds = 120 (per run) }.

import { redact } from '../../engine/state.mjs';

const STAGE = 'watch';
const TAIL = 300;

const optionsOf = (config) => config.ship?.watch ?? {};

// Runs a configured shell command for at most `seconds`. Returns { ok, status, timedOut,
// tail }: tail is the end of its output on one line, secrets redacted.
export function runCommand(ctx, command, seconds) {
  const r = ctx.sh('sh', ['-c', command], { env: ctx.env, cwd: ctx.root, timeout: seconds * 1000 });
  const output = redact(`${r.stdout ?? ''}\n${r.stderr ?? ''}`).replace(/\s+/g, ' ').trim();
  const timedOut = r.timedOut === true;
  return { ok: r.status === 0 && !timedOut, status: r.status, timedOut, tail: output.slice(-TAIL) };
}

// What went wrong with a failed run, as the end of a sentence about the command.
function problem(command, r, seconds, after) {
  if (r.timedOut) return `${command} did not finish within ${seconds} s, so production could not be checked.`;
  return `${command} reported a problem${after}: ${r.tail || `it exited ${r.status} with no output.`}`;
}

export default {
  name: 'watch',
  label: 'watching production after the deploy',
  needs: ['sh'],
  halts: true,

  async run(ctx) {
    const { command, minutes = 10, everySeconds = 60, timeoutSeconds = 120 } = optionsOf(ctx.config);
    if (!command) return { ok: false, code: 5, stage: STAGE, reason: 'ship.watch.command is not set, so production was not watched.' };
    const every = everySeconds * 1000;
    const deadline = ctx.now().getTime() + minutes * 60_000;
    for (;;) {
      const r = runCommand(ctx, command, timeoutSeconds);
      if (!r.ok) return { ok: false, code: 5, stage: STAGE, reason: problem(redact(command), r, timeoutSeconds, ' after the deploy') };
      if (ctx.now().getTime() + every > deadline) return { ok: true };
      await ctx.sleep(every);
    }
  },

  async healthy(ctx) {
    const { command, timeoutSeconds = 120 } = optionsOf(ctx.config);
    if (!command) return null;
    const r = runCommand(ctx, command, timeoutSeconds);
    if (r.ok) return { ok: true, reason: `${redact(command)} reports no problems.` };
    return { ok: false, reason: problem(redact(command), r, timeoutSeconds, '') };
  },
};
