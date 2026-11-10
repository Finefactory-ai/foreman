// Watches one sf call for runSf in sf.mjs. Run as `node sf-watch.mjs <limitMs> <cmd> <args...>`.
//
// It starts <cmd> in a process group of its own, passes its stdout and stderr straight through,
// and stops the whole group (SIGTERM, then SIGKILL 5 seconds later) when:
//   - <limitMs> pass;
//   - stderr, or the error sf printed as JSON on stdout, shows a login or rate-limit error
//     (loginTrouble and troubleText in sf.mjs), which sf would otherwise keep retrying until the
//     org locks out logins;
//   - it gets SIGTERM or SIGINT itself, which is the caller's backstop timeout.
// Killing the group, not just the child, also ends whatever the child started.
//
// After a stop it writes one last stderr line, `foreman-sf-watch: {"stop":...,"limitMs":N}`,
// with stop "timeout", "login-rate" or "auth", which runSf reads and strips. It exits with the
// child's code, 124 after a timeout, 125 after a login stop, and 127 with `spawn sf ENOENT` on
// stderr when <cmd> is not found. It sets process.exitCode and never calls process.exit(), so
// piped output is flushed before it ends.

import { spawn } from 'node:child_process';
import os from 'node:os';
import { loginTrouble, troubleText } from './sf.mjs';

const TAIL = 64 * 1024;
const GRACE_MS = 5000;
// After the child exits, how long its pipes may stay open (held by something that left the
// group) before the watcher stops waiting for them.
const CLOSE_MS = 2000;
const VERDICT = 'foreman-sf-watch:';

const [limitArg, cmd, ...args] = process.argv.slice(2);
const limitMs = Number(limitArg);

if (!cmd || !Number.isInteger(limitMs) || limitMs <= 0) {
  process.stderr.write('usage: node sf-watch.mjs <limitMs> <cmd> <args...>\n');
  process.exitCode = 2;
} else {
  watch();
}

function watch() {
  let stop = null;
  let outTail = '';
  let errTail = '';
  let killTimer = null;
  let closeTimer = null;
  let done = false;

  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // the group is already gone
    }
  };

  const stopGroup = (why) => {
    if (stop === null) stop = why;
    if (killTimer !== null || child.pid === undefined) return;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), GRACE_MS);
    killTimer.unref();
  };

  const limitTimer = setTimeout(() => stopGroup('timeout'), limitMs);

  // The cheap check over both tails comes first, so stdout is parsed only when a phrase is there.
  const relay = (out, isErr) => (chunk) => {
    out.write(chunk);
    if (stop !== null) return;
    const text = chunk.toString('utf8');
    if (isErr) errTail = (errTail + text).slice(-TAIL);
    else outTail = (outTail + text).slice(-TAIL);
    if (!loginTrouble(`${outTail}\n${errTail}`)) return;
    const trouble = loginTrouble(troubleText(outTail, errTail));
    if (trouble) stopGroup(trouble);
  };
  child.stdout.on('data', relay(process.stdout, false));
  child.stderr.on('data', relay(process.stderr, true));

  const onSignal = () => stopGroup(stop ?? 'timeout');
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const finish = (code, signal) => {
    if (done) return;
    done = true;
    clearTimeout(limitTimer);
    clearTimeout(closeTimer);
    if (killTimer !== null) {
      clearTimeout(killTimer);
      // Anything the child left in its group goes too.
      signalGroup('SIGKILL');
    }
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (stop !== null) {
      process.stderr.write(`\n${VERDICT} ${JSON.stringify({ stop, limitMs })}\n`);
      process.exitCode = stop === 'timeout' ? 124 : 125;
    } else {
      process.exitCode = Number.isInteger(code) ? code : 128 + (os.constants.signals[signal] ?? 0);
    }
  };

  child.on('error', (err) => {
    if (done) return;
    done = true;
    clearTimeout(limitTimer);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (err?.code === 'ENOENT') {
      process.stderr.write(`spawn ${cmd} ENOENT\n`);
      process.exitCode = 127;
    } else {
      process.stderr.write(`spawn ${cmd} ${err?.code ?? ''} ${err?.message ?? err}\n`);
      process.exitCode = 1;
    }
  });

  child.on('exit', (code, signal) => {
    closeTimer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      finish(code, signal);
    }, CLOSE_MS);
    closeTimer.unref();
  });
  child.on('close', (code, signal) => finish(code, signal));
}
