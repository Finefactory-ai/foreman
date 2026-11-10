import { describe, expect, it } from 'vitest';
import { gitMessageWords, heredocParts, plainCommands, rawText } from './heredocs.mjs';

describe('heredocParts: the default reading', () => {
  it('drops an unquoted body with no substitution when it is a data form', () => {
    const { outer, bodies } = heredocParts('cat > n.md <<EOF\nhi\nEOF\nls');
    expect(bodies).toEqual([]);
    expect(outer).not.toContain('hi');
    expect(outer).toContain('ls');
  });

  it('keeps an unquoted body with a substitution as a body to read', () => {
    expect(heredocParts('cat > n.md <<EOF\n$(x)\nEOF').bodies).toEqual(['$(x)\n']);
    expect(heredocParts('cat > n.md <<EOF\n`x`\nEOF').bodies).toEqual(['`x`\n']);
  });
});

describe('heredocParts: quotedOnly', () => {
  it('reads an unquoted body even when it is a data form with no substitution', () => {
    const { outer, bodies } = heredocParts('cat > n.md <<EOF\nhi\nEOF\nls', { quotedOnly: true });
    expect(bodies).toEqual(['hi\n']);
    expect(outer).not.toContain('hi');
    expect(outer).toContain('ls');
  });

  it.each([
    "cat > n.md <<'EOF'\nhi\nEOF",
    'cat <<"EOF" > n.md\nhi\nEOF',
    'cat >> n.md <<\\EOF\nhi\nEOF',
    "cat > n.md <<-'EOF'\n\thi\n\tEOF",
    'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)"',
  ])('drops the body of %j', (text) => {
    const { outer, bodies } = heredocParts(text, { quotedOnly: true });
    expect(bodies).toEqual([]);
    expect(outer).not.toMatch(/\bhi\b|\bmsg\b/);
  });

  it('drops a quoted body with a substitution in it', () => {
    expect(heredocParts("cat > n.md <<'EOF'\n$(x)\nEOF", { quotedOnly: true }).bodies).toEqual([]);
  });
});

describe('heredocParts: bodies that are read', () => {
  it.each([
    "bash <<'EOF'\nx\nEOF",
    "cat <<'EOF' | sh\nx\nEOF",
    "cat <<'EOF'\nx\nEOF",
  ])('puts the body of %j in bodies', (text) => {
    expect(heredocParts(text, { quotedOnly: true }).bodies).toEqual(['x\n']);
    expect(heredocParts(text).bodies).toEqual(['x\n']);
  });

  it('leaves an unclosed heredoc in outer', () => {
    const text = "cat > n.md <<'EOF'\nx";
    expect(heredocParts(text, { quotedOnly: true })).toEqual({ outer: text, bodies: [], unsure: null });
  });

  it('is unsure from the line of an unclosed heredoc whose head is not plain', () => {
    const text = 'true\ngit commit -m "$(cat <<\'EOF\' | sh\nnpm test\n)"';
    expect(heredocParts(text, { quotedOnly: true })).toEqual({ outer: text, bodies: [], unsure: text.slice(5) });
  });

  it('leaves an arithmetic << in outer', () => {
    const text = 'echo $((1<<2))\nx';
    expect(heredocParts(text, { quotedOnly: true })).toEqual({ outer: text, bodies: [], unsure: null });
  });

  it('is unsure from the line of an arithmetic << that could be a heredoc', () => {
    const text = 'ls\necho $((a<<b))\nx\nb';
    expect(heredocParts(text, { quotedOnly: true })).toEqual({ outer: text, bodies: [], unsure: 'echo $((a<<b))\nx\nb' });
  });
});

describe('rawText', () => {
  it('takes out quotes, backslashes and backslash-newlines', () => {
    expect(rawText(`p''kill "x" p\\kill pk\\\nill`)).toBe('pkill x pkill pkill');
  });
});

describe('heredocParts: unsure', () => {
  it.each([
    "cat > n.md <<'EOF'\nx\nEOF",
    'git commit -m "$(cat <<\'EOF\'\nx\nEOF\n)"',
    "git commit -F - <<'EOF'\nx\nEOF",
    "cd /work/acme && python3 - <<'EOF'\nx\nEOF",
    'gh pr create --body "$(cat <<\'EOF\'\nx\nEOF\n)"',
    "cat > a <<'A'\nx\nA\ncat > b <<'B'\ny\nB",
    'ls\ncat <<EOF\nx',
    'echo hi',
  ])('is null when every << is proven a heredoc: %j', (text) => {
    for (const options of [{ quotedOnly: true }, {}]) expect(heredocParts(text, options).unsure).toBeNull();
  });

  it.each([
    ["cat > ' <<EOF '\nx\nEOF", 0],
    ['cat > " <<EOF "\nx\nEOF', 0],
    ["echo ' <<EOF ' && cat > f\nx\nEOF", 0],
    ["true \" <<'X' \" ; cat >> notes.md\nx\nX", 0],
    ["echo \"<<'pkill x'\"\npkill x", 0],
    ['echo "\n<<EOF\n"; x\nEOF', 1],
    ["cat <<''\n'\n\nx", 0],
    ["ls\necho '((' ; cat <<'EOF'\n'\nEOF\nx", 1],
    ["cd \"$D\" && cat > n.md <<'EOF'\nx\nEOF", 0],
    ["bash <<'A'\nx\nA\ncat > f <<'B'\ny\nB", 3],
    // a quote opened after the delimiter: bash reads on past the newline before the body starts
    ["git commit -F - <<'EOF' \" ; cat >> f\n\" ; x\nEOF", 0],
    ["ls\ncat > f <<EOF '\n' ; x\nEOF", 1],
    // a second heredoc on the line: its body follows the first one's
    ["cat <<A <<B\nx\nA\n'\nB\nx", 0],
    // the delimiter word goes on, or a double quote changes it: the real delimiter is another
    ["git commit -F - <<E'O'F\n' ; x\nEOF\nx", 0],
    ["cat > f <<'EOF'x\n'\nEOFx\nx", 0],
    ['cat > f <<"E\\\\F"\n\'\nE\\F\nx', 0],
    // in $(cat <<, bash 3.2 can end the substitution at a ) in the body
    ['git commit -m "$(cat <<-EOF\n)" ; x\nEOF\n)"', 0],
    ['gh pr create --body "$(cat <<\'EOF\'\nsee (x)\nEOF\n)"', 0],
  ])('is the text from the line of the first << it cannot prove: %j', (text, line) => {
    const from = text.split('\n').slice(line).join('\n');
    for (const options of [{ quotedOnly: true }, {}]) expect(heredocParts(text, options).unsure).toBe(from);
  });
});

describe('plainCommands', () => {
  it('reads a plain line as commands, words and redirect targets', () => {
    expect(plainCommands('git add -A && git commit -q')).toEqual({
      commands: [
        { words: ['git', 'add', '-A'], bare: true, outs: [] },
        { words: ['git', 'commit', '-q'], bare: true, outs: [] },
      ],
      trailing: null,
    });
    expect(plainCommands("echo 'a;b' \"x y\"").commands[0].words).toEqual(['echo', 'a;b', 'x y']);
    expect(plainCommands('echo x > f.md')).toEqual({ commands: [{ words: ['echo', 'x'], bare: true, outs: ['f.md'] }], trailing: null });
    expect(plainCommands('cat >>f.md').commands[0].outs).toEqual(['f.md']);
    expect(plainCommands("'git' commit").commands[0].bare).toBe(false);
    expect(plainCommands('a && ')).toEqual({ commands: [{ words: ['a'], bare: true, outs: [] }], trailing: '&&' });
    expect(plainCommands('a;').trailing).toBe(';');
    expect(plainCommands('a ||').trailing).toBe('||');
    expect(plainCommands('')).toEqual({ commands: [], trailing: null });
    expect(plainCommands(' \t ')).toEqual({ commands: [], trailing: null });
  });

  it.each([
    'a \\',
    'a $x',
    'a `x`',
    'a #b',
    'a (b)',
    'a {',
    'a [x]',
    'a < f',
    'a | b',
    'a |',
    'a & b',
    'a &',
    'a >&2',
    'a >| f',
    'a "$x"',
    'a "`x`"',
    'a "x\\y"',
    'a "x!"',
    "a 'x",
    'a "x',
    'a\r',
    'a "x\ry"',
    'a ;; b',
    '; a',
    '&& a',
    'a && && b',
    'a >',
    'a > && b',
    'a >>>f',
    '> f',
    'a *',
    'a ?',
    'a ^',
    'a !',
    'a é',
  ])('refuses %j', (line) => {
    expect(plainCommands(line)).toBeNull();
  });

  it('lets a span hold text the bare line may not', () => {
    expect(plainCommands("git commit -m 'a $x (b) # c ` d \\ e'")).not.toBeNull();
    expect(plainCommands('git commit -m "a (b) # c [d] { e } é"')).not.toBeNull();
  });
});

describe('gitMessageWords', () => {
  it('finds the message words', () => {
    expect(gitMessageWords(['git', 'commit', '-m', 'x'])).toEqual({ messages: new Set([3]), stdin: false, flagAtEnd: false });
    expect(gitMessageWords(['git', 'commit', '-am', 'x']).messages).toEqual(new Set([3]));
    expect(gitMessageWords(['git', 'commit', '-qm', 'x']).messages).toEqual(new Set([3]));
    expect(gitMessageWords(['git', 'commit', '--message', 'x']).messages).toEqual(new Set([3]));
    expect(gitMessageWords(['git', 'commit', '-mx']).messages).toEqual(new Set([2]));
    expect(gitMessageWords(['git', 'commit', '--message=x']).messages).toEqual(new Set([2]));
    expect(gitMessageWords(['git', 'tag', '-m', 'x', 'v1']).messages).toEqual(new Set([3]));
    expect(gitMessageWords(['git', 'merge', '--no-ff', '-m', 'x', 'main']).messages).toEqual(new Set([4]));
    expect(gitMessageWords(['/usr/bin/git', 'commit', '-m', 'x']).messages).toEqual(new Set([3]));
  });

  it('skips -C dir pairs', () => {
    expect(gitMessageWords(['git', '-C', 'dir', 'commit', '-m', 'x']).messages).toEqual(new Set([5]));
    expect(gitMessageWords(['git', '-C', 'a', '-C', 'b', 'commit', '-m', 'x']).messages).toEqual(new Set([7]));
  });

  it('sees a message from stdin', () => {
    for (const words of [
      ['git', 'commit', '-F', '-'],
      ['git', 'commit', '-F-'],
      ['git', 'commit', '--file=-'],
      ['git', 'commit', '--file', '-'],
    ]) {
      expect(gitMessageWords(words)?.stdin, words.join(' ')).toBe(true);
    }
    expect(gitMessageWords(['git', 'commit', '-m', 'x']).stdin).toBe(false);
  });

  it('sees a message flag that ends the words', () => {
    expect(gitMessageWords(['git', 'commit', '-m']).flagAtEnd).toBe(true);
    expect(gitMessageWords(['git', 'commit', '-am']).flagAtEnd).toBe(true);
    expect(gitMessageWords(['git', 'commit', '--message']).flagAtEnd).toBe(true);
    expect(gitMessageWords(['git', 'commit', '--message=']).flagAtEnd).toBe(true);
    expect(gitMessageWords(['git', 'commit', '-m', 'x']).flagAtEnd).toBe(false);
    expect(gitMessageWords(['git', 'commit', '--message=x']).flagAtEnd).toBe(false);
  });

  it('allows the safe options and positionals', () => {
    expect(gitMessageWords(['git', 'commit', '-a', '-q', '--no-verify', '--allow-empty', '-m', 'x'])).not.toBeNull();
    expect(gitMessageWords(['git', 'merge', '--ff-only', 'main'])).not.toBeNull();
  });

  it.each([
    [['git', 'bisect', 'run', 'sh']],
    [['git', '-c', 'x', 'commit', '-m', 'y']],
    [['git', '--git-dir=x', 'commit', '-m', 'y']],
    [['git', 'commit', '-e', '-m', 'y']],
    [['git', 'commit', '--edit', '-m', 'y']],
    [['git', 'commit', '-c', 'HEAD']],
    [['git', 'commit', '-t', 'f']],
    [['git', 'commit', '--template=f']],
    [['git', 'commit', '--', 'f']],
    [['git', 'commit', '-F', 'file']],
    [['git', 'commit', '--file=file']],
    [['git', 'commit', '-F']],
    [['git', 'commit', '-amx']],
    [['sh', 'commit', '-m', 'x']],
    [['git']],
    [[]],
  ])('refuses %j', (words) => {
    expect(gitMessageWords(words)).toBeNull();
  });
});

const MARK = 'MARKER_WORD';
// A body is read when its marker is still in `outer` or in a body to read; a data body is in neither.
const reads = (text, options) => {
  const { outer, bodies } = heredocParts(text, options);
  return [outer, ...bodies].some((t) => t.includes(MARK));
};
const BOTH = [{ quotedOnly: true }, {}];

describe('heredocParts: the data forms', () => {
  it.each([
    `cat > n.md <<'EOF'\n${MARK}\nEOF`,
    `cat <<'EOF' > n.md\n${MARK}\nEOF`,
    `cat >> n.md <<'EOF'\n${MARK}\nEOF`,
    `cat >n.md <<"EOF"\n${MARK}\nEOF`,
    `cat <<-'EOF' >> n.md\n\t${MARK}\n\tEOF`,
    `git commit -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`,
    `git commit -am "$(cat <<'EOF'\n${MARK}\nEOF\n)"`,
    `git commit --message="$(cat <<'EOF'\n${MARK}\nEOF\n)"`,
    `git commit --message "$(cat <<'EOF'\n${MARK}\nEOF\n)"`,
    `git tag -m "$(cat <<'EOF'\n${MARK}\nEOF\n)" v1`,
    `git commit -F - <<'EOF'\n${MARK}\nEOF`,
    `git commit -F- <<'EOF'\n${MARK}\nEOF`,
    `git commit --file=- <<'EOF'\n${MARK}\nEOF`,
    `git commit --file - <<'EOF'\n${MARK}\nEOF`,
    `git -C /work/acme commit -q -F - <<'EOF'\n${MARK}\nEOF`,
    `git add -A && git commit -F - <<'EOF'\n${MARK}\nEOF`,
    `cd /work/acme && git commit -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`,
    `mkdir -p docs && cat > docs/n.md <<'EOF'\n${MARK}\nEOF`,
    `cd /work/acme\ngit add -A\ngit commit -F - <<'EOF'\n${MARK}\nEOF`,
    `cat > a.md <<'A'\n${MARK}\nA\ncat > b.md <<'B'\n${MARK}\nB`,
    `cat > a.md <<'A'\n${MARK}\nA\ngit commit -F - <<'B'\n${MARK}\nB`,
  ])('drops the body of %j', (text) => {
    for (const options of BOTH) {
      expect(heredocParts(text, options).bodies, JSON.stringify(options)).toEqual([]);
      expect(reads(text, options), JSON.stringify(options)).toBe(false);
    }
  });

  it('keeps the text after the heredoc in outer', () => {
    const { outer } = heredocParts(`git commit -F - <<'EOF'\n${MARK}\nEOF\ngit push`, { quotedOnly: true });
    expect(outer).toContain('git push');
    expect(outer).not.toContain(MARK);
  });
});

describe('heredocParts: a line joined to a heredoc, every case read', () => {
  const cases = {
    'J1 backslash-newline before a D3': [`sh -s \\\ngit commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J1 bash -s before a D3': [`bash -s \\\ngit commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J1 backslash-newline before a D1': [`sh -s \\\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J1 backslash in the header': [`cat > n\\\nm.md <<'EOF'\n${MARK}\nEOF`],
    'J2 a quote left open': [`echo 'a\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J2 a double quote left open': [`echo "a\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J3 $( then a quote': [`true $(true)#'\ngit commit -F - <<'EOF2'\n'\n${MARK}\nEOF2`],
    'J3 ${ left open': [`true \${a/x; cat >f<<'EOF2'}\n${MARK}\nEOF2`],
    'J3 ${ before the <<': [`sh \${a/x; cat >f}<<'EOF2'\n${MARK}\nEOF2`],
    'J3 $[ left open': [`true $[x; cat >f<<'EOF2']\n${MARK}\nEOF2`],
    'J3 $(( on an earlier line': [`true $((1\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J3 a backtick on an earlier line': [`echo \`\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J3 ( on an earlier line': [`( true\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J3 { on an earlier line': [`{ true\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J4 a comment before a D1 (;)': [`true #; cat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J4 a comment before a D1 (|)': [`true #| cat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J4 a comment before a D1 (&)': [`true #& cat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J4 a comment before a D2 (;)': [`true #; git commit -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    'J4 a comment before a D2 (|)': [`true #| git commit -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    'J4 a comment before a D2 (&)': [`true #& git commit -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    'J4 a comment before a D3 (;)': [`true #; git commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J4 a comment before a D3 (|)': [`true #| git commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J4 a comment before a D3 (&)': [`true #& git commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J4 a comment line before a D3': [`# note\ngit commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J5 a trailing pipe': [`sh |\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J5 a trailing ampersand': [`sh &\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J6 an earlier heredoc that is not data': [`cat <<'EOF'\nx\nEOF\ncat > f <<'B'\n${MARK}\nB`],
    'J6 a D2 before a D1': [`git commit -m "$(cat <<'A'\nx\nA\n)"\ncat > f <<'B'\n${MARK}\nB`],
    'J6 a D2 before a D3': [`git commit -m "$(cat <<'A'\nx\nA\n)"\ngit commit -F - <<'B'\n${MARK}\nB`],
    'J6 an arithmetic << line': [`echo $((1<<2))\ncat > f <<'B'\n${MARK}\nB`],
    'J6 an unclosed heredoc': [`cat <<'A'\ncat > f <<'B'\n${MARK}\nB`],
    'J6 a command between two D1': [`cat > a <<'A'\nx\nA\nnpm test\ncat > b <<'B'\n${MARK}\nB`],
    'J7 a backslash joins the delimiter': [`cat > n.md <<EOF\nEO\\\nF\n${MARK}\nEOF`],
    'J7 a backslash in an unquoted body': [`cat > n.md <<EOF\nhi \\\n${MARK}\nEOF`],
    'J8 a delimiter with a backslash': [`cat > n.md <<"E\\\\F"\nhi\nE\\F\n${MARK}\nE\\\\F`],
    'J8 text after the quoted delimiter': [`cat > n.md <<'EOF'x\n${MARK}\nEOF`],
    'J8 a redirect glued to the delimiter (read, though bash agrees)': [`cat <<'EOF'>n.md\n${MARK}\nEOF`],
    'J8 a quote inside the delimiter': [`cat > n.md <<'E'OF\n${MARK}\nE`],
    'J8 a delimiter that is not a name': [`cat > n.md <<'E F'\n${MARK}\nE F`],
    'J9 a << inside a quote': [`echo "<<EOF\n" ; ${MARK}\nEOF`],
    'J9 a quote around the << that closes after the delimiter': [`cat > ' <<EOF '\n${MARK}\nEOF`],
    'J9 a double quote around the <<': [`cat > " <<EOF "\n${MARK}\nEOF`],
    'J9 a quoted << before a D1': [`echo ' <<EOF ' && cat > f\n${MARK}\nEOF`],
    'J9 a quoted <<\'X\' before a D1': [`true " <<'X' " ; cat >> notes.md\n${MARK}\nX`],
    'J10 CRLF after the token': [`cat > n.md <<'EOF'\r\n${MARK}\nEOF`],
    'J10 CR in the header': [`cat\r > n.md <<'EOF'\n${MARK}\nEOF`],
    'J11 two heredocs on a line': [`cat <<'A' > f <<'B'\nx\nA\n${MARK}\nB`],
    'J12 hash -p': [`hash -p /bin/sh cat; cat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J12 an alias': [`alias cat=sh\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'J12 an editor in the environment': [`GIT_EDITOR=sh git commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J12 the edit flag': [`git commit -e -F - <<'EOF'\n${MARK}\nEOF`],
    'J12 a file descriptor': [`cat 3<<'EOF' > f\n${MARK}\nEOF`],
    'J12 a file descriptor on a D3': [`git commit -F - 3<<'EOF'\n${MARK}\nEOF`],
    'J12 an export': [`export GIT_EDITOR=sh\ngit commit -F - <<'EOF'\n${MARK}\nEOF`],
    'J12 a function': [`cat() { sh; }\ncat > n.md <<'EOF'\n${MARK}\nEOF`],
    'a pipe after a D2': [`git commit -m "$(cat <<'EOF' | bash\n${MARK}\nEOF\n)"`],
    'a script that takes a git commit': [`sh -s git commit -F - <<'EOF'\n${MARK}\nEOF`],
    'a script with a span': [`sh -s 'a;' git commit -F - <<'EOF'\n${MARK}\nEOF`],
    'a pipe after a D3': [`git commit -F - <<'EOF' | sh\n${MARK}\nEOF`],
    'a second command after a D3': [`git commit -F - <<'EOF'; sh\n${MARK}\nEOF`],
    'a D1 that reads a file': [`cat n.md > m.md <<'EOF'\n${MARK}\nEOF`],
    'a D1 with a pipe': [`cat > n.md <<'EOF' | tee f\n${MARK}\nEOF`],
    'a D3 with a file message': [`git commit -F f <<'EOF'\n${MARK}\nEOF`],
    'a D3 that is not a commit': [`git bisect run sh -F - <<'EOF'\n${MARK}\nEOF`],
    'an unquoted D1 body with $x': [`cat > n.md <<EOF\nhi $x\n${MARK}\nEOF`],
    'an unquoted D1 body with a backslash': [`cat > n.md <<EOF\nhi \\x\n${MARK}\nEOF`],
    'a D2 that is not a message flag': [`git commit -m x"$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    'a D2 with an earlier command that is not plain': [`sh -c x; git commit -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    'a D2 with a redirect': [`git commit -m > f "$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    'a D2 with an edit flag': [`git commit -e -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    'a D2 with a non-git command': [`echo -m "$(cat <<'EOF'\n${MARK}\nEOF\n)"`],
    // bash ends a D2 body early, so a body that could do it is not proven data
    'a D2 body line that closes the substitution': [`git commit -m "$(cat <<'EOF'\nmsg )" ; echo "$(\n${MARK}\nEOF\n)"`],
    'a D2 body holding a backtick': [`git commit -m "$(cat <<'EOF'\nmsg \` ${MARK}\nEOF\n)"`],
    'a D2 body line that starts with the delimiter': [`git commit -m "$(cat <<'EOF'\nEOF)"\n${MARK}\nEOF\n)"`],
    'a D3 body line that starts with the delimiter': [`git commit -F - <<'EOF'\nEOFx\n${MARK}\nEOF`],
    'a D1 body line that starts with the delimiter': [`cat > n.md <<'EOF'\nEOF)\n${MARK}\nEOF`],
    'a D1 body line, indented, that starts with the delimiter': [`cat > n.md <<-'EOF'\n\tEOF)\n${MARK}\n\tEOF`],
  };
  for (const [name, [text]] of Object.entries(cases)) {
    it(name, () => {
      for (const options of BOTH) expect(reads(text, options), JSON.stringify(options)).toBe(true);
    });
  }
});
