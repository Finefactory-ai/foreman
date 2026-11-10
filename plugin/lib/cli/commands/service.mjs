// `foreman service install|uninstall|status`: runs the factory as a per-user background service
// (lib/engine/service.mjs: a launchd agent on macOS, a systemd --user unit on Linux), so it keeps
// going after the terminal or Claude session that started it closes, restarts after a crash and
// starts again at each log-in. `foreman stop` stops it until the next `foreman run`.
//
//   install     refuses while a supervisor runs, when the service's label is installed for
//               another folder, when the project or log path has a control character in it, and
//               on Linux without a working systemctl --user; else clears the stop marker and
//               starts the service
//   uninstall   stops the service (a run it had going stops now) and removes it
//   status      one line: not installed, running, stopped with `foreman stop`, or not running
//
// install and uninstall write to the user's home whatever the project, so they refuse in every
// Foreman story session (FOREMAN_RUN=1), scratch repo or not. `sh`, `platform`, `home`, `uid` and
// `alive` stand in for the real ones in tests.

import { spawnSync } from 'node:child_process';
import fs, { mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { openProject } from './console-shared.mjs';
import { refuseInRun } from '../../engine/run-guard.mjs';
import { hasControl, openService } from '../../engine/service.mjs';
import { clearStopped, defaultAlive, isStopped, runningSupervisor } from '../../engine/supervisor-pid.mjs';

const EXIT_USAGE = 64;
const USAGE = 'usage: foreman service install|uninstall|status\n';
const SUBS = new Set(['install', 'uninstall', 'status']);

const realSh = (cmd, args = []) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
};

export function makeServiceCommand({ sh = realSh, platform = process.platform, home = os.homedir(), uid = process.getuid?.(), alive = defaultAlive } = {}) {
  return {
    name: 'service',
    summary: 'keep the factory running in the background, after a crash and at log-in (service install|uninstall|status)',
    async run(args, { root, env, stdout, stderr }) {
      const sub = args[0];
      if (!SUBS.has(sub) || args.length > 1) {
        stderr.write(USAGE);
        return EXIT_USAGE;
      }
      if (sub !== 'status') {
        const refusal = refuseInRun(env, `foreman service ${sub}`);
        if (refusal) {
          stderr.write(`${refusal}\n`);
          return 1;
        }
      }
      const project = openProject({ root, env, stderr });
      if (!project) return 1;
      const { config, dir } = project;
      const svc = openService({ platform, home, uid, env, sh, fs, config, root, dir });
      if (!svc) {
        stderr.write('foreman service works on macOS and Linux only.\n');
        return 1;
      }

      if (sub === 'status') {
        stdout.write(`${statusLine(svc, dir)}\n`);
        return 0;
      }

      if (sub === 'uninstall') {
        if (!svc.installed()) {
          stdout.write('Not installed; nothing to do.\n');
          return 0;
        }
        svc.uninstall();
        stdout.write(`Removed ${svc.label}. Any run it had going was stopped now; its stories resume at the next start.\n`);
        return 0;
      }

      const pid = runningSupervisor(dir, { alive });
      if (pid !== null) {
        stderr.write(`Foreman is running (pid ${pid}). Stop it with \`foreman stop\`, and install once it has finished.\n`);
        return 1;
      }
      const owner = svc.installed() ? svc.info()?.workingDirectory : null;
      if (owner && owner !== root) {
        stderr.write(`${svc.label} is installed for ${owner}; run \`foreman service uninstall\` there first.\n`);
        return 1;
      }
      if (hasControl(root) || hasControl(svc.log)) {
        stderr.write('The project path or the log path has a control character in it, which a service file cannot hold safely; move the project to a plain path.\n');
        return 1;
      }
      if (!svc.available()) {
        stderr.write('systemctl --user does not work on this computer, so Foreman cannot run as a service here.\n');
        return 1;
      }
      mkdirSync(join(dir, 'logs'), { recursive: true });
      clearStopped(dir);
      const r = svc.install();
      if (!r.ok) {
        stderr.write(`Could not install ${svc.label}: ${r.error}\n`);
        return 1;
      }
      stdout.write(
        [
          `Installed ${svc.label} (${svc.file}).`,
          'Foreman starts now, again after a crash, and each time you log in. `foreman stop` stops it until `foreman run`.',
          `Log: ${svc.log}`,
          ...(platform === 'linux' ? ['To start it at boot before you log in, run `loginctl enable-linger $USER`.'] : []),
          '',
        ].join('\n'),
      );
      return 0;
    },
  };
}

function statusLine(svc, dir) {
  if (!svc.installed()) return 'Not installed: Foreman stops when the terminal or session that started it closes. `foreman service install` keeps it running.';
  const st = svc.status();
  if (st.running) return `${svc.label}: running${st.pid ? ` (pid ${st.pid})` : ''}.`;
  if (isStopped(dir)) return `${svc.label}: stopped with \`foreman stop\`; \`foreman run\` starts it.`;
  return `${svc.label}: installed but not running; see ${svc.log}.`;
}

export default makeServiceCommand();
