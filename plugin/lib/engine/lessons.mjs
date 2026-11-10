// Lessons: what keeps going wrong, found in the state folder, for the learner to turn into a
// trait or a learned skill. Pure (no files); `foreman learning scan` reads the files.
//
// A lesson is a candidate { key, source, role, cluster, stories, evidence }. Its key is a
// stable hash, so it can be ignored, applied or covered by a learned item. Sources:
//
//   findings     findings that say the same thing in other words (topicWords, similarity),
//                within one stage family, on 2+ stories with a blocker or major (fixed round
//                lines count), or on 5+ stories of any severity
//   not-fixed    the same cluster stopping one story in two rounds in a row
//   failed       a run record whose result is 'failed'
//   retry-note   an owner's "Note for the architect:" on a story
//   tool-error   the same failed tool result (its signature: paths, ids and numbers stripped)
//                in 2+ stories, or 3+ times in one session
//
// Only the last LESSON_STORIES stories count (lessonWindow, by the latest finding or run end).
// Clusters are made from every findings line, not only the window, so a key stays the same as
// the window slides.
//
// Secrets: tool-result text is redacted (the env's secret names, the file and config values,
// then the looks-secret patterns of engine/state.mjs) before its signature, key or evidence is
// made; the signature is cleaned again after it is lowercased (a pattern can match only then),
// and a tool-error key is the hash of its cluster. Every string a candidate carries is redacted
// before it is cut.
//
// Limits: subagent tool calls do not reach the session log (the workflow streams only its
// progress, so no tool_result there has a parent_tool_use_id); tool errors come from the
// session's own tool calls. Retry notes are read from the state overlays only
// (<stateDir>/stories/*.json); the markdown file mode keeps its notes in the story files,
// outside the state folder.

import { createHash } from 'node:crypto';
import { keyOf, mostCommon, SERIOUS } from './learn.mjs';
import { redact } from '../secrets/redact.mjs';
import { redact as redactLooksSecret } from './state.mjs';

export const LESSON_STORIES = 60;
export const SOURCES = ['findings', 'not-fixed', 'failed', 'retry-note', 'tool-error'];

const NOTE_PREFIX = 'Note for the architect:';
const REVIEW = ['tester', 'compliance', 'security'];
const SKEW_MS = 5000;

const hash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

// The key of the not-fixed lesson for cluster `clusterKey` on `story`; learning-eval.mjs finds the
// cluster of an n- item with it.
export const notFixedKey = (clusterKey, story) => `n-${hash(`not-fixed\n${clusterKey}\n${story}`)}`;
// Exact values first (longest first, so a value holding another is blanked whole), then the
// looks-secret patterns.
const clean = (text, { env = {}, values = [] } = {}) => redactLooksSecret(redact(String(text ?? ''), { env, values: [...values].sort((a, b) => b.length - a.length) }));
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const time = (v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};
const serious = (f) => SERIOUS.includes(String(f.severity ?? '').toLowerCase());
const distinct = (list) => [...new Set(list)];

// ---- topic words: what a finding's rule is about ----

const GENERIC = ['how we work', 'how to work', 'judge the tests', 'try to break it', 'design', 'story design', 'done when', 'story done-when', 'test plan', 'owner rule', 'project rule'];
const STOP = new Set(
  'a an the and or of to in on for by with from at as is are be been it its this that these those each every has have had gets get got would should must can could will not no when if than then into out stay stays kept keep keeps same any all only also what which who our we you they there their them story design project rule owner note plan step done scope finding item contract follow class case one new old'.split(
    ' ',
  ),
);
const IRREGULAR = { broke: 'break', broken: 'break', behavior: 'behaviour', docs: 'doc' };

function stem(w) {
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return IRREGULAR[w] ?? w;
}

// The words a rule is about: lowercased, list numbers, a generic heading ("How we work:") and
// anything after the first sentence gone; any other "Label: detail" keeps only the label.
export function topicWords(rule) {
  let t = String(rule ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  for (;;) {
    const before = t;
    t = t.replace(/^(\d+([/.]\d+)*\.?\s+)/, ''); // list numbers: "4. ", "4/5 "
    t = t.split(/\.\s/)[0]; // first sentence
    const m = /^([^:]{1,40}):\s*(.*)$/.exec(t);
    if (m) {
      const label = m[1].trim().replace(/\s+[a-z0-9]$/, '').replace(/\s+\d+$/, '');
      t = GENERIC.includes(label) ? m[2] : m[1];
    }
    if (t === before) break;
  }
  return [...new Set(t.split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem).filter((w) => !STOP.has(w)))];
}

// Dice: 2 * shared / (a.length + b.length).
export function similarity(a, b) {
  if (!a.length && !b.length) return 0;
  const other = new Set(b);
  const shared = a.filter((w) => other.has(w)).length;
  return (2 * shared) / (a.length + b.length);
}

const familyOf = (stage) => {
  const s = str(stage).toLowerCase();
  if (!s) return 'other';
  return REVIEW.includes(s) ? 'review' : s;
};

// [{ key, family, members }] in the order made. A finding joins the first cluster of its family
// with a member at least half alike (similarity >= 0.5); the key hashes the first member's words.
export function clusterFindings(findings) {
  const clusters = [];
  for (const f of findings ?? []) {
    if (!f || typeof f !== 'object' || !str(f.story)) continue;
    const words = topicWords(f.rule);
    if (!words.length) continue;
    const family = familyOf(f.stage);
    const home = clusters.find((c) => c.family === family && c.words.some((w) => similarity(words, w) >= 0.5));
    if (home) {
      home.members.push(f);
      home.words.push(words);
      continue;
    }
    clusters.push({ key: `f-${hash(`${family}\n${[...words].sort().join(' ')}`)}`, family, members: [f], words: [words] });
  }
  return clusters.map(({ key, family, members }) => ({ key, family, members }));
}

// The last `size` story ids, oldest first, by each story's latest finding (`at`) or run end
// (`endedAt`); a time that does not parse counts as 0, and ties keep first-seen order.
export function lessonWindow({ findings = [], runs = [] } = {}, size = LESSON_STORIES) {
  const latest = new Map();
  const see = (story, at) => {
    const id = str(story);
    if (!id) return;
    latest.set(id, Math.max(latest.get(id) ?? 0, time(at)));
  };
  for (const f of findings) if (f && typeof f === 'object') see(f.story, f.at);
  for (const r of runs) if (r && typeof r === 'object') see(r.story, r.endedAt);
  const order = [...latest.keys()];
  const ranked = order.map((id, i) => ({ id, i, t: latest.get(id) })).sort((a, b) => a.t - b.t || a.i - b.i);
  return size > 0 ? ranked.slice(-size).map((x) => x.id) : [];
}

// ---- tool errors from session logs ----

const LOG_NAME = /^([A-Za-z0-9._-]+)-(\d{8}-\d{6})(?:-\d+)?\.log$/;

const stampOf = (name) => {
  const m = LOG_NAME.exec(String(name ?? ''));
  if (!m) return null;
  const [d, t] = m[2].split('-');
  return { slot: m[1], at: Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6)) };
};

// The story of the run whose slot and start (within 5 s) match a `<slot>-<stamp>.log` name (or
// `<slot>-<stamp>-<n>.log`, a second session of the slot in that second).
export function sessionStory(logName, runs) {
  const s = stampOf(logName);
  if (!s) return null;
  const r = (runs ?? []).find((x) => x && x.slot === s.slot && Math.abs(Date.parse(x.startedAt) - s.at) <= SKEW_MS);
  return r ? str(r.story) || null : null;
}

const WORTH = /error|not found|no such|denied|cannot|can't|failed|refused|invalid|missing/i;
// The signature is cut to 120 chars anyway, and the <path> and <id> regexes are quadratic on long runs.
const MAX_LINE = 2000;

// One line that says what went wrong, with paths, ids, hex and numbers made placeholders; null
// when fewer than two real words are left.
export function errorSignature(text) {
  let lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length && /^exit code \d+$/i.test(lines[0])) lines = lines.slice(1);
  lines = lines.filter((l) => !l.startsWith('{') && !l.startsWith('['));
  if (!lines.length) return null;
  const line = (lines.find((l) => WORTH.test(l)) ?? lines.at(-1)).slice(0, MAX_LINE);
  const sig = line
    .toLowerCase()
    .replace(/[^\s:'"`]*\/[^\s:'"`]*/g, '<path>')
    .replace(/\b[a-z][a-z0-9]*-\d+\b/g, '<id>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const words = sig.replace(/<(path|id|hex|n)>/g, ' ').match(/[a-z]{3,}/g) ?? [];
  return words.length >= 2 ? sig : null;
}

const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
};

// [{ tool, signature, text }], one per failed tool result in a stream-json session log. The text
// is redacted before its signature is made, because the signature lowercases it and redact
// matches values exactly; the signature is redacted again, because a case-sensitive pattern
// (sk_...) can match only once it is lowercased.
export function toolErrors(logText, { env = {}, redactValues = [] } = {}) {
  const names = new Map();
  const out = [];
  for (const line of String(logText ?? '').split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('"is_error":true')) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // a torn line
    }
    const blocks = Array.isArray(msg?.message?.content) ? msg.message.content : [];
    if (msg?.type === 'assistant') {
      for (const b of blocks) if (b?.type === 'tool_use' && b.id) names.set(b.id, b.name);
    } else if (msg?.type === 'user') {
      for (const b of blocks) {
        if (b?.type !== 'tool_result' || b.is_error !== true) continue;
        const text = clean(resultText(b.content), { env, values: redactValues });
        const sig = errorSignature(text);
        if (!sig) continue;
        const tool = names.get(b.tool_use_id) ?? null;
        out.push({ tool: tool ?? 'tool', signature: clean(`${tool ?? 'tool'}: ${sig}`, { env, values: redactValues }), text });
      }
    }
  }
  return out;
}

// ---- lessons ----

const byRecent = (list) => list.map((f, i) => ({ f, i })).sort((a, b) => time(b.f.at) - time(a.f.at) || b.i - a.i).map((x) => x.f);

export function lessons({ findings = [], runs = [], notes = [], logs = [], skip = [], items = [], env = {}, redactValues = [], size = LESSON_STORIES } = {}) {
  const stories = lessonWindow({ findings, runs }, size);
  const inWindow = new Set(stories);
  const skipped = new Set(skip);
  const cut = (text, n = 300) => clean(text, { env, values: redactValues }).slice(0, n);
  const findingEvidence = (f) => {
    const e = { story: str(f.story), stage: cut(f.stage), severity: cut(f.severity), rule: cut(f.rule), where: cut(f.where), observed: cut(f.observed), fix: cut(f.fix) };
    if (f.round !== undefined) e.round = f.round;
    return e;
  };
  const builderOf = (list) => mostCommon(list.map((f) => str(f.builder))) || 'all';
  const findingsOf = (story) => findings.filter((f) => f && typeof f === 'object' && str(f.story) === story);

  const all = [];
  const clusters = clusterFindings(findings);
  const clusterOf = new Map();
  for (const c of clusters) for (const m of c.members) clusterOf.set(m, c);

  // findings
  for (const c of clusters) {
    const members = c.members.filter((f) => inWindow.has(str(f.story)));
    if (!members.length) continue;
    const ids = distinct(members.map((f) => str(f.story)));
    const seriousIds = distinct(members.filter(serious).map((f) => str(f.story)));
    if (seriousIds.length < 2 && ids.length < 5) continue;
    if (members.some((f) => skipped.has(keyOf(str(f.builder), f.rule)))) continue;
    all.push({ key: c.key, source: 'findings', role: builderOf(members), cluster: cut(mostCommon(members.map((f) => f.rule))), stories: ids, evidence: byRecent(members).slice(0, 5).map(findingEvidence) });
  }

  // not-fixed: one story's findings at one `at` (one story end), by round
  const notFixed = new Map();
  for (const story of stories) {
    const groups = new Map();
    for (const f of findingsOf(story)) {
      if (!clusterOf.has(f)) continue;
      const g = groups.get(f.at) ?? [];
      g.push(f);
      groups.set(f.at, g);
    }
    for (const g of groups.values()) {
      const rounds = g.map((f) => f.round).filter(Number.isInteger);
      if (!rounds.length) continue;
      const last = Math.max(...rounds) + 1;
      const roundOf = (f) => (Number.isInteger(f.round) ? f.round : f.round === undefined ? last : null);
      const byCluster = new Map();
      for (const f of g.filter(serious)) {
        const c = clusterOf.get(f);
        const list = byCluster.get(c) ?? [];
        list.push(f);
        byCluster.set(c, list);
      }
      for (const [c, list] of byCluster) {
        const seen = new Set(list.map(roundOf).filter((r) => r !== null));
        if (![...seen].some((r) => seen.has(r + 1))) continue;
        const key = notFixedKey(c.key, story);
        const prev = notFixed.get(key);
        const members = [...(prev?.members ?? []), ...list];
        notFixed.set(key, { key, story, members });
      }
    }
  }
  for (const { key, story, members } of notFixed.values()) {
    all.push({ key, source: 'not-fixed', role: builderOf(members), cluster: cut(mostCommon(members.map((f) => f.rule))), stories: [story], evidence: byRecent(members).slice(0, 5).map(findingEvidence) });
  }

  // failed runs
  for (const r of runs) {
    const story = str(r?.story);
    if (r?.result !== 'failed' || !inWindow.has(story)) continue;
    const own = findingsOf(story);
    const evidence = [...byRecent(own.filter(serious)).slice(0, 4).map(findingEvidence), { rounds: r.rounds ?? 0 }];
    all.push({ key: `r-${hash(`${story}\n${r.startedAt}`)}`, source: 'failed', role: builderOf(own), cluster: '', stories: [story], evidence });
  }

  // retry notes
  for (const n of notes) {
    const story = str(n?.story);
    const text = String(n?.text ?? '').trim();
    if (!text.startsWith(NOTE_PREFIX) || !inWindow.has(story)) continue;
    all.push({ key: `a-${hash(`${story}\n${text}`)}`, source: 'retry-note', role: 'architect', cluster: '', stories: [story], evidence: [{ story, date: cut(n.date), text: cut(text, 600) }] });
  }

  // tool errors: logs in stamp order, so the last seen is the most recent
  const seen = new Map();
  const sessions = logs.map((l) => ({ ...l, story: sessionStory(l?.name, runs), at: stampOf(l?.name)?.at ?? 0 })).filter((l) => l.story && inWindow.has(l.story)).sort((a, b) => a.at - b.at);
  for (const log of sessions) {
    const perSession = new Map();
    for (const e of toolErrors(log.text, { env, redactValues })) {
      const s = seen.get(e.signature) ?? { stories: [], hits: [], most: 0 };
      if (!s.stories.includes(log.story)) s.stories.push(log.story);
      s.hits.push({ story: log.story, session: log.name, tool: e.tool, text: e.text });
      perSession.set(e.signature, (perSession.get(e.signature) ?? 0) + 1);
      s.most = Math.max(s.most, perSession.get(e.signature));
      seen.set(e.signature, s);
    }
  }
  for (const [signature, s] of seen) {
    if (s.stories.length < 2 && s.most < 3) continue;
    const evidence = s.hits.slice(-3).reverse().map((h) => ({ story: h.story, session: cut(h.session), tool: cut(h.tool), text: cut(h.text) }));
    const cluster = cut(signature);
    all.push({ key: `t-${hash(cluster)}`, source: 'tool-error', role: 'all', cluster, stories: s.stories, evidence });
  }

  // skipped, then covered
  const inForce = new Map();
  for (const item of items ?? []) if (item && Number(item.v) > 0 && item.source?.key && !inForce.has(item.source.key)) inForce.set(item.source.key, item);
  const candidates = [];
  const covered = [];
  for (const c of all) {
    if (skipped.has(c.key)) continue;
    const item = inForce.get(c.key);
    if (item) covered.push({ key: c.key, id: item.id, source: c.source, cluster: c.cluster, stories: c.stories });
    else candidates.push(c);
  }
  candidates.sort((a, b) => b.stories.length - a.stories.length || SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || a.key.localeCompare(b.key));
  return { window: { size, stories: stories.length }, candidates, covered };
}
