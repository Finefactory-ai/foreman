import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeServiceCommand } from './service.mjs';
import { openService } from '../../engine/service.mjs';
import { markStopped, writePid } from '../../engine/supervisor-pid.mjs';

let tmp;
let home;
let proj;
let state;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'foreman-service-cmd-'));
  home = join(tmp, 'home');
  proj = join(tmp, 'acme');
  state = join(proj, '.foreman');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }] }));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function fakeSh(answers = {}) {
  const calls = [];
  const sh = (cmd, args = []) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(answers).find((k) => line === k || line.startsWith(`${k} `));
    return { status: 0, stdout: '', stderr: '', ...(key !== undefined ? answers[key] : {}) };
  };
  sh.calls = calls;
  return sh;
}

const plist = () => join(home, 'Library', 'LaunchAgents', 'ai.foreman.acme.plist');

async function service(args, { sh = fakeSh(), platform = 'darwin', alive = () => false, env = {} } = {}) {
  let out = '';
  let err = '';
  const command = makeServiceCommand({ sh, platform, home, uid: 501, alive });
  const code = await command.run(args, { cwd: proj, root: proj, env: { PATH: '/usr/bin:/bin', ...env }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err, sh };
}

describe('foreman service install', () => {
  it('writes the launch agent, clears an old stop marker and says what it did', async () => {
    markStopped(state, new Date());
    const r = await service(['install']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(plist())).toBe(true);
    expect(existsSync(join(state, 'service-stopped'))).toBe(false);
    expect(existsSync(join(state, 'logs'))).toBe(true);
    expect(r.out).toContain(`Installed ai.foreman.acme (${plist()}).`);
    expect(r.out).toContain('each time you log in');
    expect(r.out).toContain(`Log: ${join(state, 'logs', 'supervisor.out')}`);
    expect(r.out).not.toContain('loginctl');
    expect(r.sh.calls).toContain(`launchctl bootstrap gui/501 ${plist()}`);
  });

  it('refuses inside a Foreman story session, writing nothing', async () => {
    const r = await service(['install'], { env: { FOREMAN_RUN: '1', FOREMAN_PROJECT_DIR: proj } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('foreman service install does not run inside a Foreman story session');
    expect(existsSync(plist())).toBe(false);
    expect(r.sh.calls.filter((c) => c.startsWith('launchctl'))).toEqual([]);
  });

  it('refuses while a supervisor runs', async () => {
    writePid(state, 4242);
    const r = await service(['install'], { alive: () => true });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Foreman is running (pid 4242)');
    expect(existsSync(plist())).toBe(false);
  });

  it('refuses when the label is installed for another folder', async () => {
    const other = join(tmp, 'elsewhere');
    openService({ platform: 'darwin', home, uid: 501, env: {}, sh: fakeSh(), fs, config: { project: { name: 'Acme' } }, root: other, dir: join(other, '.foreman') }).install();
    const r = await service(['install']);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`ai.foreman.acme is installed for ${other}; run \`foreman service uninstall\` there first.`);
  });

  it('on Linux, says how to start it at boot', async () => {
    const r = await service(['install'], { platform: 'linux', env: { XDG_CONFIG_HOME: join(tmp, 'xdg') } });
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, 'xdg', 'systemd', 'user', 'foreman-acme.service'))).toBe(true);
    expect(r.out).toContain('loginctl enable-linger $USER');
  });

  it('on Linux without a working systemctl --user, refuses and writes nothing', async () => {
    const sh = fakeSh({ 'systemctl --user --version': { status: 1, stderr: 'Failed to connect to bus' } });
    const r = await service(['install'], { platform: 'linux', sh, env: { XDG_CONFIG_HOME: join(tmp, 'xdg') } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('systemctl --user does not work on this computer');
    expect(existsSync(join(tmp, 'xdg', 'systemd', 'user', 'foreman-acme.service'))).toBe(false);
    expect(sh.calls.filter((c) => c.includes('enable') || c.includes('daemon-reload'))).toEqual([]);
  });

  it('refuses a project path with a control character in it, writing nothing', async () => {
    const odd = join(tmp, 'acme\nExecStartPre=x');
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }] }));
    for (const platform of ['linux', 'darwin']) {
      const sh = fakeSh();
      let err = '';
      const command = makeServiceCommand({ sh, platform, home, uid: 501, alive: () => false });
      const env = { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: join(tmp, 'xdg') };
      const code = await command.run(['install'], { cwd: odd, root: odd, env, stdout: { write: () => {} }, stderr: { write: (s) => { err += s; } } });
      expect(code).toBe(1);
      expect(err).toContain('has a control character in it');
      expect(sh.calls.filter((c) => !c.endsWith('--version'))).toEqual([]);
    }
    expect(existsSync(join(tmp, 'xdg', 'systemd', 'user', 'foreman-acme.service'))).toBe(false);
    expect(existsSync(plist())).toBe(false);
  });

  it('works on macOS and Linux only', async () => {
    const r = await service(['install'], { platform: 'win32' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('foreman service works on macOS and Linux only.');
  });
});

describe('foreman service uninstall', () => {
  it('has nothing to do when not installed', async () => {
    const r = await service(['uninstall']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Not installed; nothing to do.');
  });

  it('removes the agent', async () => {
    await service(['install']);
    const r = await service(['uninstall']);
    expect(r.code).toBe(0);
    expect(existsSync(plist())).toBe(false);
    expect(r.sh.calls).toContain('launchctl bootout gui/501/ai.foreman.acme');
    expect(r.out).toContain('resume at the next start');
  });
});

describe('foreman service status', () => {
  it('prints one line for each case', async () => {
    let r = await service(['status']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('Not installed: Foreman stops when the terminal or session that started it closes. `foreman service install` keeps it running.\n');

    await service(['install']);
    r = await service(['status'], { sh: fakeSh({ 'launchctl print': { stdout: '\tstate = running\n\tpid = 4242\n' } }) });
    expect(r.out).toBe('ai.foreman.acme: running (pid 4242).\n');

    r = await service(['status'], { sh: fakeSh({ 'launchctl print': { stdout: '\tstate = not running\n' } }) });
    expect(r.out).toBe(`ai.foreman.acme: installed but not running; see ${join(state, 'logs', 'supervisor.out')}.\n`);

    markStopped(state, new Date());
    r = await service(['status'], { sh: fakeSh({ 'launchctl print': { stdout: '\tstate = not running\n' } }) });
    expect(r.out).toBe('ai.foreman.acme: stopped with `foreman stop`; `foreman run` starts it.\n');
  });
});

describe('foreman service arguments', () => {
  it('prints the usage for an unknown or missing subcommand', async () => {
    expect((await service(['restart'])).code).toBe(64);
    const r = await service([]);
    expect(r.code).toBe(64);
    expect(r.err).toContain('usage: foreman service install|uninstall|status');
  });

  it('stops at a bad config', async () => {
    writeFileSync(join(proj, 'foreman.config.json'), '{');
    const r = await service(['status']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not valid JSON');
  });
});
