// Runs before every test file (a vitest setup file): times each test, its hooks included, and
// judges one over the limit that test/slow-tests.mjs does not list (slowTestFinding). The limit
// is 5 s, stretched by the machine's load when it has more runnable processes than cores
// (guardLimitMs). The test fails when the machine is idle (under 0.5 load per core when it
// ends); when it is busy, a `slow-test guard warning:` line is printed instead, and a warning
// never throws, so vitest's retry does not run the test again. The line goes straight to stderr:
// under a coding agent (Claude Code sets CLAUDECODE) vitest's reporter hides console output from
// passing tests, and a story's checks run there.
// SLOW_TEST_LIMIT_MS sets an exact limit for a run, and SLOW_TEST_GUARD=report turns every
// failure into a warning (not FOREMAN_ names, which clean-env.mjs drops).
import os from 'node:os';
import { afterEach, beforeEach } from 'vitest';
import { slowTestFinding } from './slow-tests.mjs';

const starts = new Map();

beforeEach((ctx) => {
  starts.set(ctx.task.id, performance.now());
});

afterEach((ctx) => {
  const finding = slowTestFinding({
    fullName: ctx.task.fullName,
    ms: performance.now() - starts.get(ctx.task.id),
    explicit: process.env.SLOW_TEST_LIMIT_MS,
    mode: process.env.SLOW_TEST_GUARD,
    load: os.loadavg()[0],
    cpus: os.cpus().length,
  });
  starts.delete(ctx.task.id);
  if (finding?.level === 'fail') throw new Error(finding.message);
  else if (finding) process.stderr.write(`${finding.message}\n`);
});
