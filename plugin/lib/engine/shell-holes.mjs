// A test helper that checks a guard which reads shell text against real bash. It is not part of
// the product's run: only tests import it. It uses only Node built-ins (no vitest).
//
//   hasBash(env) -> boolean: whether `bash -c true` works with that environment. A test that
//       spawns bash is skipped when it does not.
//   mulberry32(seed) -> () => number in [0,1): a seeded random number generator, so a sample
//       of layouts can be repeated.
//   LAYOUT_PARTS: the lists the generator draws from (before, head, ops, rest, body, close,
//       after). A string is the literal text and null leaves the part out. Each new form a
//       finding names is added here, and the guard test must go red before the guard is fixed.
//   heredocLayouts({ seed, size, danger }) -> string[]: shell commands built from those parts,
//       each holding a dangerous line (or a quote-closing variant of one). First the whole
//       cross of head x op x rest (so the shapes found so far are always there), then `size`
//       random layouts from the seed. No duplicates, in a fixed order.
//   bashHoles({ allow, commands, stubs, concurrency, timeoutMs }) -> { holes, checked }: runs
//       every command the guard allows in `bash -c`, in a temp folder of its own, with stub
//       executables first on PATH. A command whose stub ran with arguments the stub's
//       `counts(args)` accepts is a hole: the guard allowed what really runs the dangerous
//       command. A refused command is never run.
//
// It runs only the generator's fixed vocabulary (cd, echo, cat, mkdir, git, sh, bash, true and
// the dangerous commands). The dangerous commands are called by name, so the stubs on PATH
// shadow the real ones and nothing real is run. BASH_ENV is not used: it does not load on macOS.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import path from 'node:path';

export function hasBash(env = process.env) {
  try {
    return spawnSync('bash', ['-c', 'true'], { env, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const op = (text, delim) => Object.freeze({ text, delim });

export const LAYOUT_PARTS = Object.freeze({
  before: Object.freeze([null, 'cd sub', "echo 'x' && true", 'true #', "echo '", 'echo "', 'true \\', "echo ' <<EOF '", 'mkdir -p d', "cat <<'A'\nx\nA"]),
  head: Object.freeze([
    'cat', 'cat ', 'cat > f ', 'cat >> notes.md ', "cat > ' ", 'cat > " ', "echo ' ", 'echo " ', "echo 'x' && cat > f ",
    'true #; cat > f ', 'true " ', 'git commit -F - ', 'git commit -m "$(cat ', 'sh -s ', 'bash ', 'cat 3', 'echo $((1', 'cat <<A ',
  ]),
  ops: Object.freeze([
    op('<<EOF', 'EOF'), op('<< EOF', 'EOF'), op("<<'EOF'", 'EOF'), op('<<"EOF"', 'EOF'), op('<<\\EOF', 'EOF'),
    op('<<-EOF', 'EOF'), op("<<-'EOF'", 'EOF'), op("<<''", ''), op("<<E'O'F", 'EOF'), op("<<'EOF'x", 'EOFx'),
  ]),
  rest: Object.freeze(['', ' ', " '", ' "', ' " ; cat >> f', ' > f', ' | sh', '; true', ' )"', " # '", ' \\']),
  body: Object.freeze(['text', "it's", '"', "'", ')"', '`', 'EOFx', '\tEOF', '', 'x \\']),
  // How the delimiter line is written, from the delimiter. null: it is never closed.
  close: Object.freeze([(d) => d, (d) => `\t${d}`, (d) => `${d})`, () => ')"', null]),
  after: Object.freeze([null, ')"', "'", '"', 'echo done', 'EOF']),
});

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

// The danger line, or the same line after a quote it closes.
function dangerLine(rand, danger) {
  const d = pick(rand, danger);
  return pick(rand, [d, `' ; ${d}`, `" ; ${d}`]);
}

export function heredocLayouts({ seed, size, danger }) {
  const { before, head, ops, rest, body, close, after } = LAYOUT_PARTS;
  const out = new Set();
  for (const h of head) {
    for (const o of ops) {
      for (const r of rest) out.add(`${h}${o.text}${r}\n${danger[0]}\n${o.delim}`);
    }
  }
  const rand = mulberry32(seed);
  for (let i = 0; i < size; i++) {
    const b = pick(rand, before);
    const h = pick(rand, head);
    const o = pick(rand, ops);
    const r = pick(rand, rest);
    const lines = Array.from({ length: Math.floor(rand() * 4) }, () => pick(rand, body));
    const c = pick(rand, close);
    let a = pick(rand, after);
    const where = Math.floor(rand() * 3); // 0 body only, 1 after only, 2 both
    if (where !== 1) lines.splice(Math.floor(rand() * (lines.length + 1)), 0, dangerLine(rand, danger));
    if (where !== 0) a = dangerLine(rand, danger);
    const parts = [b, `${h}${o.text}${r}`, ...lines, c === null ? null : c(o.delim), a];
    out.add(parts.filter((p) => p !== null).join('\n'));
  }
  return [...out];
}

function runOne(command, cwd, env, timeoutMs) {
  return new Promise((resolve) => {
    // execFile-style limit: the timeout stops only this child's own pid, by SIGKILL.
    const child = spawn('bash', ['-c', command], { cwd, env, stdio: 'ignore', timeout: timeoutMs, killSignal: 'SIGKILL' });
    child.on('error', resolve);
    child.on('close', resolve);
  });
}

export async function bashHoles({ allow, commands, stubs, concurrency = Math.min(8, availableParallelism()), timeoutMs = 3000 }) {
  const root = mkdtempSync(path.join(tmpdir(), 'foreman-holes-'));
  try {
    mkdirSync(path.join(root, 'bin'));
    for (const name of Object.keys(stubs)) {
      const file = path.join(root, 'bin', name);
      // Run by the kernel or by PATH lookup, $0 is the full path. `bash npm test` reads the file as a
      // script ($0 is the bare name), which a real binary or a node script would not run as the
      // command, so that is not logged. A newline in an argument is a space, so it makes no log line.
      const body = `case "$0" in /*) ;; *) exit 0 ;; esac\nargs=$(printf '%s' "$*" | tr '\\n' ' ')\nprintf '%s\\n' "${name} $args" >> "$HOLES_LOG"\nexit 0\n`;
      writeFileSync(file, `#!/bin/sh\n${body}`);
      chmodSync(file, 0o755);
    }
    const allowed = commands.filter((c) => allow(c));
    const logs = [];
    let next = 0;
    const worker = async () => {
      while (next < allowed.length) {
        const i = next++;
        const cwd = path.join(root, `c${i}`);
        mkdirSync(path.join(cwd, 'sub'), { recursive: true });
        const log = path.join(root, `c${i}.log`);
        logs[i] = log;
        const env = { PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, HOME: root, LC_ALL: 'C', HOLES_LOG: log };
        await runOne(allowed[i], cwd, env, timeoutMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, allowed.length)) }, worker));
    const holes = [];
    allowed.forEach((command, i) => {
      let ran = [];
      try {
        ran = readFileSync(logs[i], 'utf8').split('\n').filter(Boolean);
      } catch {
        return; // the stub never ran, so there is no log
      }
      const hit = ran.some((line) => {
        const at = line.indexOf(' ');
        const name = at < 0 ? line : line.slice(0, at);
        return Object.hasOwn(stubs, name) && stubs[name](at < 0 ? '' : line.slice(at + 1));
      });
      if (hit) holes.push({ command, ran });
    });
    return { holes, checked: allowed.length };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
