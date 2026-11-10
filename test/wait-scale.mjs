// Stretches the waits and time limits of the tests that start real supervisors, for a loaded
// machine such as a CI runner: TEST_WAIT_SCALE=3 makes each wait three times as long. The name is
// not FOREMAN_ because clean-env.mjs drops every FOREMAN_ and FACTORY_ variable in the test
// workers. A value under 1, or one that is not a number, is ignored: a wait is never shortened.

export const WAIT_SCALE_VAR = 'TEST_WAIT_SCALE';

export function waitScale(env = process.env) {
  const n = Number(env[WAIT_SCALE_VAR]);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export const slow = (ms, env = process.env) => Math.round(ms * waitScale(env));
