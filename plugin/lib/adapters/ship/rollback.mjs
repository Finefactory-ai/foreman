// Ship step `rollback`: put production back the way it was. It never runs in the normal
// order (the registry refuses it in `ship.steps`). The runner (lib/engine/ship.mjs) calls it
// once when a step fails after a successful deploy, so the new build is what runs. It writes
// HALT first ("Rolling back with ..."), runs this, then rewrites HALT saying whether
// production was rolled back.
//
// The command runs with `sh -c` in the project root, with the env file's values loaded and
// FOREMAN_STORY set to the story being shipped (a `foreman ship --story X` run by hand has none
// in its env), for example `vercel rollback --yes`. A run longer than `timeoutSeconds` is a failed rollback. It
// has no health check: `foreman health` asks whether production is fine, not whether it can
// be rolled back.
//
// Options: config.ship.rollback = { command (required), timeoutSeconds = 300 }.

import { runCommand } from './watch.mjs';
import { redact } from '../../engine/state.mjs';

const optionsOf = (config) => config.ship?.rollback ?? {};

export default {
  name: 'rollback',
  label: 'rolling production back',
  needs: ['sh'],

  // The command as the HALT reason shows it, secrets redacted.
  commandFor(config) {
    return redact(optionsOf(config).command ?? '');
  },

  async run(ctx) {
    const { command, timeoutSeconds = 300 } = optionsOf(ctx.config);
    const env = typeof ctx.story === 'string' && ctx.story ? { ...(ctx.env ?? process.env), FOREMAN_STORY: ctx.story } : ctx.env;
    const r = runCommand({ ...ctx, env }, command, timeoutSeconds);
    const shown = redact(command);
    if (r.ok) return { ok: true, command: shown };
    if (r.timedOut) return { ok: false, command: shown, why: `did not finish within ${timeoutSeconds} s`, tail: r.tail };
    return { ok: false, command: shown, exitCode: r.status, why: `exited ${r.status}`, tail: r.tail };
  },
};
