// The owner's controls from the command line. Each writes through lib/console/control.mjs, which
// the supervisor reads each tick, and prints one line. The checks are lib/console/commands.mjs.
// `foreman stop` records who ran it (lib/console/stopper.mjs): this process, its parent command,
// its folder, and FOREMAN_RUN, FOREMAN_STORY and FOREMAN_SLOT from the environment.
//
//   foreman pause | resume | stop | fixed
//   foreman stop --now              stop, then end the supervisor at once with SIGTERM
//   foreman slot <wN> <action>      skip, takeover, park, unpark, resume, restart, resume-as-is, discard
//   foreman workers <n>             1 to config.slots
//   foreman handback <id>           give a story the owner took back to the factory
//   foreman next <id>               build this story next, if it can be built now
//
// `stop --now` writes the same STOP and service-stopped marker first, with the same record of
// who ran it, so a service restart honours it, then signals only the pid runningSupervisor
// (supervisor-pid.mjs) vouches for: a live process running supervisor.mjs. A stale pid file, or
// one whose pid another program now holds, signals nothing. The supervisor's SIGTERM handler stops its sessions; their claims
// stay, so the next start resumes them by priority. makeStopCommand({ alive, kill })
// takes the check and the signal for tests. A story session is refused by the run guard.

import { ownerCommand } from '../../console/commands.mjs';
import { ACTIONS } from '../../engine/scheduler.mjs';
import { defaultAlive, runningSupervisor } from '../../engine/supervisor-pid.mjs';
import { openProject } from './console-shared.mjs';
import { stopperOf } from '../../console/stopper.mjs';

// A command that opens the project, turns its arguments into an owner command (null: print
// the usage) and applies it through lib/console/commands.mjs, which the dashboard shares, so
// both check the input the same way. Prints the line it answers, or the reason it refused.
function command(name, summary, usage, request) {
  return {
    name,
    summary,
    async run(args, { root, env, cwd, stdout, stderr, now }) {
      const project = openProject({ root, env, stderr });
      if (!project) return 1;
      const clock = (now ?? (() => new Date()))();
      const req = request(args);
      if (req === null) {
        stderr.write(`usage: foreman ${usage}\n`);
        return 1;
      }
      try {
        const by = req.action === 'stop' ? stopperOf({ via: 'cli', env, cwd: cwd ?? process.cwd(), at: clock }) : undefined;
        stdout.write(`${ownerCommand(project.dir, project.config, req, clock, by)}\n`);
        return 0;
      } catch (err) {
        stderr.write(`${err.message}\n`);
        return 1;
      }
    },
  };
}

export const pause = command('pause', 'start no new stories until resume', 'pause', () => ({ action: 'pause' }));

export const resume = command('resume', 'start stories again after a pause', 'resume', () => ({ action: 'resume' }));

export function makeStopCommand({ alive = defaultAlive, kill = (pid, sig) => process.kill(pid, sig) } = {}) {
  return {
    name: 'stop',
    summary: 'finish the stories in progress, then stop the run (stop [--now] stops it at once)',
    async run(args, { root, env, cwd, stdout, stderr, now }) {
      const project = openProject({ root, env, stderr });
      if (!project) return 1;
      const clock = (now ?? (() => new Date()))();
      const nowFlag = args.length === 1 && args[0] === '--now';
      if (args.length > 0 && !nowFlag) {
        stderr.write('usage: foreman stop [--now]\n');
        return 1;
      }
      try {
        const by = stopperOf({ via: 'cli', env, cwd: cwd ?? process.cwd(), at: clock });
        stdout.write(`${ownerCommand(project.dir, project.config, { action: 'stop' }, clock, by)}\n`);
      } catch (err) {
        stderr.write(`${err.message}\n`);
        return 1;
      }
      if (!nowFlag) return 0;
      const pid = runningSupervisor(project.dir, { alive });
      if (pid === null) {
        stdout.write('No Foreman supervisor is running here, so nothing was stopped now.\n');
        return 0;
      }
      try {
        kill(pid, 'SIGTERM');
      } catch (err) {
        if (err?.code === 'ESRCH') {
          stdout.write(`The supervisor (pid ${pid}) had already stopped.\n`);
          return 0;
        }
        stderr.write(`Could not stop the supervisor (pid ${pid}): ${err.message}\n`);
        return 1;
      }
      stdout.write(`Stopped the supervisor (pid ${pid}) now: the stories in progress were cut off, and resume by priority at the next start.\n`);
      return 0;
    },
  };
}

export const stop = makeStopCommand();

export const slot = command('slot', 'act on one slot (slot <wN> <action>)', `slot <wN> <${[...ACTIONS].join('|')}>`, ([id, action]) =>
  id && action ? { action: 'slot', slot: id, slotAction: action } : null,
);

export const workers = command('workers', 'how many slots build at once (workers <n>)', 'workers <n>', ([n]) => (n ? { action: 'workers', n } : null));

export const fixed = command('fixed', "say the cause of a halt is fixed", 'fixed', () => ({ action: 'fixed' }));

export const handback = command('handback', 'give a story you took back to the factory (handback <id>)', 'handback <story id>', ([id]) =>
  id ? { action: 'handback', id } : null,
);

export const next = command('next', 'build this story next (next <id>)', 'next <story id>', ([id]) => (id ? { action: 'next', id } : null));

export const CONTROL_COMMANDS = [pause, resume, stop, slot, workers, fixed, handback, next];
