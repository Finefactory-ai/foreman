// Whether the Claude sign-in the story sessions use works right now, for the supervisor after a
// session died because it did not (classify.mjs signin), and while the run is paused for it.
// Pure apart from the `run` it is given; the supervisor passes one that spawns the command.
//
//   SIGNIN_PAUSE        the run's pause reason while the sign-in is broken; only a pause with
//                       this reason is cleared by a passing probe, never the owner's own pause
//   PROBE_EVERY_TICKS   how many ticks apart the probes are while paused for it: one a minute at
//                       the 5 s tick, so no setting of its own
//   probeArgs()         the `claude` arguments of the probe: one cheap turn, in safe mode, with
//                       no tools and nothing kept (as learner.mjs learnerCommand and the cloud
//                       doctor's 'claude answers' do)
//   probeEnv({ env, fileKeys, useSubscription })
//                       the sessions' own sign-in (session.mjs): the environment without the
//                       story session's variables, the two sign-in names from .env.foreman
//                       where it has none, and no ANTHROPIC_API_KEY once the run switched to the
//                       subscription (claude-fallback.mjs); nothing else
//   probeSignIn({ env, run }) -> { ok: true } | { ok: false, why }
//                       `claude auth status --json` first (30 s): a login it reads as signed
//                       out is 'signed out' with no probe; one it cannot read leaves it to the
//                       probe. Then the probe (60 s), ok only when it exits 0 and its last line
//                       is a JSON result that is not an error. `run(cmd, args, { env, timeout })`
//                       resolves { status, stdout, timedOut }; a rejection is a failure. `why`
//                       is one of a few fixed phrases: nothing the commands print (an email, a
//                       key, an error) is ever put in it.
//   probeDue({ running, lastAt, now, everyMs })
//                       whether the next probe is due: none runs and everyMs passed since the last
//   afterCheck({ ok, pausedAt, pauseReason, ids }) -> { resume, pause, forget, event }
//                       what a finished check does, `ids` being the stories whose sessions died
//                       on the sign-in since the last one. A pass lifts only a pause whose reason
//                       is SIGNIN_PAUSE (one 'good' event); otherwise it names the stories in one
//                       'warn' event, or none when there are none. A fail pauses for the sign-in.
//                       `event` is { text, kind } or null. `forget` is the stories whose sign-in
//                       deaths in a row the supervisor starts counting again (scheduler.mjs
//                       signinRun): `ids` on a fail, which confirmed the sign-in really was
//                       broken, and none on a pass.

import { withSessionKeys } from './foreman-keys.mjs';
import { ownerEnv } from './run-guard.mjs';

export const SIGNIN_PAUSE = 'Claude sign-in expired: run `claude` to sign in again.';
export const PROBE_TIMEOUT_MS = 60_000;
export const STATUS_TIMEOUT_MS = 30_000;
export const PROBE_EVERY_TICKS = 12;

const PROMPT = 'Reply with the word ok.';

export function probeArgs() {
  return ['-p', PROMPT, '--safe-mode', '--model', 'haiku', '--max-turns', '1', '--tools', '', '--no-session-persistence', '--output-format', 'json'];
}

export function probeEnv({ env, fileKeys, useSubscription }) {
  const out = withSessionKeys(ownerEnv(env), fileKeys);
  if (useSubscription) delete out.ANTHROPIC_API_KEY;
  return out;
}

// A JSON object from text, or null: only text that starts with `{` is parsed.
const objectOf = (text) => {
  const t = String(text ?? '').trim();
  if (!t.startsWith('{')) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

// `claude auth status --json` prints one object over several lines; the probe's answer is its
// last line.
const lastLine = (text) => String(text ?? '').trim().split('\n').pop();

const attempt = async (run, args, opts) => {
  try {
    return await run('claude', args, opts);
  } catch {
    return null;
  }
};

export async function probeSignIn({ env, run }) {
  const status = await attempt(run, ['auth', 'status', '--json'], { env, timeout: STATUS_TIMEOUT_MS });
  const login = status && !status.timedOut ? objectOf(status.stdout) : null;
  if (login?.loggedIn === false) return { ok: false, why: 'signed out' };

  const probe = await attempt(run, probeArgs(), { env, timeout: PROBE_TIMEOUT_MS });
  if (!probe) return { ok: false, why: 'the test reply failed' };
  if (probe.timedOut) return { ok: false, why: 'no reply within 60 s' };
  const answer = objectOf(lastLine(probe.stdout));
  if (probe.status === 0 && answer && answer.is_error !== true) return { ok: true };
  return { ok: false, why: 'the test reply failed' };
}

export function probeDue({ running, lastAt, now, everyMs }) {
  return !running && now - lastAt >= everyMs;
}

// "A", "A and B", "A, B and C".
const andList = (ids) => (ids.length === 1 ? ids[0] : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`);

export function afterCheck({ ok, pausedAt, pauseReason, ids }) {
  if (!ok) return { resume: false, pause: true, forget: ids, event: null };
  if (pausedAt && pauseReason === SIGNIN_PAUSE) return { resume: true, pause: false, forget: [], event: { text: 'Claude sign-in works again; carrying on.', kind: 'good' } };
  const event = ids.length ? { text: `Claude sign-in failed for ${andList(ids)}; it works again, so they carry on.`, kind: 'warn' } : null;
  return { resume: false, pause: false, forget: [], event };
}
