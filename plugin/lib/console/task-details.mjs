// What an owner task asks of the owner, read from its brief or story file: the sections
// headed "What you need", "Steps", "Effort" (or "Takes") and "Done when", at any heading
// level. taskDetails(markdown) -> { need: string[], steps: string[], effort, doneWhen }.
//
// Everything else is ignored: other headings and headings inside ``` or ~~~ fences. Reading
// stops at the first "Comments" or "Progress notes" heading, at any level: Foreman always
// writes those sections last, and their text comes from outside, so nothing after them can
// add a section. A section runs to the next heading of any level; when a name is there twice
// the first wins. A body that is one line in underscores (writeBrief's "_Not given in the
// issue._") counts as empty. need and steps are list items, or paragraphs
// when there is no list; effort and doneWhen are their lines joined into one. Pure: anything
// that is not a string gives all four empty.
//
// The text is outside input (a Jira description and its comments, or a story file) parsed on
// the dashboard's event loop, so every match here runs in linear time: no pattern can
// backtrack over a long run, titles are trimmed by index, only the first 256 KB is read, and a
// line over 500 characters is never a heading.

const MAX_TEXT = 256 * 1024;
const MAX_HEADING = 500;
// The `s` flag lets the last `.*` take the rest of the line, so `$` always matches at once.
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/s;
const FENCE = /^\s*(```|~~~)/;
const LIST = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/s;
const NAMES = { 'what you need': 'need', steps: 'steps', effort: 'effort', takes: 'effort', 'done when': 'doneWhen' };
const SKIPPED = new Set(['comments', 'progress notes']);

// A heading's title without its closing run of #, which counts only after a space or tab.
function titleOf(raw = '') {
  const t = raw.trimEnd();
  let i = t.length;
  while (i > 0 && t[i - 1] === '#') i--;
  return i < t.length && (i === 0 || t[i - 1] === ' ' || t[i - 1] === '\t') ? t.slice(0, i).trimEnd() : t;
}

const MARKS = new Set(['*', '_', ' ']);
function trimMarks(s) {
  let a = 0;
  let b = s.length;
  while (a < b && MARKS.has(s[a])) a++;
  while (b > a && MARKS.has(s[b - 1])) b--;
  return s.slice(a, b);
}

// Lowercase, spaces collapsed, surrounding * or _ and a trailing colon dropped.
function nameOf(title) {
  const s = trimMarks(title.toLowerCase().replace(/\s+/g, ' '));
  let b = s.length;
  while (b > 0 && s[b - 1] === ':') b--;
  return trimMarks(s.slice(0, b));
}

function items(lines) {
  const out = [];
  if (lines.some((l) => LIST.test(l))) {
    let current = null;
    for (const line of lines) {
      const m = LIST.exec(line);
      if (m) out.push((current = [m[1]]));
      else if (line.trim() && current) current.push(line.trim());
    }
  } else {
    let current = null;
    for (const line of lines) {
      if (!line.trim()) current = null;
      else if (current) current.push(line.trim());
      else out.push((current = [line.trim()]));
    }
  }
  return out.map((parts) => parts.join(' ').trim()).filter(Boolean);
}

const oneLine = (lines) =>
  lines
    .filter((l) => l.trim())
    .map((l) => LIST.exec(l)?.[1] ?? l)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

export function taskDetails(markdown) {
  const found = {};
  if (typeof markdown === 'string') {
    let fence = false;
    let current = null; // the lines of the section being read
    for (const line of markdown.slice(0, MAX_TEXT).split(/\r?\n/)) {
      if (FENCE.test(line)) fence = !fence;
      const h = fence || FENCE.test(line) || line.length > MAX_HEADING ? null : HEADING.exec(line);
      if (h) {
        const name = nameOf(titleOf(h[2]));
        current = null;
        if (SKIPPED.has(name)) break;
        const key = NAMES[name];
        if (key && !Object.hasOwn(found, key)) current = found[key] = [];
        continue;
      }
      if (current) current.push(line);
    }
  }
  const body = (key) => {
    const lines = found[key] ?? [];
    const filled = lines.filter((l) => l.trim());
    return filled.length === 1 && /^_[^\n]*_$/.test(filled[0].trim()) ? [] : lines;
  };
  return { need: items(body('need')), steps: items(body('steps')), effort: oneLine(body('effort')), doneWhen: oneLine(body('doneWhen')) };
}
