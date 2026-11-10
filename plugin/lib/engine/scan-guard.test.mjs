import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SCAN_HELP, scanCommandReason, scanRoots, scanStarts, scanToolReason, sessionScanRoots } from './scan-guard.mjs';

// A made-up project: anchor /acme, its state folder inside it, a slot worktree under that, and
// the owner's home folder /h/acme.
const ROOTS = ['/acme', '/acme/.foreman', '/h/acme/.claude', '/tmp', '/p/plugin'];
const CWD = '/acme/.foreman/worktrees/w1';
const VARS = { HOME: '/h/acme' };
const OWNER = path.join(path.parse(os.tmpdir()).root, 'Users', 'acme');

const deny = (command, over = {}) => scanCommandReason({ command, cwd: CWD, vars: VARS, roots: ROOTS, ...over });
const words = (s) => s.match(/'[^']*'|\S+/g).map((w) => w.replace(/^'|'$/g, ''));
const incident = 'find / -name "CHANGELOG.md" -path "*claude-code*"';

describe('scanRoots', () => {
  const base = { anchor: '/acme', stateDirPath: '/acme/.foreman', home: '/h/acme', claudeConfigDir: '/cfg/claude', tmpDirs: ['/tmp', '/tmp'], pluginRoot: '/p/plugin' };

  it('lists the anchor, state, config folder, home/.claude, temp folders and plugin root, deduped', () => {
    expect(scanRoots(base)).toEqual(['/acme', '/acme/.foreman', '/cfg/claude', '/h/acme/.claude', '/tmp', '/p/plugin']);
  });

  it('keeps only non-empty strings', () => {
    expect(scanRoots({ ...base, claudeConfigDir: '', home: undefined, tmpDirs: [null, '/tmp'] })).toEqual(['/acme', '/acme/.foreman', '/tmp', '/p/plugin']);
  });

  it('drops /, the home folder and a parent of home', () => {
    const roots = scanRoots({ ...base, anchor: '/h/acme', tmpDirs: ['/', '/h', '/tmp'], claudeConfigDir: '/h/acme' });
    expect(roots).toEqual(['/acme/.foreman', '/h/acme/.claude', '/tmp', '/p/plugin']);
  });
});

describe('scanStarts', () => {
  it('find', () => {
    expect(scanStarts(words('find / -name x'))).toEqual({ name: 'find', starts: ['/'] });
    expect(scanStarts(words('find -L . a -type f'))).toEqual({ name: 'find', starts: ['.', 'a'] });
    expect(scanStarts(words('find -name x'))).toEqual({ name: 'find', starts: ['.'] });
    expect(scanStarts(words('find -H -f /x -name y'))?.starts).toEqual(['/x']);
    expect(scanStarts(words('find ( -name x )'))?.starts).toEqual(['.']);
  });

  it('find: -- ends the options, and the starts follow it', () => {
    expect(scanStarts(words('find -- / -name x'))).toEqual({ name: 'find', starts: ['/'] });
    expect(scanStarts(words('find -L -- /h/acme'))).toEqual({ name: 'find', starts: ['/h/acme'] });
    expect(scanStarts(words('find --'))).toEqual({ name: 'find', starts: ['.'] });
  });

  it('du', () => {
    expect(scanStarts(words('du -d 1 /h/acme'))).toEqual({ name: 'du', starts: ['/h/acme'] });
    expect(scanStarts(words('du -sh'))).toEqual({ name: 'du', starts: ['.'] });
    expect(scanStarts(words('du --max-depth=1 /'))?.starts).toEqual(['/']);
    expect(scanStarts(words('du --max-depth 1 /'))?.starts).toEqual(['/']);
  });

  it('ls only when recursive', () => {
    expect(scanStarts(words('ls -la src'))).toBeNull();
    expect(scanStarts(words('ls -laR /'))).toEqual({ name: 'ls', starts: ['/'] });
    expect(scanStarts(words('ls --recursive'))).toEqual({ name: 'ls', starts: ['.'] });
  });

  it('grep and egrep only when recursive', () => {
    expect(scanStarts(words('grep -rn /api/users src'))).toEqual({ name: 'grep', starts: ['src'] });
    expect(scanStarts(words('grep -r -e foo /'))).toEqual({ name: 'grep', starts: ['/'] });
    expect(scanStarts(words('grep -R foo'))).toEqual({ name: 'grep', starts: ['.'] });
    expect(scanStarts(words('grep foo /etc/hosts'))).toBeNull();
    expect(scanStarts(words('grep -d recurse foo /'))).toEqual({ name: 'grep', starts: ['/'] });
    expect(scanStarts(words('grep --directories=recurse foo /'))?.starts).toEqual(['/']);
    expect(scanStarts(words('grep --recursive foo /x'))?.starts).toEqual(['/x']);
    expect(scanStarts(words('egrep -r foo /'))).toEqual({ name: 'egrep', starts: ['/'] });
    expect(scanStarts(words('grep -rA 3 foo /'))?.starts).toEqual(['/']);
  });

  it('rg is always recursive', () => {
    expect(scanStarts(words('rg x /'))).toEqual({ name: 'rg', starts: ['/'] });
    expect(scanStarts(words('rg x'))).toEqual({ name: 'rg', starts: ['.'] });
    expect(scanStarts(words("rg -g '*.md' x /h/acme"))).toEqual({ name: 'rg', starts: ['/h/acme'] });
    expect(scanStarts(words('rg --files /'))).toEqual({ name: 'rg', starts: ['/'] });
    expect(scanStarts(words('rg -e /api/ src'))).toEqual({ name: 'rg', starts: ['src'] });
  });

  it('mdfind', () => {
    expect(scanStarts(words('mdfind foo'))).toEqual({ name: 'mdfind', whole: true });
    expect(scanStarts(words('mdfind -onlyin /acme foo'))).toEqual({ name: 'mdfind', starts: ['/acme'] });
  });

  it('other commands give null', () => {
    expect(scanStarts(words('cat /etc/hosts'))).toBeNull();
    expect(scanStarts(words('git grep x'))).toBeNull();
    expect(scanStarts([])).toBeNull();
  });
});

describe('scanCommandReason: denies', () => {
  const reasonFor = (name, where) =>
    `Foreman denies this command: \`${name}\` would search ${where}, outside the folders a story session may search. ${SCAN_HELP}`;

  it('the incident command, with the exact reason', () => {
    expect(deny(incident)).toBe(reasonFor('find', '/'));
  });

  it('a search behind an env option the parser does not list (an abbreviated long option)', () => {
    expect(deny('env --ignore find / -name x')).toBe(reasonFor('find', '/'));
    expect(deny('env --deb find / -name x')).toBe(reasonFor('find', '/'));
  });

  it.each([
    ['find ~ -name x', '/h/acme'],
    ['du -sh ~/*', '/h/acme/*'],
    [`rg x ${OWNER}`, OWNER],
    ['ls -R ~', '/h/acme'],
    ['grep -r x $HOME', '/h/acme'],
    ['mdfind -onlyin ~ foo', '/h/acme'],
    ['cd ~ && find . -name x', '/h/acme'],
    ['timeout 30 find / -name x', '/'],
    ['bash -c "find / -name x"', '/'],
    ['sudo du -sh /', '/'],
    ['find /acme/../h/acme', '/h/acme'],
    ['if true; then find / -name x; fi', '/'],
    ['while true; do du -sh /; done', '/'],
    ['for d in /; do find $d -name x; done', '/'],
    ['for d in src ~; do rg x "$d"; done', '/h/acme'],
    ['{ find / -name x; }', '/'],
    ['! find / -name x', '/'],
    ['nice find /', '/'],
    ['nice -n 10 find /', '/'],
    ['xargs find /', '/'],
    ['xargs -I {} find / -name {}', '/'],
    ['xargs -0 rg x /', '/'],
    ['xargs -- find /', '/'],
    ['ionice -c 3 find /', '/'],
    ['for d in /; do find "${d}/sub"; done', '/sub'],
    ['eval "find / -name x"', '/'],
    ['env -C / find .', '/'],
    ['env --chdir=/h/acme find .', '/h/acme'],
    ['cd -P / && find .', '/'],
    ['cd -L -- /h/acme && find .', '/h/acme'],
    ['pushd / && find .', '/'],
    ['find -- / -name x', '/'],
  ])('%s', (command, where) => {
    const name = command.match(/\b(find|du|rg|ls|grep|mdfind)\b/)[1];
    expect(deny(command)).toBe(reasonFor(name, where));
  });

  it('mdfind without -onlyin', () => {
    expect(deny('mdfind foo')).toBe(`Foreman denies this command: \`mdfind\` without -onlyin searches the whole disk. ${SCAN_HELP}`);
  });

  it('a symlink that leads out of the roots', () => {
    const resolve = (p) => (p === '/acme/link' ? '/h/acme/Desktop' : p);
    expect(deny('find /acme/link', { resolve })).toBe(reasonFor('find', '/acme/link'));
  });

  it('a start in a later command of a pipeline', () => {
    expect(deny('echo hi | xargs echo; rg x /')).toBe(reasonFor('rg', '/'));
  });
});

describe('scanCommandReason: allows', () => {
  it.each([
    'find . -name x',
    'rg x /acme/.foreman',
    'find ~/.claude -name x',
    'du -sh /tmp/x',
    'ls -R src',
    '(cd / && ls) && find . -name x',
    'cd "$scratch" && find .',
    'find "$UNSET" -name x',
    'cat /etc/hosts',
    'grep foo /etc/hosts',
    'if true; then find . -name x; fi',
    'for f in src test; do grep -r x $f; done',
    'for d in "$@"; do find $d; done',
    'pushd /acme && find . -name x',
    'pushd && find sub',
    'popd && find sub',
    'pushd -n / && find .',
    'cd -P /acme && find .',
    'env -C /acme find .',
    'env -C "$d" find sub',
    'xargs find',
  ])('%s', (command) => {
    expect(deny(command)).toBeNull();
  });

  it('any command when roots is empty or missing', () => {
    expect(deny('find / -name x', { roots: [] })).toBeNull();
    expect(deny('find / -name x', { roots: undefined })).toBeNull();
  });

  it('nothing for an empty or non-string command', () => {
    expect(deny('')).toBeNull();
    expect(deny(undefined)).toBeNull();
  });

  it('a path outside the roots never reaches resolve', () => {
    const resolve = vi.fn((p) => p);
    expect(deny('find /h/acme/Desktop', { resolve })).not.toBeNull();
    expect(resolve.mock.calls.map(([p]) => p)).not.toContain('/h/acme/Desktop');
  });

  it('a relative start with an unknown folder is skipped', () => {
    expect(deny('cd "$d" && find sub')).toBeNull();
  });
});

describe('scanToolReason', () => {
  const tool = (t, input, over = {}) => scanToolReason({ tool: t, input, cwd: CWD, roots: ROOTS, home: VARS.HOME, ...over });
  const readReason = (where, name = 'Read') => `Foreman denies this ${name} call: ${where} is outside the folders a story session may read. ${SCAN_HELP}`;

  it('Read outside the roots is denied; inside or relative to the cwd is not', () => {
    expect(tool('Read', { file_path: '/h/acme/Desktop/a.txt' })).toBe(readReason('/h/acme/Desktop/a.txt'));
    expect(tool('Read', { file_path: '/acme/src/a.js' })).toBeNull();
    expect(tool('Read', { file_path: 'src/a.js' })).toBeNull();
    expect(tool('Read', { file_path: '/h/acme/.claude/x.md' })).toBeNull();
  });

  it('Glob', () => {
    expect(tool('Glob', { pattern: '*.js' })).toBeNull();
    expect(tool('Glob', { pattern: '*.js', path: '/' })).toBe(readReason('/', 'Glob'));
    expect(tool('Glob', { pattern: '/h/acme/**/*.md' })).toBe(readReason('/h/acme', 'Glob'));
    expect(tool('Glob', { pattern: '/**/*.md' })).toBe(readReason('/', 'Glob'));
    expect(tool('Glob', { pattern: 'src/**/*.ts' })).toBeNull();
    expect(tool('Glob', { pattern: '/acme/src/**/*.ts' })).toBeNull();
  });

  it('Grep', () => {
    expect(tool('Grep', { pattern: 'x', path: '/h/acme' })).toBe(readReason('/h/acme', 'Grep'));
    expect(tool('Grep', { pattern: 'x' })).toBeNull();
    expect(tool('Grep', { pattern: 'x', path: 'src' })).toBeNull();
  });

  it('a leading ~ is the home folder', () => {
    expect(tool('Grep', { pattern: 'x', path: '~' })).toBe(readReason('/h/acme', 'Grep'));
    expect(tool('Read', { file_path: '~/Desktop/a' })).toBe(readReason('/h/acme/Desktop/a'));
    expect(tool('Read', { file_path: '~/.claude/x.md' })).toBeNull();
    expect(tool('Glob', { pattern: '~/**' })).toBe(readReason('/h/acme', 'Glob'));
    expect(tool('Glob', { pattern: '*.md', path: '~/.claude' })).toBeNull();
  });

  it('with no home, ~ is not expanded', () => {
    expect(tool('Read', { file_path: '~/x' }, { home: undefined })).toBeNull();
  });

  it('a relative Glob pattern that climbs out is denied', () => {
    expect(tool('Glob', { pattern: '../../../../h/acme/**' })).toBe(readReason('/h/acme', 'Glob'));
    expect(tool('Glob', { pattern: '../**', path: '/acme/src' })).toBeNull();
  });

  it('a symlink out of the roots is denied', () => {
    const resolve = (p) => (p === '/acme/link' ? '/h/acme/Desktop' : p);
    expect(tool('Read', { file_path: '/acme/link' }, { resolve })).toBe(readReason('/acme/link'));
  });

  it('Write, a non-string path and no roots are not its business', () => {
    expect(tool('Write', { file_path: '/h/acme/x' })).toBeNull();
    expect(tool('Read', { file_path: 7 })).toBeNull();
    expect(tool('Read', { file_path: '/h/acme/x' }, { roots: [] })).toBeNull();
    expect(tool('Read', undefined)).toBeNull();
  });
});

describe('sessionScanRoots', () => {
  const args = {
    anchor: '/srv/acme',
    config: {},
    env: { FOREMAN_STATE_DIR: '/srv/acme-state', HOME: '/h/acme', CLAUDE_CONFIG_DIR: '/cfg/claude' },
    homedir: '/h/other',
    tmpdir: '/var/t',
    pluginRoot: '/p/plugin',
  };
  const reasonFor = (name, where) =>
    `Foreman denies this command: \`${name}\` would search ${where}, outside the folders a story session may search. ${SCAN_HELP}`;

  it('the project, its state folder, the Claude folders, the temp folders and the plugin', () => {
    expect(sessionScanRoots(args)).toEqual(['/srv/acme', '/srv/acme-state', '/cfg/claude', '/h/acme/.claude', '/var/t', '/tmp', '/p/plugin']);
  });

  it('the state folder comes from the config, else .foreman', () => {
    const env = { HOME: '/h/acme' };
    expect(sessionScanRoots({ ...args, env, config: { stateDir: 'state' } })).toContain('/srv/acme/state');
    expect(sessionScanRoots({ ...args, env, config: null })).toContain('/srv/acme/.foreman');
  });

  it('the home folder falls back to homedir', () => {
    expect(sessionScanRoots({ ...args, env: {} })).toContain('/h/other/.claude');
  });

  it('the project and the state folder alone allow a search, with no temp folder involved', () => {
    const roots = sessionScanRoots(args);
    const check = (command) => scanCommandReason({ command, cwd: '/srv/acme', vars: {}, roots });
    expect(check('find /srv/acme/src -name x')).toBeNull();
    expect(check('rg x /srv/acme-state/runs')).toBeNull();
    expect(check('find /srv/other')).toBe(reasonFor('find', '/srv/other'));
  });
});
