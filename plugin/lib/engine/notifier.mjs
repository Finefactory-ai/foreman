// Opens the project's notifier, named by config.notify.adapter. ctx carries what adapters
// need: { stateDir, project: { name }, env, now, fetch, gitEmail }. With features.notifications
// off (the resolved config, local layer included) it is always `none`: the outbox only.

import * as emailResend from '../adapters/notify/email-resend.mjs';
import * as none from '../adapters/notify/none.mjs';

const ADAPTERS = { none, 'email-resend': emailResend };

export function openNotifier({ config, ctx }) {
  const options = config.features?.notifications === false ? { adapter: 'none' } : (config.notify ?? { adapter: 'none' });
  const adapter = Object.hasOwn(ADAPTERS, options.adapter) ? ADAPTERS[options.adapter] : null;
  if (!adapter) throw new Error(`unknown notifier: ${options.adapter}`);
  return adapter.create(options, { project: config.project, ...ctx });
}
