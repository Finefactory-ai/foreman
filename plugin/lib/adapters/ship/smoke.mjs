// Ship step `smoke`: after the deploy, check the live site answers. Each configured url is
// fetched without following redirects (a redirect is the site answering); no answer or a
// status of 500 or more exits 5 and writes HALT.
//
// healthy() is the same check following redirects, for `foreman health` (and `--site`). With
// no urls there is nothing to check: run passes and healthy returns null.
//
// Options: config.ship.smoke = { urls: [], expect: { <url>: <status> } }. A url named in
// `expect` must answer exactly that status (a health route that touches the database must
// say 200, not just "below 500"); every other url keeps the rule above.

const STAGE = 'smoke';
const TIMEOUT_MS = 15_000;

// The status a url answers with, 0 for none.
async function statusOf(fetchImpl, url, redirect) {
  try {
    const r = await fetchImpl(url, { redirect, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return Number(r?.status) || 0;
  } catch {
    return 0;
  }
}

const down = (status) => status === 0 || status >= 500;
const urlsOf = (config) => config.ship?.smoke?.urls ?? [];

// null when the answer is acceptable, else the words for what was wrong (no stop at the end).
function problem(config, url, status, answered) {
  const want = config.ship?.smoke?.expect?.[url];
  if (want === undefined) return down(status) ? answered : null;
  return status === want ? null : `${answered}; expected ${want}`;
}

export default {
  name: 'smoke',
  label: 'checking the live site',
  needs: [],
  halts: true,

  async run(ctx) {
    const live = [];
    for (const url of urlsOf(ctx.config)) {
      const status = await statusOf(ctx.fetch ?? fetch, url, 'manual');
      const bad = problem(ctx.config, url, status, `${url} answered ${status || 'nothing'} after the deploy`);
      if (bad) return { ok: false, code: 5, stage: STAGE, reason: `${bad}.` };
      live.push({ url, status });
    }
    return { ok: true, live };
  },

  async healthy(ctx) {
    const urls = urlsOf(ctx.config);
    if (urls.length === 0) return null;
    for (const url of urls) {
      const status = await statusOf(ctx.fetch ?? fetch, url, 'follow');
      const bad = problem(ctx.config, url, status, status === 0 ? `${url} did not answer` : `${url} answered ${status}`);
      if (bad) return { ok: false, reason: `${bad}.` };
    }
    return { ok: true, reason: `The live site answers (${urls.join(', ')}).` };
  },
};
