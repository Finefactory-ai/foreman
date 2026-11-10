import { describe, expect, it } from 'vitest';
import { checkSignatures, handRun, handRunReason } from './check-guard.mjs';
import { bashHoles, hasBash, heredocLayouts } from './shell-holes.mjs';

const RUN = 'SLOW_TEST_GUARD=report npm test';
const node = [{ run: RUN, when: 'always' }];
const hit = (command, checks) => handRun({ command, checks });

describe('checkSignatures', () => {
  it('gives one signature per check: its last command that does not read a pipe, skipping cd and foreman', () => {
    const sigs = checkSignatures([{ run: 'cd sub && npm test; foreman checks', when: 'always' }, { run: 'npm run lint', when: 'src/**' }]);
    expect(sigs).toEqual([
      { run: 'cd sub && npm test; foreman checks', full: true, words: ['npm', 'test'] },
      { run: 'npm run lint', full: false, words: ['npm', 'run', 'lint'] },
    ]);
  });

  it('removes a timeout prefix and gives none for a check of only timeout', () => {
    expect(checkSignatures([{ run: 'timeout 600 npm test', when: 'always' }])).toEqual([{ run: 'timeout 600 npm test', full: true, words: ['npm', 'test'] }]);
    expect(checkSignatures([{ run: 'timeout 600', when: 'always' }])).toEqual([]);
  });

  it('keeps set-up steps and pipe filters out of the signature', () => {
    const db = checkSignatures([{ run: 'npm run db:reset && npm run test:db', when: 'always' }]);
    expect(db).toHaveLength(1);
    expect(db[0].words).toEqual(['npm', 'run', 'test:db']);
    expect(checkSignatures([{ run: 'npm test 2>&1 | tee out.log', when: 'always' }])[0].words).toEqual(['npm', 'test']);
  });

  it('gives [] for non-array input and skips a check with no run', () => {
    expect(checkSignatures(undefined)).toEqual([]);
    expect(checkSignatures('npm test')).toEqual([]);
    expect(checkSignatures([{ run: 5 }, { run: '' }, null, { when: 'always' }])).toEqual([]);
  });
});

describe('handRun with an npm check', () => {
  it.each([
    'SLOW_TEST_GUARD=report npm test 2>&1 | tail -40',
    'npm test',
    'npm test > /tmp/out.txt 2>&1 &',
    'env CI=1 npm test',
    'timeout 900 npm test',
    'timeout -s KILL --kill-after=5 -v 900 npm test',
    'timeout --foreground --preserve-status 10s npm test',
    'timeout -k 5 -s TERM 900 CI=1 npm test',
    'cd sub && npm test',
    'bash -c "npm test"',
    'npm test -- --reporter=dot',
    'npm test --silent',
    'npm test --',
  ])('denies %s', (command) => {
    expect(hit(command, node)).toEqual({ run: RUN, full: true });
  });

  it.each([
    'foreman checks --changed',
    'foreman checks --changed --start',
    'foreman checks --wait w1-x-1',
    'npx vitest run plugin/lib/engine/state.test.mjs',
    'npm test -- plugin/lib/engine/state.test.mjs',
    'echo npm test',
    'git commit -m "npm test"',
    'npm run lint',
    'npm ci',
    'npm',
    'timeout 900',
    'timeout',
    '',
  ])('allows %s', (command) => {
    expect(hit(command, node)).toBeNull();
  });

  it('allows a non-string command', () => {
    expect(hit(undefined, node)).toBeNull();
    expect(hit(7, node)).toBeNull();
  });
});

describe('handRun with a check that has a timeout prefix', () => {
  const run = 'timeout 600 npm test';
  const checks = [{ run, when: 'always' }];
  it.each(['timeout 600 npm test', 'npm test', 'timeout 600 npm test 2>&1 | tail'])('denies %s', (command) => {
    expect(hit(command, checks)).toEqual({ run, full: true });
  });
  it('allows a targeted run', () => {
    expect(hit('npm test -- plugin/x.test.mjs', checks)).toBeNull();
  });
});

describe('handRun with a check of several commands', () => {
  const ci = [{ run: 'npm ci && npm test', when: 'always' }];
  it('leaves the set-up step free and denies the last command', () => {
    expect(hit('npm ci', ci)).toBeNull();
    expect(hit('npm test', ci)).toEqual({ run: 'npm ci && npm test', full: true });
    expect(hit('npm ci && npm test', ci)).toEqual({ run: 'npm ci && npm test', full: true });
  });
  it('leaves a database reset free and denies the test run', () => {
    const db = [{ run: 'npm run db:reset && npm run test:db', when: 'always' }];
    expect(hit('npm run db:reset', db)).toBeNull();
    expect(hit('npm run test:db', db)).toEqual({ run: db[0].run, full: true });
  });
  it('leaves a pipe filter free', () => {
    expect(hit('tee out.log', [{ run: 'npm test 2>&1 | tee out.log', when: 'always' }])).toBeNull();
  });
});

describe('handRun behind an env option the parser does not list', () => {
  it.each(['env --ignore npm test', 'env --deb npm test', 'env --ignore-env npm test'])('denies %j', (command) => {
    expect(hit(command, node)).toEqual({ run: RUN, full: true });
  });
});

describe('handRun and heredocs', () => {
  it.each([
    "cat > notes.md <<'EOF'\nRun the suite:\nnpm test\nEOF",
    "cat <<'EOF' > notes.md\nnpm test\nEOF",
    'cat >> notes.md <<"EOF"\nnpm test\nEOF',
    "cat > notes.md <<-'EOF'\n\tnpm test\n\tEOF",
    'git commit -m "$(cat <<\'EOF\'\nFM-1 npm test\nEOF\n)"',
    "git commit -F - <<'EOF'\nnpm test\nEOF",
    // after a << it cannot prove, a check is still denied only where a command starts
    'cd "$D" && cat > n.md <<\'EOF\'\nRun npm test first.\nEOF',
    'gh pr create --title x --body "$(cat <<\'EOF\'\nThe page (and its tests).\n- npm test passes; pytest is not used\nEOF\n)"',
  ])('allows the quoted data body of %j', (command) => {
    expect(hit(command, node)).toBeNull();
  });

  it.each([
    'cat <<EOF\nnpm test\nEOF',
    'cat > notes.md <<EOF\nnpm test\nEOF',
    "cat <<'EOF'\nnpm test\nEOF",
    "bash <<'EOF'\nnpm test\nEOF",
    'sh <<"EOF"\nnpm test\nEOF',
    "cat <<'EOF' | bash\nnpm test\nEOF",
    "cat > n.md <<'EOF' && npm test\nx\nEOF",
    "cat > n.md <<'EOF'\nx\nEOF\nnpm test",
    "cat > n.md <<'EOF'\nnpm test",
    'echo $((1<<2))\nnpm test',
    'cat <<$HOME >/tmp/x\nhi\n$HOME\nnpm test',
    "sh -s \\\ngit commit -F - <<'EOF'\nnpm test\nEOF",
    "# x\ncat > n.md <<'EOF'\nnpm test\nEOF",
    // a << inside a quote is not a heredoc, so the lines after it run
    "cat > ' <<EOF '\nnpm test\nEOF",
    'cat > " <<EOF "\nnpm test\nEOF',
    "echo ' <<'EOF' ' && cat > f\nnpm test\nEOF",
    "true \" <<'X' \" ; cat >> notes.md\nnpm test\nX",
    'echo "\n<<EOF\n"; npm test\nEOF',
    "echo \"<<'npm test'\"\nnpm test",
    "cat <<''\n'\n\nnpm test",
    // found by running generated commands through bash
    "git commit -F - <<'EOF' \" ; cat >> f\n\" ; npm test\nEOF\n' ; npm test",
    "echo 'x' && cat > f <<\"EOF\" \"\n\" ; npm test\nEOF\n' ; npm test",
    "git commit -F - <<E'O'F\n' ; npm test\nEOF\nnpm test",
    'git commit -m "$(cat <<-EOF\n)" ; npm test\nEOF\n\'\nnpm test',
    "cat <<A <<B\nx\nA\n'\nB\nnpm test",
    // found by the real-bash test: a heredoc in a substitution that never closes still feeds sh
    'git commit -m "$(cat <<\'EOF\' | sh\nnpm test\n)"\n\'',
    'git commit -m "$(cat <<\'EOF\' | sh\nnpm test\n)"',
  ])('denies %j', (command) => {
    expect(hit(command, node)).toEqual({ run: RUN, full: true });
  });
});

describe('handRun with a pytest check', () => {
  const py = [{ run: 'pytest', when: 'always' }];
  it('denies pytest, pytest -q and a chained run', () => {
    for (const command of ['pytest', 'pytest -q', 'python3 -m x; pytest']) {
      expect(hit(command, py)).toEqual({ run: 'pytest', full: true });
    }
  });
  it('allows a targeted run', () => {
    expect(hit('pytest tests/test_x.py', py)).toBeNull();
    expect(hit('pytest -k login tests/', py)).toBeNull();
  });
});

describe('handRun with other checks', () => {
  it('denies a Salesforce test-level check but allows a targeted one', () => {
    const sf = [{ run: 'sf apex run test --test-level RunLocalTests', when: 'always' }];
    expect(hit('sf apex run test --test-level RunLocalTests', sf)).toEqual({ run: sf[0].run, full: true });
    expect(hit('sf apex run test --tests AcmeTest', sf)).toBeNull();
    expect(hit('sf apex run test', sf)).toBeNull();
  });

  it('gives full: false for a check chosen by a glob', () => {
    expect(hit('npm run lint', [{ run: 'npm run lint', when: 'src/**' }])).toEqual({ run: 'npm run lint', full: false });
  });

  it('matches the first configured check', () => {
    const checks = [{ run: 'npm run lint', when: 'src/**' }, ...node];
    expect(hit('npm test', checks)).toEqual({ run: RUN, full: true });
    expect(hit('npm run lint && npm test', checks)).toEqual({ run: 'npm run lint', full: false });
  });

  it('never matches a foreman command, even from a check that names one', () => {
    expect(hit('foreman checks', [{ run: 'foreman checks', when: 'always' }])).toBeNull();
  });

  it('gives null with no checks, undefined checks or a non-string run', () => {
    expect(hit('npm test', [])).toBeNull();
    expect(hit('npm test', undefined)).toBeNull();
    expect(hit('npm test', [{ run: 5, when: 'always' }])).toBeNull();
  });
});

describe('handRunReason', () => {
  it('is the exact message', () => {
    const reason = handRunReason('X');
    expect(reason).toBe(
      "Foreman denies this command: it runs the project's check `X` by hand, which leaves no record. Run the checks through Foreman: `foreman checks --changed`, or for a long suite `foreman checks --changed --start` and then `foreman checks --wait <id>` (add --reuse where your instructions say so). Targeted runs of single tests stay free.",
    );
    expect(reason).toContain('foreman checks --changed');
    expect(reason).toContain('foreman checks --wait <id>');
  });
});

describe.skipIf(!hasBash())('real bash: generated heredoc and quote layouts', () => {
  it('allows no layout that runs npm test by hand', async () => {
    const commands = heredocLayouts({ seed: 403, size: 1500, danger: ['npm test', 'npm test --silent'] });
    const { holes, checked } = await bashHoles({
      allow: (c) => handRun({ command: c, checks: [{ run: 'npm test', when: 'always' }] }) === null,
      commands,
      // A targeted run (`npm test -- x`) stays free, as in the guard's `matches`.
      stubs: { npm: (args) => /^test(?: -\S+)*$/.test(args), git: () => false },
    });
    expect(holes.map((h) => h.command)).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });
});
