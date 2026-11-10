import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifierContract } from './contract.mjs';
import { create } from './none.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-notify-none-'));
});
const make = () => create({ adapter: 'none' }, { stateDir: dir, now: () => new Date('2026-10-15T09:08:07Z') });

notifierContract({ name: 'none', make });

describe('none notifier', () => {
  it('writes exactly one outbox file named by time and kind', async () => {
    const r = await make().send({ kind: 'stopped', subject: 'Factory stopped', text: 't', html: '<p>h</p>' });
    expect(r.sent).toBe(true);
    const files = fs.readdirSync(path.join(dir, 'outbox'));
    expect(files).toEqual(['20261015-090807-stopped.json']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'outbox', files[0]), 'utf8'))).toEqual({
      kind: 'stopped',
      subject: 'Factory stopped',
      text: 't',
      html: '<p>h</p>',
      at: '2026-10-15T09:08:07.000Z',
    });
  });
  it('refuses unknown options', () => {
    expect(() => create({ adapter: 'none', to: 'a@b.c' }, { stateDir: dir })).toThrow(/to/);
  });
});
