// Follows the run's events.jsonl and writes each new event as one line, so a container's log
// shows story starts and ends, halts and slots that go down. Events come from the supervisor and
// from the sessions' own `foreman story end`, so the file is followed, not hooked.
//
//   eventLine(e, { mask })
//                    `<at> <kind> <slot|-> <text>` on one line, with control characters dropped
//                    from every part. The text is masked by `mask` (the known key values; default
//                    none) and then of key patterns; null when `e` has no text
//   secretValues(env, names)
//                    the unique values of env[name] for the names that are long enough (8 or more
//                    characters) to be a secret, longest first, for a mask to blank
//   followEvents({ file, write, fs, mask })
//                    { poll(), close() }. Starts at the end of a file that is already there, so
//                    an earlier run's history is not replayed. poll() writes the complete lines
//                    added since the last poll, and follows the log when it is rotated (the old
//                    file is read to its end first). close() polls once more and stops. Nothing
//                    here throws: a broken echo must never stop a run, so a line whose mask throws
//                    is not written. Multi-byte characters survive a read that ends inside one.

import { StringDecoder } from 'node:string_decoder';
import { redact } from '../engine/state.mjs';

// C0 except \t \n \v \f \r (which `\s` turns into one space), DEL and C1.
const CONTROL = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;
const oneLine = (v) => String(v).replace(CONTROL, '').replace(/\s+/g, ' ').trim();
const MIN_SECRET = 8;

export function eventLine(e, { mask = (t) => t } = {}) {
  if (!e || typeof e !== 'object' || typeof e.text !== 'string') return null;
  const text = oneLine(redact(mask(String(e.text).replace(CONTROL, ''))));
  return `${oneLine(e.at)} ${oneLine(e.kind)} ${oneLine(e.slot ?? '-') || '-'} ${text}`;
}

export function secretValues(env, names) {
  const values = names.map((name) => env?.[name]).filter((v) => typeof v === 'string' && v.length >= MIN_SECRET);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function followEvents({ file, write, fs, mask }) {
  let fd = null;
  let offset = 0;
  let partial = '';
  let decoder = new StringDecoder('utf8');
  let closed = false;

  const open = (at) => {
    try {
      fd = fs.openSync(file, 'r');
      offset = at === 'end' ? fs.fstatSync(fd).size : 0;
    } catch {
      fd = null;
    }
  };
  const shut = () => {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {}
    fd = null;
    offset = 0;
    partial = '';
    decoder = new StringDecoder('utf8');
  };

  const emit = (line) => {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const text = eventLine(e, { mask });
      if (text !== null) write(text + '\n');
    } catch {}
  };

  const drain = () => {
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (!n) return;
      offset += n;
      partial += decoder.write(chunk.subarray(0, n));
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) if (line.trim()) emit(line);
    }
  };

  const rotated = () => {
    try {
      return fs.statSync(file).ino !== fs.fstatSync(fd).ino;
    } catch {
      return true;
    }
  };

  try {
    if (fs.existsSync(file)) open('end');
  } catch {
    fd = null;
  }

  const poll = () => {
    if (closed) return;
    try {
      if (fd === null) open('start');
      if (fd === null) return;
      drain();
      if (rotated()) {
        shut();
        open('start');
        if (fd !== null) drain();
      }
    } catch {}
  };

  return {
    poll,
    close() {
      if (closed) return;
      poll();
      closed = true;
      shut();
    },
  };
}
