// A shell command split into what it runs and the heredoc bodies it holds. Pure: no file is
// read. kill-guard.mjs and check-guard.mjs read it. It imports nothing from either (kill-guard
// already imports check-guard, so a shared module avoids a cycle).
//
//   heredocParts(text, { quotedOnly }) -> { outer, bodies, unsure }: a closed heredoc (its delimiter line
//       is found) is cut out of `outer`. Its body is DATA, and not read at all, only in one of
//       three exact forms, and only when it is inert (see quotedOnly):
//         D1  cat writing to a file: `cat >[>] FILE <<'EOF'` or `cat <<'EOF' > FILE`.
//         D2  the git message idiom: `git commit|tag|merge ... -m|-am|--message[=] "$(cat <<'EOF'`,
//             with nothing after the delimiter.
//         D3  a message from stdin: `git commit|tag|merge ... -F -|--file=-|--file - <<'EOF'`,
//             with nothing after the delimiter.
//       The shell is not copied here. A body counts as data only when the text before it is
//       PROVEN plain by an allow-list (plainCommands, gitMessageWords): the whole line before the
//       `<<` (joined with the rest of the line after the delimiter) and every command on the
//       earlier lines. Anything outside the allow-list (a backslash, `$`, a backtick, `#`, a
//       parenthesis, a brace, a quote left open, a `<`, a single `|` or `&`, a CR, an alias, an
//       editor or an unknown command) makes the body be read as commands, because any of them
//       can join a line to the next or change what `cat` or `git` runs. Each such way is a test.
//       A body is also read when it could end early in the shell: a D2 body holding a `)` or a
//       backtick, or any body line that starts with the delimiter without being exactly it.
//       Any other heredoc, and a D2, ends the proof for the rest of the command: only D1 and D3
//       keep it.
//       Every body that is not data goes to `bodies` and is read as its own text, as commands, so
//       an unbalanced quote in it cannot swallow the commands after it. A heredoc that never ends,
//       and `1 << 3` in arithmetic, stay in `outer` and are read as commands too.
//       A body is inert when its delimiter is quoted ('EOF', "EOF" or \EOF), because the shell
//       expands nothing in it; by default it is also inert when it holds no `$`, backtick or
//       backslash at all (a backslash-newline can join a line into the delimiter). With
//       quotedOnly, only a quoted delimiter makes a body inert, so an unquoted body is always
//       read.
//       A `<<` is PROVEN a heredoc only when every earlier line is proven plain and the text
//       before it on its line is plain on its own (or plain up to a `$(cat `). Otherwise it may
//       sit in a quote or a comment that closes after the delimiter (`cat > ' <<EOF '`), and no
//       cut of the text is sure to match the shell's. `unsure` is then the text from the start
//       of that line to the end (also for an arithmetic `((...<<x` and the empty delimiter
//       `<<''`), else null. The guards search it raw (rawText) and refuse on any hit.
//   rawText(text) -> the text with quotes, backslashes and backslash-newlines taken out
//   plainCommands(line) -> { commands: [{ words, bare, outs }], trailing }, or null: the line
//       read by an allow-list scanner. It accepts only [A-Za-z0-9_./@:+,=%~-], space, tab, a '...'
//       span closed on the line, a "..." span closed on the line with no $, backtick, \ or !, the
//       separators && || ;, and > or >> followed by a word (it goes to `outs`). Anything else
//       gives null. `bare` is true when the first word has no quote. `trailing` is the separator
//       that ends the line, if any.
//   gitMessageWords(words) -> { messages, stdin, flagAtEnd }, or null: for `git [-C dir]
//       commit|tag|merge` with only safe options, the indexes of the message words, whether the
//       message comes from stdin, and whether a message flag ends the words. Any other option
//       (-e, -c, -t, --) gives null: an editor would run the message.

import path from 'node:path';

const HEREDOC = /(?<!<)<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([A-Za-z_]\w*))/g;
const PLAIN_CHAR = /[A-Za-z0-9_./@:+,=%~-]/;

export function plainCommands(line) {
  if (typeof line !== 'string') return null;
  const commands = [];
  let words = [];
  let outs = [];
  let bare = true;
  let cur = '';
  let has = false;
  let quoted = false;
  let redirect = false; // the next word is a redirect's target
  let trailing = null;
  const endWord = () => {
    if (!has) return;
    if (redirect) outs.push(cur);
    else {
      if (words.length === 0) bare = !quoted;
      words.push(cur);
    }
    redirect = false;
    cur = '';
    has = false;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    if (redirect || words.length === 0) return false;
    commands.push({ words, bare, outs });
    words = [];
    outs = [];
    bare = true;
    return true;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\r') return null;
    if (PLAIN_CHAR.test(c)) {
      cur += c;
      has = true;
    } else if (c === ' ' || c === '\t') {
      endWord();
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return null;
      const span = line.slice(i + 1, end);
      if (span.includes('\r')) return null;
      cur += span;
      has = true;
      quoted = true;
      i = end;
    } else if (c === '"') {
      const end = line.indexOf('"', i + 1);
      if (end === -1) return null;
      const span = line.slice(i + 1, end);
      if (/[$`\\!\r]/.test(span)) return null;
      cur += span;
      has = true;
      quoted = true;
      i = end;
    } else if (c === ';' || (c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) {
      const sep = c === ';' ? ';' : c + c;
      if (!endCommand()) return null;
      trailing = sep;
      i += sep.length - 1;
      continue;
    } else if (c === '>') {
      endWord();
      if (redirect) return null;
      if (line[i + 1] === '>') i++;
      redirect = true;
    } else {
      return null;
    }
    if (c !== ' ' && c !== '\t') trailing = null;
  }
  endWord();
  if (redirect) return null;
  if (words.length) commands.push({ words, bare, outs });
  else if (outs.length) return null;
  else if (trailing === null && commands.length === 0) return { commands: [], trailing: null };
  return { commands, trailing };
}

const GIT_SAFE_OPTION = /^(?:-[aqsnvf]+|--(?:all|quiet|signoff|no-verify|allow-empty|amend|no-edit|verbose|annotate|force|no-ff|ff-only))$/;

export function gitMessageWords(words) {
  if (!Array.isArray(words) || path.basename(String(words[0] ?? '')) !== 'git') return null;
  let i = 1;
  while (words[i] === '-C') i += 2;
  if (!['commit', 'tag', 'merge'].includes(words[i])) return null;
  const messages = new Set();
  let stdin = false;
  let flagAtEnd = false;
  for (i += 1; i < words.length; i++) {
    const w = words[i];
    if (/^-[aqsnvf]*m$/.test(w) || w === '--message') {
      if (i + 1 < words.length) messages.add(++i);
      else flagAtEnd = true;
    } else if (/^-m./s.test(w) || w.startsWith('--message=')) {
      messages.add(i);
      if (w === '--message=' && i === words.length - 1) flagAtEnd = true;
    } else if (w === '-F' || w === '--file') {
      if (words[i + 1] !== '-') return null;
      stdin = true;
      i++;
    } else if (w === '-F-' || w === '--file=-') {
      stdin = true;
    } else if (/^(?:-F|--file=)/.test(w)) {
      return null;
    } else if (GIT_SAFE_OPTION.test(w)) {
      // allowed
    } else if (w.startsWith('-')) {
      return null;
    }
  }
  return { messages, stdin, flagAtEnd };
}

// Commands that may come before a data heredoc: none of them changes what `cat` or `git` runs.
const EARLIER = new Set(['cd', 'mkdir', 'git', 'ls', 'pwd', 'echo', 'true']);
const earlierCommand = (c) => c.bare && EARLIER.has(c.words[0]);
const earlierLineOk = (line) => {
  const p = plainCommands(line);
  return p !== null && p.commands.every(earlierCommand);
};

// `$(cat ` (or `"$(cat `) just before the <<: the heredoc of a command substitution.
const ASKED = /"?\$\([ \t]*cat[ \t]*$/;

// Whether the << is proven to be a heredoc operator by the text before it on its line: that text is
// plain (no quote left open, no comment, no substitution), or it is plain up to a `$(cat `.
function provenHead(head) {
  if (plainCommands(head)) return true;
  const asked = ASKED.exec(head);
  return Boolean(asked && plainCommands(head.slice(0, asked.index)));
}

// Whether the rest of the line after the delimiter ends where the line does, so the body starts on
// the next line: every quote closes on the line (a "..." with no $, backtick or backslash), and
// what is left is plain words, separators and `>`. A quote left open carries the line on past the
// newline, and a second `<<` puts its body after this one's.
function restPlain(rest) {
  let left = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c !== "'" && c !== '"') {
      left += c;
      continue;
    }
    const end = rest.indexOf(c, i + 1);
    if (end === -1 || (c === '"' && /[$`\\]/.test(rest.slice(i + 1, end)))) return false;
    i = end;
  }
  return /^[A-Za-z0-9_./@:+,=%~ \t;&|>-]*$/.test(left);
}

// 'D1', 'D2', 'D3' or null: whether the text before the `<<` (head) and after the delimiter
// (rest) prove one of the data forms.
function dataKind(head, rest, delimiter) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(delimiter)) return null;
  if (rest !== '' && !/^[ \t]/.test(rest)) return null;
  const blank = /^[ \t]*$/.test(rest);
  const asked = ASKED.exec(head);
  if (asked) {
    if (!blank) return null;
    const p = plainCommands(head.slice(0, asked.index));
    if (!p || p.trailing !== null || !p.commands.length) return null;
    const last = p.commands.at(-1);
    if (!p.commands.slice(0, -1).every(earlierCommand) || last.outs.length) return null;
    return gitMessageWords(last.words)?.flagAtEnd ? 'D2' : null;
  }
  // `3<<` hands the body to another descriptor
  if (/(?:^|[ \t])\d+$/.test(head)) return null;
  // The head is proven plain on its own first: joined with the rest, a quote opened before the <<
  // and closed after the delimiter (`cat > ' <<EOF '`) would look closed.
  if (!plainCommands(head)) return null;
  const p = plainCommands(head + rest);
  if (!p || p.trailing !== null || !p.commands.length) return null;
  const last = p.commands.at(-1);
  if (!p.commands.slice(0, -1).every(earlierCommand)) return null;
  if (last.bare && last.words.length === 1 && last.words[0] === 'cat' && last.outs.length === 1) return 'D1';
  if (blank && !last.outs.length && gitMessageWords(last.words)?.stdin) return 'D3';
  return null;
}

// Whether the shell ends the body where the delimiter search did. It may not: a line that starts
// with the delimiter but is not exactly it (`EOF)"`) ends a heredoc inside `$( )` in some shells,
// and in a D2 a `)` or a backtick in the body can close the substitution early. The lines after
// that point would run as commands, so such a body is not proven data and is read.
function bodyEndsWhereFound(body, delimiter, kind) {
  if (kind === 'D2' && /[)`]/.test(body)) return false;
  return !body.split('\n').some((line) => line.trimStart().startsWith(delimiter));
}

export function heredocParts(text, { quotedOnly = false } = {}) {
  const re = new RegExp(HEREDOC.source, 'g');
  const bodies = [];
  let outer = '';
  let from = 0;
  let clean = true;
  let unsure = null;
  let m;
  while ((m = re.exec(text))) {
    const delimiter = m[2] ?? m[3] ?? m[5];
    const quoted = m[2] !== undefined || m[3] !== undefined || m[4] === '\\';
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const before = text.slice(lineStart, m.index);
    const eol = text.indexOf('\n', m.index);
    // nothing follows the line: there is no body, so nothing can hide in one
    if (eol === -1) continue;
    // inside (( )) the << is a shift, not a heredoc, but the (( may be in a quote; `<<''` ends at
    // the first empty line. Neither is cut, and the rest is unsure.
    if (before.lastIndexOf('((') > before.lastIndexOf('))') || !delimiter) {
      unsure ??= text.slice(lineStart);
      continue;
    }
    // The delimiter word goes on (`<<E'O'F`, `<<'EOF'x`), or a double quote changes what it holds
    // (`<<"E\\F"`): the shell's delimiter is not the one found, so neither is the body's end.
    const rest = text.slice(m.index + m[0].length, eol);
    if (/^[^ \t;&|<>()]/.test(rest) || (m[3] !== undefined && /[\\$`]/.test(m[3]))) {
      unsure ??= text.slice(lineStart);
      continue;
    }
    let at = eol + 1;
    let end = -1;
    for (;;) {
      const next = text.indexOf('\n', at);
      const line = text.slice(at, next === -1 ? text.length : next);
      if ((m[1] ? line.replace(/^\t+/, '') : line) === delimiter) {
        end = next === -1 ? text.length : next;
        break;
      }
      if (next === -1) break;
      at = next + 1;
    }
    // A heredoc that never ends stays in `outer`. When its head is not plain (a `$(cat ` with a pipe
    // to sh, a quote) `outer` may not be parsable as commands, so the text is unsure and searched raw.
    if (end === -1) {
      if (!plainCommands(before)) unsure ??= text.slice(lineStart);
      continue;
    }
    const body = text.slice(eol + 1, at);
    if (!text.slice(from, lineStart).split('\n').every(earlierLineOk)) clean = false;
    // In `$(cat <<`, bash 3.2 can end the substitution at a `)` in the body.
    const proven =
      clean && provenHead(before) && restPlain(rest) && bodyEndsWhereFound(body, delimiter, plainCommands(before) ? null : 'D2');
    if (!proven) unsure ??= text.slice(lineStart);
    const inert = quoted || (!quotedOnly && !/[$`\\]/.test(body));
    let kind = proven && inert ? dataKind(before, rest, delimiter) : null;
    if (kind && !bodyEndsWhereFound(body, delimiter, kind)) kind = null;
    if (!kind) bodies.push(body);
    clean = kind === 'D1' || kind === 'D3';
    outer += `${text.slice(from, eol)}\n`;
    from = end;
    re.lastIndex = end;
  }
  return { outer: outer + text.slice(from), bodies, unsure };
}

// `text` with its quotes, backslashes and backslash-newlines taken out, so `p''kill`, `"pkill"` and
// `p\kill` all read `pkill`. For searching an unsure text, which cannot be parsed.
export function rawText(text) {
  return String(text ?? '').replace(/\\\n/g, '').replace(/[\\'"]/g, '');
}
