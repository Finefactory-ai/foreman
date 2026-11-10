import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allowedKill, KILL_HELP, killLook, killReason, pidVerdict, processSnapshot, protectedPids, sessionRoot } from './kill-guard.mjs';
import { canonicalPath } from './run-guard.mjs';
import { bashHoles, hasBash, heredocLayouts } from './shell-holes.mjs';
import { writeAdopted, writePid } from './supervisor-pid.mjs';

let state;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'foreman-kill-'));
});
afterEach(() => rmSync(state, { recursive: true, force: true }));

const INCIDENT = `pkill -f "vitest run plugin/lib/engine/supervisor-file-locks" ; pkill -f "foreman.*run --foreground"; cp /tmp/sup.bak plugin/lib/engine/supervisor.mjs`;
const reason = (command, extra = {}) => killReason({ command, cwd: '/work/acme', vars: {}, ...extra });
const PREFIX = 'Foreman denies this command: ';
const PATTERN = 'stops processes by name or pattern';
const ONLY = 'Foreman allows only';
// A spy that must never be asked, or an answer for each pid.
const spy = (answer = () => null) => ({ verdict: vi.fn(answer) });

describe('allowedKill', () => {
  it('returns the pids for exactly the allowed forms', () => {
    expect(allowedKill(['123'])).toEqual([123]);
    expect(allowedKill(['123', '456'])).toEqual([123, 456]);
    expect(allowedKill(['-TERM', '123'])).toEqual([123]);
    expect(allowedKill(['-KILL', '123'])).toEqual([123]);
    expect(allowedKill(['-9', '123'])).toEqual([123]);
    expect(allowedKill(['-15', '123'])).toEqual([123]);
    expect(allowedKill(['-s', 'TERM', '123'])).toEqual([123]);
    expect(allowedKill(['-s', 'KILL', '123', '4'])).toEqual([123, 4]);
  });

  it('returns null for anything else', () => {
    for (const words of [
      [],
      ['-9'],
      ['-s', 'TERM'],
      ['-l'],
      ['--list'],
      ['-0', '1'],
      ['-s', '0', '123'],
      ['-s', '0', '-TERM', '200'],
      ['-n', '0', '-9', '200'],
      ['-n', '9', '123'],
      ['--signal=KILL', '123'],
      ['--signal', 'KILL', '123'],
      ['-sTERM', '123'],
      ['-SIGTERM', '123'],
      ['-INT', '123'],
      ['-2', '123'],
      ['--', '123'],
      ['--', '-123'],
      ['-9', '-123'],
      ['0'],
      ['12', '0'],
      ['012'],
      ['-1'],
      ['12345678901'],
      ['-9', '-TERM', '12'],
      ['-TERM', '-KILL', '12'],
      ['-s', 'TERM', '-TERM', '12'],
      ['$!'],
      ['%1'],
      ['$PID'],
      ['1*'],
    ]) {
      expect(allowedKill(words), words.join(' ')).toBeNull();
    }
  });
});

describe('killReason', () => {
  it('refuses the exact incident command, saying why and to kill the recorded PID', () => {
    const r = reason(INCIDENT);
    expect(r.startsWith(`${PREFIX}\`pkill\` ${PATTERN}`)).toBe(true);
    expect(r).toContain('the PID you recorded');
    expect(r.endsWith(KILL_HELP)).toBe(true);
    expect(KILL_HELP).toContain('`ps -p <pid>`');
  });

  it('refuses a kill by name or pattern, however it is wrapped, even with no signals', () => {
    for (const command of [
      'killall node',
      '/usr/bin/pkill -9 foreman',
      'sudo pkill x',
      'timeout 5 pkill x',
      "bash -c 'pkill -f foreman'",
      'echo $(pkill x)',
      'echo `pkill x`',
      'echo "$(pkill x)"',
      'nice -n 5 pkill x',
      'builtin command pkill x',
      'FOO=1 killall -9 node',
      'ls && (killall node)',
      'eval "pkill -f foreman"',
      "bash <<'EOF'\npkill -f foreman\nEOF",
      "bash <<< 'pkill x'",
      "xargs sh -c 'pkill x'",
      "watch 'pkill x'",
      "cat <<'EOF' | bash\npkill x\nEOF",
      "cat <<EOF\ndon't\nEOF\npkill x",
      'cat <<EOF\npkill x\n',
      'cat <<EOF\npkill x\nEOFX',
      'echo $((1 << 3)); pkill x',
      'x=$((a<<b))\npkill y\nb',
      'echo "pkill x"',
      "cat <<'EOF'\nhello\nEOF\npkill x",
      'echo "$(echo $(pkill x))"',
    ]) {
      expect(reason(command), command).toContain(PATTERN);
    }
  });

  // commandSteps unwraps caffeinate as a wrapper, so `caffeinate kill 5` is the numeric form
  // `kill 5`: its pid goes to signals.verdict. Plan case 6 listed it as refused; the pid check
  // keeps it safe.
  it('allows the numeric forms, however the kill command is named', () => {
    for (const command of ['kill 123', 'kill -9 123 456', 'kill -s TERM 123', '/bin/kill -15 123', 'exec kill 123', 'timeout 5 kill 123', 'sudo kill -KILL 5', 'caffeinate kill 5']) {
      const signals = spy();
      expect(reason(command, { signals }), command).toBeNull();
      expect(signals.verdict).toHaveBeenCalled();
      expect(reason(command), command).toBeNull();
    }
  });

  it('refuses every kill that is not one of the allowed forms, before it asks about a pid', () => {
    for (const command of [
      'kill',
      'kill -l',
      'kill -L',
      'kill --list',
      'kill -0 123',
      'kill -s 0 123',
      'kill -s 0 -TERM 200',
      'kill -n 0 -9 200',
      'kill -n 9 123',
      'kill --signal=KILL 123',
      'kill --signal KILL 123',
      'kill -sTERM 123',
      'kill -SIGTERM 123',
      'kill -INT 123',
      'kill -HUP 123',
      'kill -2 123',
      'kill -- 123',
      'kill -- -123',
      'kill -9 -123',
      'kill 0',
      'kill -TERM 0',
      'kill -9 -1',
      'kill 12 0',
      'kill -9 -TERM 12',
      'kill -TERM -KILL 12',
      'kill -s TERM -TERM 12',
      'kill 012',
      'kill $PID',
      'kill ${PID}',
      'kill $$',
      'kill $!',
      'npm start & sleep 1; kill $!',
      'kill %1',
      'kill "$(pgrep x)"',
      'kill $(cat supervisor.pid)',
      'kill `cat supervisor.pid`',
      'kill 5 `pgrep x`',
      'kill `pgrep -f foreman',
      'kill "`pgrep -f foreman`"',
      'echo "$(kill `pgrep -f foreman`)"',
      'kill {100,200}',
      'kill 1*',
      'kill $((1))',
      'for p in $(pgrep -f foreman); do kill $p; done',
      'pgrep -f "foreman.*run" | while read p; do kill -9 $p; done',
      'if true; then kill 0; fi',
    ]) {
      const signals = spy(() => 'asked');
      const r = reason(command, { signals });
      expect(r, command).toContain(ONLY);
      expect(r.startsWith(PREFIX)).toBe(true);
      expect(r.endsWith(KILL_HELP)).toBe(true);
      expect(signals.verdict, command).not.toHaveBeenCalled();
    }
  });

  it('asks signals.verdict for each pid and returns the first answer', () => {
    const verdict = (pid) => (pid === 200 || pid === 456 ? 'no' : null);
    expect(reason('kill -s 0 -TERM 200', { signals: spy(verdict) })).toContain(ONLY);
    expect(reason('kill -TERM 200', { signals: spy(verdict) })).toBe('no');
    const signals = spy(verdict);
    expect(reason('kill 123 456 789', { signals })).toBe('no');
    expect(signals.verdict.mock.calls.map((c) => c[0])).toEqual([123, 456]);
    expect(reason('kill 123', { signals: spy(verdict) })).toBeNull();
  });

  it('reads a pid inside a script or a substitution, and a kill after a heredoc-like line', () => {
    const signals = { verdict: (pid) => (pid === 7 ? 'no 7' : null) };
    expect(reason('bash -c "kill 7"', { signals })).toBe('no 7');
    expect(reason('echo $(kill 7)', { signals })).toBe('no 7');
    expect(reason('echo "$(kill 7)"', { signals })).toBe('no 7');
    expect(reason('cat <<EOF\nhello\nEOF\nkill 7', { signals })).toBe('no 7');
    expect(reason('bash <<< "kill 7"', { signals })).toBe('no 7');
    expect(reason('kill 123 456', { signals })).toBeNull();
  });
});

describe('killReason refuses a command that runs kill for you', () => {
  it('names the runner', () => {
    for (const command of [
      'pgrep -f foreman | xargs kill',
      'ps ax | grep x | xargs -r kill -9',
      'pgrep x | xargs -n 1 -I {} kill {}',
      'find . -name x -exec kill {} \;',
      'parallel kill ::: 1 2',
      'eval kill 5',
      'eval pkill x',
      'watch kill 5',
      'which kill',
      'grep -n kill notes.md',
      'echo kill',
      'git bisect run pkill x',
      'pgrep x | xargs sudo pkill',
    ]) {
      const r = reason(command);
      expect(r, command).toContain('runs `kill`');
      expect(r.endsWith(KILL_HELP)).toBe(true);
    }
  });

  it('reads a script held in a word', () => {
    expect(reason('pgrep x | xargs bash -c "kill $0"')).toContain(ONLY);
    expect(reason("git rebase -x 'pkill x' main")).toContain(PATTERN);
    expect(reason("perl -e 'kill 9, 123'")).toContain(ONLY);
    expect(reason("echo 'kill `cat x`'")).toContain(ONLY);
  });

  it('refuses a command name it cannot read when a kill is possible', () => {
    for (const command of ['k=kill; $k 5', '$(echo kill) 5', '${K} -9 5']) {
      expect(reason(command, { signals: spy() }), command).toContain('cannot read the name');
    }
    expect(reason('$HOME/bin/tool run')).toBeNull();
  });
});

describe('killReason leaves text that only mentions a kill', () => {
  it('allows commit messages, Foreman notes and a file written by cat', () => {
    for (const command of [
      'git commit -m "FM-365 A story agent can kill the factory with pkill by pattern"',
      'git commit -m "$(cat <<\'EOF\'\nFM-1 Stop kill by pattern\n\nkill -s 0 -TERM gets past; pkill -f acme\nEOF\n)"',
      'git commit --message="pkill is denied"',
      'git commit -m kill',
      'foreman story block ACME-1 --reason pkill',
      'git commit --message "pkill is denied"',
      'git commit -m"pkill is denied"',
      'foreman story block ACME-1 --reason "kill -s 0 -TERM <pid> gets past the guard"',
      "foreman decide add --story ACME-1 --title \"x\" --happened 'pkill -f acme matched the service'",
      "cat > notes.md <<'EOF'\nkill the old process\nEOF",
      "cat <<'EOF' > notes.md\nkill the old process\nEOF",
      "cat >> notes.md <<'EOF'\npkill x\nEOF",
      'cat <<EOF > notes.md\npkill is how it was done\nEOF',
    ]) {
      const signals = spy();
      expect(reason(command, { signals }), command).toBeNull();
      expect(signals.verdict).not.toHaveBeenCalled();
    }
  });

  it('still reads what runs outside the data', () => {
    for (const command of [
      'git commit -m x; pkill y',
      'git commit -m "$(pkill x)"',
      'foreman story done ACME-1 --note "$(pkill x)"',
      'cat > n.md <<EOF\n$(pkill x)\nEOF',
      'cat > n.md <<EOF\n`pkill x`\nEOF',
      'eval "$(cat <<\'EOF\'\npkill x\nEOF\n)"',
      "cat notes.md <<'EOF' | sh\npkill x\nEOF",
      "cat > notes.md <<'EOF'; pkill x\nhello\nEOF",
      "cat <<'EOF' | tee notes.md\npkill x\nEOF",
      'git log --grep "x" ; echo "kill"',
    ]) {
      expect(reason(command), command).not.toBeNull();
    }
  });

  it('allows ordinary commands', () => {
    for (const command of [
      'npm test',
      'ls | xargs wc -l',
      'pgrep -f foreman',
      'ps -p 123',
      'npx vitest run plugin/lib/engine/kill-guard.test.mjs',
      'git commit -m "fix the guard"',
      'timeout -s KILL 5 npm test',
      'node -e "console.log(1)"',
      'echo hello',
      'cat <<EOF\nhello\nEOF',
      'kill 123 # `x`',
    ]) {
      expect(reason(command, { signals: spy() }), command).toBeNull();
    }
  });
});

describe('killReason reads shell text closed', () => {
  it('reads a heredoc body as commands unless it is one of the data forms', () => {
    expect(reason('cat <<EOF\n$(pkill x)\nEOF')).toContain(PREFIX);
    expect(reason('cat <<EOF\n`pkill x`\nEOF')).toContain(PREFIX);
    expect(reason("cat <<'EOF'\nkill the old process\nEOF")).toContain(ONLY);
    expect(reason('cat <<-EOF\n\tpkill x\n\tEOF')).toContain(PATTERN);
  });

  it('keeps an unbalanced quote in a body from swallowing later commands', () => {
    expect(reason("cat <<EOF\ndon't\nEOF\npkill x")).toContain(PATTERN);
    expect(reason('cat <<EOF\nsay "hi\nEOF\npkill x')).toContain(PATTERN);
  });

  it('reads a here-string as its own text', () => {
    expect(reason('cat <<< "kill foo"\npkill x')).toContain(PATTERN);
    expect(reason('bash <<< "pkill x"')).toContain(PATTERN);
  });

  it('does not read a backtick inside single quotes as a substitution', () => {
    expect(reason("echo 'a `cat x`'")).toBeNull();
  });
});

describe('killReason reads a kill inside a compound command', () => {
  const signals = { verdict: (pid) => `no ${pid}` };

  it('refuses a pattern kill after if/then, for/do, while/do, a group and !', () => {
    for (const command of [
      'if pgrep -f "foreman.*run"; then pkill -f "foreman.*run --foreground"; fi',
      'if a; then b; elif c; then pkill x; fi',
      'if a; then b; else killall node; fi',
      'for p in $(pgrep -f foreman); do pkill -f $p; done',
      'pgrep -f "foreman.*run" | while read p; do pkill -9 -f x; done',
      'until false; do pkill x; done',
      '{ pkill x; }',
      'true && { pkill x; }',
      '! pkill x',
      'if true; then ! time pkill x; fi',
    ]) {
      expect(reason(command), command).toContain(PATTERN);
    }
  });

  it('asks signals.verdict about a pid in each of those forms', () => {
    for (const command of [
      '{ kill 123; }',
      '! kill 123',
      'if true; then kill 123; fi',
      'if a; then b; elif c; then kill 123; fi',
      'for p in a b; do kill 123; done',
      'while true; do kill -9 123; done',
      'until false; do kill 123; done',
      'if kill 123; then :; fi',
      'if ! kill 123; then :; fi',
      'true && { kill 123; }',
      'x | while read p; do kill 123; done',
    ]) {
      expect(reason(command, { signals }), command).toBe('no 123');
    }
  });

  it('allows what only mentions a reserved word', () => {
    expect(reason('echo then 123', { signals })).toBeNull();
    expect(reason('for p in a; do echo $p; done', { signals })).toBeNull();
  });
});

const TABLE = () =>
  new Map([
    [1, { ppid: 0, command: '/sbin/launchd' }],
    [100, { ppid: 1, command: 'node /opt/acme/plugin/bin/foreman run --foreground --service' }],
    [200, { ppid: 100, command: 'node /opt/acme/plugin/lib/engine/supervisor.mjs' }],
    [300, { ppid: 200, command: 'claude -p /foreman:story ACME-1 --output-format stream-json' }],
    [400, { ppid: 300, command: 'node /opt/acme/plugin/lib/hooks/agent-events.mjs --decide' }],
    [500, { ppid: 400, command: 'node /opt/acme/plugin/lib/hooks/agent-events.mjs --decide' }],
    [600, { ppid: 300, command: 'npm test' }],
    [610, { ppid: 600, command: 'node vitest' }],
    [310, { ppid: 200, command: 'claude -p /foreman:story ACME-2' }],
    [700, { ppid: 1, command: 'node server.js --token hunter2' }],
    [800, { ppid: 1, command: 'node other.js --token hunter2' }],
  ]);
const WORKTREE = '/work/acme/.foreman/worktrees/w1';
const TMP = '/tmp/acme/w1';

describe('pidVerdict', () => {
  const verdictFor = (pid, over = {}) => {
    writePid(state, 200);
    const table = over.table === undefined ? TABLE() : over.table;
    const protect = protectedPids({ stateDir: state, env: {}, table });
    return pidVerdict({ pid, table, self: 500, story: 'ACME-1', protect, places: [WORKTREE, TMP], cwdOf: () => null, ...over });
  };

  it('refuses the supervisor, its service and the session itself, and allows its children', () => {
    expect(verdictFor(200)).toContain('the Foreman supervisor');
    expect(verdictFor(100)).toContain('started the Foreman supervisor');
    expect(verdictFor(300)).toContain('this story session itself');
    expect(verdictFor(400)).toContain('this story session itself');
    expect(verdictFor(600)).toBeNull();
    expect(verdictFor(610)).toBeNull();
    expect(verdictFor(310)).toContain('not a process this session started');
    expect(verdictFor(999)).toContain('not running, or not one this session started');
  });

  it('allows an orphan running in the worktree or in the slot temp folder', () => {
    expect(verdictFor(700, { cwdOf: () => `${WORKTREE}/packages/web` })).toBeNull();
    expect(verdictFor(700, { cwdOf: () => TMP })).toBeNull();
    expect(verdictFor(700, { cwdOf: () => `${TMP}/run1` })).toBeNull();
  });

  it('refuses an orphan elsewhere, and never prints a command line', () => {
    for (const cwd of ['/work/acme', '/tmp/acme/w2', '/tmp/acme/w10', `${WORKTREE}-copy`, null]) {
      const r = verdictFor(800, { cwdOf: () => cwd });
      expect(r, String(cwd)).toContain('not a process this session started');
      expect(r).not.toContain('hunter2');
      expect(r).not.toContain('other.js');
    }
  });

  it('keeps a protected pid protected even when it sits under the session', () => {
    writePid(state, 610);
    const table = TABLE();
    const protect = protectedPids({ stateDir: state, env: {}, table });
    const r = pidVerdict({ pid: 610, table, self: 500, story: 'ACME-1', protect, places: [WORKTREE], cwdOf: () => WORKTREE });
    expect(r).toContain('the Foreman supervisor');
  });

  it('protects FOREMAN_SUPERVISOR_PID and the adopted voucher', () => {
    writeAdopted(state, { by: 100, pids: [300] });
    const p = protectedPids({ stateDir: state, env: { FOREMAN_SUPERVISOR_PID: '600' }, table: TABLE() });
    expect(p.get(600)).toBe('the Foreman supervisor');
    expect(p.get(100)).toBe('the Foreman service or `foreman run` that started the supervisor');
    expect(p.has(700)).toBe(false);
    expect(p.has(1)).toBe(false);
    expect(protectedPids({ stateDir: state, env: { FOREMAN_SUPERVISOR_PID: 'abc' }, table: null }).size).toBe(1);
  });

  it('refuses every pid it cannot place when the session has no root', () => {
    const table = TABLE();
    table.set(300, { ppid: 200, command: 'zsh -c claude' });
    const r = verdictFor(700, { table });
    expect(r).toContain("cannot find this story session's own process");
    expect(verdictFor(200, { table })).toContain('the Foreman supervisor');
  });

  it('refuses every unprotected pid when the process list is unavailable', () => {
    expect(verdictFor(700, { table: null })).toContain('could not list the processes');
    expect(verdictFor(200, { table: null })).toContain('the Foreman supervisor');
  });

  it('allows no temp folder when the slot is unknown', () => {
    writePid(state, 200);
    const look = killLook({ stateDir: state, env: { FOREMAN_STORY: 'ACME-1' }, self: 500, tmpdir: TMP, sh: fakeSh(), platform: 'darwin' });
    expect(look.verdict(700)).toContain('not a process this session started');
  });

  it('finds the session root, nearest first, and by story', () => {
    expect(sessionRoot({ table: TABLE(), self: 500, story: 'ACME-1' })).toBe(300);
    expect(sessionRoot({ table: TABLE(), self: 500, story: '' })).toBe(300);
    expect(sessionRoot({ table: TABLE(), self: 500, story: 'ACME-2' })).toBeNull();
    expect(sessionRoot({ table: TABLE(), self: 999, story: '' })).toBeNull();
  });
});

const PS = () =>
  [...TABLE()].map(([pid, v]) => `${String(pid).padStart(5)} ${String(v.ppid).padStart(5)} ${v.command}`).join('\n') + '\n';
function fakeSh({ ps = { status: 0, stdout: PS() }, lsof = '' } = {}) {
  const sh = (cmd, args = []) => {
    sh.calls.push([cmd, ...args].join(' '));
    if (cmd === 'ps') {
      if (ps instanceof Error) throw ps;
      return ps;
    }
    if (cmd === 'lsof') return { status: 0, stdout: lsof };
    return { status: 1, stdout: '' };
  };
  sh.calls = [];
  return sh;
}

describe('processSnapshot', () => {
  it('parses one ps call', () => {
    const sh = fakeSh();
    const t = processSnapshot({ sh });
    expect(t.get(300)).toEqual({ ppid: 200, command: 'claude -p /foreman:story ACME-1 --output-format stream-json' });
    expect(t.size).toBe(TABLE().size);
    expect(sh.calls).toEqual(['ps -axo pid=,ppid=,command=']);
  });

  it('reads /proc when ps fails or throws', () => {
    const proc = mkdtempSync(join(tmpdir(), 'foreman-proc-'));
    try {
      mkdirSync(join(proc, '42'));
      writeFileSync(join(proc, '42', 'stat'), '42 (node (x) y) S 7 42 42 0');
      writeFileSync(join(proc, '42', 'cmdline'), 'node\0server.js\0');
      mkdirSync(join(proc, 'self'));
      for (const ps of [{ status: 127, stdout: '' }, new Error('ENOENT')]) {
        const t = processSnapshot({ sh: fakeSh({ ps }), proc });
        expect(t.get(42)).toEqual({ ppid: 7, command: 'node server.js' });
        expect(t.size).toBe(1);
      }
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });

  it('is null when neither works', () => {
    expect(processSnapshot({ sh: fakeSh({ ps: { status: 1, stdout: '' } }), proc: join(state, 'none') })).toBeNull();
  });
});

describe('killLook', () => {
  const env = { FOREMAN_STORY: 'ACME-1', FOREMAN_SLOT: 'w1' };

  it('lists the processes once, and asks lsof only about an orphan', () => {
    writePid(state, 200);
    const sh = fakeSh({ lsof: `p700\nn${TMP}\n` });
    const look = killLook({ stateDir: state, env, self: 500, tmpdir: '/tmp/acme', sh, platform: 'darwin' });
    expect(sh.calls).toEqual([]);
    expect(look.verdict(600)).toBeNull();
    expect(look.verdict(200)).toContain('the Foreman supervisor');
    expect(sh.calls.filter((c) => c.startsWith('ps'))).toHaveLength(1);
    expect(sh.calls.filter((c) => c.startsWith('lsof'))).toHaveLength(0);
    expect(look.verdict(700)).toBeNull();
    expect(sh.calls.filter((c) => c.startsWith('ps'))).toHaveLength(1);
    expect(sh.calls.filter((c) => c.startsWith('lsof'))).toEqual(['lsof -a -d cwd -Fn -p 700']);
  });

  it('wraps a refusal with the prefix and the help', () => {
    writePid(state, 200);
    const look = killLook({ stateDir: state, env, self: 500, tmpdir: '/tmp/acme', sh: fakeSh(), platform: 'darwin' });
    const r = look.verdict(800);
    expect(r.startsWith(PREFIX)).toBe(true);
    expect(r.endsWith(KILL_HELP)).toBe(true);
  });

  it('allows the worktree of the slot, with symlinks resolved', () => {
    writePid(state, 200);
    const wt = join(state, 'worktrees', 'w1');
    mkdirSync(wt, { recursive: true });
    const look = killLook({ stateDir: state, env, self: 500, tmpdir: '/tmp/acme', sh: fakeSh({ lsof: `p800\nn${canonicalPath(wt)}\n` }), platform: 'darwin' });
    expect(look.verdict(800)).toBeNull();
  });

  it('reads /proc/<pid>/cwd on Linux', () => {
    writePid(state, 200);
    const seen = [];
    const readlink = (p) => (seen.push(p), `${TMP}/x`);
    const sh = fakeSh();
    const look = killLook({ stateDir: state, env, self: 500, tmpdir: '/tmp/acme', sh, platform: 'linux', readlink });
    expect(look.verdict(700)).toBeNull();
    expect(seen).toEqual(['/proc/700/cwd']);
    expect(sh.calls.filter((c) => c.startsWith('lsof'))).toHaveLength(0);
  });

  it('refuses when no process list can be had', () => {
    writePid(state, 200);
    const look = killLook({ stateDir: state, env, self: 500, tmpdir: '/tmp/acme', sh: fakeSh({ ps: { status: 1, stdout: '' } }), platform: 'darwin', proc: join(state, 'none') });
    expect(look.verdict(700)).toContain('could not list the processes');
  });
});

// A pattern kill, built from parts so that this file holds no command that stops a process.
const K = `${'p'}kill -f acme`;

describe('killReason leaves a git message and a heredoc that is data', () => {
  it('allows a message from -am, -qm, -F - and the heredoc idioms, and never asks about a pid', () => {
    for (const command of [
      'git commit -am "FM-365 A story agent can kill the factory with pkill by pattern"',
      'git commit -qm "stop the kill"',
      `git commit -F - <<'EOF'\nstop the kill\n${K}\nEOF`,
      `git commit --file=- <<'EOF'\nstop the kill\n${K}\nEOF`,
      `git commit --file - <<'EOF'\nstop the kill\n${K}\nEOF`,
      `git add -A && git commit -F - <<'EOF'\nstop the kill\n${K}\nEOF`,
      `git -C /work/acme commit -q -F - <<'EOF'\nkill\nEOF`,
      `git add . && git commit -am "$(cat <<'EOF'\nkill x\nEOF\n)"`,
      `git commit --message="$(cat <<'EOF'\n${K}\nEOF\n)"`,
      'git tag -m "kill" v1',
      `cd /work/acme && git commit -m "$(cat <<'EOF'\n${K}\nEOF\n)"`,
    ]) {
      const signals = spy();
      expect(reason(command, { signals }), command).toBeNull();
      expect(signals.verdict, command).not.toHaveBeenCalled();
    }
  });
});

describe('killReason still reads what runs outside the data', () => {
  const body = `\n${K}\nEOF`;
  const joined = {
    'J1 sh -s before a D3': `sh -s \\\ngit commit -F - <<'EOF'${body}`,
    'J1 bash -s before a D3': `bash -s \\\ngit commit -F - <<'EOF'${body}`,
    'J1 sh -s before a D1': `sh -s \\\ncat > n.md <<'EOF'${body}`,
    'J2 a quote left open': `echo 'a\ncat > n.md <<'EOF'${body}`,
    'J3 $( then a quote': `true $(true)#'\ngit commit -F - <<'EOF2'\n'\n${K}\nEOF2`,
    'J3 ${ left open': `true \${a/x; cat >f<<'EOF2'}\n${K}\nEOF2`,
    'J3 ${ before the <<': `sh \${a/x; cat >f}<<'EOF2'\n${K}\nEOF2`,
    'J3 $[ left open': `true $[x; cat >f<<'EOF2']\n${K}\nEOF2`,
    'J4 a comment before a D1': `true #; cat > n.md <<'EOF'${body}`,
    'J4 a comment before a D2': `true #| git commit -m "$(cat <<'EOF'${body}\n)"`,
    'J4 a comment before a D3': `true #& git commit -F - <<'EOF'${body}`,
    'J4 a comment line': `# note\ngit commit -F - <<'EOF'${body}`,
    'J5 a trailing pipe': `sh |\ncat > n.md <<'EOF'${body}`,
    'J6 an earlier heredoc': `cat <<'EOF'\nx\nEOF\ncat > f <<'B'\n${K}\nB`,
    'J6 a D2 before a D1': `git commit -m "$(cat <<'A'\nx\nA\n)"\ncat > f <<'B'\n${K}\nB`,
    'J7 a backslash joins the delimiter': `cat > n.md <<EOF\nEO\\\nF\n${K}\nEOF`,
    'J8 a delimiter with a backslash': `cat > n.md <<"E\\\\F"\nhi\nE\\F\n${K}\nE\\\\F`,
    'J8 text after the delimiter': `cat > n.md <<'EOF'x${body}`,
    'J8 a quote inside the delimiter': `cat > n.md <<'E'OF\n${K}\nE`,
    'J9 a << inside a quote': `echo "<<EOF\n" ; ${K}\nEOF`,
    'J10 CRLF': `cat > n.md <<'EOF'\r${body}`,
    'J11 two heredocs on a line': `cat <<'A' > f <<'B'\nx\nA\n${K}\nB`,
    'J12 hash -p': `hash -p /bin/sh cat; cat > n.md <<'EOF'${body}`,
    'J12 an alias': `alias cat=sh\ncat > n.md <<'EOF'${body}`,
    'J12 an editor': `GIT_EDITOR=sh git commit -F - <<'EOF'${body}`,
    'J12 the edit flag': `git commit -e -F - <<'EOF'${body}`,
    'J12 a descriptor': `cat 3<<'EOF' > f${body}`,
    'a pipe after a D2': `git commit -m "$(cat <<'EOF' | bash\n${K}\nEOF\n)"`,
    'a pipe after a D3': `git commit -F - <<'EOF' | sh${body}`,
    'sh -s with a commit': `sh -s git commit -F - <<'EOF'${body}`,
    'sh -s with a span': `sh -s 'a;' git commit -F - <<'EOF'${body}`,
    'an unquoted D1 body with $x': `cat > n.md <<EOF\nhi $x\n${K}\nEOF`,
    // bash ends a D2 body at a `)` that closes the substitution, or at a line `EOF)"`
    'a D2 body line that closes the substitution': `git commit -m "$(cat <<'EOF'\nmsg )" ; ${K}\nEOF\n)"`,
    'a D2 body holding a backtick': `git commit -m "$(cat <<'EOF'\nmsg \` ; ${K} ; echo \`\nEOF\n)"`,
    'a D2 body line that starts with the delimiter': `git commit -m "$(cat <<'EOF'\nEOF)"\n${K}\nEOF\n)"`,
    'a D3 body line that starts with the delimiter': `git commit -F - <<'EOF'\nEOFx\n${K}\nEOF`,
    'a D1 body line that starts with the delimiter': `cat > n.md <<'EOF'\nEOF)\n${K}\nEOF`,
    'a D1 body line with tabs that starts with the delimiter': `cat > n.md <<-'EOF'\n\tEOF)\n${K}\n\tEOF`,
  };
  for (const [name, command] of Object.entries(joined)) {
    it(`refuses ${name}`, () => {
      expect(reason(command), command).toContain(PATTERN);
    });
  }

  it('refuses the D2 layout that closes the substitution early and runs a kill', () => {
    const command = `git commit -m "$(cat <<'EOF'\nmsg )" ; echo RAN ; ${K} ; echo "$(\nEOF\n)"`;
    expect(reason(command), command).not.toBeNull();
  });

  // A `<<` inside a quote is not a heredoc: the lines after it run. The quote may open before the
  // << and close after the delimiter, or open on an earlier line.
  it.each([
    `cat > ' <<EOF '\n${K}\nEOF`,
    `cat > " <<EOF "\n${K}\nEOF`,
    `echo ' <<EOF ' && cat > f\n${K}\nEOF`,
    `true " <<'X' " ; cat >> notes.md\n${K}\nX`,
    `echo "<<'${K}'"\n${K}`,
    `echo "\n<<EOF\n"; ${K}\nEOF`,
    `echo '\n<<EOF\n'; ${K}\nEOF`,
    `cat <<''\n'\n\n${K}`,
    `echo '((' ; cat <<'EOF'\n'\nEOF\n${K}`,
    `echo "\n<<EOF\n"; p\\kill -f acme\nEOF`,
    `echo "\n<<EOF\n"; p''kill -f acme\nEOF`,
    `cd "$D" && cat > n.md <<'EOF'\n'\nEOF\n${K}`,
    `git commit -F - <<'EOF' " ; cat >> f\n" ; ${K}\nEOF\n'`,
    `git commit -F - <<E'O'F\n'\nEOF\n${K}`,
    `cat > f <<'EOF'x\n'\nEOFx\n${K}`,
    `cat > f <<"E\\\\F"\n'\nE\\F\n${K}`,
    `cat <<A <<B\nx\nA\n'\nB\n${K}`,
    `git commit -m "$(cat <<-EOF\n)" ; ${K}\nEOF\n'`,
  ])('refuses a kill after a << it cannot prove is a heredoc: %j', (command) => {
    expect(reason(command), command).toContain(PREFIX);
  });

  it('still allows a heredoc it can prove, and one after a plain $(cat', () => {
    for (const command of [
      `cat > notes.md <<'EOF'\n${K}\nEOF\ngit add notes.md`,
      `gh pr create --title x --body "$(cat <<'EOF'\nA note.\nEOF\n)"`,
      `cd "$D" && cat > n.md <<'EOF'\nhello\nEOF\nls`,
    ]) {
      expect(reason(command), command).toBeNull();
    }
  });

  it('refuses a git subcommand that runs its words', () => {
    for (const command of [
      "git bisect run sh -cm 'pkill x'",
      "git bisect run sh -c -m 'pkill x'",
      "git --git-dir commit bisect run sh -c -m 'pkill x'",
      `git -c alias.x='!sh -c' x -m "$(cat <<'EOF'\n${K}\nEOF\n)"`,
      "GIT_EDITOR=sh git commit -e -m 'pkill -f foreman'",
    ]) {
      expect(reason(command), command).not.toBeNull();
    }
  });
});

describe('killReason reads a one-liner, an alias and env -S', () => {
  it('reads the kill held in a language one-liner', () => {
    for (const command of [
      `node -e 'require("child_process").execSync("pkill -f foreman")'`,
      `perl -e 'system("pkill x")'`,
      `echo "('pkill x')"`,
    ]) {
      expect(reason(command), command).toContain(PATTERN);
    }
    expect(reason(`python3 -c 'import subprocess; subprocess.run(["pkill","-f","foreman"])'`)).toContain('runs `kill`');
  });

  it('refuses a git alias that runs a kill', () => {
    expect(reason("git -c alias.k='!pkill -f foreman' k")).toContain('runs `kill`');
    expect(reason('git -c alias.k=!pkill k -f foreman')).toContain('runs `kill`');
  });

  it('reads the command string of env -S', () => {
    for (const command of [
      "env -S 'pkill -f foreman'",
      "env --split-string='pkill -f foreman'",
      "env --split-string 'pkill -f foreman'",
      "env -S'pkill -f foreman'",
      "env -iS 'pkill -f foreman'",
      "timeout 5 env -S 'pkill -f foreman'",
      `env -S "-S'pkill -f foreman'"`,
      `env ${'-S '.repeat(7)}pkill -f foreman`,
    ]) {
      expect(reason(command), command).toContain(PATTERN);
    }
  });

  it('refuses an env -S string it cannot read', () => {
    const CANNOT = 'cannot read the string of `env -S`';
    for (const command of [
      "env -S 'pkill\\_-f\\_foreman'",
      "env -S '${X} -f foreman'",
      "env -S 'a\\x20b'",
      `env ${'-S '.repeat(8)}pkill -f foreman`,
      `env ${'-S '.repeat(16)}pkill -f foreman`,
      `env ${'-S '.repeat(30)}pkill -f foreman`,
      `env -S "${'-S '.repeat(8)}pkill -f foreman"`,
    ]) {
      expect(reason(command), command).toContain(CANNOT);
    }
  });

  it('reads env -S given as an abbreviated long option, with or without =', () => {
    for (const command of [
      `env '--sp=${K}'`,
      `env --s='${K}'`,
      `env --split-str='${K}'`,
      `env --split-string='${K}'`,
      `env --sp '-i ${K}'`,
      `env --s '-i ${K}'`,
      `env -S '-i ${K}'`,
      `env -S '--s=${K}'`,
    ]) {
      expect(reason(command), command).toContain(PATTERN);
    }
  });

  it('refuses an env option it does not know, because its value may be a string env splits', () => {
    const CANNOT = 'cannot read the string of `env -S`';
    for (const command of [`env --bogus '${K}'`, `env --st x '${K}'`, `env -Z '${K}'`, `env -iZ '${K}'`, `env --ig=x '${K}'`]) {
      expect(reason(command), command).toContain(CANNOT);
    }
  });

  it('still allows env with its known options', () => {
    for (const command of ['env -i FOO=1 ls', 'env -u FOO ls', 'env -0 ls', 'env --unset=FOO ls', 'env --ignore-environment ls', 'env -C /work/acme ls', 'env --chdir=/work/acme ls', 'env -- ls']) {
      expect(reason(command), command).toBeNull();
    }
  });

  it('still allows a path or a file name that holds the word', () => {
    for (const command of ['ls scripts/pkill.sh', 'echo kill-guard.mjs', "env -S 'npm test'", "env -S 'echo a b'"]) {
      expect(reason(command), command).toBeNull();
    }
  });
});

describe.skipIf(!hasBash())('real bash: generated heredoc and quote layouts', () => {
  it('allows no layout that runs pkill or killall', async () => {
    const commands = heredocLayouts({ seed: 403, size: 1500, danger: ['pkill -f acme-none', 'killall acme-none'] });
    const { holes, checked } = await bashHoles({
      allow: (c) => killReason({ command: c, cwd: '/work/acme', vars: {} }) === null,
      commands,
      stubs: { pkill: () => true, killall: () => true, git: () => false },
    });
    expect(holes.map((h) => h.command)).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
