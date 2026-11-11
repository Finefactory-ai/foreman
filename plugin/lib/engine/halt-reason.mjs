// The one line the owner reads for a failed release. `foreman ship` writes HALT as an ISO stamp
// and the whole result object (the facts the steps found, then stage and reason), so the file
// starts with `{"sfDelta":...`; the readers of HALT (the supervisor's loop reason, the Waiting on
// you item) and `foreman decide add` (the story skill gives it the same JSON line as a body)
// show the reason in it, never the object. Pure: it imports nothing from state.mjs, which
// imports this file.
//
//   reasonOf(value, stage)  value as the sentence it says: text is trimmed, an object gives its
//                           `reason` text, anything else gives "The release failed at <stage>."
//                           (or "A release failed." with no stage). The ship runner uses it so a
//                           step's reason is never stored as an object.
//   haltReason(raw)         the reason in a HALT file or a ship JSON line, with or without its
//                           ISO stamp. Text that is not JSON is returned as it is; JSON gives its
//                           reason; JSON that was cut gives the "reason" text still in it, else
//                           "A release failed.". It never throws and never returns object text.
//   shipLineBody(text)      for a --body that is a ship JSON line (a plain JSON object with a
//                           `stage` or `reason`): its reason, and "Pull request: <pr>" after a
//                           blank line when it has one. Anything else gives null: leave it.

const FAILED = 'A release failed.';
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z(?:\s+|$)/;
const REASON_FIELD = /"reason"\s*:\s*("(?:[^"\\]|\\.)*")/;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

export function reasonOf(value, stage) {
  const text = words(value) ?? (isPlain(value) ? words(value.reason) : null);
  if (text) return text;
  return typeof stage === 'string' && stage.trim() ? `The release failed at ${stage.trim()}.` : FAILED;
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isPlain(value) ? value : null;
  } catch {
    return null;
  }
}

export function haltReason(raw) {
  try {
    const s = String(raw ?? '').trim().replace(STAMP, '');
    if (!s) return FAILED;
    if (!s.startsWith('{')) return s;
    const obj = parseObject(s);
    if (obj) return reasonOf(obj.reason, obj.stage ?? obj.step);
    const cut = REASON_FIELD.exec(s);
    if (cut) {
      const text = words(JSON.parse(cut[1]));
      if (text) return text;
    }
    return FAILED;
  } catch {
    return FAILED;
  }
}

export function shipLineBody(text) {
  const obj = parseObject(String(text ?? '').trim());
  if (!obj || !('stage' in obj || 'reason' in obj)) return null;
  const pr = words(obj.pr);
  return `${haltReason(JSON.stringify(obj))}${pr ? `\n\nPull request: ${pr}` : ''}`;
}
