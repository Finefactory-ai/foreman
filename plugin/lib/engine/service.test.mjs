import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOREMAN_BIN, openService, serviceLabel, stableNode } from './service.mjs';

let tmp;
let home;
let root;
let dir;

beforeEach(() => {
  tmp = fs.mkdtempSync(join(tmpdir(), 'foreman-service-'));
  home = join(tmp, 'home');
  root = join(tmp, 'acme');
  dir = join(root, '.foreman');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// A fake shell: `answers` maps "cmd arg arg" (prefix match) to a result; every call is recorded.
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

const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/acme', LANG: 'en_GB.UTF-8', ANTHROPIC_API_KEY: 'sk-ant-acme-secret-value', FOREMAN_RUN: '1', OTHER: 'x' };
const config = (name = 'Acme') => ({ project: { name } });
const mac = (extra = {}) => openService({ platform: 'darwin', home, uid: 501, env: ENV, sh: fakeSh(), fs, config: config(), root, dir, node: '/opt/node/bin/node', bin: '/opt/foreman/bin/foreman', ...extra });
const linux = (extra = {}) => openService({ platform: 'linux', home, uid: 1000, env: ENV, sh: fakeSh(), fs, config: config(), root, dir, node: '/opt/node/bin/node', bin: '/opt/foreman/bin/foreman', ...extra });

describe('serviceLabel', () => {
  it('slugs the project name', () => {
    expect(serviceLabel(config('Acme Shop'), root)).toBe('ai.foreman.acme-shop');
    expect(serviceLabel(config('--Acme  Shop!--'), root)).toBe('ai.foreman.acme-shop');
  });

  it("falls back to the root's folder name, then to project", () => {
    expect(serviceLabel({}, '/srv/Acme Store')).toBe('ai.foreman.acme-store');
    expect(serviceLabel({ project: { name: '!!!' } }, '/srv/!!!')).toBe('ai.foreman.project');
  });
});

describe('the macOS launch agent', () => {
  it('runs `foreman run --foreground --service` in the project, restarting on a crash', () => {
    const svc = mac();
    expect(svc.label).toBe('ai.foreman.acme');
    expect(svc.file).toBe(join(home, 'Library', 'LaunchAgents', 'ai.foreman.acme.plist'));
    const text = svc.text();
    expect(text).toContain('<key>Label</key>\n  <string>ai.foreman.acme</string>');
    expect(text).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/opt\/foreman\/bin\/foreman<\/string>\s*<string>run<\/string>\s*<string>--foreground<\/string>\s*<string>--service<\/string>\s*<\/array>/);
    expect(text).toContain(`<key>WorkingDirectory</key>\n  <string>${root}</string>`);
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text.replace(/\s+/g, '')).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(text).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
    expect(text).toContain(`<key>StandardOutPath</key>\n  <string>${join(dir, 'logs', 'supervisor.out')}</string>`);
    expect(text).toContain(`<key>StandardErrorPath</key>\n  <string>${join(dir, 'logs', 'supervisor.out')}</string>`);
    expect(text).toMatch(/<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/);
    expect(text).toMatch(new RegExp(`<key>FOREMAN_PROJECT_DIR</key>\\s*<string>${root}</string>`));
    expect(text).not.toContain('ProcessType');
  });

  it('copies only the allow-listed variables: no keys, no FOREMAN_RUN', () => {
    const text = mac().text();
    for (const word of ['ANTHROPIC_API_KEY', 'sk-ant-acme-secret-value', 'FOREMAN_RUN', 'OTHER']) expect(text).not.toContain(word);
    expect(text).toContain('<key>LANG</key>');
  });

  it('escapes a project path with & in it', () => {
    const odd = join(tmp, 'Acme & <Co>');
    const text = mac({ root: odd, dir: join(odd, '.foreman') }).text();
    expect(text).toContain('Acme &amp; &lt;Co&gt;');
    expect(text).not.toContain('Acme & ');
  });

  it.runIf(process.platform === 'darwin')('writes a plist that plutil accepts', () => {
    const odd = join(tmp, 'Acme & Co');
    const svc = mac({ root: odd, dir: join(odd, '.foreman') });
    expect(svc.install().ok).toBe(true);
    const r = spawnSync('plutil', ['-lint', svc.file], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toContain('OK');
    expect(r.status).toBe(0);
  });

  it('install writes the file, then boots the old agent out and the new one in', () => {
    const sh = fakeSh({ 'launchctl bootout': { status: 3, stderr: 'No such process' } });
    const svc = mac({ sh });
    expect(svc.install()).toEqual({ ok: true });
    expect(fs.existsSync(svc.file)).toBe(true);
    expect(fs.statSync(svc.file).mode & 0o777).toBe(0o644);
    expect(sh.calls).toEqual([`launchctl bootout gui/501/ai.foreman.acme`, `launchctl bootstrap gui/501 ${svc.file}`]);
    expect(svc.installed()).toBe(true);
    expect(svc.info()).toEqual({ workingDirectory: root, bin: '/opt/foreman/bin/foreman', node: '/opt/node/bin/node' });
  });

  it('install removes the file again when bootstrap fails, and gives its error', () => {
    const sh = fakeSh({ 'launchctl bootstrap': { status: 5, stderr: 'Bootstrap failed: 5: Input/output error' } });
    const svc = mac({ sh });
    expect(svc.install()).toEqual({ ok: false, error: 'Bootstrap failed: 5: Input/output error' });
    expect(fs.existsSync(svc.file)).toBe(false);
    expect(svc.info()).toBeNull();
  });

  it('uninstall boots the agent out and removes the file', () => {
    const svc = mac();
    svc.install();
    const sh = fakeSh();
    const again = mac({ sh });
    again.uninstall();
    expect(sh.calls).toEqual(['launchctl bootout gui/501/ai.foreman.acme']);
    expect(fs.existsSync(again.file)).toBe(false);
  });

  it('start kickstarts the agent, and bootstraps it when that fails', () => {
    let sh = fakeSh();
    mac({ sh }).start();
    expect(sh.calls).toEqual(['launchctl kickstart gui/501/ai.foreman.acme']);
    sh = fakeSh({ 'launchctl kickstart': { status: 113 } });
    const svc = mac({ sh });
    svc.start();
    expect(sh.calls).toEqual(['launchctl kickstart gui/501/ai.foreman.acme', `launchctl bootstrap gui/501 ${svc.file}`]);
  });

  it('status reads the state and pid from launchctl print', () => {
    const print = 'gui/501/ai.foreman.acme = {\n\tactive count = 1\n\tpath = x\n\tstate = running\n\n\tprogram = /opt/node/bin/node\n\tpid = 4242\n}\n';
    const sh = fakeSh({ 'launchctl print gui/501/ai.foreman.acme': { stdout: print } });
    const svc = mac({ sh });
    svc.install();
    expect(svc.status()).toEqual({ installed: true, running: true, pid: 4242 });
    const off = mac({ sh: fakeSh({ 'launchctl print': { stdout: '\tstate = not running\n' } }) });
    expect(off.status()).toEqual({ installed: true, running: false, pid: null });
    const gone = mac({ sh: fakeSh({ 'launchctl print': { status: 113, stderr: 'Could not find service' } }) });
    gone.uninstall();
    expect(gone.status()).toEqual({ installed: false, running: false, pid: null });
  });
});

describe('the Linux systemd user unit', () => {
  it('runs the same program, restarting on a failure', () => {
    const svc = linux();
    expect(svc.file).toBe(join(home, '.config', 'systemd', 'user', 'foreman-acme.service'));
    const text = svc.text();
    expect(text).toContain('[Unit]\nDescription=Foreman for acme');
    expect(text).toContain(`WorkingDirectory=${root}`);
    expect(text).toContain('ExecStart="/opt/node/bin/node" "/opt/foreman/bin/foreman" "run" "--foreground" "--service"');
    expect(text).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(text).toContain(`Environment="FOREMAN_PROJECT_DIR=${root}"`);
    expect(text).toContain('Restart=on-failure');
    expect(text).toContain('RestartSec=60');
    expect(text).toContain(`StandardOutput=append:${join(dir, 'logs', 'supervisor.out')}`);
    expect(text).toContain(`StandardError=append:${join(dir, 'logs', 'supervisor.out')}`);
    expect(text).toContain('[Install]\nWantedBy=default.target');
    for (const word of ['ANTHROPIC_API_KEY', 'sk-ant-acme-secret-value', 'FOREMAN_RUN', 'OTHER']) expect(text).not.toContain(word);
  });

  it('a project name cannot add lines to the unit', () => {
    const text = linux({ config: config('Acme\n[Service]\nExecStartPre=/bin/sh -c "touch /tmp/acme"\r') }).text();
    const lines = text.split('\n');
    expect(lines.filter((l) => l === '[Service]')).toHaveLength(1);
    expect(lines.some((l) => l.startsWith('ExecStartPre'))).toBe(false);
    expect(text).not.toContain('\r');
    expect(lines[1]).toMatch(/^Description=Foreman for [a-z0-9-]+$/);
  });

  it('C-escapes newlines in quoted values, so they stay on one line, and reads them back', () => {
    const bin = '/opt/foreman\nExecStartPre=/bin/false\r\t/bin/foreman';
    const svc = linux({ bin, env: { ...ENV, LANG: 'en\nExecStartPre=/bin/false' } });
    const text = svc.text();
    const lines = text.split('\n');
    expect(lines.some((l) => l.startsWith('ExecStartPre'))).toBe(false);
    expect(text).not.toContain('\r');
    expect(text).toContain('"/opt/foreman\\nExecStartPre=/bin/false\\r\\t/bin/foreman"');
    expect(text).toContain('Environment="LANG=en\\nExecStartPre=/bin/false"');
    svc.install();
    expect(svc.info().bin).toBe(bin);
  });

  it('install refuses a project or log path with a control character, writing nothing', () => {
    const odd = join(tmp, 'acme\nExecStartPre=x');
    for (const make of [linux, mac]) {
      const sh = fakeSh();
      const svc = make({ sh, root: odd, dir: join(odd, '.foreman') });
      const r = svc.install();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('control character');
      expect(fs.existsSync(svc.file)).toBe(false);
      expect(sh.calls).toEqual([]);
    }
  });

  it('install writes under XDG_CONFIG_HOME, reloads and enables the unit', () => {
    const sh = fakeSh();
    const xdg = join(tmp, 'xdg');
    const svc = linux({ sh, env: { ...ENV, XDG_CONFIG_HOME: xdg } });
    expect(svc.file).toBe(join(xdg, 'systemd', 'user', 'foreman-acme.service'));
    expect(svc.install()).toEqual({ ok: true });
    expect(fs.existsSync(svc.file)).toBe(true);
    expect(sh.calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now foreman-acme.service']);
    expect(svc.info()).toEqual({ workingDirectory: root, bin: '/opt/foreman/bin/foreman', node: '/opt/node/bin/node' });
  });

  it('uninstall disables the unit, removes the file and reloads', () => {
    linux().install();
    const sh = fakeSh();
    const svc = linux({ sh });
    svc.uninstall();
    expect(sh.calls).toEqual(['systemctl --user disable --now foreman-acme.service', 'systemctl --user daemon-reload']);
    expect(fs.existsSync(svc.file)).toBe(false);
  });

  it('start, status and available go through systemctl --user', () => {
    const sh = fakeSh({ 'systemctl --user is-active': { stdout: 'active\n' }, 'systemctl --user show': { stdout: '777\n' } });
    const svc = linux({ sh });
    svc.install();
    svc.start();
    expect(sh.calls).toContain('systemctl --user start foreman-acme.service');
    expect(svc.status()).toEqual({ installed: true, running: true, pid: 777 });
    expect(sh.calls).toContain('systemctl --user show -p MainPID --value foreman-acme.service');
    expect(svc.available()).toBe(true);
    expect(linux({ sh: fakeSh({ 'systemctl --user --version': { status: 1 } }) }).available()).toBe(false);
  });
});

describe('other platforms', () => {
  it('have no service', () => {
    expect(openService({ platform: 'win32', home, uid: undefined, env: ENV, sh: fakeSh(), fs, config: config(), root, dir })).toBeNull();
  });

  it('runs this copy of Foreman by default', () => {
    expect(FOREMAN_BIN).toMatch(/plugin[\\/]bin[\\/]foreman$/);
    expect(openService({ platform: 'darwin', home, uid: 501, env: ENV, sh: fakeSh(), fs, config: config(), root, dir }).text()).toContain(`<string>${FOREMAN_BIN}</string>`);
  });

  it('starts the stable Node by default, on both platforms', () => {
    const node = stableNode(process.execPath, fs);
    const open = (extra) => openService({ platform: 'darwin', home, uid: 501, env: ENV, sh: fakeSh(), fs, config: config(), root, dir, ...extra });
    const program = open().text().match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)[1];
    expect(program).toBe(node);
    expect(open({ platform: 'linux', uid: 1000 }).text()).toContain(`ExecStart="${node}" `);
  });
});

describe('stableNode', () => {
  let brew;
  let cellar;
  beforeEach(() => {
    brew = join(tmp, 'brew');
    cellar = join(brew, 'Cellar', 'node', '26.9.0', 'bin', 'node');
    fs.mkdirSync(join(brew, 'Cellar', 'node', '26.9.0', 'bin'), { recursive: true });
    fs.writeFileSync(cellar, '');
    fs.mkdirSync(join(brew, 'bin'), { recursive: true });
  });

  it("is Homebrew's link when it points at the same Node", () => {
    fs.symlinkSync(cellar, join(brew, 'bin', 'node'));
    expect(stableNode(cellar, fs)).toBe(join(brew, 'bin', 'node'));
  });

  it('keeps the Cellar path when the link points at another Node', () => {
    const other = join(brew, 'Cellar', 'node@20', '20.19.0', 'bin', 'node');
    fs.mkdirSync(join(other, '..'), { recursive: true });
    fs.writeFileSync(other, '');
    fs.symlinkSync(other, join(brew, 'bin', 'node'));
    expect(stableNode(cellar, fs)).toBe(cellar);
  });

  it('keeps the Cellar path when there is no link', () => {
    expect(stableNode(cellar, fs)).toBe(cellar);
  });

  it('leaves a path outside a Cellar as it is', () => {
    expect(stableNode('/usr/bin/node', fs)).toBe('/usr/bin/node');
    expect(stableNode('/opt/node/bin/node', fs)).toBe('/opt/node/bin/node');
  });
});
