// Standby and the owner task watch of the supervisor's loop, and publishing the state to the console.
//
// Standby: when nothing is running or queued and the last pick found nothing to build, a run
// with no limit stays up on standby (the loop state 'standby', one event on entering and one on
// leaving, not one per poll). It keeps re-reading the story source each tick, the Jira
// refresher keeps polling, and the owner's answers are applied; the first story that becomes
// buildable (a new story, a blocker that ships, an owner task marked done, an answered
// decision) leaves standby and starts. Keep-awake is let go on standby and taken again on
// leaving it. Only `foreman stop`, a signal or new code ends it; a halt or a pause shows over
// it and the loop goes back to standby after. --max N, --once and --exit-when-idle still stop
// with NOTHING_LEFT ("Nothing left to build.") instead. On entering standby, once the `foreman
// learn` that starts then has ended, one info event and one `standby` notification name what
// waits on the owner and what an answer would start (console/waiting.mjs standbyNews: "Standby: 3
// follow-up proposals and 1 owner task wait on you; finishing ACME-300 starts ACME-301."). Nothing
// is sent or logged when nothing waits, and the email is not sent again while its text is the same.
//
// Owner task watch: a story carries no created time, so the supervisor notes when it first saw
// an owner task that holds something back (state.json ownerTasks, which outlives a run), and
// every OWNER_TASK_CHECK_MS (50 s at the real tick) reads the waiting list again. A task held for
// more than watchdog.ownerTaskHours (default 24) is told once, as one info event and one
// `owner-task` notification naming the story it holds (owner-task-watch.mjs). A task that stops
// holding anything is forgotten, so it starts a fresh clock if it holds again.

import { resolve } from 'node:path';
import { publishGate, stateFingerprint } from './publish-gate.mjs';
import { ownerWaiting, setLoop, snapshot } from './state.mjs';
import { STANDBY } from './scheduler.mjs';
import { standbyNews } from '../console/waiting.mjs';
import { ownerTaskHours, ownerTaskText, ownerTaskWatch } from './owner-task-watch.mjs';

const OWNER_TASK_CHECK_MS = 5 * 60_000;
const OWNER_TASK_CHECK_TICKS = 10; // 50 s at the real 5 s tick
const PUBLISH_EVERY_MS = 5 * 60_000;

// The supervisor passes what it replaces while the run goes on as getters (settings, consoleAdapter, awake,
// stopping, exiting); the standby state is this run's own.
export function standbyWatch({ root: ROOT, config: CONFIG, dir: DIR, tickMs: TICK_MS, dry: DRY, settings, consoleAdapter, awake, stopping, exiting, owner, notify, state, saveRun, event, now }) {
  let standby = false; // waiting for something to build (see the header)
  let standbySince = null; // when standby began (ms), for the leash's idle limit
  let standbyMailed = ''; // the text of the last standby email, so a standby that flaps does not send it again
  let ownerTaskCheck = { running: false, at: 0 }; // the owner task watch (see the header)

  // The snapshot is built only when the state files moved (publish-gate.mjs), and sent when it
  // changed and at least every PUBLISH_EVERY_MS, so status.json never goes stale.
  const gate = publishGate({
    fingerprint: () => stateFingerprint(DIR, { root: ROOT, slots: CONFIG.slots, paths: settings().stories?.adapter === 'markdown' ? [resolve(ROOT, settings().stories.dir)] : [] }),
    build: () => snapshot(DIR, now(), null, { root: ROOT, slots: CONFIG.slots }),
    publish: (snap) => consoleAdapter().publish(snap),
    everyMs: PUBLISH_EVERY_MS,
  });

  async function publish(force = false) {
    if (!consoleAdapter()) return;
    await gate(force);
  }

  // Standby (see the header): one loop change each way, keep-awake let go while it lasts, and
  // `foreman learn` on entering it, as a run that ended with nothing left did, so the proposals
  // keep coming. Once that learn has ended, announceStandby says what waits, in an event and an
  // email.
  function enterStandby() {
    if (standby) return;
    standby = true;
    standbySince = Date.now();
    setLoop(DIR, 'standby', STANDBY);
    awake()?.release();
    // Asks the owner about findings that keep stopping stories, in the background; then says what waits.
    owner.learn().then(() => announceStandby());
  }
  // The owner's list after the learn, as one event and, when its text is new, one email. It stays
  // quiet when nothing waits or when standby ended while the learn ran. A failure anywhere in it
  // is swallowed: nothing awaits it, and the next standby says it again.
  async function announceStandby() {
    try {
      if (!standby || stopping() || exiting()) return;
      const { items } = await ownerWaiting(DIR, now(), { root: ROOT, slots: CONFIG.slots, loop: state().loop });
      const news = standbyNews(items);
      if (!news || !standby || stopping() || exiting()) return;
      event(news.text, 'info');
      if (news.text === standbyMailed) return;
      standbyMailed = news.text;
      notify('standby', { reason: news.text, story: news.starts[0] ?? '' });
    } catch {
      // a failed announcement changes nothing; the next standby says it again
    }
  }

  // The owner task watch (see the header): at most one look at a time, one every
  // OWNER_TASK_CHECK_MS, and never in a dry run or once a stop has begun.
  async function checkOwnerTasks() {
    if (DRY || stopping() || exiting() || ownerTaskCheck.running || Date.now() < ownerTaskCheck.at) return;
    ownerTaskCheck = { running: true, at: Date.now() + Math.min(OWNER_TASK_CHECK_MS, OWNER_TASK_CHECK_TICKS * TICK_MS) };
    try {
      const { items } = await ownerWaiting(DIR, now(), { root: ROOT, slots: CONFIG.slots, loop: state().loop });
      const r = ownerTaskWatch({ seen: state().ownerTasks ?? {}, items, now: now(), hours: ownerTaskHours(settings()) });
      if (r.changed) saveRun({ ownerTasks: r.seen });
      for (const t of r.tell) {
        const text = ownerTaskText(t, now());
        event(text, 'info');
        notify('owner-task', { story: t.holds[0], reason: text });
      }
    } catch {
      // a look that fails changes nothing; the next one tries again
    } finally {
      ownerTaskCheck.running = false;
    }
  }
  function leaveStandby() {
    if (!standby) return;
    standby = false;
    standbySince = null;
    awake()?.take();
    setLoop(DIR, 'running', '');
  }
  return { publish, enterStandby, announceStandby, checkOwnerTasks, leaveStandby, standbyOn: () => standby, standbySince: () => standbySince };
}
