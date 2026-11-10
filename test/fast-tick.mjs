// A short supervisor tick for the tests that start one (`foreman run`, `cloud tick`, `cloud
// run`): spread fastTick into the child's env after the FOREMAN_* variables are dropped, and
// write fixed waits as multiples of TEST_TICK_MS. The supervisor reads it as FOREMAN_TICK_MS
// (tickMs in plugin/lib/engine/wake.mjs). A test whose point is the real 5 s tick leaves it out.
export const TEST_TICK_MS = 500;
export const fastTick = { FOREMAN_TICK_MS: String(TEST_TICK_MS) };
