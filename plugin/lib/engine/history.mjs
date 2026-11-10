// The run history the dashboard's Insights tab draws, from the run records (run-record.mjs
// readRuns). Pure. Days are UTC, by when a story ended, as in the token view (token-report.mjs),
// so the two line up day for day.
//
//   historyView(runs, { now, days })
//     { since, total, days, week, tokensPerStory }
//     since   the first record's endedAt, or null
//     total   how many records have an end
//     days    from the first record's day (at most `days`, 14, back) to today, oldest first:
//             [{ day: 'YYYY-MM-DD', shipped, notShipped, costUsd }]
//     week    the stories that ended in the last 7 days: { finished, shipped, costUsd,
//             medianMinutes (of the shipped, or null), firstTry (shipped in one round),
//             stages: { architect, build, test, review } (average minutes per shipped story) }
//     tokensPerStory  the tokens it takes to ship a story: every session's tokens (failed ones
//             included, cache reads and writes counted) over the stories shipped, by agent (the
//             token view's whoOf). A shipped record with no token counts (agents null) is left
//             out of the stories, so it does not pull the average down. Averages are rounded
//             tokens, and null with nothing shipped.
//             { agents: [{ who, label }] biggest so far first, at most AGENT_SERIES, the rest
//                 folded into { who: 'rest', label: 'Other agents' },
//               overall: { shipped, average, agents: { <who>: average } } over every record,
//               days: [{ day, shipped, average, agents }] for the same days as `days` }

import { whoOf } from './token-report.mjs';

const DAY = 86400000;
export const STAGES = ['architect', 'build', 'test', 'review'];
export const AGENT_SERIES = 6;
const LABELS = { architect: 'Architect', builder: 'Builder', tester: 'Tester', orchestration: 'Story session', learner: 'Learner', other: 'Other', rest: 'Other agents' };

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const cents = (x) => Math.round(x * 100) / 100;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

const labelOf = (who) => (who.startsWith('reviewer:') ? who.slice(9) + ' reviewer' : who).replace(/^./, (c) => c.toUpperCase());
const tokensOf = (row) => ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((n, k) => n + (num(row?.[k]) > 0 ? row[k] : 0), 0);

// { shipped, tokens: Map(who -> tokens) } for some records.
function tally(records) {
  const tokens = new Map();
  let shipped = 0;
  for (const r of records) {
    if (!Array.isArray(r.agents)) continue;
    if (r.result === 'shipped') shipped += 1;
    for (const row of r.agents) {
      const { who } = whoOf(row);
      tokens.set(who, (tokens.get(who) ?? 0) + tokensOf(row));
    }
  }
  return { shipped, tokens };
}

function tokensPerStory(ended, dayList) {
  const all = tally(ended);
  const ranked = [...all.tokens.entries()].filter(([, n]) => n > 0)
    .map(([who]) => ({ who, label: LABELS[who] ?? labelOf(who) }))
    .sort((x, y) => all.tokens.get(y.who) - all.tokens.get(x.who) || x.label.localeCompare(y.label, 'en'));
  const shown = ranked.length > AGENT_SERIES ? [...ranked.slice(0, AGENT_SERIES - 1), { who: 'rest', label: LABELS.rest }] : ranked;
  const kept = new Set(shown.map((x) => x.who));
  const averages = ({ shipped, tokens }) => {
    if (!shipped) return { shipped, average: null, agents: {} };
    const folded = {};
    let total = 0;
    for (const [who, n] of tokens) {
      if (!n) continue;
      const key = kept.has(who) ? who : 'rest';
      folded[key] = (folded[key] ?? 0) + n;
      total += n;
    }
    return { shipped, average: Math.round(total / shipped), agents: Object.fromEntries(Object.entries(folded).map(([k, n]) => [k, Math.round(n / shipped)])) };
  };
  return {
    agents: shown,
    overall: averages(all),
    days: dayList.map((day) => ({ day, ...averages(tally(ended.filter((r) => dayOf(Date.parse(r.endedAt)) === day))) })),
  };
}

export function historyView(runs, { now = Date.now(), days = 14 } = {}) {
  const ended = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && typeof r === 'object' && Number.isFinite(Date.parse(r.endedAt)))
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt));
  const first = ended.length ? Date.parse(ended[0].endedAt) : now;
  const from = Math.max(first, now - (days - 1) * DAY);

  const byDay = new Map();
  for (let t = Date.parse(dayOf(from) + 'T00:00:00Z'); dayOf(t) <= dayOf(now); t += DAY) byDay.set(dayOf(t), { day: dayOf(t), shipped: 0, notShipped: 0, costUsd: 0 });
  for (const r of ended) {
    const d = byDay.get(dayOf(Date.parse(r.endedAt)));
    if (!d) continue;
    if (r.result === 'shipped') d.shipped += 1; else d.notShipped += 1;
    d.costUsd = cents(d.costUsd + num(r.costUsd));
  }

  const week = ended.filter((r) => Date.parse(r.endedAt) >= now - 7 * DAY);
  const shipped = week.filter((r) => r.result === 'shipped');
  const stages = Object.fromEntries(STAGES.map((k) => [k, shipped.length ? shipped.reduce((a, r) => a + num(r.stages?.[k]), 0) / shipped.length : 0]));
  return {
    since: ended[0]?.endedAt ?? null,
    total: ended.length,
    days: [...byDay.values()],
    week: {
      finished: week.length,
      shipped: shipped.length,
      costUsd: cents(week.reduce((a, r) => a + num(r.costUsd), 0)),
      medianMinutes: median(shipped.map((r) => r.minutes).filter((m) => typeof m === 'number' && Number.isFinite(m))),
      firstTry: shipped.filter((r) => num(r.rounds) <= 1).length,
      stages,
    },
    tokensPerStory: tokensPerStory(ended, [...byDay.keys()]),
  };
}
