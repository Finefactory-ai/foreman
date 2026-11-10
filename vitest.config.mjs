import os from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests sit next to the code they test.
// The suite is two projects, which share the cores this run may use (testCores): one worker per
// core in all, so an idle machine runs on every core and a busy one is not oversubscribed twice
// over. unit gets a third of them and waits the rest.
// - 'waits': files that mostly wait on child processes rather than compute: a child supervisor
//   (`foreman run`, `cloud tick`, `cloud run`), git against a local remote, the hook or sf
//   wrapper run for real, a set-up check's child, the fake Atlassian in a worker thread. They have their own pool,
//   running beside unit's, and get two cores in three, since they hold most of the suite's
//   file-seconds while mostly waiting rather than computing.
// - 'unit': every other file.
// `npm test` (test/run-suite.mjs) runs the two at the same time, as two vitest processes, since
// one vitest run puts projects with different worker caps in different groups, one after the
// other. Every test and hook gets 30 s instead of vitest's 5 s, a test that fails is tried once
// more, and test/slow-guard.mjs fails a test over 5 s (stretched by the machine's load past one
// runnable process per core) that test/slow-tests.mjs does not list, when the machine is idle
// (under 0.5 load per core). On a busy machine, or with SLOW_TEST_GUARD=report, it prints a
// `slow-test guard warning:` line instead.
//
// FOREMAN_TEST_CORES is the number of cores this run may use. A story session gets it from the
// supervisor as its share of the machine (session.mjs testCoreShare), so several slots running
// tests at once do not each take every core. Unset (the owner's own `npm test`), or not a
// positive whole number, it is all the cores (`os.availableParallelism()`). The main vitest
// process reads this file before test/clean-env.mjs, which takes FOREMAN_* out only inside the
// test workers, so the variable sets the workers while a test file importing this config still
// sees all the cores.

// Workers for each project on a machine with `cores` cores: the two together have one per core,
// unit a third (rounded down) and waits the rest, and each has at least one, also when the count
// is not a positive whole number. Numbers, not '%' strings: vitest caps those at 100% for each
// project on its own.
export function workersFor(cores) {
  const n = Number.isInteger(cores) && cores > 0 ? cores : 1;
  const unit = Math.max(1, Math.floor(n / 3));
  return { unit, waits: Math.max(1, n - unit) };
}

// The cores this run may use: FOREMAN_TEST_CORES when it is a positive whole number, else `cores`.
export function testCores(env = process.env, cores = os.availableParallelism()) {
  const n = Number(env?.FOREMAN_TEST_CORES);
  return Number.isInteger(n) && n > 0 ? n : cores;
}

export const WORKERS = workersFor(testCores());

export const ALL = ['plugin/lib/**/*.test.mjs', 'plugin/packs/**/*.test.mjs', 'test/**/*.test.mjs', 'workshop/**/*.test.mjs'];
export const WAITS = [
  'plugin/lib/engine/supervisor-*.test.mjs',
  'test/cloud-tick*.test.mjs',
  'test/cloud-run.test.mjs',
  'test/supervisors.test.mjs',
  'plugin/lib/cli/commands/run*.test.mjs',
  'plugin/lib/state-store/branch.test.mjs',
  'plugin/lib/state-store/branch-sync.test.mjs',
  'plugin/lib/state-store/branch-sync-recovery.test.mjs',
  'plugin/lib/state-store/with-state.test.mjs',
  'plugin/lib/state-store/with-state-clones.test.mjs',
  'plugin/lib/hooks/agent-events.test.mjs',
  'plugin/lib/hooks/agent-events-files.test.mjs',
  'plugin/lib/hooks/agent-events-scratch.test.mjs',
  'plugin/lib/hooks/agent-events-contract.test.mjs',
  'plugin/lib/cli/commands/checks-start.test.mjs',
  'plugin/lib/cli/anchor-guard.test.mjs',
  'plugin/lib/cli/anchor-guard-refused.test.mjs',
  'plugin/lib/cli/anchor-guard-owner.test.mjs',
  'plugin/lib/adapters/stories/jira-write.test.mjs',
  'plugin/lib/adapters/stories/jira.test.mjs',
  'plugin/lib/cli/commands/story-jira.test.mjs',
  'plugin/packs/salesforce/isolation.test.mjs',
  'plugin/packs/salesforce/rollback.test.mjs',
  'plugin/packs/salesforce/stage-merge.test.mjs',
  'plugin/packs/salesforce/prod-block.test.mjs',
  'plugin/lib/engine/slot-prepare.test.mjs',
  'plugin/lib/dashboard/setup-api.test.mjs',
  'plugin/lib/dashboard/setup-slow-check.test.mjs',
  'plugin/lib/dashboard/state-sync.test.mjs',
  'plugin/packs/salesforce/sf-command.test.mjs',
  'plugin/packs/salesforce/skills.test.mjs',
];

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/clean-env.mjs', './test/slow-guard.mjs'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 1,
    projects: [
      { extends: true, test: { name: 'waits', include: WAITS, maxWorkers: WORKERS.waits, sequence: { groupOrder: 0 } } },
      {
        extends: true,
        test: { name: 'unit', include: ALL, exclude: [...configDefaults.exclude, ...WAITS], maxWorkers: WORKERS.unit, sequence: { groupOrder: 1 } },
      },
    ],
  },
});
