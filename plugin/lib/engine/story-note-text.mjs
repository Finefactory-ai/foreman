// What Foreman writes on a story, as words for a person. Pure: data in, text out. The notes
// themselves are queued by story-notes-queue.mjs and posted by story-notes.mjs; this file only
// says what each one reads like. Everything is plain prose in markdown that jira/adf.mjs
// markdownToAdf takes: paragraphs, "## " headings and "- " lists. Never JSON, never a plan
// file's field name (builder:, test_plan, done_when, owner_question, needs_owner), never a
// FACTORY_RESULT line.
//
//   renderNote(entry, { config, previousDesign, detail }) -> { title, summary, body } | null
//       entry is { kind, data } (the queue's entry); kinds: decision, answer, design, round,
//       session, release, follow-up. The title is lower case ("Foreman: " is added by the story
//       source); null for a kind it does not know, or a revised design with nothing changed.
//       detail is 'summary' (findings counted) or 'full' (each listed). A round's data may hold
//       `waiting`, the engine reviewers whose verdict is still to come: an approved round then
//       says so and is not titled "round N approved"
//   sessionEnding({ stop, watchdog, cause, resetAt, next, kept, reason, session })
//       the data of a session note, or null when the note is not worth writing (the story had
//       ended already, or nothing is known to have gone wrong)
//   clean(text, { roots, home, env, values }) -> text
//       every known secret value (the env's, longest first, and `values`), then the looks-secret
//       patterns (state.mjs redact); each `<root>/` dropped, `<home>/` made `~/`; every
//       FACTORY_RESULT line removed. Applied to every string that goes out
//   footer(at, slot) -> "At 2026-10-31 14:05 UTC, slot w2."
//   machineText(text) -> why the text looks machine-made, or null (JSON, a plan field name or a
//       FACTORY_RESULT line); the tests use it

import { redact as redactValues } from '../secrets/redact.mjs';
import { redact } from './state.mjs';
import { designData } from './story-notes-queue.mjs';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// "a", "a and b", "a, b and c"
const words = (items) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const stop = (s) => {
  const t = text(s).trim();
  return t === '' || /[.!?]$/.test(t) ? t : `${t}.`;
};
// The first letter lower case, unless the word is a name or an acronym (CLAUDE.md, ACME-1).
const lower = (s) => (/^[A-Z][a-z]/.test(s) ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s);

// ---- the plan, as the design note sees it ----

const lines = (s) => text(s).split('\n').map((l) => l.trim()).filter(Boolean);
const bullets = (items) => items.map((i) => `- ${i}`).join('\n');
const section = (heading, body) => (text(body).trim() === '' ? '' : `## ${heading}\n\n${body.trim()}`);

const STORY_IDS = /^[A-Z][A-Z0-9_]+-\d+(?:\s*,\s*[A-Z][A-Z0-9_]+-\d+)*/;
const LAND_FIRST = /^(?:(?:must|need(?:s)? to|have to|has to|should)\s+(?:be\s+)?(?:land|ship|merge|finish|complete)\w*(?:\s+first)?)\b[\s.:;,-]*/i;

// "ACME-1, ACME-2 must land first" -> "It waits for ACME-1, ACME-2 to land first."
function blockerWords(blocker) {
  const t = text(blocker).trim();
  const ids = STORY_IDS.exec(t);
  if (!ids) return stop(t);
  const rest = t.slice(ids[0].length).replace(/^[\s:;,.\-–—]+/, '').replace(LAND_FIRST, '').trim();
  return [`It waits for ${ids[0].replace(/\s*,\s*/g, ', ')} to land first.`, rest ? stop(capital(rest)) : ''].filter(Boolean).join(' ');
}

const optionLines = (options, recommend) =>
  bullets(options.map((o) => `${o.label}${o.label === recommend ? ' (recommended)' : ''}${o.hint ? `: ${o.hint}` : ''}`));

function questionWords(q) {
  if (!q) return '';
  return [`It asks the owner: ${stop(q.summary)}`, q.options.length ? optionLines(q.options, q.recommend) : ''].filter(Boolean).join('\n\n');
}

function designBody(d) {
  const blocked = d.ready
    ? ''
    : section('Why it cannot be built yet', [blocker(d), questionWords(d.owner_question)].filter(Boolean).join('\n\n'));
  return [
    section('The design', d.design || 'The architect gave no design text.'),
    section('How it will be tested', d.test_plan),
    section('Done when', d.done_when),
    section('Files it expects to change', bullets(d.files)),
    section('What it needs for itself', bullets(d.resources)),
    blocked,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const blocker = (d) => (d.blocker.trim() ? blockerWords(d.blocker) : 'It cannot be built yet.');

const CAP = 30;
// The trimmed non-empty lines in `a` and not in `b`, in order, at most CAP then "…and N more lines".
function onlyIn(a, b) {
  const other = new Set(lines(b));
  const seen = new Set();
  const out = [];
  for (const l of lines(a)) {
    if (other.has(l) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out.length > CAP ? [...out.slice(0, CAP), `…and ${out.length - CAP} more lines`] : out;
}

// The design keeps the headings the note promises; its other two long parts say which they are.
const PARTS = [
  ['design', 'the design'],
  ['test_plan', 'the test plan'],
  ['done_when', 'the done-when line'],
];

function revisedBody(now, before) {
  const out = [];
  if (now.builder !== before.builder) out.push(`The builder is now ${now.builder || 'not chosen'} (it was ${before.builder || 'not chosen'}).`);
  const added = now.files.filter((f) => !before.files.includes(f));
  const dropped = before.files.filter((f) => !now.files.includes(f));
  if (added.length) out.push(`It will now also change ${words(added)}.`);
  if (dropped.length) out.push(`It will no longer change ${words(dropped)}.`);
  const needed = now.resources.filter((r) => !before.resources.includes(r));
  const freed = before.resources.filter((r) => !now.resources.includes(r));
  if (needed.length) out.push(`It now also needs ${words(needed)} for itself.`);
  if (freed.length) out.push(`It no longer needs ${words(freed)} for itself.`);
  if (now.ready && !before.ready) out.push('It can now be built.');
  if (!now.ready && before.ready) out.push(`It can no longer be built: ${blocker(now)}`);
  const head = out.length ? [out.join('\n')] : [];
  const diffs = [];
  for (const [key, phrase] of PARTS) {
    const plus = onlyIn(now[key], before[key]);
    const minus = onlyIn(before[key], now[key]);
    if (plus.length) diffs.push(section(`Added to ${phrase}`, bullets(plus)));
    if (minus.length) diffs.push(section(`Taken out of ${phrase}`, bullets(minus)));
  }
  return [...head, ...diffs].join('\n\n');
}

function renderDesign(data, { config, previousDesign }) {
  const d = designData(data);
  if (previousDesign) {
    const before = designData(previousDesign);
    if (JSON.stringify(before) === JSON.stringify(d)) return null;
    return { title: 'design (revised)', summary: 'The architect revised the design.', body: revisedBody(d, before) || 'The design was revised.' };
  }
  const use = text(config?.roles?.builders?.[d.builder]?.use).trim();
  const chose = d.builder ? `The architect chose the ${d.builder} builder` : 'The architect chose no builder';
  return { title: 'design', summary: `${chose}${use ? `, whose work is: ${use}` : ''}.`, body: designBody(d) };
}

// ---- decisions and answers ----

function renderDecision(d) {
  const options = list(d.options);
  const hints = list(d.hints);
  const lines = [
    d.urgent === true ? 'It is urgent.' : '',
    options.length ? ['The options:', bullets(options.map((o, i) => `${o}${o === d.recommend ? ' (recommended)' : ''}${hints[i] ? `: ${hints[i]}` : ''}`))].join('\n\n') : '',
  ].filter(Boolean);
  return {
    title: `${d.kind === 'task' ? 'the owner was asked to do' : 'the owner was asked'}: ${text(d.title)}`,
    summary: text(d.summary),
    body: lines.join('\n\n'),
  };
}

function renderAnswer(d) {
  const note = text(d.note);
  const chose = text(d.option);
  return {
    title: `the owner answered: ${text(d.title)}`,
    summary: chose ? `They chose "${chose}".` : `Their answer: "${note}"`,
    body: chose && note ? `Their note: "${note}"` : '',
  };
}

// ---- rounds ----

const REVIEWER_STAGES = new Set(['build', 'checks', 'merge', 'release']);
const whoWords = (stage) => {
  const s = text(stage);
  if (s === 'test' || s === 'tester') return 'tester';
  if (REVIEWER_STAGES.has(s)) return s;
  return /reviewer$/i.test(s) ? s : `${s || 'a'} reviewer`;
};

// "file:42" -> "file, line 42"; '-' and '' are left out.
function whereWords(where) {
  const w = text(where).trim();
  if (w === '' || w === '-') return '';
  const m = /^(.*?):(\d+)(?:-\d+)?$/.exec(w);
  return m ? `${m[1]}, line ${m[2]}` : w;
}

function findingLine(f) {
  const who = whoWords(f.stage);
  const where = whereWords(f.where);
  const rule = text(f.rule).trim();
  const found = rule ? `The ${who} found that ${lower(rule)}` : `The ${who} found a problem`;
  const seen = stop(f.observed);
  const fix = text(f.fix).trim();
  return `- (${text(f.severity) || 'finding'}) ${found}${where ? ` (${where})` : ''}${seen ? `: ${seen}` : '.'}${fix ? ` Fix: ${stop(fix)}` : ''}`;
}

const SEVERITIES = ['blocker', 'major', 'minor'];
const countWords = (findings) =>
  words(
    SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])
      .filter(([, n]) => n > 0)
      .map(([s, n]) => (s === 'blocker' ? plural(n, 'blocker') : `${n} ${s}`)),
  );

const reviewerWords = (stages) => words(list(stages).map((s) => `the ${whoWords(s)}`));

function renderRound(d, { detail }) {
  const findings = (Array.isArray(d.findings) ? d.findings : []).filter(isPlain);
  const full = detail === 'full';
  const minor = findings.filter((f) => f.severity === 'minor');
  if (d.approved === true) {
    const left = minor.length ? ` ${capital(plural(minor.length, 'minor finding'))} ${minor.length === 1 ? 'is' : 'are'} left for later.` : '';
    const waiting = list(d.waiting);
    if (waiting.length) {
      const who = reviewerWords(d.stages) || 'the reviewers';
      const names = waiting.map((n) => `the ${whoWords(n)}`);
      const pending = waiting.length === 1
        ? `${capital(names[0])} reviews it outside this session; its verdict is still to come.`
        : `${capital(words(names))} review it outside this session; their verdicts are still to come.`;
      return {
        title: `round ${d.round}: ${who} approved`,
        summary: `${capital(who)} approved the change. ${pending}${full ? '' : left}`,
        body: full && minor.length ? ['Minor findings left for later:', minor.map(findingLine).join('\n')].join('\n\n') : '',
      };
    }
    return {
      title: `round ${d.round} approved`,
      summary: `${capital(reviewerWords(d.stages) || 'The reviewers')} approved the change.${full ? '' : left}`,
      body: full && minor.length ? ['Minor findings left for later:', minor.map(findingLine).join('\n')].join('\n\n') : '',
    };
  }
  const blocking = findings.filter((f) => f.severity !== 'minor');
  const senders = [...new Set(blocking.map((f) => `the ${whoWords(f.stage)}`))];
  const sent = `${capital(words(senders) || 'The reviewers')} sent it back`;
  const summary = findings.length ? `${sent} with ${plural(findings.length, 'finding')}: ${countWords(findings)}.` : `${sent}.`;
  return {
    title: `round ${d.round} sent back`,
    summary,
    body: full && findings.length ? findings.map(findingLine).join('\n') : '',
  };
}

// ---- session endings ----

const CAUSES = ['signin', 'api-credit', 'credit', 'rate-limit', 'outage'];
const WATCHDOG_WHY = { 'too-long': 'too-long', quiet: 'quiet', ceiling: 'ceiling' };

export function sessionEnding({ stop: how = null, watchdog = null, cause = null, resetAt = null, next = null, kept = [], reason = '', session = null } = {}) {
  if (watchdog === 'ended-quiet' || watchdog === 'ended-alive') return null;
  const resumes = next === 'resume' || next === 'parked';
  if (!how && !cause && !resumes) return null;
  let why = 'crash';
  if (how === 'watchdog' && Object.hasOwn(WATCHDOG_WHY, watchdog ?? '')) why = WATCHDOG_WHY[watchdog];
  else if (CAUSES.includes(cause)) why = cause;
  return { why, next, kept: list(kept), resetAt: resetAt ?? null, reason: text(reason), session: session ?? null };
}

const WHY_WORDS = {
  'too-long': 'The watchdog stopped it because there was no progress for too long (no stage change and no agent starting or finishing).',
  quiet: 'The watchdog stopped it because it was quiet for too long.',
  ceiling: 'The watchdog stopped it because it hit the hard limit.',
  crash: 'It ended without reporting a result.',
  signin: 'The Claude sign-in stopped working.',
  'api-credit': 'The Console API key ran out of credit.',
  'rate-limit': 'The Claude API was rate limited.',
  outage: 'The Claude API was down or overloaded.',
};

// "architect:ACME-1" -> "the design", "test:ACME-1#1" -> "the tester's approval in round 1".
function keptWords(label) {
  const colon = label.indexOf(':');
  const name = colon === -1 ? label : label.slice(0, colon);
  const round = /#(\d+)\s*$/.exec(label)?.[1];
  if (name === 'architect') return 'the design';
  if (name === 'build' || name === 'fix') return 'the build';
  if (name === 'test') return `the tester's approval${round ? ` in round ${round}` : ''}`;
  return `the ${name} review${round ? ` in round ${round}` : ''}`;
}

function renderSession(d) {
  const why = d.why === 'credit' ? `The usage limit was reached${d.resetAt ? `, and it resets ${d.resetAt}` : ''}.` : (WHY_WORDS[d.why] ?? WHY_WORDS.crash);
  let next = '';
  if (d.next === 'resume') {
    const kept = [...new Set(list(d.kept).map(keptWords))];
    next = kept.length ? `It will resume, keeping ${words(kept)}.` : 'It will resume.';
  } else if (d.next === 'parked') next = `The slot is parked: ${stop(d.reason) || 'it waits for the owner.'}`;
  else if (d.next === 'held') next = 'Its commit is kept and it waits for the Claude API.';
  // One paragraph: a story source that keeps one line per note shows all of it.
  return { title: 'the session stopped', summary: [why, next].filter(Boolean).join(' '), body: '' };
}

// ---- releases and follow-ups ----

const RELEASE_WORDS = {
  2: 'CI or the checks on the merged code failed, so nothing was merged.',
  4: 'The migration failed, and releases are frozen until the owner clears the halt.',
  5: 'The deploy, or a step after the point of no return, failed, and releases are frozen.',
  6: 'The branch conflicts with the base branch.',
  10: 'The owner must allow metadata deletes before this can be released.',
};

function renderRelease(d) {
  const what = RELEASE_WORDS[d.code] ?? `The release step ${text(d.stage) || 'it was on'} failed.`;
  const reason = text(d.reason).trim();
  const pr = text(d.pr).trim();
  return {
    title: 'the release stopped',
    // The reason is in the summary, so a source that keeps one line per note shows it.
    summary: [what, reason ? `The reason given: ${stop(reason)}` : ''].filter(Boolean).join(' '),
    body: pr ? `The pull request: ${pr}` : '',
  };
}

function renderFollowUp(d) {
  return { title: 'follow-up created', summary: `Foreman created ${text(d.id)} (${text(d.title)}) for the minor findings this story left.`, body: '' };
}

export function renderNote(entry, { config, previousDesign = null, detail = 'summary' } = {}) {
  const d = isPlain(entry?.data) ? entry.data : {};
  switch (entry?.kind) {
    case 'decision':
      return renderDecision(d);
    case 'answer':
      return renderAnswer(d);
    case 'design':
      return renderDesign(d, { config, previousDesign });
    case 'round':
      return renderRound(d, { detail });
    case 'session':
      return renderSession(d);
    case 'release':
      return renderRelease(d);
    case 'follow-up':
      return renderFollowUp(d);
    default:
      return null;
  }
}

// ---- what goes out ----

const FACTORY_RESULT = /^\s*FACTORY_RESULT:/;
const usable = (p) => typeof p === 'string' && p.length > 1 && p.startsWith('/');
const trimSlash = (p) => p.replace(/\/+$/, '');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function clean(input, { roots = [], home = '', env = {}, values = [] } = {}) {
  const known = [...values].filter((v) => typeof v === 'string' && v !== '').sort((a, b) => b.length - a.length);
  let out = redact(redactValues(String(input ?? ''), { env, values: known }));
  const tops = [...new Set(roots.filter(usable).map(trimSlash))].sort((a, b) => b.length - a.length);
  for (const top of tops) out = out.split(`${top}/`).join('').replace(new RegExp(`${escape(top)}(?![\\w.-])`, 'g'), '.');
  if (usable(home)) {
    const own = trimSlash(home);
    out = out.split(`${own}/`).join('~/').replace(new RegExp(`${escape(own)}(?![\\w.-])`, 'g'), '~');
  }
  return out
    .split('\n')
    .filter((l) => !FACTORY_RESULT.test(l))
    .join('\n');
}

const pad = (n) => String(n).padStart(2, '0');

export function footer(at, slot = null) {
  const d = at instanceof Date ? at : new Date(at);
  const when = Number.isNaN(+d) ? 'an unknown time' : `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `At ${when} UTC${slot ? `, slot ${slot}` : ''}.`;
}

const PLAN_FIELDS = /\b(?:test_plan|done_when|owner_question|needs_owner)\b|^\s*(?:builder|blocker|ready|resources|files|design)\s*:/m;

// The end of the JSON value that starts at `at` (a { or [), or -1: brackets matched outside strings.
function jsonEnd(s, at) {
  const stack = [];
  let inString = false;
  for (let i = at; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

export function machineText(input) {
  const s = String(input ?? '');
  if (/^\s*FACTORY_RESULT:/m.test(s) || /FACTORY_RESULT/.test(s)) return 'it holds a FACTORY_RESULT line';
  const field = PLAN_FIELDS.exec(s);
  if (field) return `it names a plan field (${field[0].trim()})`;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '{' && s[i] !== '[') continue;
    const end = jsonEnd(s, i);
    if (end === -1) continue;
    try {
      const v = JSON.parse(s.slice(i, end + 1));
      if (v !== null && typeof v === 'object') return 'it holds JSON';
    } catch {
      // brackets in prose
    }
  }
  return null;
}
