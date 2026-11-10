// Opens the project's console, named by config.console.adapter. ctx carries { stateDir, now };
// the config goes on to the adapter as ctx.config. `dashboard` (the default) is the files
// console plus a local server: it opens here as files, and the supervisor (or `foreman
// dashboard`) runs the server, lib/dashboard/server.mjs, over the same state folder.
// `artifacts` keeps the console on two claude.ai artifact pages instead.

import * as artifacts from '../adapters/console/artifacts.mjs';
import * as files from '../adapters/console/files.mjs';

const ADAPTERS = { files, artifacts };

export function openConsole({ config, ctx }) {
  const options = config?.console ?? { adapter: 'dashboard' };
  if (options.adapter === 'dashboard') return files.create({ adapter: 'files' }, ctx);
  const adapter = Object.hasOwn(ADAPTERS, options.adapter) ? ADAPTERS[options.adapter] : null;
  if (!adapter) throw new Error(`unknown console: ${options.adapter}`);
  return adapter.create(options, { config, ...ctx });
}
