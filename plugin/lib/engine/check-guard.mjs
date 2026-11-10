// Whether a Bash command runs one of the project's checks by hand. `foreman checks` runs the
// checks (config `checks`) and records every run in check-runs.jsonl (check-runs.mjs); a check
// an agent runs itself leaves no record, so a story session's other agents cannot reuse it and
// `foreman report` cannot count it. So bash-guard.mjs denies the command and points to
// `foreman checks`. Pure: the signatures come only from the config, nothing here knows a
// language or a tool.
//
//   checkSignatures(checks) -> [{ run, full, words }]: one per check with a `run`: the words of
//       its last command that does not read a pipe, with a timeout prefix removed (the cd and
//       foreman commands left out). Set-up steps (`npm ci` in `npm ci && npm test`) and pipe
//       filters (`| tee log`) are not the check and stay free; a check of only `timeout 600`
//       gives none.
//   handRun({ command, checks, vars }) -> { run, full } for the first configured check the command
//       runs, or null. A simple command of `command` (a timeout wrapper, NAME=value prefixes and
//       wrappers such as env removed) runs a check when it starts with the check's words and
//       every word after them is an option (starts with -). A positional word after them is a
//       targeted run (`pytest tests/x.py`, `npm test -- file`) and stays free.
//       A heredoc body is not read only when its delimiter is quoted and it is a data form
//       (`cat >[>] FILE <<'EOF'`, the `git commit -m "$(cat <<'EOF'` idiom, or `git commit -F -
//       <<'EOF'`), and the text before it is proven plain (heredocs.mjs). Every other body,
//       including any unquoted one, is read as commands, so `cat <<EOF` with a bare check line
//       is still denied: a known limit. The anchor and scan guards still read heredoc bodies
//       inline. When a `<<` is not proven a heredoc (heredocParts `unsure`), the text from its
//       line on is also searched raw: a check's words where a command may start are denied.
//   handRunReason(run) -> why Foreman denies it
//   stripTimeout(words) -> the command a `timeout [options] DURATION cmd...` runs, or the words as
//       they are (scan-guard.mjs reads it too)

import path from 'node:path';
import { commandWords, pipelineHeads } from './anchor-files.mjs';
import { heredocParts, rawText } from './heredocs.mjs';

const NAME_VALUE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// timeout's options that take a value, and those that do not.
const TIMEOUT_VALUE_OPTIONS = new Set(['-s', '--signal', '-k', '--kill-after']);
const TIMEOUT_FLAGS = new Set(['--foreground', '--preserve-status', '-v']);

const base = (word) => path.basename(String(word ?? ''));

// The command `timeout [options] DURATION cmd...` runs, or the words as they are.
export function stripTimeout(words) {
  if (base(words[0]) !== 'timeout') return words;
  let i = 1;
  while (i < words.length && words[i].startsWith('-') && words[i] !== '-') {
    if (words[i] === '--') {
      i++;
      break;
    }
    if (TIMEOUT_VALUE_OPTIONS.has(words[i])) i++;
    else if (!TIMEOUT_FLAGS.has(words[i]) && !/^--(signal|kill-after)=/.test(words[i])) break;
    i++;
  }
  i++; // the duration
  while (i < words.length && NAME_VALUE.test(words[i])) i++;
  return words.slice(i);
}

export function checkSignatures(checks) {
  if (!Array.isArray(checks)) return [];
  const out = [];
  for (const check of checks) {
    if (!check || typeof check.run !== 'string' || check.run === '') continue;
    const core = pipelineHeads(check.run, {})
      .map(stripTimeout)
      .filter((w) => w.length > 0 && base(w[0]) !== 'cd' && base(w[0]) !== 'foreman')
      .at(-1);
    if (core) out.push({ run: check.run, full: check.when === 'always', words: core });
  }
  return out;
}

const matches = (w, sig) => {
  if (w.length < sig.words.length || w.length === 0) return false;
  if (base(w[0]) !== base(sig.words[0]) || base(w[0]) === 'foreman') return false;
  for (let i = 1; i < sig.words.length; i++) if (w[i] !== sig.words[i]) return false;
  for (let k = sig.words.length; k < w.length; k++) if (!w[k].startsWith('-')) return false;
  return true;
};

export function handRun({ command, checks, vars = {} }) {
  const signatures = checkSignatures(checks);
  if (signatures.length === 0 || typeof command !== 'string' || command === '') return null;
  const { outer, bodies, unsure } = heredocParts(command, { quotedOnly: true });
  const simple = [outer, ...bodies].flatMap((t) => commandWords(t, vars ?? {})).map(stripTimeout);
  for (const sig of signatures) {
    if (simple.some((w) => matches(w, sig))) return { run: sig.run, full: sig.full };
  }
  if (unsure !== null) {
    const raw = rawText(unsure);
    for (const sig of signatures) if (startsCommand(sig).test(raw)) return { run: sig.run, full: sig.full };
  }
  return null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The check as `matches` reads it, in text that cannot be parsed: the check's words where a command
// starts (a line start, or after ; & | or a parenthesis, past NAME=value prefixes, the first word
// with any folder), then only options to the end of the command. `npm test passes` in prose is a
// targeted run, as it is in a parsed command.
const startsCommand = (sig) => {
  const [first, ...more] = sig.words.map(escape);
  const words = [`(?:[^\\s;&|()]*/)?${escape(base(sig.words[0])) || first}`, ...more].join('[ \\t]+');
  return new RegExp(`(?:^|[;&|(])[ \\t]*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*[ \\t]+)*${words}(?:[ \\t]+-[^\\s;&|()]*)*[ \\t]*(?=$|[;&|)])`, 'm');
};

export const handRunReason = (run) =>
  `Foreman denies this command: it runs the project's check \`${run}\` by hand, which leaves no record. Run the checks through Foreman: \`foreman checks --changed\`, or for a long suite \`foreman checks --changed --start\` and then \`foreman checks --wait <id>\` (add --reuse where your instructions say so). Targeted runs of single tests stay free.`;
