// A repeated error logged once, with a count, instead of once per loop. Pure.
//
//   repeatGate()   { seen(text, now), clear(now) }, each returning the lines to log
//
//   seen    the same text as the one open: counted, nothing to log. A new text: the closing
//           line of the one open (if any), then the new text.
//   clear   the loop ran clean: the closing line of the one open (if any), and nothing open.
//
// The closing line is "<text> (<count> times since HH:MM)", HH:MM in local time of the first
// occurrence, and only when the text came at least twice; once is already logged as it was.

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function repeatGate() {
  let open = null; // { text, count, first }

  const close = () => {
    const lines = open && open.count >= 2 ? [`${open.text} (${open.count} times since ${hhmm(open.first)})`] : [];
    open = null;
    return lines;
  };

  return {
    seen(text, now = new Date()) {
      if (open && open.text === text) {
        open.count += 1;
        return [];
      }
      const lines = close();
      open = { text, count: 1, first: new Date(now) };
      return [...lines, text];
    },
    clear() {
      return close();
    },
  };
}
