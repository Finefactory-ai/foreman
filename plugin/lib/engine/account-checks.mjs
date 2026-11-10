// The Claude account checks the supervisor runs without holding the loop: the sign-in check, the credit check and the
// subscription check. Each is asked in a child of its own and answers through the run's state files.
//
// Platform credits first, then the subscription: when a session that had ANTHROPIC_API_KEY dies
// because the key is out of credit or reached the usage limit set on it (classify.mjs api-credit,
// limit 'balance' or 'usage') and claude.fallback is subscription (the default), the story is
// requeued in its slot with no miss and the run checks for a subscription sign-in
// (CLAUDE_CODE_OAUTH_TOKEN, or a claude.ai login that `claude auth status` reports, asked in a
// child of its own within 30 s, claude-signin.mjs subscriptionSignInAsync). The loop keeps
// ticking while it asks, but the check holds every start until it answers, as the sign-in check
// does. With one, the switch is recorded in <stateDir>/claude-signin.json (claude-fallback.mjs):
// every later session starts without ANTHROPIC_API_KEY, the story that hit it starts again at once
// with no pause, and the owner gets one warn event and one `credits` notification (Waiting on you
// shows an FYI while it lasts), naming the usage limit and when access returns when that was why.
// With none, the run pauses with a reason that says no subscription sign-in was found, and the
// story waits in the queue under the pause. Sessions still on the key when it switched (or while
// the check runs) die the same way; each is requeued in its own slot, again with no miss, no park,
// no second check and no second notification. It never switches back by itself: `foreman claude
// use-key` does. With claude.fallback none the run pauses with a reason that says so. Only the
// error text is read (the credit balance and the usage limit only from the session's own error
// words); no key value is stored, logged or shown.
//
// A sign-in that stops working: when a session dies because its Claude sign-in no longer works
// (classify.mjs signin: an expired or refreshed login, read only from the session's own error
// words), it is nobody's miss and parks no slot. A story resumes this way up to MAX_SIGNIN_RESUMES
// times in a row while the check passes (scheduler.mjs signinRun; in memory, started again by a
// failed check or an owner action on the story); the next death counts as a plain crash, with one
// warn event, and a story that crashed before is parked. The story keeps its
// claim and checkpoint and is queued to resume, and the run checks the sign-in itself
// (signin-probe.mjs: `claude auth status`, then a one-turn probe, in the sessions' own sign-in
// environment) before anything starts: every start, queued resumes and new picks alike, waits
// for the answer, as do --once and a stop. When it works, the stories carry on at once with one
// warn event per check naming them. When it does not, the run pauses with SIGNIN_PAUSE and one
// `paused` notification, probes again every PROBE_EVERY_TICKS ticks (and at once after a
// restart), and clears that pause by itself, with one event, once a probe passes. It never
// clears the owner's own pause or a pause for another reason (afterCheck). No probe output is
// stored, logged or shown.
//
// A usage limit or an empty balance with no switch to make pauses the run (autoPause with a
// resumeAt) and records when to try again in state.json's autoResumeAt: the reset time Claude
// printed (credit-resume.mjs resetTime), else an hour on. Once that time has come the loop runs
// the same one-turn probe as above (checkCredit), in a child of its own while it keeps ticking, and
// clears the pause by itself, with one good event, when Claude answers; the queued stories then
// resume as after a Resume. A probe that fails keeps the pause and tries again every 30 minutes
// (FOREMAN_CREDIT_RETRY_MS, for tests, can shorten that), with no event. Only a pause that has an
// autoResumeAt is ever cleared this way, and only the same pause that was probed: the owner's own
// pause (`foreman pause`), a pause for another reason and a pause the owner resumed meanwhile are
// never touched. Resume still works sooner. The `paused` notification, Waiting on you and
// `foreman status` say when Foreman tries again.

import { spawn } from 'node:child_process';
import { sessionKeys, withSessionKeys } from './foreman-keys.mjs';
import { creditPauseReason, creditsOutFyi, hhmm, readSignIn, useSubscription } from './claude-fallback.mjs';
import { afterCreditProbe, resumeAtFor } from './credit-resume.mjs';
import { subscriptionSignInAsync } from './claude-signin.mjs';
import { afterCheck, probeEnv, probeSignIn, SIGNIN_PAUSE } from './signin-probe.mjs';

// The supervisor passes what it keeps in `ctx`; the state objects returned here are the ones it mutates in place.
export function accountChecks({ root: ROOT, config: CONFIG, dir: DIR, creditRetryMs: CREDIT_RETRY, state, saveRun, event, notify, autoPause, guarded, signins, now }) {
  // One command for signin-probe.mjs: { status, stdout, timedOut }, never a rejection. Spawned with
  // stdin closed, since `claude -p` would wait on an open one; SIGTERM at the time limit, SIGKILL
  // 5 s later.
  function runProbe(cmd, args, { env, timeout }) {
    return new Promise((resolve) => {
      let stdout = '';
      let timedOut = false;
      let hard = null;
      let settled = false;
      let child;
      const done = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(soft);
        clearTimeout(hard);
        resolve({ status, stdout, timedOut });
      };
      const soft = setTimeout(() => {
        timedOut = true;
        child?.kill('SIGTERM');
        hard = setTimeout(() => child?.kill('SIGKILL'), 5000);
      }, timeout);
      try {
        child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        done(1);
        return;
      }
      child.stdout.on('data', (d) => {
        stdout = (stdout + d).slice(-65_536);
      });
      child.stderr.resume();
      child.on('error', () => done(1));
      child.on('close', (code) => done(code ?? 1));
      // Something the command started may keep its output open after it ends.
      child.on('exit', (code) => setTimeout(() => done(code ?? 1), 1000));
    });
  }

  // `ids`: the stories whose sessions died on the sign-in since the last check.
  const signInCheck = { running: false, lastAt: 0, ids: new Set() };
  const afterSignInCheck = (r) => {
    const ids = [...signInCheck.ids];
    signInCheck.ids.clear();
    const v = afterCheck({ ok: !!r?.ok, pausedAt: state().autoPausedAt, pauseReason: state().autoPauseReason, ids });
    for (const sid of v.forget) signins.delete(sid);
    if (v.resume) saveRun({ autoPausedAt: null, autoPauseReason: '', autoResumeAt: null });
    if (v.event) event(v.event.text, v.event.kind);
    if (v.pause) autoPause(SIGNIN_PAUSE);
  };

  // Starts a check unless one runs; `running` is set before the first await, so the tick that
  // follows already holds every start.
  async function checkSignIn() {
    if (signInCheck.running) return;
    signInCheck.running = true;
    signInCheck.lastAt = Date.now();
    try {
      let r;
      try {
        const env = probeEnv({ env: process.env, fileKeys: sessionKeys({ root: ROOT, config: CONFIG }), useSubscription: readSignIn(DIR).using === 'subscription' });
        r = await probeSignIn({ env, run: runProbe });
      } catch {
        r = { ok: false, why: 'the check could not run' };
      }
      guarded('the Claude sign-in check', afterSignInCheck)(r);
    } finally {
      signInCheck.running = false;
    }
  }

  // ── the credit check, when a credit pause's time has come ───────────────────────────────────

  // The same probe, for a pause with an autoResumeAt (see the header). `running` is set before the
  // first await. The answer clears only the pause that was probed, and only if it is still there.
  const creditCheck = { running: false };
  async function checkCredit() {
    creditCheck.running = true;
    const probedPausedAt = state().autoPausedAt;
    try {
      let r;
      try {
        const env = probeEnv({ env: process.env, fileKeys: sessionKeys({ root: ROOT, config: CONFIG }), useSubscription: readSignIn(DIR).using === 'subscription' });
        r = await probeSignIn({ env, run: runProbe });
      } catch {
        r = { ok: false };
      }
      guarded('the Claude credit check', () => {
        const saved = state();
        const v = afterCreditProbe({ ok: !!r?.ok, pausedAt: saved.autoPausedAt, probedPausedAt, resumeAt: saved.autoResumeAt, now: Date.now(), retryMs: CREDIT_RETRY });
        if (v.clear) saveRun({ autoPausedAt: null, autoPauseReason: '', autoResumeAt: null });
        else if (v.resumeAt) saveRun({ autoResumeAt: v.resumeAt });
        if (v.event) event(v.event.text, v.event.kind);
      })();
    } finally {
      creditCheck.running = false;
    }
  }

  // ── the subscription check, after the Console key ran out ───────────────────────────────────

  // What the session that ran out said, for the switch or the pause the answer leads to.
  const subscriptionCheck = { running: false, since: null, limit: null, resetAt: null, fallback: null, slot: null };

  // The switch to the subscription: one warn event and one `credits` notification, only when this
  // call made it.
  function switchToSubscription({ limit, resetAt, slot }) {
    const { switched, record } = useSubscription(DIR, now(), { limit, resetAt });
    if (!switched) return;
    const why = record.limit === 'usage' ? `The Console API key reached its usage limit at ${hhmm(record.since)}${record.resetAt ? ` (access returns ${record.resetAt})` : ''}` : `API credits used up at ${hhmm(record.since)}`;
    event(`${why}; later sessions use your subscription.`, 'warn', slot);
    notify('credits', { reason: creditsOutFyi(record) });
  }

  // Asks for a subscription sign-in without holding the loop; `running` is set before the first
  // await, so the tick that follows already holds every start until it answers.
  async function checkSubscription() {
    subscriptionCheck.running = true;
    try {
      let found = null;
      try {
        found = await subscriptionSignInAsync({ env: withSessionKeys(process.env, sessionKeys({ root: ROOT, config: CONFIG })), run: runProbe });
      } catch {
        found = null;
      }
      const { since, limit, resetAt, fallback, slot } = subscriptionCheck;
      guarded('the subscription check', () => {
        if (found === 'token' || found === 'login') switchToSubscription({ limit, resetAt, slot });
        else autoPause(creditPauseReason({ since, fallback, limit, resetAt }), { resumeAt: resumeAtFor({ resetAt, now: Date.now() }) });
      })();
    } finally {
      subscriptionCheck.running = false;
    }
  }
  return { runProbe, signInCheck, afterSignInCheck, checkSignIn, creditCheck, checkCredit, subscriptionCheck, switchToSubscription, checkSubscription };
}
