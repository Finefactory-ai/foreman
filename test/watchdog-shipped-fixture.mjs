// The fixture for `foreman run 1` end to end, for the build-limit watchdog around a story that
// ships (supervisor-watchdog-shipped.test.mjs, supervisor-watchdog-ended.test.mjs,
// supervisor-watchdog-release.test.mjs, supervisor-watchdog-overrun.test.mjs,
// supervisor-watchdog-merged.test.mjs, supervisor-watchdog-hang.test.mjs,
// supervisor-watchdog-merged-hang.test.mjs and supervisor-watchdog-gh.test.mjs, split so their
// waits run on different workers). The supervisor runs on the short test tick
// (test/fast-tick.mjs), so a session needs to stay up only four ticks past the build limit to be
// seen there. The watchdog cases run with a 9 s build limit, stretched by the machine's load
// (stretchByLoad in test/slow-tests.mjs): the fake session's own start and its first `foreman`
// calls must land before the limit, and on a busy shared machine each takes several seconds.
// Their waits past the limit are real time, so they are listed in test/slow-tests.mjs. The resume
// cases keep the default limit and do not wait. A fake `claude` (and `gh`) on the PATH stand in
// for the session and GitHub; FAKE_MODE says what the fake session does, FAKE_LIMIT_S is the
// build limit and FAKE_AFTER_S the four ticks, in seconds. With the quiet option the quiet limit
// is the same as the build limit, so a session that hangs after its story ended, or after its
// pull request merged, is ended in the test's time. The fake gh logs every call it gets
// (ghCalls), and FAKE_GH_BROKEN makes its merged-PR look-up exit 1 ('exit', after printing a
// merged answer, so only the exit status refuses it) or print bad JSON ('json').

import { afterEach } from 'vitest';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, makeRepos } from './state-repos.mjs';
import { fastTick, TEST_TICK_MS } from './fast-tick.mjs';
import { stretchByLoad } from './slow-tests.mjs';
import { runForeman, useSupervisors } from './supervisors.mjs';

const BIN = fileURLToPath(new URL('../plugin/bin/foreman', import.meta.url));
export const PR = 'https://example.com/acme/pull/1';
// The watchdog cases' build limit, and four short test ticks, on an idle machine.
const LIMIT_MS = 9000;
const AFTER_MS = 4 * TEST_TICK_MS;
// The time for one run, long enough for two sessions past a stretched limit, and for its test.
const RUN_MS = stretchByLoad(100_000);
export const TEST_MS = RUN_MS + 20_000;

const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const id = process.env.FOREMAN_STORY;
const before = readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').split('\\n').filter(Boolean).length;
appendFileSync(process.env.FAKE_CLAUDE_LOG, id + '\\n');
const foreman = (...args) => spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, ...args], { stdio: 'ignore' }).status;
const wait = (s) => spawnSync('sleep', [String(s)]);
const shipped = () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 1000, result: 'Shipped.\\nFACTORY_RESULT: shipped ' + id, total_cost_usd: 0, session_id: 'fake' }));
const mode = process.env.FAKE_MODE;
const LIMIT = Number(process.env.FAKE_LIMIT_S);
const AFTER = Number(process.env.FAKE_AFTER_S);
// Only the first overrun session overruns; the resumed one ends at once, before any \`foreman\`
// call a busy machine could stretch past the limit, so one stop is counted.
if (mode === 'overrun' && before > 0) process.exit(0);
foreman('story', 'start', id);
if (mode === 'ship-late') {
  foreman('stage', 'commit');
  wait(LIMIT + 1);
  foreman('story', 'done', id, '--note', 'ok');
  foreman('story', 'end', 'shipped', '${PR}', 'ok');
  wait(AFTER);
  shipped();
} else if (mode === 'end-only') {
  // Ends the story without marking it done: only its own \`story end\` spares it.
  foreman('story', 'end', 'shipped', '${PR}', 'ok');
  wait(LIMIT + AFTER);
  shipped();
} else if (mode === 'done-only') {
  // Marks the story done and has not run \`story end\` yet: only the status spares it.
  foreman('story', 'done', id, '--note', 'ok');
  wait(LIMIT + AFTER);
  foreman('story', 'end', 'shipped', '${PR}', 'ok');
  shipped();
} else if (mode === 'release') {
  foreman('stage', 'release', 'merging');
  wait(LIMIT + AFTER);
  foreman('story', 'done', id, '--note', 'ok');
  foreman('story', 'end', 'shipped', '${PR}', 'ok');
  shipped();
} else if (mode === 'merged-only') {
  // Neither ends its story nor marks it done before the limit: only its merged pull request
  // (FAKE_GH_MERGED) spares it.
  wait(LIMIT + AFTER);
  foreman('story', 'done', id, '--note', 'ok');
  foreman('story', 'end', 'shipped', '${PR}', 'ok');
  shipped();
} else if (mode === 'end-hang') {
  // Ends its story, then hangs and never prints a result.
  foreman('story', 'done', id, '--note', 'ok');
  foreman('story', 'end', 'shipped', '${PR}', 'ok');
  wait(4 * LIMIT);
} else if (mode === 'merged-hang') {
  // Neither ends its story nor marks it done; only its merged pull request (FAKE_GH_MERGED)
  // spares it. Then it hangs and never prints a result.
  wait(4 * LIMIT);
} else if (mode === 'done-no-result') {
  foreman('story', 'done', id, '--note', 'ok');
  foreman('story', 'end', 'shipped', '', 'ok');
} else if (mode === 'overrun') {
  wait(3 * LIMIT);
}
process.exit(0);
`;

// Logs each call's arguments to FAKE_GH_LOG. Answers the supervisor's merged-PR look-up for the
// story's branch with FAKE_GH_MERGED, when set, unless FAKE_GH_BROKEN breaks it; every other
// \`pr list\` (start-up recovery's) with no pull requests.
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
if [ "$1 $2" = "pr list" ]; then
  if [ "$3 $4 $5 $6" = "--head story/acme-1 --state merged" ]; then
    if [ "$FAKE_GH_BROKEN" = "exit" ]; then echo "[{\\"url\\":\\"$FAKE_GH_MERGED\\"}]"; exit 1; fi
    if [ "$FAKE_GH_BROKEN" = "json" ]; then echo 'not json'; exit 0; fi
  fi
  if [ -n "$FAKE_GH_MERGED" ] && [ "$3 $4 $5 $6" = "--head story/acme-1 --state merged" ]; then
    echo "[{\\"url\\":\\"$FAKE_GH_MERGED\\"}]"
  else
    echo "[]"
  fi
  exit 0
fi
exit 1
`;

const TODO = '---\nid: ACME-1\ntitle: Story ACME-1\nstatus: todo\ndepends_on: []\n---\n\nDo ACME-1.\n\n## Progress notes\n';

let repos;
let clone;
// The run's state folder, for a test to read.
export let state;
let bin;
let log;
let ghLog;
let limitS;
let afterS;

// `limited` gives the run the short build limit, stretched by the load now; without it the
// default limits stand. `quiet` gives it the same quiet limit too, and an outlive limit twice
// as long, so the ended-alive check (its own `story end`, then still running) cannot beat the
// quiet one on a loaded machine where the limit stretches past the one-minute default.
export function setup(limited = false, { quiet = false } = {}) {
  limitS = Math.ceil(stretchByLoad(LIMIT_MS) / 1000);
  afterS = Math.ceil(stretchByLoad(AFTER_MS) / 1000);
  const watchdog = limited ? { watchdog: { buildMinutes: limitS / 60, ...(quiet ? { quietMinutes: limitS / 60, outliveMinutes: (2 * limitS) / 60 } : {}) } } : {};
  repos = makeRepos({ version: 1, project: { name: 'Acme' }, console: { adapter: 'files' }, features: { keepAwake: false }, learning: { auto: false }, ...watchdog });
  clone = repos.clone('acme');
  writeFileSync(join(clone, '.gitignore'), '.foreman/\n');
  mkdirSync(join(clone, 'stories'));
  writeFileSync(join(clone, 'stories', 'ACME-1.md'), TODO);
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'Add ACME-1');
  git(clone, 'push', '-q', 'origin', 'main');
  state = join(clone, '.foreman');
  bin = join(repos.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  log = join(repos.base, 'claude.log');
  writeFileSync(log, '');
  ghLog = join(repos.base, 'gh.log');
  writeFileSync(ghLog, '');
}

// Registers the hooks that drop each test's repos and end its supervisor (that one first:
// vitest runs afterEach hooks last first).
export function withWatchdogRepos() {
  afterEach(() => repos?.cleanup());
  useSupervisors();
}

const runEnv = (extra) => {
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: repos.base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of Object.keys(env)) if (/^(FOREMAN|FACTORY)_/.test(key) || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(key)) delete env[key];
  Object.assign(env, fastTick);
  return { ...env, FAKE_CLAUDE_LOG: log, FAKE_FOREMAN_BIN: BIN, FAKE_GH_MERGED: '', FAKE_GH_BROKEN: '', FAKE_GH_LOG: ghLog, FAKE_LIMIT_S: String(limitS), FAKE_AFTER_S: String(afterS), ...extra };
};

export const run = (extra) => runForeman(['run', '--foreground', '1'], { cwd: clone, env: runEnv(extra), encoding: 'utf8', timeout: RUN_MS });
export const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
// The fake gh's calls, each its arguments joined by spaces.
export const ghCalls = () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
export const texts = () => readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
export const runResults = () =>
  readdirSync(join(state, 'runs'))
    .filter((f) => f.startsWith('ACME-1-') && f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(state, 'runs', f), 'utf8')).result);
// The run's events and output, for a failed expectation.
export const why = (r) => {
  const feed = readFileSync(join(state, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return `${feed.map((e) => `${e.at} ${e.text}`).join('\n')}\n${r.stdout}\n${r.stderr}`;
};
export const stopped = (list) => list.filter((t) => t.includes('no progress for') || t.includes('still building after') || t.includes('stopping the session to resume it'));

