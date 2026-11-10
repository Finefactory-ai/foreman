// A read-through cache for the files and folders the supervisor reads on every tick (state.json,
// the decisions, claims and story folders, the overlays), keyed by what stat says about them:
// device, inode, size, mtime and ctime. A file nobody touched is read once; a file replaced by
// temp file and rename has a new inode, and an in-place write moves the size, mtime or ctime.
//
// Why files are "racy" for 2 seconds (RACY_MS): a second change made within the clock
// granularity of an mtime that was just read (coarse clocks on Linux, 1 s on HFS+) would keep
// the same key and be missed. So a file whose mtime is that young is read on every call, and
// is trusted only once it is older. A writer that is this process primes the entry itself
// through renameWritten. It stats its temp file before the rename and keeps the entry only when
// the file in place afterwards is that same inode, with the size of the text. Otherwise another
// writer got in between, the entry is dropped, and the next read reads the file.
//
// The cache hands out text, never a parsed object, so every caller parses its own copy and no
// two callers share one to mutate. It imports nothing from Foreman, so it cannot cause an import
// cycle, and it is only for reads that do not decide a write: those keep reading the file.
//
//   readText(file)               the text, or null when the file does not exist
//   listNames(dir, { strict })   the folder's names (a new array each time), [] when it is missing
//                                (strict: throws ENOENT instead)
//   renameWritten(tmp, file, text)  renames this process's temp file into place and primes the entry; throws only the rename's error
//   forget(file)                 drop one entry
//   readTailLines(file, n)       the last n non-empty lines, oldest first, read from the end of
//                                the file (not cached)
//   cacheSize()                  for tests

import fs from 'node:fs';

export const RACY_MS = 2000;
export const MAX_ENTRIES = 5000;

const TAIL_BYTES = 64 * 1024;

const entries = new Map(); // path -> { key, value, trusted }

const keyOf = (st) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
const settled = (st) => Date.now() - st.mtimeMs > RACY_MS;

function remember(path, entry) {
  entries.delete(path);
  entries.set(path, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
}

// The cached value when the path is unchanged and old enough to trust, else `read()`'s.
function through(path, read) {
  const st = fs.statSync(path, { throwIfNoEntry: false });
  if (!st) {
    entries.delete(path);
    return null;
  }
  const key = keyOf(st);
  const had = entries.get(path);
  if (had && had.trusted && had.key === key) return had.value;
  const value = read();
  remember(path, { key, value, trusted: settled(st) });
  return value;
}

export function readText(file) {
  try {
    return through(file, () => fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      entries.delete(file);
      return null;
    }
    throw err;
  }
}

// With `strict`, a missing folder throws ENOENT as readdirSync does, for a caller that treats it
// as an error.
export function listNames(dir, { strict = false } = {}) {
  let names = null;
  try {
    names = through(dir, () => fs.readdirSync(dir));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    entries.delete(dir);
  }
  if (names !== null) return [...names];
  if (strict) throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${dir}'`), { code: 'ENOENT', path: dir });
  return [];
}

export function renameWritten(tmp, file, text) {
  let before = null;
  try {
    before = fs.statSync(tmp, { throwIfNoEntry: false }) ?? null;
  } catch {
    before = null;
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    entries.delete(file);
    throw err;
  }
  try {
    // The key comes from the stat after the rename, because a rename moves ctime.
    const after = fs.statSync(file, { throwIfNoEntry: false });
    if (!before || !after || after.dev !== before.dev || after.ino !== before.ino || after.size !== Buffer.byteLength(text)) {
      entries.delete(file);
      return;
    }
    remember(file, { key: keyOf(after), value: text, trusted: true });
  } catch {
    entries.delete(file);
  }
}

export const forget = (file) => {
  entries.delete(file);
};

export const cacheSize = () => entries.size;

// The last `maxLines` non-empty lines of a file, oldest first. Reads the last 64 KB, then four
// times as much while that holds too few whole lines, up to the whole file.
export function readTailLines(file, maxLines) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let want = TAIL_BYTES;
    for (;;) {
      const len = Math.min(want, size);
      const start = size - len;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, start + got);
        if (n === 0) break;
        got += n;
      }
      let lines = buf.subarray(0, got).toString('utf8').split('\n');
      if (start > 0) lines = lines.slice(1); // the first line may be cut off
      lines = lines.filter((l) => l.trim() !== '');
      if (lines.length >= maxLines || start === 0) return lines.slice(-maxLines);
      want *= 4;
    }
  } finally {
    fs.closeSync(fd);
  }
}
