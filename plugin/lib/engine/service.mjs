// The factory as a per-user background service: a launchd agent on macOS, a systemd --user unit
// on Linux. The service manager runs `foreman run --foreground --service` in the project, restarts
// it after a crash (a non-zero exit or a signal, never after a clean exit such as `foreman stop`)
// and starts it again at each log-in. `foreman stop` leaves a marker
// (supervisor-pid.mjs) that the --service run honours, so a stopped factory stays stopped.
//
//   serviceLabel(config, root) -> 'ai.foreman.<slug>', the slug from project.name, else the
//       root's folder name, else 'project'
//   openService({ platform, home, uid, env, sh, fs, config, root, dir, bin?, node? }) -> null on
//       a platform other than darwin and linux, else
//       { label, file, log, installed(), available(),
//         info() -> { workingDirectory, bin, node } | null, text(), install() -> { ok, error? },
//         uninstall(), start() -> { ok, error? }, status() -> { installed, running, pid } }
//   stableNode(execPath, fs) -> the Node the service starts by default
//
// The service outlives the Node that installed it, so it starts Node by a path an upgrade
// keeps. Homebrew's process.execPath is versioned (<prefix>/Cellar/node/26.9.0/bin/node) and
// goes away at the next `brew upgrade node`; stableNode takes Homebrew's link <prefix>/bin/node
// instead, but only while that link resolves to the very same file, so the service runs the
// Node that installed it. Any other path is kept. The doctor warns when the Node a service
// starts is not there any more (doctor-checks.mjs 'background service').
//
// Every outside call goes through `sh(cmd, args) -> { status, stdout, stderr }` and `fs`. On
// Linux the label is the unit's name (foreman-<slug>.service), the name systemctl takes.
//
// The service's environment is an allow-list copied from `env` (ENV_NAMES) plus
// FOREMAN_PROJECT_DIR: launchd starts a program with a bare PATH, and the supervisor needs
// claude, git, gh and caffeinate on it. Nothing else is copied, so no key and no FOREMAN_RUN is
// ever written into the file; the supervisor reads the Claude sign-in from .env.foreman itself.
// Output and errors are appended to <stateDir>/logs/supervisor.out.
//
// The unit file is lines of text, so no value may break a line: the Description takes the slug,
// quoted values C-escape control characters (systemd decodes them), and install() refuses a
// project or log path with a control character in it (hasControl), on both platforms, before
// it writes anything or calls the service manager.

import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FOREMAN_BIN = fileURLToPath(new URL('../../bin/foreman', import.meta.url));

const ENV_NAMES = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'FOREMAN_STATE_DIR', 'FOREMAN_PLUGIN_DIR', 'CLAUDE_CONFIG_DIR'];
const LOG = (dir) => join(dir, 'logs', 'supervisor.out');

const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const CELLAR_NODE = /^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/;

export function stableNode(execPath, fs) {
  const prefix = String(execPath).match(CELLAR_NODE)?.[1];
  if (prefix === undefined) return execPath;
  const link = `${prefix}/bin/node`;
  try {
    return fs.realpathSync(link) === fs.realpathSync(execPath) ? link : execPath;
  } catch {
    return execPath;
  }
}

const serviceSlug = (config, root) => slug(config?.project?.name) || slug(basename(String(root ?? ''))) || 'project';

export const serviceLabel = (config, root) => `ai.foreman.${serviceSlug(config, root)}`;

function serviceEnv(env, root) {
  const out = {};
  for (const name of ENV_NAMES) if (env?.[name]) out[name] = String(env[name]);
  out.FOREMAN_PROJECT_DIR = root;
  return out;
}

const CONTROL = /[\x00-\x1f\x7f]/;
export const hasControl = (s) => CONTROL.test(String(s ?? ''));
const CONTROL_PATH = 'the project path or the log path has a control character in it';

const ok = (r) => r?.status === 0;
const why = (r, what) => String(r?.stderr || r?.stdout || `${what} exited ${r?.status}`).trim();

function readText(fs, file) {
  try {
    return String(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeText(fs, file, text) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
}

// macOS: a property list in ~/Library/LaunchAgents, run in the user's GUI session.

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function plist({ label, program, root, env, log }) {
  const str = (v, pad) => `${pad}<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    str(label, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...program.map((a) => str(a, '    ')),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    str(root, '  '),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, str(v, '    ')]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>60</integer>',
    '  <key>StandardOutPath</key>',
    str(log, '  '),
    '  <key>StandardErrorPath</key>',
    str(log, '  '),
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function plistInfo(text) {
  if (text === null) return null;
  const wd = text.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/);
  const args = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const strings = args ? [...args[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1])) : [];
  return { workingDirectory: wd ? unxml(wd[1]) : null, bin: strings[1] ?? null, node: strings[0] ?? null };
}

function launchdService({ label, file, log, program, root, env, uid, sh, fs }) {
  const target = `gui/${uid}/${label}`;
  const text = () => plist({ label, program, root, env, log });
  const installed = () => fs.existsSync(file);
  return {
    label,
    file,
    log,
    installed,
    available: () => true,
    text,
    info: () => plistInfo(readText(fs, file)),
    install() {
      if (hasControl(root) || hasControl(log)) return { ok: false, error: CONTROL_PATH };
      writeText(fs, file, text());
      sh('launchctl', ['bootout', target]);
      const r = sh('launchctl', ['bootstrap', `gui/${uid}`, file]);
      if (ok(r)) return { ok: true };
      fs.rmSync(file, { force: true });
      return { ok: false, error: why(r, 'launchctl bootstrap') };
    },
    uninstall() {
      sh('launchctl', ['bootout', target]);
      fs.rmSync(file, { force: true });
      return { ok: true };
    },
    start() {
      if (ok(sh('launchctl', ['kickstart', target]))) return { ok: true };
      const r = sh('launchctl', ['bootstrap', `gui/${uid}`, file]);
      return ok(r) ? { ok: true } : { ok: false, error: why(r, 'launchctl bootstrap') };
    },
    status() {
      const r = sh('launchctl', ['print', target]);
      const out = ok(r) ? String(r.stdout ?? '') : '';
      const state = out.match(/^\s*state = (\S+)/m)?.[1];
      const pid = out.match(/^\s*pid = (\d+)/m)?.[1];
      const running = state === 'running';
      return { installed: installed(), running, pid: running && pid ? Number(pid) : null };
    },
  };
}

// Linux: a systemd user unit in ~/.config/systemd/user (or $XDG_CONFIG_HOME/systemd/user).

// systemd expands %specifiers everywhere and $VARIABLES in ExecStart; quoted values take C
// escapes, so a newline in a value stays inside its line as \n.
const noSpec = (s) => String(s).replace(/%/g, '%%');
const C_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const C_CHARS = { n: '\n', r: '\r', t: '\t' };
const cEscape = (s) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f\x7f]/g, (c) => C_ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
const quoted = (s) => `"${cEscape(noSpec(s))}"`;
const unquote = (s) =>
  s.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, e) => (e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : (C_CHARS[e] ?? e))).replace(/%%/g, '%');

function unit({ name, program, root, env, log }) {
  return [
    '[Unit]',
    `Description=Foreman for ${name}`,
    '',
    '[Service]',
    `WorkingDirectory=${noSpec(root)}`,
    `ExecStart=${program.map((a) => quoted(a).replace(/\$/g, '$$$$')).join(' ')}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}`),
    'Restart=on-failure',
    'RestartSec=60',
    `StandardOutput=append:${noSpec(log)}`,
    `StandardError=append:${noSpec(log)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function unitInfo(text) {
  if (text === null) return null;
  const wd = text.match(/^WorkingDirectory=(.*)$/m);
  const exec = text.match(/^ExecStart=(.*)$/m);
  const args = exec ? [...exec[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => unquote(m[1]).replace(/\$\$/g, '$')) : [];
  return { workingDirectory: wd ? wd[1].replace(/%%/g, '%') : null, bin: args[1] ?? null, node: args[0] ?? null };
}

function systemdService({ unitName, name, file, log, program, root, env, sh, fs }) {
  const text = () => unit({ name, program, root, env, log });
  const installed = () => fs.existsSync(file);
  const systemctl = (...args) => sh('systemctl', ['--user', ...args]);
  return {
    label: unitName,
    file,
    log,
    installed,
    available: () => ok(systemctl('--version')),
    text,
    info: () => unitInfo(readText(fs, file)),
    install() {
      if (hasControl(root) || hasControl(log)) return { ok: false, error: CONTROL_PATH };
      writeText(fs, file, text());
      systemctl('daemon-reload');
      const r = systemctl('enable', '--now', unitName);
      if (ok(r)) return { ok: true };
      fs.rmSync(file, { force: true });
      systemctl('daemon-reload');
      return { ok: false, error: why(r, 'systemctl --user enable') };
    },
    uninstall() {
      systemctl('disable', '--now', unitName);
      fs.rmSync(file, { force: true });
      systemctl('daemon-reload');
      return { ok: true };
    },
    start() {
      const r = systemctl('start', unitName);
      return ok(r) ? { ok: true } : { ok: false, error: why(r, 'systemctl --user start') };
    },
    status() {
      const running = String(systemctl('is-active', unitName)?.stdout ?? '').trim() === 'active';
      const pid = Number(String(systemctl('show', '-p', 'MainPID', '--value', unitName)?.stdout ?? '').trim());
      return { installed: installed(), running, pid: running && pid > 0 ? pid : null };
    },
  };
}

export function openService({ platform, home, uid, env, sh, fs, config, root, dir, bin = FOREMAN_BIN, node = stableNode(process.execPath, fs) }) {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const program = [node, bin, 'run', '--foreground', '--service'];
  const common = { program, root, env: serviceEnv(env, root), log: LOG(dir), sh, fs };
  if (platform === 'darwin') {
    const label = serviceLabel(config, root);
    return launchdService({ ...common, label, uid, file: join(home, 'Library', 'LaunchAgents', `${label}.plist`) });
  }
  const unitName = `foreman-${serviceSlug(config, root)}.service`;
  const base = env?.XDG_CONFIG_HOME || join(home, '.config');
  return systemdService({ ...common, unitName, name: serviceSlug(config, root), file: join(base, 'systemd', 'user', unitName) });
}
