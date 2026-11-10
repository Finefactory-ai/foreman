// The supervisor's Jira refresher. The supervisor must never wait on Jira, so it
// opens its story source cache-only and this does the Jira calls with await, on its own timer:
//
//   const r = jiraRefresher({ stories, stateDir, env, now, writeBrief, onLoginExpired });
//   r.start()            refresh now, then every pollSeconds (5 s at least); r.stop() ends it
//   r.refresh()          one poll: the JQL into <stateDir>/jira/list.json (the cache the
//                        source reads), then the outbox sent; resolves when done, never rejects
//   r.drain()            send the outbox now (the cache-only source queues its writes there)
//   r.hold()             null when picking may go on, else { reason } for the loop to show:
//                        "Jira not reachable since HH:MM: <why>; picking paused, stories in
//                        progress carry on" when the last refresh failed or the cache is older
//                        than 5 × pollSeconds; { quiet: true, reason } before the first answer
//   r.fetchBrief(id)     fetch an issue's brief and write it (writeBrief); resolves true or false
//   r.briefTried(id)     whether a fetch of that brief has finished, well or not
//
// `stories()` gives the current `stories` options (site, jql, pollSeconds, doneWhenField), so a
// settings change applies at the next poll. `env` is what the Jira client reads (HOME, and the
// Jira keys from .env.foreman and the env file for a token refresh); it stays in this object,
// never in process.env.
// onLoginExpired(err) runs once when the sign-in lapses, and again only after a good refresh.
// Each Jira request gives up after requestTimeoutMs, so a hung connection is a failed refresh,
// not a refresh that never ends.

import { normalizeSite } from './auth.mjs';
import { readListCache, writeListCache } from './cache.mjs';
import { jiraClient } from './client.mjs';
import { readBrief, readSnapshot } from './issues.mjs';
import { outbox } from './outbox.mjs';
import { sendWrites } from './writes.mjs';

export const STALE_POLLS = 5;
export const MIN_POLL_SECONDS = 5;
export const REQUEST_TIMEOUT_MS = 60_000;

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function jiraRefresher({
  stories,
  stateDir,
  env = process.env,
  now = () => new Date(),
  fetch: fetchImpl = globalThis.fetch,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  writeBrief = () => {},
  onLoginExpired = () => {},
}) {
  const box = outbox(stateDir, { now, slot: null });
  const timedFetch = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  const opts = () => {
    const o = stories() ?? {};
    return { site: normalizeSite(o.site), jql: o.jql, pollSeconds: o.pollSeconds ?? 60, doneWhenField: o.doneWhenField };
  };
  const pollMs = () => Math.max(opts().pollSeconds, MIN_POLL_SECONDS) * 1000;
  const requestFor = (site) => jiraClient({ site, env, fetch: timedFetch, now }).request;

  let refreshing = null;
  let draining = null;
  let lastError = null;
  let failingSince = null;
  let loginNotified = false;
  let timer = null;
  let running = false;
  const briefs = new Map(); // id -> the fetch in flight
  const briefsDone = new Set();

  async function drainWith(request) {
    const release = box.lock();
    if (!release) return;
    try {
      const batch = box.entries();
      if (!batch.length) return;
      let results;
      try {
        results = await sendWrites(request, { ops: batch.map((b) => b.op) });
      } catch (err) {
        const error = String(err?.message ?? err);
        results = batch.map(() => ({ status: 'failed', error }));
      }
      box.settle(batch, results);
    } finally {
      release();
    }
  }

  function drain() {
    if (box.isEmpty()) return Promise.resolve();
    draining ??= (async () => {
      try {
        if (refreshing) await refreshing;
        await drainWith(requestFor(opts().site));
      } catch {
        // the outbox keeps what was not sent
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
        const { site, jql } = opts();
        const request = requestFor(site);
        const snap = await readSnapshot(request, { jql });
        writeListCache(stateDir, { site, jql, fetchedAt: startedAt, ...snap });
        lastError = null;
        failingSince = null;
        loginNotified = false;
        await drainWith(request).catch(() => {});
      } catch (err) {
        lastError = err;
        failingSince ??= startedAt;
        if (err?.name === 'JiraLoginExpired' && !loginNotified) {
          loginNotified = true;
          try {
            onLoginExpired(err);
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
    const { site, jql } = opts();
    const paused = (since, why) => ({ reason: `Jira not reachable since ${hhmm(since)}: ${why}; picking paused, stories in progress carry on` });
    if (lastError) return paused(failingSince, String(lastError.message ?? lastError).replace(/[.\s]+$/, ''));
    const cache = readListCache(stateDir, { site, jql });
    if (!cache) return { quiet: true, reason: 'waiting for the first answer from Jira' };
    if (+now() - cache.fetchedAt > STALE_POLLS * pollMs()) return paused(cache.fetchedAt, 'no fresh answer');
    return null;
  }

  function fetchBrief(id) {
    if (briefs.has(id)) return briefs.get(id);
    const p = (async () => {
      try {
        const { site, doneWhenField } = opts();
        writeBrief(id, await readBrief(requestFor(site), { key: id, doneWhenField }));
        return true;
      } catch {
        return false;
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
