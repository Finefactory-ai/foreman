// When the supervisor needs to rebuild the snapshot it publishes. Building it reads every state
// file, so the loop first takes a fingerprint of the files and folders the snapshot is made
// from (their stat, never their content) and builds only when that moved.
//
//   stateFingerprint(dir, opts)   a string, or null (build) when it cannot be trusted: a file
//                                 changed within the last racyMs, so a second change inside the
//                                 clock's granularity could hide behind the same mtime
//   publishGate({...})            async (force) => 'skipped' | 'unchanged' | 'published'
//   changeKey(snap)               the snapshot without its clock: what decides whether to publish
//
// The folders are fingerprinted as folders, because every writer of the files in them puts a
// file there by temp file and rename, link or removal, which moves the folder's mtime. The
// minute is part of the fingerprint, so texts that count minutes (an agent quiet for 3 min, a
// wait of 12 min) still refresh once a minute. status.json is left out: publishing writes it.
// Other sources, such as process liveness and in-place note edits, show up within the minute
// through the minute in the fingerprint.
// Nothing here throws.

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { CHECK_RUNNING_DIR } from './check-slots.mjs';
import { RACY_MS } from './read-cache.mjs';
import { ADOPTED_FILE, PID_FILE, STOPPED_FILE } from './supervisor-pid.mjs';
import { LAST_STOP } from '../console/stopper.mjs';
import { SIGNIN_FILE } from './claude-fallback.mjs';

const FILES = ['state.json', 'control.json', 'events.jsonl', 'HALT', 'STOP', LAST_STOP, STOPPED_FILE, PID_FILE, ADOPTED_FILE, SIGNIN_FILE, 'settings.json', join('jira', 'list.json'), join('salesforce', 'list.json')];
const FOLDERS = [
  'decisions',
  join('sync', 'decisions', 'items'),
  join('sync', 'decisions', 'answers'),
  'claims',
  'parks',
  'locks',
  'waits',
  'plans',
  'stories',
  join('stories', 'new'),
  'jira',
  'slots',
  CHECK_RUNNING_DIR,
];

// Everything but the clock: the timestamp and how long each slot's agents have been quiet.
export const changeKey = (snap) => JSON.stringify({ ...snap, updatedAt: null, slots: (snap.slots ?? []).map((s) => ({ ...s, agents: (s.agents ?? []).map((a) => ({ ...a, quietFor: null })) })) });

export function stateFingerprint(dir, { root, slots = 8, paths = [], nowMs = Date.now(), racyMs = RACY_MS } = {}) {
  try {
    const list = [...FILES.map((f) => join(dir, f)), ...FOLDERS.map((f) => join(dir, f))];
    for (let n = 1; n <= slots; n++) {
      list.push(join(dir, 'slots', `w${n}.json`), join(dir, 'slots', `w${n}`, 'agents'), join(dir, 'slots', `w${n}`, 'spans.jsonl'));
    }
    if (root) list.push(join(root, 'foreman.config.json'));
    list.push(...paths);
    const parts = [];
    for (const path of list) {
      const st = statSync(path, { throwIfNoEntry: false });
      if (!st) {
        parts.push('-');
        continue;
      }
      if (st.mtimeMs > nowMs - racyMs) return null;
      parts.push(`${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`);
    }
    parts.push(Math.floor(nowMs / 60_000));
    return parts.join('|');
  } catch {
    return null;
  }
}

// `fingerprint` runs on every call. `build` runs only when the fingerprint moved since the last
// call, when the fingerprint is null or threw, when `force` is set, or when everyMs has passed
// since the last publish; otherwise the gate returns 'skipped' without building. `publish` runs
// only when the built snapshot's changeKey differs from the last one published, when `force` is
// set, or when everyMs has passed (so status.json never goes stale).
// A build or publish that throws leaves the gate as it was, and the error reaches the caller.
export function publishGate({ fingerprint, build, publish, changeKey: keyOf = changeKey, everyMs, clock = Date.now }) {
  let last = { fingerprint: null, key: null, at: 0 };
  return async (force = false) => {
    let fp = null;
    try {
      fp = fingerprint();
    } catch {
      fp = null;
    }
    const fresh = clock() - last.at < everyMs;
    if (!force && fp !== null && fp === last.fingerprint && fresh) return 'skipped';
    const snap = await build();
    const key = keyOf(snap);
    if (!force && key === last.key && fresh) {
      last.fingerprint = fp;
      return 'unchanged';
    }
    await publish(snap);
    last = { fingerprint: fp, key, at: clock() };
    return 'published';
  };
}
