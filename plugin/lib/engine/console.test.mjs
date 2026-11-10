import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConsole } from './console.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-open-console-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('openConsole', () => {
  it('opens files', async () => {
    const con = openConsole({ config: { console: { adapter: 'files' } }, ctx: { stateDir: dir } });
    await con.publish({ slots: [] });
    expect(existsSync(join(dir, 'status.json'))).toBe(true);
  });

  it('opens the default dashboard as files, which its server reads', async () => {
    const con = openConsole({ config: { console: { adapter: 'dashboard', host: '127.0.0.1', port: 4317 } }, ctx: { stateDir: dir } });
    await con.publish({ slots: [] });
    expect(existsSync(join(dir, 'status.json'))).toBe(true);
  });

  it('opens files when the config names no console', () => {
    expect(() => openConsole({ config: {}, ctx: { stateDir: dir } })).not.toThrow();
  });

  it('opens artifacts with its page urls, passing the config on', async () => {
    const calls = [];
    const spawnSync = (cmd, args) => {
      calls.push(args);
      return { status: 0, stdout: `${JSON.stringify({ result: '{"set": 1, "problem": "", "control": {"handBack": {"id": "ABC-7", "at": "H"}}}' })}\n` };
    };
    const config = { slots: 2, stories: { adapter: 'markdown', idPattern: '[A-Z]+-\\d+' }, console: { adapter: 'artifacts', commandCenterUrl: 'https://pages.example/artifact/cc', decisionsUrl: 'https://pages.example/artifact/dp' } };
    const con = openConsole({ config, ctx: { stateDir: dir, spawnSync } });
    await con.publish({ slots: [] });
    expect(calls[0][1]).toContain('https://pages.example/artifact/cc');
    expect((await con.controls()).handBack).toEqual({ id: 'ABC-7', at: 'H' });
  });

  it('refuses artifacts without its urls', () => {
    expect(() => openConsole({ config: { console: { adapter: 'artifacts' } }, ctx: { stateDir: dir } })).toThrow(/commandCenterUrl/);
  });

  it('refuses an unknown console', () => {
    expect(() => openConsole({ config: { console: { adapter: 'x' } }, ctx: { stateDir: dir } })).toThrow('unknown console: x');
  });
});
