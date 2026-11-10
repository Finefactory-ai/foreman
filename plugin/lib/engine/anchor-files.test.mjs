import { describe, expect, it } from 'vitest';
import { anchorEditReason, anchorWriteReason, commandSteps, commandWords, pipelineHeads, protectedFiles } from './anchor-files.mjs';
import { ownerFilesWrite } from './run-guard.mjs';

const protect = ['/a/foreman.config.json', '/a/.foreman/settings.json', '/a/.env.local', '/a/.env.foreman', '/a/.foreman/check-runs.jsonl', '/a/.foreman/session-config', '/a/.foreman/session-config/w1-env.json'];
const cwd = '/a/.foreman/worktrees/w1';
// The slot's .env.local is a symlink to the project's.
const resolve = (p) => (p === '/a/.foreman/worktrees/w1/.env.local' ? '/a/.env.local' : p);
const vars = { FOREMAN_PROJECT_DIR: '/a', HOME: '/h' };
const reasonFor = (file) =>
  `Foreman denies this command: it would change ${file}, which belongs to the project this run builds. Story sessions never write the real project's config, settings or keys; check Foreman commands in a scratch git repo, with the FOREMAN_* variables left set.`;
const decide = (command) => anchorWriteReason({ command, cwd, protect, vars, resolve });

describe('protectedFiles', () => {
  it("names the project's config, local settings and env files", () => {
    expect(protectedFiles({ anchor: '/a', stateDirPath: '/a/.foreman', config: {} })).toEqual(protect);
  });

  it('honours a custom envFile and foremanEnvFile, and keeps the defaults', () => {
    const files = protectedFiles({ anchor: '/a', stateDirPath: '/s', config: { envFile: '.env.acme', foremanEnvFile: '.env.own' } });
    expect(files).toEqual(['/a/foreman.config.json', '/s/settings.json', '/a/.env.acme', '/a/.env.own', '/a/.env.local', '/a/.env.foreman', '/s/check-runs.jsonl', '/s/session-config', '/s/session-config/w1-env.json']);
  });

  it("ends with each slot's session env file: one for no slot count, one per slot for a count", () => {
    const at = (config) => protectedFiles({ anchor: '/a', stateDirPath: '/s', config }).filter((f) => f.endsWith('-env.json'));
    expect(at({})).toEqual(['/s/session-config/w1-env.json']);
    expect(at({ slots: 3 })).toEqual(['/s/session-config/w1-env.json', '/s/session-config/w2-env.json', '/s/session-config/w3-env.json']);
    expect(at({ slots: 0 })).toEqual(['/s/session-config/w1-env.json']);
    expect(at({ slots: 'many' })).toEqual(['/s/session-config/w1-env.json']);
    expect(at({ slots: 2.5 })).toEqual(['/s/session-config/w1-env.json']);
    expect(protectedFiles({ anchor: '/a', stateDirPath: '/s', config: { slots: 2 } }).slice(-2)).toEqual(['/s/session-config/w1-env.json', '/s/session-config/w2-env.json']);
  });

  it('falls back to the defaults for a value that is not a name, and dedupes', () => {
    const files = protectedFiles({ anchor: '/a', stateDirPath: '/a/.foreman', config: { envFile: '', foremanEnvFile: 3 } });
    expect(files).toEqual(protect);
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('anchorWriteReason', () => {
  it.each([
    ['echo X > /a/.env.local', '/a/.env.local'],
    ['echo X >>/a/.env.foreman', '/a/.env.foreman'],
    ['printf x 1>/a/foreman.config.json', '/a/foreman.config.json'],
    ['cat x &> "/a/.env.local"', '/a/.env.local'],
    ['echo x > $FOREMAN_PROJECT_DIR/.env.local', '/a/.env.local'],
    ['echo x > ${FOREMAN_PROJECT_DIR}/.env.local', '/a/.env.local'],
    ['echo x | tee -a /a/.foreman/settings.json', '/a/.foreman/settings.json'],
    ['cp /tmp/c.json /a/foreman.config.json', '/a/foreman.config.json'],
    ['cp /tmp/foreman.config.json /a/', '/a/foreman.config.json'],
    ['cp -t /a /tmp/.env.local', '/a/.env.local'],
    ['ln -sf /tmp/k /a/.env.local', '/a/.env.local'],
    ['mv /tmp/x /a/.env.local', '/a/.env.local'],
    ['mv /a/.env.local /tmp/x', '/a/.env.local'],
    ["sed -i '' 's/a/b/' /a/foreman.config.json", '/a/foreman.config.json'],
    ['sed -i.bak -e s/a/b/ /a/.env.local', '/a/.env.local'],
    ['perl -pi -e s/a/b/ /a/.env.foreman', '/a/.env.foreman'],
    ['rm -f /a/.env.foreman', '/a/.env.foreman'],
    ['truncate -s0 /a/.env.local', '/a/.env.local'],
    ['cd /a && echo x > .env.local', '/a/.env.local'],
    ['echo x >> .env.local', '/a/.env.local'],
    ['npm test && echo x > /a/.env.local', '/a/.env.local'],
    ["bash -c 'echo x > /a/.env.local'", '/a/.env.local'],
    ['FOO=1 env BAR=2 cp x /a/.env.local', '/a/.env.local'],
    ['/bin/cp x /a/.env.local', '/a/.env.local'],
    ['sudo tee /a/.env.local', '/a/.env.local'],
    ['echo x > ~/../a/.env.local', '/a/.env.local'],
    ['(cd /tmp) ; echo x > ../../../.env.local', '/a/.env.local'],
    ['echo x >> /a/.foreman/check-runs.jsonl', '/a/.foreman/check-runs.jsonl'],
    ['rm /a/.foreman/check-runs.jsonl', '/a/.foreman/check-runs.jsonl'],
    ['echo \'{}\' > /a/.foreman/session-config/w1-env.json', '/a/.foreman/session-config/w1-env.json'],
    ['cp f /a/.foreman/session-config/w1-env.json', '/a/.foreman/session-config/w1-env.json'],
    ["printf '{}' > /a/.foreman/session-config/w9-env.json", '/a/.foreman/session-config/w9-env.json'],
    ['cp f /a/.foreman/session-config/x-env.json', '/a/.foreman/session-config/x-env.json'],
    ['tee /a/.foreman/session-config/w2-settings.json', '/a/.foreman/session-config/w2-settings.json'],
    ["bash -c 'echo {} > /a/.foreman/session-config/w9-env.json'", '/a/.foreman/session-config/w9-env.json'],
    ['rm -r /a/.foreman/session-config', '/a/.foreman/session-config'],
    ['mv /a/.foreman/session-config /tmp/x', '/a/.foreman/session-config'],
    ['cp f /a/.foreman/check-runs.jsonl', '/a/.foreman/check-runs.jsonl'],
  ])('denies %s', (command, file) => {
    expect(decide(command)).toBe(reasonFor(file));
  });

  it.each([
    ['cat /a/.env.local'],
    ['grep KEY /a/.env.local'],
    ['cp /a/.env.local /tmp/copy'],
    ['diff /a/foreman.config.json foreman.config.json'],
    ['source /a/.env.local'],
    ['echo x > foreman.config.json'],
    ['echo x > /tmp/scratch/.env.local'],
    ["sed 's/a/b/' /a/foreman.config.json"],
    ['npm test 2>&1'],
    ['echo ok > /dev/null'],
    ['ls > /tmp/out'],
    ["echo '> /a/.env.local'"],
    ['echo x > $UNKNOWN/.env.local'],
  ])('allows %s', (command) => {
    expect(decide(command)).toBeNull();
  });

  it('allows an empty or non-string command', () => {
    expect(decide('')).toBeNull();
    expect(decide(undefined)).toBeNull();
    expect(decide(42)).toBeNull();
  });

  it('does nothing with an empty protect list', () => {
    expect(anchorWriteReason({ command: 'echo X > /a/.env.local', cwd, protect: [], vars, resolve })).toBeNull();
    expect(anchorWriteReason({ command: 'echo X > /a/.env.local', cwd, vars, resolve })).toBeNull();
  });
});

describe('anchorWriteReason: keywords, cd options, pushd, env -C and eval', () => {
  it.each([
    'cd -P /a && echo x > foreman.config.json',
    'pushd /a && rm foreman.config.json',
    'if true; then rm /a/foreman.config.json; fi',
    'env -C /a rm foreman.config.json',
    'eval "echo x > /a/foreman.config.json"',
  ])('denies %s', (command) => {
    expect(decide(command)).toBe(reasonFor('/a/foreman.config.json'));
  });

  it('a redirect of env -C resolves in the shell folder, not in the one env sets', () => {
    expect(decide('env -C /a echo x > foreman.config.json')).toBeNull();
  });
});

describe('anchorEditReason', () => {
  const editReasonFor = (file) =>
    `Foreman denies this edit: it would change ${file}, which belongs to the project this run builds. Story sessions never write the real project's config, settings or keys; check Foreman commands in a scratch git repo, with the FOREMAN_* variables left set.`;
  const edit = (filePath) => anchorEditReason({ filePath, cwd, protect, resolve });

  it.each([
    ['/a/.env.local', '/a/.env.local'],
    ['/a/foreman.config.json', '/a/foreman.config.json'],
    ['/a/.foreman/settings.json', '/a/.foreman/settings.json'],
    ['/a/.foreman/worktrees/w1/.env.local', '/a/.env.local'],
    ['.env.local', '/a/.env.local'],
    ['../../../.env.foreman', '/a/.env.foreman'],
    ['/a/.foreman/check-runs.jsonl', '/a/.foreman/check-runs.jsonl'],
    ['/a/.foreman/session-config/w1-env.json', '/a/.foreman/session-config/w1-env.json'],
    ['/a/.foreman/session-config/w9-env.json', '/a/.foreman/session-config/w9-env.json'],
    ['/a/.foreman/session-config/x-env.json', '/a/.foreman/session-config/x-env.json'],
    ['/a/.foreman/session-config/nested/w1-env.json', '/a/.foreman/session-config/nested/w1-env.json'],
  ])('denies an edit of %s', (filePath, file) => {
    expect(edit(filePath)).toBe(editReasonFor(file));
  });

  it.each([['foreman.config.json'], ['/a/.foreman/session-config-other/w1-env.json'], ['/a/.foreman/worktrees/w1/src/app.js'], ['/tmp/scratch/.env.local'], ['/a/README.md']])('allows an edit of %s', (filePath) => {
    expect(edit(filePath)).toBeNull();
  });

  it('allows an empty or non-string path, and does nothing with an empty protect list', () => {
    expect(edit('')).toBeNull();
    expect(edit(undefined)).toBeNull();
    expect(edit(42)).toBeNull();
    expect(anchorEditReason({ filePath: '/a/.env.local', cwd, protect: [], resolve })).toBeNull();
    expect(anchorEditReason({ filePath: '/a/.env.local', cwd, resolve })).toBeNull();
  });
});

describe('anchorWriteReason: Foreman commands that write the owner files', () => {
  const isAnchorDir = (d) => d === '/a' || d.startsWith('/a/');
  const foreman = { anchor: '/a', guarded: ownerFilesWrite, isAnchorDir };
  const call = (command) => anchorWriteReason({ command, cwd, protect, vars, resolve, foreman });
  const inAnchor = (what) =>
    `${what} would change /a, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.`;
  const varsChanged = (what) =>
    `Foreman denies this command: it runs ${what} with the Foreman run variables changed, so it could change /a, the project this run builds, whatever folder it runs in. Keep the FOREMAN_* variables set and run it in a scratch git repo: inside a run it then acts on that repo.`;

  it.each([
    ['foreman settings set workers 1', 'foreman settings set'],
    ['(unset FOREMAN_RUN FOREMAN_PROJECT_DIR FOREMAN_STATE_DIR; foreman settings set workers 1)', 'foreman settings set'],
    ['env -u FOREMAN_RUN node /x/plugin/bin/foreman workers 1', 'foreman workers'],
    ['env -i PATH=/bin foreman pause', 'foreman pause'],
    ['FOREMAN_PROJECT_DIR=/tmp/s foreman settings set workers 1', 'foreman settings set'],
    ['npx foreman traits add all "x"', 'foreman traits add'],
    ['cd /tmp/s && cd /a && foreman features on learning', 'foreman features on'],
    ["bash -c 'unset FOREMAN_RUN; foreman settings reset workers'", 'foreman settings reset'],
    ['env -u FOREMAN_RUN foreman keys migrate', 'foreman keys migrate'],
    ['cd /tmp/s && env -u FOREMAN_RUN foreman keys set JIRA_TOKEN --project /a', 'foreman keys set'],
    ['cd /tmp/s && foreman keys remove JIRA_TOKEN --project=../../a/.foreman/worktrees/w1', 'foreman keys remove'],
  ])('denies %s from the slot or the project', (command, what) => {
    expect(call(command)).toBe(inAnchor(what));
  });

  it.each([
    ['(cd "$scratch" && unset FOREMAN_RUN FOREMAN_PROJECT_DIR FOREMAN_STATE_DIR && foreman settings set workers 1)', 'foreman settings set'],
    ['cd $(mktemp -d) && env -u FOREMAN_RUN foreman workers 1', 'foreman workers'],
    ['cd "$S" && FOREMAN_RUN=0 foreman pause', 'foreman pause'],
    // A known folder outside the project is no safer: with FOREMAN_RUN cleared and
    // FOREMAN_PROJECT_DIR or FOREMAN_STATE_DIR still set, the CLI writes the project from anywhere.
    ['cd /tmp/scratch && (unset FOREMAN_RUN; foreman settings set learning.auto true)', 'foreman settings set'],
    ['cd /tmp/notgit && FOREMAN_RUN= foreman settings set workers 1', 'foreman settings set'],
    ['(cd /tmp/scratch && unset FOREMAN_RUN FOREMAN_PROJECT_DIR && foreman settings set workers 1)', 'foreman settings set'],
    ['cd /tmp/scratch && export FOREMAN_RUN=0 && foreman workers 1', 'foreman workers'],
    ['cd /tmp/scratch && env -u FOREMAN_STATE_DIR foreman pause', 'foreman pause'],
    ['cd /tmp/scratch && env -i PATH=/bin foreman features on learning', 'foreman features on'],
    ["cd /tmp/scratch && bash -c 'FOREMAN_RUN=0 foreman settings reset workers'", 'foreman settings reset'],
  ])('denies %s: the run variables changed, whatever the folder', (command, what) => {
    expect(call(command)).toBe(varsChanged(what));
  });

  it.each([
    ['cd /tmp/scratch && foreman settings set workers 1'],
    ['cd /tmp/scratch && echo "$FOREMAN_PROJECT_DIR" && foreman settings set workers 1'],
    ['(unset FOREMAN_RUN; foreman settings get workers)'],
    ['(cd "$scratch" && foreman settings set workers 1)'],
    ['foreman settings get workers'],
    ['foreman story next'],
    ['foreman config show'],
    ['echo foreman settings set workers 1'],
    ['node plugin/bin/foreman learning list'],
    ['cd /tmp/s && foreman keys migrate'],
    ['foreman keys set JIRA_TOKEN --project /tmp/s'],
    ['foreman checks --reuse'],
    ['foreman checks --changed --reuse'],
    ['cat /a/.foreman/check-runs.jsonl'],
  ])('allows %s', (command) => {
    expect(call(command)).toBeNull();
  });

  it('does not look at Foreman commands without the foreman option', () => {
    expect(anchorWriteReason({ command: 'foreman settings set workers 1', cwd, protect, vars, resolve })).toBeNull();
  });
});

describe('commandWords', () => {
  it('splits on the separators and drops prefixes, wrappers and redirects', () => {
    expect(commandWords('A=1 npm test 2>&1 | tail -40')).toEqual([['npm', 'test'], ['tail', '-40']]);
    expect(commandWords('cd sub && env CI=1 npm test > /tmp/o 2>&1 &')).toEqual([['cd', 'sub'], ['npm', 'test']]);
    expect(commandWords('a; b || (c) `d`\ne < in.txt')).toEqual([['a'], ['b'], ['c'], ['d'], ['e']]);
  });

  it('also gives the commands of a sh -c script, up to depth 3', () => {
    expect(commandWords('sh -c "npm test"')).toContainEqual(['npm', 'test']);
    const nest = (script, times) => (times === 0 ? script : nest(`sh -c '${script.replaceAll("'", "'\\''")}'`, times - 1));
    expect(commandWords(nest('npm test', 3)).some((w) => w[0] === 'npm')).toBe(true);
    expect(commandWords(nest('npm test', 4)).some((w) => w[0] === 'npm')).toBe(false);
  });

  it('gives [] for an empty or non-string command', () => {
    expect(commandWords('')).toEqual([]);
    expect(commandWords(undefined)).toEqual([]);
    expect(commandWords(42)).toEqual([]);
    expect(commandWords(' ; ')).toEqual([]);
  });
});

describe('commandWords: ||', () => {
  it('separates the commands of a logical or like ;', () => {
    expect(commandWords('a || b')).toEqual([['a'], ['b']]);
    expect(commandWords('a | b || c |& d')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });
});

describe('pipelineHeads', () => {
  it('leaves out a command that reads a pipe', () => {
    expect(pipelineHeads('npm test 2>&1 | tee out.log')).toEqual([['npm', 'test']]);
    expect(pipelineHeads('a | b | c')).toEqual([['a']]);
    expect(pipelineHeads('a |& b')).toEqual([['a']]);
  });

  it('keeps every command of && and ; and ||', () => {
    expect(pipelineHeads('npm ci && npm test')).toEqual([['npm', 'ci'], ['npm', 'test']]);
    expect(pipelineHeads('npm ci || npm test')).toEqual([['npm', 'ci'], ['npm', 'test']]);
    expect(pipelineHeads('a; b\nc')).toEqual([['a'], ['b'], ['c']]);
  });

  it('reads a parenthesised group before a pipe as a head', () => {
    expect(pipelineHeads('(npm ci && npm test) | tee log')).toEqual([['npm', 'ci'], ['npm', 'test']]);
    expect(pipelineHeads('a | (b); c')).toEqual([['a'], ['c']]);
  });

  it('ends a pipeline at ||', () => {
    expect(pipelineHeads('a | b || c')).toEqual([['a'], ['c']]);
  });

  it('adds the commands of a sh -c script as heads, last', () => {
    const heads = pipelineHeads('bash -c "npm ci && npm test"');
    expect(heads.at(-1)).toEqual(['npm', 'test']);
    expect(heads).toContainEqual(['npm', 'ci']);
  });

  it('gives [] for an empty or non-string command', () => {
    expect(pipelineHeads('')).toEqual([]);
    expect(pipelineHeads(undefined)).toEqual([]);
    expect(pipelineHeads(42)).toEqual([]);
  });
});

describe('commandWords: keywords, more wrappers and eval', () => {
  it('reads the command after a shell keyword', () => {
    expect(commandWords('if true; then npm test; fi')).toEqual(expect.arrayContaining([['true'], ['npm', 'test']]));
    expect(commandWords('{ nice -n 5 npm test; }')).toContainEqual(['npm', 'test']);
  });

  it('follows eval', () => {
    expect(commandWords('eval "npm test"')).toContainEqual(['npm', 'test']);
  });

  it('leaves xargs to the scan guard', () => {
    expect(commandWords('xargs npm test')).toEqual([['xargs', 'npm', 'test']]);
  });
});

describe('commandSteps', () => {
  const at = (steps, name) => steps.find((s) => s.words[0] === name);

  it.each([
    ['cd -P /x && find .', { dir: '/x', known: true }],
    ['cd -L -- /x && find .', { dir: '/x' }],
    ['pushd /x && find .', { dir: '/x', known: true }],
    ['pushd /x && popd && find .', { known: false }],
    ['pushd -n /x && find .', { dir: '/start', known: true }],
    ['pushd && find .', { known: false }],
    ['eval "cd /y && find ."', { dir: '/y' }],
  ])('%s', (command, expected) => {
    expect(at(commandSteps(command, '/start'), 'find')).toMatchObject(expected);
  });

  it.each([
    ['env -C /x find .', { words: ['find', '.'], dir: '/x', known: true }],
    ['env --chdir=/x find .', { dir: '/x' }],
    ['env -C"/x" find .', { dir: '/x' }],
    ['env -C "$d" find .', { known: false }],
    ['sudo -D /x find .', { dir: '/x' }],
  ])('a wrapper that sets the folder: %s', (command, expected) => {
    const steps = commandSteps(command, '/start');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject(expected);
  });

  it('the folder of env -C does not last past its step', () => {
    const finds = commandSteps('env -C /x find . ; find .', '/start').filter((s) => s.words[0] === 'find');
    expect(finds.map((s) => s.dir)).toEqual(['/x', '/start']);
  });

  it('eval runs its script from the folder', () => {
    expect(at(commandSteps('eval "cd /y && rg x"', '/start'), 'rg')).toMatchObject({ dir: '/y' });
  });

  it('reads the command after then, do, { and !', () => {
    const names = commandSteps('if true; then find a; fi; while x; do du b; done; { ls -R c; }; ! rg x', '/s').map((s) => s.words[0]);
    expect(names).toEqual(expect.arrayContaining(['find', 'du', 'ls', 'rg']));
  });

  it('tracks cd, scoped by parentheses', () => {
    const steps = commandSteps('cd /x && find . ; (cd /y && ls) ; pwd', '/start');
    expect(at(steps, 'find')).toMatchObject({ dir: '/x', known: true, words: ['find', '.'] });
    expect(at(steps, 'ls')).toMatchObject({ dir: '/y', known: true });
    expect(at(steps, 'pwd')).toMatchObject({ dir: '/x', known: true });
    expect(at(steps, 'cd')).toMatchObject({ words: ['cd', '/x'], dir: '/start' });
  });

  it('marks a cd into a variable unknown', () => {
    expect(at(commandSteps('cd "$d" && find .', '/start'), 'find')).toMatchObject({ known: false });
  });

  it('follows the script of bash -c from the enclosing folder', () => {
    const steps = commandSteps('cd /w && bash -c "cd /y && rg x"', '/start');
    expect(at(steps, 'rg')).toMatchObject({ dir: '/y', known: true });
    expect(commandSteps('cd "$d" && bash -c "find ."', '/start').find((s) => s.words[0] === 'find')).toMatchObject({ dir: expect.any(String), known: false });
  });

  it('sends a bare cd to HOME and leaves cd - alone', () => {
    expect(at(commandSteps('cd && find .', '/start', { HOME: '/h/acme' }), 'find')).toMatchObject({ dir: '/h/acme' });
    expect(at(commandSteps('cd - && find .', '/start', { HOME: '/h/acme' }), 'find')).toMatchObject({ dir: '/start' });
  });

  it('leaves redirect targets and wrappers out of the words', () => {
    expect(commandSteps('A=1 sudo find . > /tmp/o 2>&1', '/s').map((s) => s.words)).toEqual([['find', '.']]);
  });

  it('gives [] for an empty or non-string command', () => {
    expect(commandSteps('', '/s')).toEqual([]);
    expect(commandSteps(undefined, '/s')).toEqual([]);
  });
});

describe('env -S', () => {
  it.each([
    "env -S 'rm -f x'",
    "env --split-string 'rm -f x'",
    "env --split-string='rm -f x'",
    "env -S'rm -f x'",
    "env -iS 'rm -f x'",
    "env -i -S 'rm -f x'",
    "env --s='rm -f x'",
    "env --sp 'rm -f x'",
    "env --split-str='rm -f x'",
    "env --sp '-i rm -f x'",
  ])('splits the string of %j into the command it holds', (command) => {
    expect(commandWords(command)).toEqual([['rm', '-f', 'x']]);
  });

  it('takes a NAME=value prefix of the string as an assignment', () => {
    expect(commandWords("env -S 'FOO=1 rm x'")).toEqual([['rm', 'x']]);
  });

  it('gives nothing for -S with no string', () => {
    expect(commandWords('env -S')).toEqual([]);
  });

  it('marks a string it cannot read, and keeps env as the first word', () => {
    for (const command of ["env -S 'rm\\_x'", "env -S 'rm $X'", "env -S 'a\\x20b'", `env ${'-S '.repeat(8)}rm x`]) {
      const [step] = commandSteps(command, '/s');
      expect(step.unreadable, command).toBe(true);
      expect(step.words[0], command).toBe('env');
    }
    expect(commandSteps("env -S 'rm x'", '/s')[0].unreadable).toBeUndefined();
    // an option env is not known to take is unreadable: its value may be a string env splits
    for (const command of ["env --bogus 'rm x'", "env -Z 'rm x'", "env -iZ 'rm x'", "env --ig=x 'rm x'"]) {
      expect(commandSteps(command, '/s')[0].unreadable, command).toBe(true);
    }
    for (const command of ['env -i FOO=1 rm x', 'env -u FOO rm x', 'env -0 rm x', 'env --unset=FOO rm x', 'env --ignore-environment rm x', 'env -- rm x']) {
      expect(commandSteps(command, '/s')[0].unreadable, command).toBeUndefined();
    }
    expect(commandSteps(`env ${'-S '.repeat(7)}rm x`, '/s').map((s) => s.words)).toEqual([['rm', 'x']]);
  });

  it('keeps the command after an env option it does not know, so the anchor guard denies it as before', () => {
    for (const option of ['--ignore-env', '--ignore', '--nul', '--deb']) {
      expect(decide(`env ${option} rm /a/foreman.config.json`), option).toBe(reasonFor('/a/foreman.config.json'));
      expect(commandSteps(`env ${option} rm x`, '/s')[0].words, option).toEqual(['rm', 'x']);
    }
  });

  it('denies a protected file written through env -S', () => {
    expect(decide("env -S 'rm /a/foreman.config.json'")).toBe(reasonFor('/a/foreman.config.json'));
    expect(decide("env -S 'ls /a/foreman.config.json'")).toBeNull();
  });
});
