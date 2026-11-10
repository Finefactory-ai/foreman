import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandList, main, projectRoot } from './main.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

function run(argv, opts = {}) {
  let out = '';
  let err = '';
  const ctx = {
    cwd: '/tmp',
    env: {},
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    ...opts,
  };
  return main(argv, ctx).then((code) => ({ code, out, err }));
}

describe('main', () => {
  for (const argv of [[], ['--help'], ['help']]) {
    it(`prints usage for ${JSON.stringify(argv)}`, async () => {
      const { code, out } = await run(argv);
      expect(code).toBe(0);
      expect(out).toMatch(/^config\s+\S/m);
    });
  }

  it('lists the release command', async () => {
    const { out } = await run(['--help']);
    expect(out).toMatch(/^release\s+finish parked releases \(release watch\)$/m);
  });

  it('lists the setup command right after doctor', async () => {
    const { out } = await run(['--help']);
    const names = out.split('\n').map((l) => l.split(/\s+/)[0]);
    expect(names).toContain('setup');
    expect(names.indexOf('setup')).toBe(names.indexOf('doctor') + 1);
  });

  it('lists the pack commands, and dispatches to them', async () => {
    const { out } = await run(['--help']);
    expect(out).toMatch(/^sf\s+Salesforce pack tools \(sf skills, sf deletes allow\|keep-out <id>, sf baseline \[--refresh\|--story\], sf rollback <id>, sf fixed <stage>\)$/m);
    const sf = await run(['sf']);
    expect(sf.code).toBe(64);
    expect(sf.err).toContain('usage: foreman sf skills');
    expect(sf.err).not.toContain('unknown command');
  });

  it('commandList adds the pack commands after the core ones, and refuses a clash', () => {
    const core = [{ name: 'doctor', summary: 'd', run: () => 0 }];
    const extra = { name: 'acme', summary: 'a', run: () => 0 };
    expect(commandList(core, { acme: fakePack({ commands: [extra] }) }).map((c) => c.name)).toEqual(['doctor', 'acme']);
    const clash = { acme: fakePack({ commands: [{ name: 'doctor', summary: 'x', run: () => 0 }] }) };
    expect(() => commandList(core, clash)).toThrow('pack command doctor clashes with a command');
    const twice = { acme: fakePack({ commands: [extra] }), zeta: fakePack({ name: 'zeta', commands: [extra] }) };
    expect(() => commandList(core, twice)).toThrow('pack command acme clashes with a command');
  });

  it('rejects an unknown command with exit 64', async () => {
    const { code, err, out } = await run(['nope']);
    expect(code).toBe(64);
    expect(err).toContain('unknown command: nope');
    expect(err).toContain('foreman --help');
    expect(out).toBe('');
  });

  it('projectRoot prefers FOREMAN_PROJECT_DIR, else cwd', () => {
    expect(projectRoot({ cwd: '/a', env: { FOREMAN_PROJECT_DIR: '/b' } })).toBe('/b');
    expect(projectRoot({ cwd: '/a', env: {} })).toBe('/a');
  });

  it('the bin launcher runs', () => {
    const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/foreman');
    const res = spawnSync(bin, ['--help'], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('config');
  });
});
