// The learning loop: findings that keep stopping stories become proposed traits, and the minor
// findings a story shipped with become a proposed follow-up story. Pure; the `foreman learn`
// command reads the files and asks the owner.
//
// A finding line in <stateDir>/findings.jsonl is { at, story, result, builder?, stage,
// severity, rule, where, observed, fix, round?, resolved? }. `round` and `resolved: true` mark a
// finding a build round sent back and the builder then fixed; it counts like any other line.
// Only blocker and major findings count. They are
// grouped by builder (lines without one go under "all") and by the rule, normalised, and a
// group seen on at least `minStories` different stories becomes a proposal. Each question
// also gets a one-line summary (traitSummary, followUpSummary) of at most 160 characters, and
// a trait proposal is said in plain words for the owner (traitExplain, traitHints). The note
// about follow-up stories Foreman created itself has its own title and summary (createdTitle,
// createdSummary).

export const SERIOUS = ['blocker', 'major'];

const QUOTES = `"'\`“”‘’`;
const LEADING = new RegExp(`^[${QUOTES}]+`);
const TRAILING = new RegExp(`[\\s.,;:!?${QUOTES}]+$`);

// Spaces collapsed, quotes and trailing punctuation gone; case kept.
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().replace(LEADING, '').replace(TRAILING, '').trim();

export const normaliseRule = (text) => clean(text).toLowerCase();

export const keyOf = (builder, rule) => `${builder || 'all'}::${normaliseRule(rule)}`;

// One object per JSON line; a line that does not parse is left out.
export function parseFindings(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === 'object') out.push(item);
    } catch {
      // a torn or hand-edited line
    }
  }
  return out;
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').toLowerCase();

// The most common value by its normalised form, shown as first written.
export function mostCommon(values) {
  const counts = new Map();
  for (const v of values) {
    const k = normaliseRule(v);
    if (!k) continue;
    const seen = counts.get(k) ?? { n: 0, first: clean(v) };
    seen.n += 1;
    counts.set(k, seen);
  }
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  return best?.first ?? '';
}

export function traitText(rule, fix) {
  const head = capitalise(clean(rule));
  return fix ? `${head} (the usual fix: ${fix}).` : `${head}.`;
}

// [{ key, builder, rule, stories, examples, trait }], most stories first.
export function proposals(findingsLines, { ignored = [], existingTraits = {}, minStories = 3 } = {}) {
  const skip = new Set(ignored);
  const groups = new Map();
  for (const raw of findingsLines ?? []) {
    let f = raw;
    if (typeof raw === 'string') {
      try {
        f = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    if (!f || typeof f !== 'object') continue;
    if (!SERIOUS.includes(String(f.severity ?? '').toLowerCase())) continue;
    const rule = normaliseRule(f.rule);
    const story = typeof f.story === 'string' ? f.story.trim() : '';
    if (!rule || !story) continue;
    const builder = typeof f.builder === 'string' && f.builder.trim() ? f.builder.trim() : 'all';
    const key = keyOf(builder, rule);
    const g = groups.get(key) ?? { key, builder, rule, norm: rule, rules: [], fixes: [], stories: [], examples: [] };
    g.rules.push(f.rule);
    if (f.fix) g.fixes.push(f.fix);
    if (!g.stories.includes(story)) {
      g.stories.push(story);
      if (g.examples.length < 3) g.examples.push({ story, where: f.where ?? '', fix: f.fix ?? '' });
    }
    groups.set(key, g);
  }

  const out = [];
  for (const g of groups.values()) {
    if (g.stories.length < minStories || skip.has(g.key)) continue;
    const known = [existingTraits[g.builder], existingTraits.all].filter(Boolean).map(flat);
    if (known.some((text) => text.includes(g.norm))) continue;
    const rule = capitalise(mostCommon(g.rules));
    out.push({ key: g.key, builder: g.builder, rule, stories: g.stories, examples: g.examples, trait: traitText(rule, mostCommon(g.fixes)) });
  }
  return out.sort((a, b) => b.stories.length - a.stories.length || a.key.localeCompare(b.key));
}

// ---- follow-ups: the minor findings a story shipped with become a proposed story ----

export const followUpKey = (story, rule) => `followup:${story}:${normaliseRule(rule)}`;

// [{ story, keys, findings: [{ rule, where, observed, fix }] }], one per shipped story that
// has minor findings not yet `seen` (ledger keys) and not covered by an existing story's
// title (a rough duplicate guard: the title, normalised, contains the rule). Stories in
// the order their findings first appear; one finding per rule within a story.
export function followUps(findingsLines, { seen = [], titles = [] } = {}) {
  const skip = new Set(seen);
  const covered = titles.map(normaliseRule).filter(Boolean);
  const byStory = new Map();
  for (const f of findingsLines ?? []) {
    if (!f || typeof f !== 'object') continue;
    if (String(f.severity ?? '').toLowerCase() !== 'minor' || f.result !== 'shipped') continue;
    const story = typeof f.story === 'string' ? f.story.trim() : '';
    const rule = normaliseRule(f.rule);
    if (!story || !rule) continue;
    const key = followUpKey(story, rule);
    if (skip.has(key) || covered.some((t) => t.includes(rule))) continue;
    const p = byStory.get(story) ?? { story, keys: [], findings: [] };
    if (p.keys.includes(key)) continue;
    p.keys.push(key);
    p.findings.push({ rule: capitalise(clean(f.rule)), where: clean(f.where), observed: clean(f.observed), fix: clean(f.fix) });
    byStory.set(story, p);
  }
  return [...byStory.values()];
}

export const followUpTitle = (p) => `Follow up on ${p.story}: ${p.findings.length} minor finding(s)?`;

// The findings as a markdown list: rule (`where`): observed — fix: fix.
export const followUpWhat = (p) =>
  p.findings.map((f) => `- ${f.rule}${f.where ? ` (\`${f.where}\`)` : ''}${f.observed ? `: ${f.observed}` : ''}${f.fix ? ` — fix: ${f.fix}` : ''}`).join('\n');

// ---- one-line summaries for the owner's questions, at most 160 characters ----

const SUMMARY_MAX = 160;

// Cut at the last space after the head (the first `from` characters) that leaves room for
// "…"; with no such space, hard-cut at max-1 without splitting a character.
function cutAtWord(text, max = SUMMARY_MAX, from = 0) {
  if (text.length <= max) return text;
  let room = '';
  for (const ch of text) {
    if (room.length + ch.length > max - 1) break;
    room += ch;
  }
  const space = room.lastIndexOf(' ');
  if (space > from) return `${room.slice(0, space).replace(/[\s,;:]+$/, '')}…`;
  return `${room}…`;
}

// "LoadConfig can throw" reads "loadConfig can throw"; "CSRF token missing" stays as it is.
const lowerFirst = (s) => (/^.[A-Z]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

// "3 minor: loadConfig can throw; a test passes without the fix; …", whole rules while they
// fit, then "; and N more". When even the first rule alone is too long, it is cut (never into
// the "N minor: " head) so the line, with its "; and N more", stays within 160 characters.
export function followUpSummary(p) {
  const rules = p.findings.map((f) => lowerFirst(clean(f.rule)));
  const head = `${p.findings.length} minor: `;
  for (let shown = rules.length; shown >= 1; shown -= 1) {
    const left = rules.length - shown;
    const line = `${head}${rules.slice(0, shown).join('; ')}${left ? `; and ${left} more` : ''}`;
    if (line.length <= SUMMARY_MAX) return line;
  }
  const left = rules.length - 1;
  const tail = left ? `; and ${left} more` : '';
  return cutAtWord(`${head}${rules[0] ?? ''}`, SUMMARY_MAX - tail.length, head.length) + tail;
}

// "S-1", "S-1 and S-2", "S-1, S-2 and S-3", or "S-1, S-2 and 3 more" past three.
function storyIds(stories) {
  const n = stories.length;
  if (n > 3) return `${stories.slice(0, 2).join(', ')} and ${n - 2} more`;
  if (n > 1) return `${stories.slice(0, -1).join(', ')} and ${stories.at(-1)}`;
  return stories.join('');
}

// ---- follow-up stories Foreman created itself (features.autoCreateFollowUps) ----

export const createdTitle = (n) => `Foreman created ${n} follow-up ${n === 1 ? 'story' : 'stories'}`;

// "F-1 and F-2 to fix the minor findings of S-3 and S-4", from [{ id, story }], at most 160
// characters; past three ids, "F-1, F-2 and N more".
export function createdSummary(stories) {
  const list = Array.isArray(stories) ? stories : [];
  const origins = [...new Set(list.map((s) => s.story))];
  return cutAtWord(`${storyIds(list.map((s) => s.id))} to fix the minor findings of ${storyIds(origins)}`);
}

// "Stopped 3 stories for developer: S-1, S-2 and S-3", or "S-1, S-2 and 3 more" past three.
export function traitSummary(p) {
  const n = p.stories.length;
  return cutAtWord(`Stopped ${n} stories for ${p.builder === 'all' ? 'the builders' : p.builder}: ${storyIds(p.stories)}`);
}

// ---- a trait proposal in plain words, for the owner (decisions.mjs explain and hints) ----

const EXPLAIN_MAX = 280;
const HINT_MAX = 100;
const whoBuilds = (p) => (p.builder === 'all' ? 'every builder' : `the ${p.builder} builder`);

// { purpose, happened, recommendation }, each at most 280 characters: a trait is about how a
// builder works on every story, not about the one story it is filed under.
export function traitExplain(p) {
  const n = p.stories.length;
  return {
    purpose: cutAtWord(`This is not about one story: it changes how ${whoBuilds(p)} works on every story.`, EXPLAIN_MAX),
    happened: cutAtWord(`The same problem stopped ${n} ${n === 1 ? 'story' : 'stories'} (${storyIds(p.stories)}), so Foreman wrote it up as a rule.`, EXPLAIN_MAX),
    recommendation: cutAtWord('Add as a trait: the same problem keeps coming back, and a written rule catches it while the story is built instead of at review.', EXPLAIN_MAX),
  };
}

// One hint per TRAIT_OPTIONS (Add as a trait, Ignore), each at most 100 characters.
export function traitHints(p) {
  const who = whoBuilds(p);
  return [
    cutAtWord(`From now on ${who} follows this rule on every story.`, HINT_MAX),
    'Nothing changes, and Foreman does not suggest this rule again.',
  ];
}

// "Done when" for a follow-up story, naming the checks that always run.
export function followUpDoneWhen(checks) {
  const always = (checks ?? []).filter((c) => c?.when === 'always' && c.run).map((c) => `\`${c.run}\``);
  const pass = always.length === 0 ? "the project's checks pass" : always.length === 1 ? `${always[0]} passes` : `${always.slice(0, -1).join(', ')} and ${always.at(-1)} pass`;
  return `Each listed finding is fixed, with a test where it is a behaviour, and ${pass}.`;
}

// The supervisor's event for what `foreman learn` printed, or null when it proposed and created
// nothing.
export function learnEvent(stdout) {
  const text = String(stdout ?? '');
  const traits = /Proposed (\d+) trait\(s\) from repeated findings/.exec(text);
  const created = /Created (\d+) follow-up story\(s\) from minor findings/.exec(text);
  const follow = /Proposed (\d+) follow-up\(s\) from minor findings/.exec(text);
  const parts = [];
  if (traits && Number(traits[1]) > 0) parts.push(`Proposed ${traits[1]} trait(s) from repeated findings`);
  if (created && Number(created[1]) > 0) parts.push(`${parts.length ? 'created' : 'Created'} ${created[1]} follow-up story(s) from minor findings`);
  if (follow && Number(follow[1]) > 0) parts.push(`${parts.length ? 'proposed' : 'Proposed'} ${follow[1]} follow-up(s) from minor findings`);
  return parts.length ? parts.join('; ') : null;
}
