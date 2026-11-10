// The default notifier: writes each email to <stateDir>/outbox/<YYYYMMDD-HHMMSS>-<kind>.json
// so the owner can read it, and sends nothing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function create(options = {}, ctx = {}) {
  const { adapter, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`notifier none: unknown option ${unknown.join(', ')}`);
  const now = ctx.now ?? (() => new Date());
  return {
    async send({ kind, subject, text, html }) {
      const at = now();
      const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
      const dir = join(ctx.stateDir, 'outbox');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${stamp}-${kind}.json`);
      writeFileSync(file, `${JSON.stringify({ kind, subject, text, html, at: at.toISOString() }, null, 2)}\n`);
      return { sent: true, file };
    },
  };
}
