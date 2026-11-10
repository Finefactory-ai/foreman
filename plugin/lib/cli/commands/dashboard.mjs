// `foreman dashboard [--port N] [--host H]`: the local dashboard (lib/dashboard/server.mjs), in
// the foreground until Ctrl-C. Host and port default to config.console's (127.0.0.1:4317).
// It prints the address, never the token. `foreman run` starts the same server itself when
// console.adapter is `dashboard`, so this is for watching without a run. A project with no
// foreman.config.json is pointed at `foreman setup`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE } from '../../config/load.mjs';
import { isLoopback, startDashboard } from '../../dashboard/server.mjs';
import { RUN_SETUP } from '../../setup/steps.mjs';
import { openProject } from './console-shared.mjs';

const USAGE = 'usage: foreman dashboard [--port N] [--host H]\n';

// Resolves on Ctrl-C (or a kill), so the command can close the server and return.
export function untilSignal() {
  return new Promise((resolve) => {
    const done = () => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}

// The line for a dashboard that would not start: a port in use, or a host without a token.
export function startFailure(err) {
  const why = err?.code === 'EADDRINUSE' ? 'that port is in use (is a run already serving the dashboard?); try --port' : err?.message ?? String(err);
  return `The dashboard did not start: ${why}\n`;
}

export default {
  name: 'dashboard',
  summary: 'the local dashboard, until Ctrl-C (dashboard [--port N] [--host H])',

  async run(args, { root, env, stdout, stderr, now, until }) {
    let values;
    try {
      ({ values } = parseArgs({ args, options: { port: { type: 'string' }, host: { type: 'string' } }, strict: true }));
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return 64;
    }
    if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535)) {
      stderr.write(`--port needs a port number from 0 to 65535, not ${values.port}.\n${USAGE}`);
      return 64;
    }
    if (values.host !== undefined && !values.host) {
      stderr.write(`--host needs a host name or address.\n${USAGE}`);
      return 64;
    }
    if (!existsSync(join(root, CONFIG_FILE))) {
      stderr.write(`${RUN_SETUP}\n`);
      return 1;
    }
    const project = openProject({ root, env, stderr });
    if (!project) return 1;

    let started;
    try {
      started = await startDashboard({
        root,
        config: project.config,
        stateDir: project.dir,
        env,
        now,
        host: values.host,
        port: values.port === undefined ? undefined : Number(values.port),
      });
    } catch (err) {
      stderr.write(startFailure(err));
      return 1;
    }
    const { server, url } = started;
    const host = values.host ?? project.config.console?.host ?? '127.0.0.1';
    stdout.write(`Dashboard: ${url}\n`);
    if (!isLoopback(host)) stdout.write('Every request needs the token in FOREMAN_DASHBOARD_TOKEN (Authorization: Bearer, or ?token= on the page address).\n');
    stdout.write('Ctrl-C stops it.\n');

    await (until ?? untilSignal());
    await new Promise((resolve) => server.close(() => resolve()));
    return 0;
  },
};
