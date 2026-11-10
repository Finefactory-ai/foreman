// The token view: what each agent role used today, over the last 7 days, this run and per day
// for 14 days, per story, and plain hints for where to save. Built from the run records'
// `agents` (run-record.mjs) and the learner's lines (learner.mjs readLearnerCalls); read by
// `foreman report --tokens` and the dashboard's GET /api/tokens. Pure, and tokens only: no
// cost and no money anywhere in it.
//
//   units(n)            850, 8.5 k, 85 k, 1.2 M, 250 M, 3.4 B
//   tokenLine(t)        '1.2 M in · 85 k out · 9.8 M cache read · 410 k cache write'
//   sparkline(values)   one of ▁▂▃▄▅▆▇█ per value, scaled to the biggest
//   whoOf(row)          { who, label }: reviewers by name ('security reviewer'), everyone else
//                       by role (architect, builder, tester, the story session itself, learner,
//                       other)
//   tokenView({ runs, learner, findings, now, runSince, since })
//       { roles, stories, hints, unknown, empty }. Days are UTC, by when a session ended (a
//       learner line by its `at`), as in summarise; nothing before `since` (YYYY-MM-DD) counts.
//       roles: [{ who, label, today, week, run, spark, todayText, weekText, runText, weekLine,
//         sparkText, models, modelsText }], week being today and the 6 days before, run
//         everything from runSince (state.json totals.since; zeros without one), spark the 14
//         daily totals, oldest first; biggest week first.
//       stories: the last 14 days, a story's sessions summed: [{ story, endedAt, total,
//         totalText, agents: [{ who, label, total, totalText, line, models, modelsText }] }],
//         biggest first, at most STORY_ROWS.
//       models: a role's are the distinct models its sessions recorded (agents[].model) in the
//         last 7 days, the same window as `week`; a story agent's are those of that story's
//         sessions. Both sorted; modelsText them joined with ', ', or '' when none (a learner
//         line has none).
//       hints: [{ kind, text }] for lowCache, growth, fixRounds and quietReviewer (HINTS).
//       unknown: the sessions of the last 14 days with no token counts.
//       empty: no run has an agents list and no learner line has tokens.

export const STORY_ROWS = 20;
export const SPARK_DAYS = 14;
export const HINTS = Object.freeze({
  // lowCache: a role whose input side over 7 days is this big ...
  lowCacheMinInput: 1_000_000,
  // ... and reads less than this share of it from the cache
  lowCacheShare: 0.5,
  // growth: this many stories in each of the last two 7-day windows ...
  growthMinStories: 2,
  // ... and more than this many times the tokens per story of the week before
  growthFactor: 1.5,
  // fixRounds: fix rounds over this share of the builder's tokens in 14 days ...
  fixShare: 0.5,
  // ... on at least this many stories
  fixMinStories: 2,
  // quietReviewer: a reviewer on at least this many stories in 14 days, with no findings ...
  quietMinStories: 5,
  // ... using at least this share of all tokens
  quietMinShare: 0.1,
});

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const LABELS = { architect: 'architect', builder: 'builder', tester: 'tester', orchestration: 'the story session itself', learner: 'learner', other: 'other' };
const BARS = [...'▁▂▃▄▅▆▇█'];
const DAY_MS = 86_400_000;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const time = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : NaN);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMinus = (day, n) => dayOf(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS);
const pct = (share) => `${Math.round(share * 100)}%`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function units(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  if (Math.round(x) < 1000) return String(Math.round(x));
  const steps = [
    [1e3, 'k', 10],
    [1e6, 'M', 100],
    [1e9, 'B', 100],
  ];
  for (let i = 0; i < steps.length; i++) {
    const [size, unit, decimalsUnder] = steps[i];
    const v = x / size;
    const tenth = Math.round(v * 10) / 10;
    const text = tenth < decimalsUnder ? tenth.toFixed(1) : String(Math.round(v));
    if (Number(text) < 1000 || i === steps.length - 1) return `${text} ${unit}`;
  }
  return '0';
}

export const tokenLine = (t) => `${units(t?.input)} in · ${units(t?.output)} out · ${units(t?.cacheRead)} cache read · ${units(t?.cacheWrite)} cache write`;

export function sparkline(values) {
  const list = (Array.isArray(values) ? values : []).map(count);
  const max = Math.max(0, ...list);
  return list.map((v) => (max > 0 && v > 0 ? BARS[Math.max(1, Math.round((v / max) * (BARS.length - 1)))] : BARS[0])).join('');
}

export function whoOf(row) {
  const role = row?.role;
  if (role === 'reviewer') {
    const name = typeof row.name === 'string' && row.name ? row.name : 'agent';
    return { who: `reviewer:${name}`, label: `${name} reviewer` };
  }
  const who = Object.hasOwn(LABELS, role) ? role : 'other';
  return { who, label: LABELS[who] };
}

const countsOf = (x) => ({ input: count(x?.input), output: count(x?.output), cacheRead: count(x?.cacheRead), cacheWrite: count(x?.cacheWrite), turns: count(x?.turns) });

// T plus total over the items.
function sum(items) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const i of items) for (const f of [...FIELDS, 'turns']) t[f] += i.t[f];
  return { ...t, total: FIELDS.reduce((n, f) => n + t[f], 0) };
}

const totalOf = (items) => items.reduce((n, i) => n + i.total, 0);

// { models, modelsText }: the distinct models the items recorded, sorted.
function modelsOf(items) {
  const models = [...new Set(items.map((i) => i.model).filter((m) => m !== null))].sort();
  return { models, modelsText: models.join(', ') };
}

const groupBy = (items, key) => {
  const map = new Map();
  for (const i of items) {
    const k = key(i);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  return map;
};

// One item per agent row of a run with an agents list, and per learner line with tokens.
function itemsOf({ runs, learner, since }) {
  const items = [];
  const keep = (at) => Number.isFinite(at) && (!since || dayOf(at) >= since);
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!isPlain(r) || !Array.isArray(r.agents)) continue;
    const at = time(r.endedAt);
    if (!keep(at)) continue;
    for (const row of r.agents) {
      if (!isPlain(row)) continue;
      const t = countsOf(row);
      const model = typeof row.model === 'string' && row.model ? row.model : null;
      items.push({ ...whoOf(row), role: row.role, name: row.name, model, story: String(r.story ?? ''), at, day: dayOf(at), t, total: FIELDS.reduce((n, f) => n + t[f], 0) });
    }
  }
  for (const l of Array.isArray(learner) ? learner : []) {
    if (!isPlain(l) || !isPlain(l.tokens)) continue;
    const at = time(l.at);
    if (!keep(at)) continue;
    const t = countsOf(l.tokens);
    items.push({ ...whoOf({ role: 'learner' }), role: 'learner', name: 'learner', model: null, story: null, at, day: dayOf(at), t, total: FIELDS.reduce((n, f) => n + t[f], 0) });
  }
  return items;
}

function lowCache(weekItems) {
  const hints = [];
  for (const list of groupBy(weekItems, (i) => i.who).values()) {
    const t = sum(list);
    const side = t.input + t.cacheRead + t.cacheWrite;
    if (side < HINTS.lowCacheMinInput || !(t.cacheRead / side < HINTS.lowCacheShare)) continue;
    hints.push({
      kind: 'lowCache',
      who: list[0].who,
      text: `${list[0].label}: only ${pct(t.cacheRead / side)} of its input came from the cache in the last 7 days (${units(t.cacheRead)} of ${units(side)}). Keeping the start of its prompt the same from call to call lets more of it be read from the cache.`,
    });
  }
  return hints;
}

function growth(items, { weekStart, prevStart, prevEnd, today }) {
  const hints = [];
  const stories = items.filter((i) => i.story !== null);
  for (const list of groupBy(stories, (i) => i.who).values()) {
    const now = list.filter((i) => i.day >= weekStart && i.day <= today);
    const before = list.filter((i) => i.day >= prevStart && i.day <= prevEnd);
    const nNow = new Set(now.map((i) => i.story)).size;
    const nBefore = new Set(before.map((i) => i.story)).size;
    if (nNow < HINTS.growthMinStories || nBefore < HINTS.growthMinStories) continue;
    const avgNow = totalOf(now) / nNow;
    const avgBefore = totalOf(before) / nBefore;
    if (!(avgNow > HINTS.growthFactor * avgBefore)) continue;
    hints.push({
      kind: 'growth',
      who: list[0].who,
      text: `Tokens per story for ${list[0].label}: ${units(avgNow)} in the last 7 days, up from ${units(avgBefore)} the week before (${plural(nNow, 'story', 'stories')} and ${plural(nBefore, 'story', 'stories')}). Look at what changed in its prompt, skills or the stories it gets.`,
    });
  }
  return hints;
}

function fixRounds(windowItems) {
  const builder = windowItems.filter((i) => i.role === 'builder');
  const fixes = builder.filter((i) => i.name === 'fix');
  const all = totalOf(builder);
  const share = all > 0 ? totalOf(fixes) / all : 0;
  const n = new Set(fixes.map((i) => i.story)).size;
  if (!(share > HINTS.fixShare) || n < HINTS.fixMinStories) return [];
  return [
    {
      kind: 'fixRounds',
      who: 'builder',
      text: `Fix rounds used ${pct(share)} of the builder's tokens in the last 14 days, across ${plural(n, 'story', 'stories')}. Clearer plans, or running the checks before handing over, could save rounds.`,
    },
  ];
}

function quietReviewer(windowItems, findings, { windowStart, today }) {
  const hints = [];
  const all = totalOf(windowItems);
  const reviewers = windowItems.filter((i) => i.role === 'reviewer');
  for (const [name, list] of groupBy(reviewers, (i) => String(i.name ?? ''))) {
    const stories = new Set(list.map((i) => i.story));
    if (stories.size < HINTS.quietMinStories) continue;
    const found = (Array.isArray(findings) ? findings : []).some((f) => {
      if (!isPlain(f) || f.stage !== name || !stories.has(String(f.story ?? ''))) return false;
      const at = time(f.at);
      if (!Number.isFinite(at)) return false;
      const day = dayOf(at);
      return day >= windowStart && day <= today;
    });
    const share = all > 0 ? totalOf(list) / all : 0;
    if (found || share < HINTS.quietMinShare) continue;
    hints.push({
      kind: 'quietReviewer',
      who: list[0].who,
      text: `The ${list[0].label} ran on ${stories.size} stories in the last 14 days, found nothing, and used ${pct(share)} of all tokens. It may not be needed on every story.`,
    });
  }
  return hints;
}

export function tokenView({ runs = [], learner = [], findings = [], now = new Date(), runSince = null, since = '' } = {}) {
  const today = dayOf(time(now));
  const weekStart = dayMinus(today, 6);
  const windowStart = dayMinus(today, SPARK_DAYS - 1);
  const prevStart = dayMinus(today, 13);
  const prevEnd = dayMinus(today, 7);
  const runFrom = runSince ? time(runSince) : NaN;
  const keptRuns = (Array.isArray(runs) ? runs : []).filter((r) => isPlain(r) && Number.isFinite(time(r.endedAt)) && (!since || dayOf(time(r.endedAt)) >= since));

  const items = itemsOf({ runs: keptRuns, learner, since });
  const inWindow = (i) => i.day >= windowStart && i.day <= today;
  const inWeek = (i) => i.day >= weekStart && i.day <= today;
  const inRun = (i) => Number.isFinite(runFrom) && i.at >= runFrom;
  const windowItems = items.filter(inWindow);
  const weekItems = items.filter(inWeek);
  const days = Array.from({ length: SPARK_DAYS }, (_, k) => dayMinus(today, SPARK_DAYS - 1 - k));

  const roles = [...groupBy(items.filter((i) => inWindow(i) || inRun(i)), (i) => i.who).values()]
    .map((list) => {
      const todayT = sum(list.filter((i) => i.day === today));
      const week = sum(list.filter(inWeek));
      const run = sum(list.filter(inRun));
      const spark = days.map((d) => totalOf(list.filter((i) => i.day === d)));
      return {
        who: list[0].who,
        label: list[0].label,
        today: todayT,
        week,
        run,
        spark,
        todayText: units(todayT.total),
        weekText: units(week.total),
        runText: units(run.total),
        weekLine: tokenLine(week),
        sparkText: sparkline(spark),
        ...modelsOf(list.filter(inWeek)),
      };
    })
    .sort((a, b) => b.week.total - a.week.total || b.run.total - a.run.total || a.label.localeCompare(b.label, 'en'));

  const stories = [...groupBy(windowItems.filter((i) => i.story !== null), (i) => i.story)]
    .map(([story, list]) => {
      const total = totalOf(list);
      const agents = [...groupBy(list, (i) => i.who).values()]
        .map((group) => {
          const t = sum(group);
          return { who: group[0].who, label: group[0].label, total: t.total, totalText: units(t.total), line: tokenLine(t), ...modelsOf(group) };
        })
        .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, 'en'));
      return { story, endedAt: new Date(Math.max(...list.map((i) => i.at))).toISOString(), total, totalText: units(total), agents };
    })
    .sort((a, b) => b.total - a.total || b.endedAt.localeCompare(a.endedAt) || a.story.localeCompare(b.story, 'en', { numeric: true }))
    .slice(0, STORY_ROWS);

  const hints = [...lowCache(weekItems), ...growth(items, { weekStart, prevStart, prevEnd, today }), ...fixRounds(windowItems), ...quietReviewer(windowItems, findings, { windowStart, today })].map(({ kind, text }) => ({ kind, text }));

  const unknown = keptRuns.filter((r) => {
    const day = dayOf(time(r.endedAt));
    return !Array.isArray(r.agents) && day >= windowStart && day <= today;
  }).length;
  const keptLearner = (Array.isArray(learner) ? learner : []).filter((l) => isPlain(l) && isPlain(l.tokens) && Number.isFinite(time(l.at)) && (!since || dayOf(time(l.at)) >= since));
  const empty = !keptRuns.some((r) => Array.isArray(r.agents)) && !keptLearner.length;

  return { roles, stories, hints, unknown, empty };
}
