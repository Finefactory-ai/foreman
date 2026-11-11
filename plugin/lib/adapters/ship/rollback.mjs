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
// Where it is rolled back is said as the pack says it (live-stage.mjs): the Salesforce pack's
// stage and org, "qa (acme-qa)", in the step's label and in the HALT reason (whereFor); with no
// such stage it is production.
//
// A rollback command may end its stdout with a JSON line holding manualSteps, an array of the
// steps it left to the owner (the Salesforce pack's `foreman sf rollback` does). The line is
// parsed as the command printed it, then each step is redacted and cut to 300 characters; the
// step keeps at most 20 non-empty strings and returns them as manualSteps on a successful rollback; the runner puts them in the HALT reason. Without such a
// line the result is { ok: true, command } as before.
//
// Options: config.ship.rollback = { command (required), timeoutSeconds = 300 }.

import { runCommand } from './watch.mjs';
import { redact } from '../../engine/state.mjs';
import { liveWhere } from './live-stage.mjs';

const optionsOf = (config) => config.ship?.rollback ?? {};
const MAX_STEPS = 20;
const MAX_STEP_LENGTH = 300;

// The manual steps on the last line of the command's stdout, or [].
function manualStepsOf(last) {
  try {
    const parsed = JSON.parse(last);
    const steps = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.manualSteps) ? parsed.manualSteps : [];
    return steps.filter((s) => typeof s === 'string' && s.trim()).slice(0, MAX_STEPS).map((s) => redact(s).slice(0, MAX_STEP_LENGTH));
  } catch {
    return [];
  }
}

export default {
  name: 'rollback',
  label: (ctx) => {
    const where = liveWhere(ctx);
    return where ? `rolling ${ctx.story ? `${ctx.story} back` : 'back'} on ${where.text}` : 'rolling production back';
  },
  needs: ['sh'],

  // The stage the release was rolled back on, as the pack names it, or null for production.
  whereFor(ctx) {
    return liveWhere(ctx)?.text ?? null;
  },

  // The command as the HALT reason shows it, secrets redacted.
  commandFor(config) {
    return redact(optionsOf(config).command ?? '');
  },

  async run(ctx) {
    const { command, timeoutSeconds = 300 } = optionsOf(ctx.config);
    const env = typeof ctx.story === 'string' && ctx.story ? { ...(ctx.env ?? process.env), FOREMAN_STORY: ctx.story } : ctx.env;
    const r = runCommand({ ...ctx, env }, command, timeoutSeconds);
    const shown = redact(command);
    if (r.ok) {
      const manualSteps = manualStepsOf(r.last);
      return manualSteps.length ? { ok: true, command: shown, manualSteps } : { ok: true, command: shown };
    }
    if (r.timedOut) return { ok: false, command: shown, why: `did not finish within ${timeoutSeconds} s`, tail: r.tail };
    return { ok: false, command: shown, exitCode: r.status, why: `exited ${r.status}`, tail: r.tail };
  },
};
