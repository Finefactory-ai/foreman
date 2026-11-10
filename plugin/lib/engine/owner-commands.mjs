// The commands the supervisor runs for the owner, `foreman notify` and `foreman learn`, each in a
// child of its own with a time limit (run-async.mjs), so neither holds the loop: an email that
// waits on a slow network, or a learn over a long findings log, no longer stops the ticks, the
// dashboard or the watchdogs.
//
//   const owner = ownerCommands({ bin, root, env, event, run, node, notifyMs, learnMs })
//   owner.notify(kind, { story, reason, slot, parkedFor, log, stories, shipped }) -> Promise
//       `foreman notify --kind <kind> ...` in root, as the supervisor always ran it (the command
//       loads the env file itself). One that exits non-zero, cannot start or passes notifyMs
//       (60 s) logs the warn event 'Could not email you (<kind>).' on its slot (null for none).
//       When its error output is a library load error (the Node itself could not start, as after
//       a Homebrew upgrade of Node), the event names that Node and the load error line and calls
//       it a problem with the computer's set-up (node-path.mjs childNodeText) instead.
//   owner.learn({ queue }) -> Promise
//       `foreman learn` in root, within learnMs (60 s). While one runs, a plain call gets the
//       running promise (the queued one, when there is one) and starts no other. With
//       queue: true, a call made while one runs sets one more to start the moment that one ends
//       and gets its promise, so a story that ships during a learn still has its findings read:
//       however many queued calls arrive, only one more follows. What it proposed (learn.mjs learnEvent) is one info event;
//       nothing is logged when it proposed nothing. It never throws: a problem only costs the
//       proposals. It logs nothing when it fails either, except one warn event, '`foreman learn`
//       failed: Node (...) could not start: ...', when the failure is a library load error.
//   owner.finish(kind | null, fields) -> Promise
//       the stop's last words: owner.learn() (the running one, if any) and, when kind is given,
//       owner.notify(kind, fields), side by side, so a stop waits for the slower of the two and
//       not for both in turn. Resolves once both have settled; it never throws.
//   owner.settled() -> Promise
//       resolves once every notify and learn started so far has settled. The supervisor awaits it
//       before it exits: the children are detached, so the "stopped" email still goes out.
//
// `run` is runAsync, for tests; `bin` is the foreman launcher, run with `node()`, the Node to
// use right now (the supervisor passes the one it chose, node-path.mjs nodeWatch; default this
// process's own), asked again for every command.

import { learnEvent } from './learn.mjs';
import { childNodeText, loadErrorLine } from './node-path.mjs';
import { runAsync } from './run-async.mjs';

export const NOTIFY_MS = 60_000;
export const LEARN_MS = 60_000;

export function ownerCommands({ bin, root, env = process.env, event, run = runAsync, node = () => process.execPath, notifyMs = NOTIFY_MS, learnMs = LEARN_MS }) {
  const pending = new Set();
  let learning = null;
  let next = null;

  // Keeps p in pending until it settles; p itself never rejects.
  const held = (p) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };
  const call = async (args, timeoutMs) => {
    const used = node();
    try {
      return { ...(await run(used, [bin, ...args], { cwd: root, env, timeoutMs })), node: used };
    } catch (err) {
      return { status: null, stdout: '', stderr: '', timedOut: false, error: String(err?.message ?? err), node: used };
    }
  };
  // The warn text for a command whose Node could not load a library, else null.
  const nodeProblem = (what, r) => {
    const cause = loadErrorLine(r.stderr);
    return cause ? childNodeText(what, { node: r.node, cause }) : null;
  };

  function notify(kind, { story = '', reason = '', slot = '', parkedFor = '', log = '', stories = 0, shipped = 0 } = {}) {
    const args = ['notify', '--kind', kind, '--story', story, '--reason', reason, '--stories', String(stories), '--shipped', String(shipped), '--log', log];
    if (slot) args.push('--slot', slot);
    if (parkedFor) args.push('--parked-for', parkedFor);
    return held(
      call(args, notifyMs).then((r) => {
        if (r.status !== 0 || r.timedOut || r.error) event(nodeProblem(`Could not email you (${kind})`, r) ?? `Could not email you (${kind}).`, 'warn', slot || null);
      }).catch(() => {}),
    );
  }

  function learn({ queue = false } = {}) {
    if (learning) {
      if (!queue) return next ?? learning;
      next ??= held(
        learning.then(() => {
          next = null;
          return learn();
        }),
      );
      return next;
    }
    learning = held(
      call(['learn'], learnMs)
        .then((r) => {
          const problem = r.status !== 0 ? nodeProblem('`foreman learn` failed', r) : null;
          if (problem) return event(problem, 'warn');
          const text = learnEvent(r.stdout);
          if (text) event(text);
        })
        .catch(() => {})
        .finally(() => {
          learning = null;
        }),
    );
    return learning;
  }

  function finish(kind, fields = {}) {
    const runs = [learn()];
    if (kind) runs.push(notify(kind, fields));
    return Promise.allSettled(runs).then(() => undefined);
  }

  const settled = () => Promise.allSettled([...pending]).then(() => undefined);

  return { notify, learn, finish, settled };
}
