// The detached child `foreman run` starts (startDetached in commands/run.mjs): it runs the
// supervisor through startSupervisor, so a background run is started again on new code
// (RESTART_EXIT) just as a foreground one is, and exits with the supervisor's code. Its
// arguments are the supervisor's; its folder, environment and output are what startDetached
// gave it. The supervisor writes its own pid (supervisor-pid.mjs), which is the one to stop.

import { startSupervisor } from './commands/run.mjs';

process.exitCode = await startSupervisor({
  root: process.cwd(),
  env: process.env,
  args: process.argv.slice(2),
  stderr: process.stderr,
});
