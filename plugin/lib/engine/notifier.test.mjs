import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNotifier } from './notifier.mjs';

const ctx = { stateDir: '/tmp/x', env: {} };

describe('openNotifier', () => {
  it('opens none by default and email-resend by name', () => {
    expect(typeof openNotifier({ config: {}, ctx }).send).toBe('function');
    expect(typeof openNotifier({ config: { project: { name: 'P' }, notify: { adapter: 'email-resend' } }, ctx }).send).toBe('function');
  });
  it('opens none, the outbox only, when features.notifications is off, whatever the adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-notifier-'));
    try {
      const n = openNotifier({ config: { notify: { adapter: 'email-resend', to: 'a@b.c' }, features: { notifications: false } }, ctx: { stateDir: dir, env: {}, now: () => new Date('2026-10-15T12:00:00Z') } });
      const r = await n.send({ kind: 'stopped', subject: 's', text: 't', html: 'h' });
      expect(r).toEqual({ sent: true, file: join(dir, 'outbox', '20261015-120000-stopped.json') });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses an unknown notifier', () => {
    expect(() => openNotifier({ config: { notify: { adapter: 'x' } }, ctx })).toThrow('unknown notifier: x');
    expect(() => openNotifier({ config: { notify: { adapter: 'toString' } }, ctx })).toThrow('unknown notifier: toString');
  });
});
