// When a pause for the Claude usage limit or an empty balance ends by itself. A credit pause
// records when to try again (the reset time Claude printed, else an hour on); once that passes the
// supervisor runs the one-turn sign-in probe, and clears the pause only when Claude answers. A
// failed probe tries again after CREDIT_RETRY_MS. Pure: no file, no clock (the caller passes `now`
// in ms) and no import of state.mjs, so each rule has a test.
//
//   CREDIT_WAIT_MS     the wait when no reset time is known (an hour)
//   CREDIT_RETRY_MS    the wait between probes that fail (30 minutes)
//   MAX_RESET_AHEAD_MS a reset time further ahead than this (35 days) is not believed
//   creditRetryMs      the retry wait from FOREMAN_CREDIT_RETRY_MS (for tests): shorter, never longer
//   resetTime          a reset time in Claude's words as ms, or null: the Console's "2026-11-01 at
//                      00:00 UTC", or a clock time such as "3pm (Europe/London)", "Fri 6pm
//                      (Europe/London)", "Nov 7, 6pm (Europe/London)", "18:00 UTC"; null for text
//                      longer than 80 characters
//   resumeAtFor        when the pause tries again, as an ISO string: the reset time, else now + an hour
//   creditProbeDue     is it time to probe (a pause with a resume time that has come, nothing running)?
//   afterCreditProbe   what the probe's answer means: clear the pause (one good event), or keep it
//                      and try again later; never touches a pause that is gone, changed, or has no
//                      resume time (the owner's, or another reason's)
//   retryWhen          the retry time in words: 'HH:MM' today, else 'YYYY-MM-DD HH:MM'
//   retrySentence      "Foreman tries again at ... by itself."

import { hhmm, localStamp } from './claude-fallback.mjs';

export const CREDIT_WAIT_MS = 60 * 60_000;
export const CREDIT_RETRY_MS = 30 * 60_000;
export const MAX_RESET_AHEAD_MS = 35 * 24 * 60 * 60_000;
// The shortest retry FOREMAN_CREDIT_RETRY_MS can set.
const MIN_CREDIT_RETRY_MS = 1000;
// Longer text is not a reset time (the longest real form is well under this), and the patterns below
// are quadratic on long runs of spaces or dots.
const MAX_RESET_TEXT = 80;

export function creditRetryMs(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return CREDIT_RETRY_MS;
  return Math.max(MIN_CREDIT_RETRY_MS, Math.min(CREDIT_RETRY_MS, Number(value)));
}

const DATE_FORM = /^(\d{4})-(\d{2})-(\d{2})(?:\s+at)?\s+(\d{1,2}):(\d{2})(?:\s*\(?(UTC|GMT|Z)\)?)?$/i;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CLOCK_FORM = new RegExp(
  `^(?:(?<weekday>${DAYS.join('|')})[a-z]*,?\\s+|(?<month>${MONTHS.join('|')})[a-z]*\\.?\\s+(?<day>\\d{1,2})(?:st|nd|rd|th)?,?\\s+)?` +
    '(?:at\\s+)?(?<hour>\\d{1,2})(?::(?<minute>\\d{2}))?\\s*(?<ampm>am|pm)?' +
    '(?:\\s*\\(\\s*(?<zone>[A-Za-z0-9_+\\-/]+)\\s*\\)|\\s+(?<bare>UTC|GMT))?$',
  'i',
);

const machineZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

// The wall clock of `ms` in `zone` as numbers; throws RangeError for an unknown zone.
function wallOf(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(ms));
  const n = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { year: n('year'), month: n('month'), day: n('day'), hour: n('hour') % 24, minute: n('minute'), second: n('second') };
}

// How far ahead of UTC the zone's wall clock is at `ms`.
function offset(ms, zone) {
  const w = wallOf(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// The instant the zone's wall clock reads y-m-d h:mi; the second pass settles a daylight-saving jump.
function wallToUtc(y, m, d, h, mi, zone) {
  const guess = Date.UTC(y, m, d, h, mi);
  const first = guess - offset(guess, zone);
  return guess - offset(first, zone);
}

function fromDateForm(m) {
  const [, y, mo, d, h, mi] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  return new Date(ms).getUTCMonth() === mo - 1 ? ms : null;
}

function fromClockForm(g, nowMs) {
  const hour = Number(g.hour);
  const minute = g.minute === undefined ? 0 : Number(g.minute);
  const ampm = g.ampm?.toLowerCase();
  if (!ampm && g.minute === undefined) return null;
  if (minute > 59) return null;
  let h = hour;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    h = (hour % 12) + (ampm === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const zoneText = g.zone ?? g.bare;
  const zone = !zoneText ? machineZone() : /^(utc|gmt|z)$/i.test(zoneText) ? 'UTC' : zoneText;
  let today;
  try {
    today = wallOf(nowMs, zone);
  } catch {
    return null;
  }
  const at = (dayOffset, y = today.year, mo = today.month - 1, d = today.day) => {
    const date = new Date(Date.UTC(y, mo, d + dayOffset));
    return wallToUtc(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, minute, zone);
  };

  if (g.weekday) {
    const want = DAYS.indexOf(g.weekday.toLowerCase());
    for (let i = 0; i <= 7; i++) {
      const dow = new Date(Date.UTC(today.year, today.month - 1, today.day + i)).getUTCDay();
      const t = at(i);
      if (dow === want && t > nowMs) return t;
    }
    return null;
  }
  if (g.month) {
    const mo = MONTHS.indexOf(g.month.toLowerCase());
    const d = Number(g.day);
    if (d < 1 || d > 31 || new Date(Date.UTC(today.year, mo, d)).getUTCMonth() !== mo) return null;
    const thisYear = at(0, today.year, mo, d);
    return nowMs - thisYear > 24 * 60 * 60_000 ? at(0, today.year + 1, mo, d) : thisYear;
  }
  const t = at(0);
  return t <= nowMs ? at(1) : t;
}

export function resetTime(text, nowMs) {
  if (typeof text !== 'string' || text.length > MAX_RESET_TEXT) return null;
  const s = text.trim().replace(/\.+$/, '').trim();
  if (!s) return null;
  const date = DATE_FORM.exec(s);
  let ms;
  if (date) ms = fromDateForm(date);
  else {
    const clock = CLOCK_FORM.exec(s);
    ms = clock ? fromClockForm(clock.groups, nowMs) : null;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  return ms - nowMs > MAX_RESET_AHEAD_MS ? null : ms;
}

export function resumeAtFor({ resetAt, now }) {
  const ms = resetTime(resetAt, now);
  return new Date(ms ?? now + CREDIT_WAIT_MS).toISOString();
}

export function creditProbeDue({ pausedAt, resumeAt, running, now }) {
  if (!pausedAt || !resumeAt || running) return false;
  return now >= Date.parse(resumeAt);
}

const NOTHING = { clear: false, resumeAt: null, event: null };

export function afterCreditProbe({ ok, pausedAt, probedPausedAt, resumeAt, now, retryMs }) {
  if (!pausedAt || pausedAt !== probedPausedAt || !resumeAt) return { ...NOTHING };
  if (ok) {
    return { clear: true, resumeAt: null, event: { text: 'Claude answers again; carrying on after the usage limit.', kind: 'good' } };
  }
  return { clear: false, resumeAt: new Date(now + retryMs).toISOString(), event: null };
}

export function retryWhen(at, now) {
  const d = new Date(at);
  const n = new Date(now);
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return same ? hhmm(at) : localStamp(at);
}

export const retrySentence = (at, now) => `Foreman tries again at ${retryWhen(at, now)} by itself.`;
