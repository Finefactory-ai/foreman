// The supervisor's Salesforce refresher. The supervisor must never wait on sf, so it opens its
// story source cache-only and this does the sf calls in a child process (salesforce-worker.mjs),
// with await, on its own timer. Same interface as the Jira refresher (lib/jira/refresher.mjs):
//
//   const r = salesforceRefresher({ stories, stateDir, root, env, features, salesforceOrgs, now, run, onLoginExpired });
//   r.start()            refresh now, then every pollSeconds (5 s at least); r.stop() ends it
//   r.refresh()          one poll: the filter into <stateDir>/salesforce/list.json (the cache the
//                        source reads), then the outbox sent; resolves when done, never rejects
//   r.drain()            send the outbox now (the cache-only source queues its writes there); no
//                        child is started when <stateDir>/salesforce-outbox is empty
//   r.hold()             null when picking may go on, else { reason } for the loop to show:
//                        "Salesforce not reachable since HH:MM: <why>; picking paused, stories in
//                        progress carry on" when the last refresh failed or the cache is older
//                        than 5 × pollSeconds; { quiet: true, reason } before the first answer
//   r.fetchBrief(id)     fetch a Case's brief and write it; resolves true or false
//   r.briefTried(id)     whether a fetch of that brief has finished, well or not
//
// `stories()` gives the current `stories` options, so a settings change applies at the next poll.
// `run(job, extra)` does one job and resolves to the worker's JSON, { ok, value } or { ok: false,
// error: { name, message, code? } }, and never rejects; by default it is runWorker below.
// `env` goes to the worker on stdin only. onLoginExpired(error) runs once when the sign-in lapses
// (the error code is 'auth'), and again only after a good refresh.
//
// runWorker(input, { spawn, worker, timeoutMs }) starts the worker with process.execPath, writes
// the input as JSON to its stdin and reads its answer from stdout. It gives the child 3 minutes
// and then kills that child, and only that child, by its pid: sf's own watcher (sf-watch.mjs)
// ends any sf it started at its time limit.

import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { outbox } from '../../jira/outbox.mjs';
import { describeCaseOp } from '../../../packs/salesforce/cases.mjs';
import { readCache } from './salesforce.mjs';

export const STALE_POLLS = 5;
export const MIN_POLL_SECONDS = 5;
export const WORKER_TIMEOUT_MS = 180_000;
export const SF_EXPIRED_MESSAGE = "Foreman's sign-in to the Salesforce org that holds the stories has lapsed: connect it again on Set up › Salesforce, then resume.";

const WORKER = fileURLToPath(new URL('./salesforce-worker.mjs', import.meta.url));

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const failed = (message, code) => ({ ok: false, error: { name: 'Error', message, ...(code ? { code } : {}) } });

export function runWorker(input, { spawn = nodeSpawn, worker = WORKER, timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let child = null;
    let out = '';
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    try {
      child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      settle(failed(`the Salesforce worker could not start: ${err?.message ?? err}`));
      return;
    }
    timer = setTimeout(() => {
      settle(failed(`Salesforce did not answer within ${Math.round(timeoutMs / 1000)} s`, 'timeout'));
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr?.resume?.();
    child.on('error', (err) => settle(failed(`the Salesforce worker failed: ${err?.message ?? err}`)));
    child.on('close', () => {
      try {
        const answer = JSON.parse(out);
        settle(answer && typeof answer === 'object' && typeof answer.ok === 'boolean' ? answer : failed('the Salesforce worker gave no answer'));
      } catch {
        settle(failed('the Salesforce worker gave no answer'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

export function salesforceRefresher({
  stories,
  stateDir,
  root,
  env = process.env,
  features,
  salesforceOrgs,
  now = () => new Date(),
  run,
  onLoginExpired = () => {},
}) {
  const box = outbox(stateDir, { now, slot: null, folder: 'salesforce-outbox', label: 'Salesforce', describe: describeCaseOp });
  const opts = () => stories() ?? {};
  const pollMs = () => Math.max(opts().pollSeconds ?? 60, MIN_POLL_SECONDS) * 1000;
  // The job's input; env goes on the worker's stdin only.
  const doJob = async (job, extra = {}) => {
    try {
      const doIt = run ?? ((j, e) => runWorker({ job: j, root, options: opts(), stateDir, env, features, salesforceOrgs, ...e }));
      const answer = await doIt(job, extra);
      return answer && typeof answer === 'object' ? answer : failed('the Salesforce worker gave no answer');
    } catch (err) {
      return failed(String(err?.message ?? err));
    }
  };

  let refreshing = null;
  let draining = null;
  let lastError = null;
  let failingSince = null;
  let loginNotified = false;
  let timer = null;
  let running = false;
  const briefs = new Map(); // id -> the fetch in flight
  const briefsDone = new Set();

  function drain() {
    if (box.isEmpty()) return Promise.resolve();
    draining ??= (async () => {
      try {
        if (refreshing) await refreshing;
        await doJob('drain');
      } finally {
        draining = null;
      }
    })();
    return draining;
  }

  function refresh() {
    refreshing ??= (async () => {
      const startedAt = +now();
      try {
        const answer = await doJob('refresh');
        if (answer.ok) {
          lastError = null;
          failingSince = null;
          loginNotified = false;
          return;
        }
        lastError = answer.error ?? { message: 'no answer from Salesforce' };
        failingSince ??= startedAt;
        if (lastError.code === 'auth' && !loginNotified) {
          loginNotified = true;
          try {
            onLoginExpired(lastError);
          } catch {
            // a failed notice never stops the refresher
          }
        }
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  function start() {
    if (running) return;
    running = true;
    const loop = async () => {
      await refresh();
      if (!running) return;
      timer = setTimeout(loop, pollMs());
      timer.unref?.();
    };
    loop();
  }

  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function hold() {
    const paused = (since, why) => ({ reason: `Salesforce not reachable since ${hhmm(since)}: ${why}; picking paused, stories in progress carry on` });
    if (lastError) return paused(failingSince, String(lastError.message ?? 'no answer').replace(/[.\s]+$/, ''));
    const cache = readCache(stateDir, opts());
    if (!cache) return { quiet: true, reason: 'waiting for the first answer from Salesforce' };
    if (+now() - cache.fetchedAt > STALE_POLLS * pollMs()) return paused(cache.fetchedAt, 'no fresh answer');
    return null;
  }

  function fetchBrief(id) {
    if (briefs.has(id)) return briefs.get(id);
    const p = (async () => {
      try {
        const answer = await doJob('brief', { id });
        return answer.ok === true && answer.value?.written === true;
      } finally {
        briefs.delete(id);
        briefsDone.add(id);
      }
    })();
    briefs.set(id, p);
    return p;
  }

  return { start, stop, refresh, drain, hold, fetchBrief, briefTried: (id) => briefsDone.has(id) };
}
