import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cli-'));
});

function write(config) {
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
}

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: {},
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

const valid = { version: 1, project: { name: 'T' }, checks: [{ run: 'npm test', when: 'always' }] };

describe('foreman config check', () => {
  it('prints ok for a valid config', async () => {
    write(valid);
    expect(await run(['config', 'check'])).toMatchObject({ code: 0, out: 'ok\n' });
  });

  it('prints path: message per error and exits 1', async () => {
    write({ ...valid, slot: 2 });
    const { code, out } = await run(['config', 'check']);
    expect(code).toBe(1);
    expect(out).toContain('slot: unknown key\n');
  });

  it('warns about the deprecated top-level keepAwake and still passes', async () => {
    write({ ...valid, keepAwake: false });
    const { code, out } = await run(['config', 'check']);
    expect(code).toBe(0);
    expect(out).toContain('warning: keepAwake is deprecated; it is read as features.keepAwake');
    expect(out.endsWith('ok\n')).toBe(true);
  });

  it('refuses a learning window below 3', async () => {
    write({ ...valid, learning: { window: 1 } });
    const { code, out } = await run(['config', 'check']);
    expect(code).toBe(1);
    expect(out).toContain('learning.window: must be an integer of at least 3');
  });

  it('prints whole-file errors without a path prefix', async () => {
    const { code, out } = await run(['config', 'check']);
    expect(code).toBe(1);
    expect(out).toMatch(/^no foreman\.config\.json in /);
    expect(out).not.toMatch(/^: /);
  });
});

describe('foreman config show', () => {
  it('prints the merged config as pretty JSON', async () => {
    write(valid);
    const { code, out } = await run(['config', 'show']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.project.name).toBe('T');
    expect(out).toContain('\n  "version": 1');
    expect(Object.keys(parsed).length).toBeGreaterThan(Object.keys(valid).length);
  });

  it('shows the learning defaults', async () => {
    write({ version: 1, project: { name: 'Acme' } });
    const { code, out } = await run(['config', 'show']);
    expect(code).toBe(0);
    expect(JSON.parse(out).learning).toEqual({ auto: true, apply: true, model: 'haiku', skillModel: 'sonnet', window: 5, maxPerRole: 8, maxSkills: 10, maxEvaluating: 2, maxPerDay: 3, maxUsdPerDay: 2, redact: [] });
  });

  it('reports errors like check and exits 1', async () => {
    write({ ...valid, slot: 2 });
    const { code, out } = await run(['config', 'show']);
    expect(code).toBe(1);
    expect(out).toContain('slot: unknown key');
  });
});

describe('foreman config usage', () => {
  for (const argv of [['config'], ['config', 'bogus']]) {
    it(`prints usage and exits 64 for ${JSON.stringify(argv)}`, async () => {
      const { code, out, err } = await run(argv);
      expect(code).toBe(64);
      expect(out + err).toMatch(/check/);
      expect(out + err).toMatch(/show/);
    });
  }
});
