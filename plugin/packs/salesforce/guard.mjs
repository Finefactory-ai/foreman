// The Salesforce pack's Bash guard: layer 4 of the production block. Deployments to production
// are blocked. The real safety sits below the Bash text: a run's sf home holds only
// allow-listed sandboxes and the production orgs salesforce.orgs marks "production": true (layer
// 1), the sf wrapper refuses every command off the production allow-list that would reach a
// marked production org through it, however sf was started (prod-block.mjs), and the release
// steps check IsSandbox on the server (layer 2). This hook stops the common mistakes early, in
// every stage, with a clear reason. It shares the wrapper's rules (prod-block.mjs): the
// allow-list, the flag spellings and how a word names production. For `sf` and `sfdx` it denies:
//   - while a production org is marked, any command not on the production allow-list
//     (PROD_ALLOWED: reads, record changes, describe and schema, the org lists, retrieves, Apex
//     logs, user and permission-set commands, and scratch org create and delete with production
//     as the Dev Hub) when any of its words names that org, by alias or org ID, in every stage.
//     Every argument word counts, not only flag values, so no spelling slips past: -o,
//     --target-org, -u, --u, --targetusername, -c and --devops-center-username, the dev-hub
//     flags, `flag=value`, `-ovalue` and a bare word. For scratch org create and delete a
//     dev-hub flag's value may be production. A command that deploys (`deploy` with start,
//     validate, quick, resume, metadata, source or mdapi, `project deploy pipeline *`, `delete
//     source`, `source push`, `org delete`, `org refresh`, `package install` and `uninstall`,
//     `agent publish|create|activate|deactivate`, `community publish`, DevOps Center's `devops
//     promote` and `devops promotion complete|validate`, or any command whose words name a deploy
//     endpoint: deployRequest, /services/Soap/m/, MetadataContainer, ContainerAsyncRequest) gets
//     the deploy reason; one that prints or hands out credentials or calls the API directly
//     (`org display`, `org open`, `org generate password`, `org auth show-*`, `api request`) gets
//     that reason; a record change given -t, --use-tooling-api (any spelling, --usetoolingapi
//     included) or --flags-dir, which writes Tooling API objects (fields, flows: metadata), gets
//     the metadata-change reason; any other
//     (anonymous Apex, `package *`, `org create sandbox`, legacy `force:*` commands, `project
//     deploy report`) gets the allow-list reason. An allowed command that names a deploy
//     endpoint is checked as a deploy;
//   - a target org (-o, --target-org, -u, --u, --targetusername, and -c or
//     --devops-center-username on `project deploy pipeline` commands) that is not the slot's
//     org, except the test org for `project deploy start --dry-run` in the test stage, when
//     salesforce.test names a stage, and a marked production org for a command on the
//     allow-list;
//   - a dev hub (-v, --target-dev-hub, ...) outside scratch mode, or other than the configured one;
//   - `org login`, `org logout` and the auth aliases; `deploy quick`;
//   - --ignore-conflicts and --ignore-errors (and -c, -r on deploy start, `project deploy
//     pipeline start` included, so a pipeline promotion never starts);
//   - changing the default org or aliases, and --flags-dir; SF_TARGET_ORG, SF_TARGET_DEV_HUB,
//     SFDX_DEFAULTUSERNAME or SFDX_DEFAULTDEVHUBUSERNAME set in front of sf or sfdx; and, only
//     while a production org is marked, the same variables set in front of any other program, by
//     a bare assignment, or by `export`, `declare` or `typeset`, since a later sf reads them with
//     no -o;
//   - `agent test run-eval`, which in this CLI refreshes its sign-in in a loop until the org
//     locks out logins (`sf agent preview` checks an agent instead);
//   - `sf project retrieve` (and `retrieve`, `source retrieve|pull`, `mdapi retrieve`) unless
//     every target is an org marked production, and the `sf data` subcommands that create,
//     update, delete, upsert or import records, against any org, production included. Both are
//     denied in every stage, since every agent's rules forbid them. The production block itself
//     does not refuse record changes; the wrapper runs them;
//   - every command above with its words in any order, since sf's flexibleTaxonomy runs
//     `sf login org` as `sf org login`, and after leading flags (`sf --json agent test run-eval`);
//   - stepping around the isolated sf home (isolation.mjs): sf or sfdx written with a `/`,
//     relative or absolute, which skips the wrapper; HOME, FOREMAN_SF_HOME, SF_DATA_DIR or PATH
//     set in front of sf or sfdx; and HOME, FOREMAN_SF_HOME, SF_DATA_DIR or PATH given by
//     `export`, `declare`, `typeset` or a bare assignment, always for FOREMAN_SF_HOME (sessions
//     export it) and for the others when the command names sf or sfdx;
//   - in every stage, and for any program, not only sf: a command that names ~/.config/foreman/sf,
//     the folder holding the project's Salesforce sign-in key (setup.mjs keyPaths), checked first.
//     It counts in the raw text, and again once backslash-newline pairs, then quotes and
//     backslashes, are removed and the $ forms are joined as below, so `$HOME/...`,
//     `${HOME}/...`, `~/.config/"foreman"/sf` and an absolute /home/acme/.config/foreman/sf
//     all count. The isolated home ~/.config/foreman/sf-home does not.
// The slot org, the test org, the dev hub and the production orgs come from layout() in
// config.mjs. A production dev hub is the configured one in scratch mode, so scratch-org
// commands with --target-dev-hub reach it.
// Any other program whose words name a deploy endpoint (a raw `curl` to deployRequest or the
// Metadata SOAP endpoint, say) is denied while a production org is marked; `bash -c` scripts are
// checked the same way.
// No target means the worktree default, which Foreman sets to the slot org, and is allowed. The
// guard never sees that default: .sf/config.json can be changed by a file edit or a redirection.
// The sf wrapper reads it, and SF_TARGET_ORG and the dev-hub defaults, and refuses a command off
// the allow-list that would reach a marked production org through them, and a `project deploy
// pipeline` deploy that gives no DevOps Center org. A program built at run
// time ($X, $( ), backticks, eval, or
// `bash/sh/zsh -c` with a script built at run time) is denied only when the program word or the
// whole command names sf or sfdx. "Names" means after removing backslash-newline pairs, reading
// $'...' and $"..." as their text, taking ${...}, $NAME and the special parameters as empty, and
// removing quotes, backslashes, and empty $( ) and backtick pairs, as the shell joins `s$()f` or
// `s${Y}f` into sf. Nesting
// deeper than 200 levels stops the scan, and is denied the same way when the command or its
// unscanned rest names sf or sfdx. A program word using unquoted brace expansion is always
// denied. sf, sfdx and the launchers match in any case, and a launcher by its file name
// (`/usr/bin/env` is env).
// Every other program is allowed.
//
// The command is split only at && || ; | & and newline, and at ( ), $( ) and backticks.
// Redirections and their targets are dropped.
//
// Accepted limits. This hook never sees these; the sf wrapper's production check still refuses
// any command off the allow-list against a marked production org through them, and layer 2
// checks every release step:
//   - launcher flags that take values (`sudo -u root sf`, `nice -n 5 sf`, `timeout -s KILL 60 sf`)
//   - when no production org is marked, `export SF_TARGET_ORG=...` and the other default-org
//     variables as a separate command or in front of a program other than sf
//   - xargs, heredocs, `source`, shell functions and aliases
//   - scripts or npm scripts that call sf
//   - dynamic flag names such as `"$F" acme-qa`
//   - false denies when a quoted argument literally equals a guarded flag or a production
//     alias, or when a `bash -c` script uses a $VAR and sf appears elsewhere in the command
//   - an sf name built by a substitution or a variable that prints part of it, such as
//     `s$(echo f)`, `s$X` or `s${Y:-f}`
//   - a command that reaches the key folder without spelling `.config/foreman/sf`, such as
//     `cd ~/.config/foreman && cat s?/*/server.key`, `find ~ -name server.key` or a script. The
//     Read tool is covered apart from Bash: the session's settings deny it on the folder
//     (isolation.mjs setUp)
//   - production named by a username or by another alias in the sf home: the guard matches
//     alias and org ID only, and has no file system; the wrapper resolves usernames and other
//     aliases through the home's alias.json and login files
// What these limits still let reach a production org: the allow-listed commands, such as
// `sf data create record` or a retrieve run through a launcher or a script (the agents' rules
// forbid these), and a raw deploy call from a script.
// Beyond any hook or wrapper, two routes stay open and are accepted:
//   - a session can read the credential files in $FOREMAN_SF_HOME/.sfdx (key.json and the
//     encrypted auth files)
//   - a script that runs the real sf by its full path with HOME set to the isolated home skips
//     the wrapper and its check
//
// Pure: no file system, no environment, never throws.

import { layout } from './config.mjs';
import {
  ALLOWED_SUMMARY,
  DEVHUB_SPELLINGS,
  DEVOPS_SPELLINGS,
  TARGET_SPELLINGS,
  allowedEntry,
  deployEndpoint,
  deploys,
  exposes,
  isProductionName,
  namesProduction,
  pushesUpgrade,
  toolingWrite,
} from './prod-block.mjs';

const START = "Foreman's Salesforce guard denies";
const LOGIN = `${START} \`sf org login\`, \`sf org logout\` and the auth commands: runs use only the logins Foreman sets up.`;
const QUICK = `${START} \`deploy quick\`: deploy with \`sf project deploy start\` so tests run.`;
const IGNORE = `${START} --ignore-conflicts and --ignore-errors (and -c or -r on deploy start): fix the conflict or error instead.`;
const DEVHUB = `${START} this dev hub: --target-dev-hub is allowed only in scratch mode, and only for the dev hub in salesforce.build.scratch.devHub.`;
const DEFAULTS = `${START} this command: the slot's default org and aliases belong to Foreman, and --flags-dir and SF_* org variables would change them.`;
const ISOLATION = `${START} this command: it would step around Foreman's isolated sf home. Run sf or sfdx by name (Foreman's wrapper is first on PATH), and do not set HOME, FOREMAN_SF_HOME, SF_DATA_DIR or PATH for it.`;
const RUN_EVAL = `${START} \`sf agent test run-eval\`: in this CLI it refreshes its sign-in in a loop until the org locks out logins. Check the agent with \`sf agent preview\` instead.`;
const RETRIEVE = `${START} \`sf project retrieve\`: a retrieve rewrites local files with whatever is in the org. Change the files in the worktree instead.`;
const PROD_DEPLOY = `${START} deploying to a production org: Foreman never deploys to production. Against production Foreman runs only: ${ALLOWED_SUMMARY}.`;
const PROD_NOT_ALLOWED = `${START} this command against a production org: it is not one Foreman allows against production. Against production Foreman runs only: ${ALLOWED_SUMMARY}. Deployments to production are blocked.`;
const PROD_TOOLING = `${START} this command against a production org: a record change with --use-tooling-api (or flags from --flags-dir) writes metadata such as fields and flows, and deployments and metadata changes to production are blocked. Change records without --use-tooling-api.`;
const EXPOSE = `${START} this command against a production org: it prints or hands out the org's credentials, or calls its API directly (org display, org open, org generate password, org auth show-*, api request). Query, describe or retrieve with sf instead.`;
const RAW_DEPLOY = `${START} a raw call to a Salesforce deploy endpoint while a production org is connected: deploy with sf project deploy start to the slot org.`;
const DATA_WRITE = `${START} \`sf data\` commands that create, update, delete, upsert or import records: runs never change records in an org, and tests build their own data. \`sf data query\` and other reads are allowed.`;
const DYNAMIC = `${START} this command: Foreman cannot tell which program or command runs. Write the sf command out in full.`;
const KEY = `${START} this command: it names ~/.config/foreman/sf, where Foreman keeps the project's Salesforce sign-in key. Runs never read or change it; Foreman signs orgs in itself, from the dashboard.`;
const TARGET = (value, alias) =>
  `${START} the target org ${value ? `"${value}"` : 'with no value'}; this slot's org is ${alias || 'none'}. ` +
  'Give no target to use the slot org. The test org (salesforce.test) is allowed only for `project deploy start --dry-run` in the test stage. ' +
  "If -o, -u or -v means something else in this command, use that flag's long name.";

// The key folder, ~/.config/foreman/sf, in any spelling of its home; not sf-home or sfdx.
const KEY_DIR = /\.config\/+foreman\/+sf(?![A-Za-z0-9_.-])/;
// sf or sfdx as a whole word. (`sfdx?` would mean "sfd" or "sfdx" and miss plain sf.)
const SF_WORD = /(?<![A-Za-z0-9_.-])sf(?:dx)?(?![A-Za-z0-9_.-])/i;
// The `sf data` words that write records, in any order (`data create record`,
// `force:data:record:create`, `create data record`).
const DATA_WRITES = new Set(['create', 'update', 'delete', 'upsert', 'import']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'while', 'until', 'do', 'coproc']);
const LAUNCHERS = new Set(['env', 'command', 'exec', 'nohup', 'sudo', 'npx', 'time', 'nice', 'timeout']);
// A brace expansion such as {a,b} or {1..3}: the shell turns one word into several.
const BRACES = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
// Stands in for a quoted or escaped character in a word's unquoted text: never { } , or .
const QUOTED = '\0';
const DEFAULT_VARS = new Set(['SF_TARGET_ORG', 'SF_TARGET_DEV_HUB', 'SFDX_DEFAULTUSERNAME', 'SFDX_DEFAULTDEVHUBUSERNAME']);
// The variables that move sf's home or data, and PATH, which can skip the wrapper.
const HOME_VARS = new Set(['HOME', 'FOREMAN_SF_HOME', 'SF_DATA_DIR']);
const SF_PREFIX_VARS = new Set([...HOME_VARS, 'PATH']);
const EXPORTS = new Set(['export', 'declare', 'typeset']);
const EXPORTED = /^[A-Za-z_][A-Za-z0-9_]*(=|$)/;
const DEFAULT_KEYS = /^(target-org|target-dev-hub|defaultusername|defaultdevhubusername)(=|$)/;
const DQ_ESCAPES = new Set(['$', '`', '"', '\\', '\n']);
const REDIRECT = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/;
// Deeper nesting than this stops the scan with a command whose program is unknown. The guard
// denies it as DYNAMIC when the command, or the unscanned rest, names sf (see namesSf).
const MAX_NESTING = 200;

const ANSI_C = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const SPECIAL_PARAMS = '0123456789@*#?-$!';

// The body of a $'...' string from `i` (just after the opening quote) to the next unescaped
// quote or the end, decoded as bash does. Returns [text, index after the closing quote].
function ansiC(s, i) {
  const parts = [];
  while (i < s.length && s[i] !== "'") {
    if (s[i] !== '\\' || i + 1 >= s.length) {
      parts.push(s[i]);
      i += 1;
      continue;
    }
    const e = s[i + 1];
    i += 2;
    const digits = (re, max) => {
      let n = 0;
      while (n < max && i + n < s.length && re.test(s[i + n])) n += 1;
      const text = s.slice(i, i + n);
      i += n;
      return text;
    };
    if ('\\\'"?'.includes(e)) parts.push(e);
    else if (Object.hasOwn(ANSI_C, e)) parts.push(ANSI_C[e]);
    else if (/[0-7]/.test(e)) {
      i -= 1;
      parts.push(String.fromCharCode(parseInt(digits(/[0-7]/, 3), 8)));
    } else if (e === 'x' || e === 'u' || e === 'U') {
      const hex = digits(/[0-9A-Fa-f]/, e === 'x' ? 2 : e === 'u' ? 4 : 8);
      const code = parseInt(hex, 16);
      if (!hex) parts.push(`\\${e}`);
      else parts.push(code > 0x10ffff ? '' : String.fromCodePoint(code));
    } else if (e === 'c' && i < s.length) {
      parts.push(String.fromCharCode(s.charCodeAt(i) & 0x1f));
      i += 1;
    } else parts.push(`\\${e}`);
  }
  return [parts.join(''), i + 1];
}

// `s` with the $ forms that bash turns into a static or empty string inside a word undone:
// $'...' and $"..." become their text, and ${...}, $NAME and the special parameters ($1, $@,
// ...) become empty. $( and any other $ stay. One linear pass; decoded text is not re-scanned.
function joinDollars(s) {
  const parts = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c !== '$' || next === undefined) {
      parts.push(c);
      i += 1;
    } else if (next === "'") {
      const [text, end] = ansiC(s, i + 2);
      parts.push(text);
      i = end;
    } else if (next === '"') {
      parts.push('"');
      i += 2;
    } else if (next === '{') {
      const end = s.indexOf('}', i + 2);
      if (end === -1) {
        // no later ${ can close either, so the rest stays as it is
        parts.push(s.slice(i));
        break;
      }
      i = end + 1;
    } else if (/[A-Za-z_]/.test(next)) {
      i += 2;
      while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i += 1;
    } else if (SPECIAL_PARAMS.includes(next)) {
      i += 2;
    } else {
      parts.push(c);
      i += 1;
    }
  }
  return parts.join('');
}

// Whether `s` names sf or sfdx once the shell's joins are undone: backslash-newline pairs,
// $'...' and $"..." read as their text, ${...}, $NAME and the special parameters taken as empty,
// then quotes, backslashes, and empty $( ) and backtick pairs removed, nested ones included.
// joinDollars does not track quotes, so a quoted string ending in $ (as in `'a$' s\f`) can be
// misread as a $'...' string; the text is therefore also checked without that step, which only
// denies more. Linear passes (a repeat-until-stable regex would be quadratic on deep nesting, and
// this runs in a hook).
function namesSf(s) {
  const text = s.replace(/\\\n/g, '');
  return joinsSf(joinDollars(text)) || joinsSf(text);
}

// Whether `command` names the key folder: as written, with backslash-newline pairs then quotes and
// backslashes removed, and that text with the $ forms joined (so $HOME and ${HOME} go).
function namesKeyDir(command) {
  if (KEY_DIR.test(command)) return true;
  const flat = command.replace(/\\\n/g, '').replace(/[\\'"]/g, '');
  return KEY_DIR.test(flat) || KEY_DIR.test(joinDollars(flat));
}

// Whether `text` names sf or sfdx once quotes, backslashes, and empty $( ) and backtick pairs
// are removed. One linear pass.
function joinsSf(text) {
  const flat = text.replace(/[\\'"]/g, '').replace(/`\s*`/g, '');
  const out = [];
  const opens = []; // [index in out, full] for each open $(
  for (let i = 0; i < flat.length; i += 1) {
    const c = flat[i];
    if (c === '$' && flat[i + 1] === '(') {
      opens.push([out.length, false]);
      out.push('$', '(');
      i += 1;
    } else if (c === ')' && opens.length) {
      const [at, full] = opens.pop();
      if (full) {
        out.push(')');
        if (opens.length) opens[opens.length - 1][1] = true;
      } else out.length = at;
    } else {
      out.push(c);
      if (opens.length && !' \t\n\r'.includes(c)) opens[opens.length - 1][1] = true;
    }
  }
  return SF_WORD.test(out.join('').replace(/`\s*`/g, ''));
}

// Scans `src` from `i` until `close` (or the end), pushing each simple command, nested ones
// included, into `out`. Returns the index after the closer.
function scan(src, i, close, out, depth = 0) {
  if (depth > MAX_NESTING) {
    out.push([namesSf(src.slice(i)) ? { text: '', dynamic: true, sf: true } : { text: '', dynamic: true }]);
    return src.length;
  }
  let words = [];
  // `bare` follows `text` with each quoted or escaped character replaced by QUOTED, so brace
  // expansion is tested on the unquoted part only, as the shell does.
  let [text, bare, dynamic, inWord, dropNext] = ['', '', false, false, false];
  const endWord = () => {
    if (inWord && dropNext) dropNext = false;
    else if (inWord) words.push(BRACES.test(bare) ? { text, dynamic, braces: true } : { text, dynamic });
    [text, bare, dynamic, inWord] = ['', '', false, false];
  };
  const endCommand = () => {
    endWord();
    dropNext = false;
    if (words.length) out.push(words);
    words = [];
  };
  // $( ) or backticks at j, quoted or not: scans the nested command and marks the word dynamic.
  const isNested = (j) => src[j] === '`' || (src[j] === '$' && src[j + 1] === '(');
  const nested = (j) => {
    dynamic = inWord = true;
    return src[j] === '`' ? scan(src, j + 1, '`', out, depth + 1) : scan(src, j + 2, ')', out, depth + 1);
  };
  while (i < src.length) {
    const c = src[i];
    if (close && c === close) {
      endCommand();
      return i + 1;
    }
    if (c === '\\') {
      // backslash-newline joins lines and adds nothing, not even an empty word
      if (i + 1 < src.length && src[i + 1] !== '\n') [text, bare, inWord] = [text + src[i + 1], bare + QUOTED, true];
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1) === -1 ? src.length : src.indexOf("'", i + 1);
      [text, bare, inWord, i] = [text + src.slice(i + 1, end), bare + QUOTED.repeat(end - i - 1), true, end + 1];
    } else if (c === '"') {
      inWord = true;
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && DQ_ESCAPES.has(src[i + 1])) {
          if (src[i + 1] !== '\n') [text, bare] = [text + src[i + 1], bare + QUOTED];
          i += 2;
        } else if (isNested(i)) {
          i = nested(i);
        } else {
          if (src[i] === '$') dynamic = true;
          [text, bare] = [text + src[i++], bare + QUOTED];
        }
      }
      i += 1;
    } else if (isNested(i)) {
      i = nested(i);
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      // process substitution: the nested command is checked like $( )
      dynamic = inWord = true;
      i = scan(src, i + 2, ')', out, depth + 1);
    } else if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      // a redirection: drop a leading fd number, the operator and the next word (its target)
      if (c !== '&' && inWord && !dynamic && /^\d+$/.test(text)) [text, bare, dynamic, inWord] = ['', '', false, false];
      else endWord();
      i += REDIRECT.exec(src.slice(i))[0].length;
      dropNext = true;
    } else if (c === '(') {
      endCommand();
      i = scan(src, i + 1, ')', out, depth + 1);
    } else if (';\n|)'.includes(c) || c === '&') {
      endCommand();
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i += 1;
    } else if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else {
      if (c === '$') dynamic = true;
      [text, bare, inWord] = [text + c, bare + c, true];
      i += 1;
    }
  }
  endCommand();
  return i;
}

// The simple commands in `command`, each an array of words { text, dynamic }, plus
// `braces: true` on a word whose unquoted part uses brace expansion.
export function simpleCommands(command) {
  const out = [];
  scan(String(command ?? ''), 0, null, out);
  return out;
}

const isOrg = (org, value) =>
  org !== null && typeof org === 'object' && [org.alias, org.orgId].some((id) => typeof id === 'string' && id !== '' && id === value);

// The org leased to `slot` (wN is build org N), as { alias, orgId }, or null. Scratch mode has none.
export function slotOrg(config, slot) {
  return layout(config?.salesforce, config).slotOrg(slot);
}

// Every value given to one of `flags` in `args`: { text, dynamic }, or null for a missing value.
function flagValues(args, flags) {
  const values = [];
  args.forEach((word, i) => {
    const next = args[i + 1];
    const following = next && !next.text.startsWith('-') ? next : null;
    for (const flag of flags) {
      if (word.text === flag) values.push(following);
      else if (word.text.startsWith(`${flag}=`)) values.push({ text: word.text.slice(flag.length + 1), dynamic: word.dynamic });
      else if (flag.length === 2 && word.text.startsWith(flag) && !word.text.startsWith('--')) values.push({ text: word.text.slice(2), dynamic: word.dynamic });
      else continue;
      break;
    }
  });
  return values;
}

function checkSf(words, prefix, ctx) {
  const args = words.slice(1);
  let start = 0;
  while (start < args.length && args[start].text.startsWith('-')) start += 1;
  const leading = [];
  for (const word of args.slice(start)) {
    if (word.text.startsWith('-')) break;
    leading.push(word);
  }
  if (leading.some((w) => w.dynamic || w.braces)) return DYNAMIC;
  if (prefix.some((w) => DEFAULT_VARS.has(w.text.slice(0, w.text.indexOf('='))))) return DEFAULTS;
  // The command words, matched as a set: sf's flexibleTaxonomy runs them in any order
  // (`sf create data record` is `sf data create record`). `cmd` holds only the words after any
  // leading flags and before the next flag, so a later flag's value, such as a query string,
  // never matches here. A leading flag's value (`sf -o x agent ...`) becomes one more command
  // word, which can only add matches.
  const cmd = leading.flatMap((w) => w.text.split(':'));
  const has = (...parts) => parts.every((part) => cmd.includes(part));
  const texts = args.map((w) => w.text);
  const entry = allowedEntry(cmd);
  const deploying = deploys(cmd) || deployEndpoint(texts);
  const tooling = toolingWrite(cmd, texts);
  const isProd = (text) => isProductionName(ctx.production, text);

  // A command off the production allow-list (or Dev Hub only, naming a deploy endpoint, or a
  // record change through the Tooling API or with --flags-dir) that names a marked production org
  // in any word: refused before every other reason, so the production one is the one given.
  if (ctx.production.length && pushesUpgrade(cmd)) return PROD_DEPLOY;
  if (ctx.production.length && (!entry || entry.devHubOnly || deploying || tooling)) {
    const statics = args.map((w) => (w.dynamic ? '' : w.text));
    if (namesProduction(statics, isProd, { skipDevHub: entry?.devHubOnly === true })) {
      return deploying ? PROD_DEPLOY : tooling ? PROD_TOOLING : exposes(cmd) ? EXPOSE : PROD_NOT_ALLOWED;
    }
  }

  if (has('login') || has('logout')) return LOGIN;
  if (has('auth') && !has('list')) return LOGIN;
  if (has('deploy', 'quick')) return QUICK;
  if (has('run-eval')) return RUN_EVAL;
  const setting = has('set') || has('unset');
  if (setting && has('config') && texts.some((t) => DEFAULT_KEYS.test(t))) return DEFAULTS;
  if (setting && has('alias')) return DEFAULTS;
  if (texts.some((t) => t === '--flags-dir' || t.startsWith('--flags-dir='))) return DEFAULTS;

  // `project deploy pipeline start` counts too, as on main: its -c (the DevOps Center org, which
  // it requires) and -r are denied here, so no pipeline promotion starts.
  const pipeline = has('project', 'deploy', 'pipeline');
  const isDeployStart = has('project', 'deploy', 'start') || (cmd.length === 2 && has('deploy', 'metadata'));
  const ignores = (t) => ['--ignore-conflicts', '--ignore-errors'].some((f) => t === f || t.startsWith(`${f}=`));
  if (texts.some((t) => ignores(t) || (isDeployStart && (t === '-c' || t === '-r')))) return IGNORE;

  const l = layout(ctx.config?.salesforce, ctx.config);
  // -c is the DevOps Center org only on `project deploy pipeline` commands.
  const targets = flagValues(args, pipeline ? [...TARGET_SPELLINGS, ...DEVOPS_SPELLINGS] : TARGET_SPELLINGS);
  const isStatic = (value) => Boolean(value && !value.dynamic && value.text);

  const retrieving = has('retrieve') || has('source', 'pull');
  if (retrieving && !(targets.length > 0 && targets.every((value) => isStatic(value) && isProd(value.text)))) return RETRIEVE;
  if (has('data') && cmd.some((w) => DATA_WRITES.has(w))) return DATA_WRITE;

  const slot = l.slotOrg(ctx.slot);
  const slotAlias = typeof slot?.alias === 'string' ? slot.alias : null;
  const devHub = l.build.mode === 'scratch' && l.build.devHub ? { alias: l.build.devHub, orgId: l.orgs[l.build.devHub]?.orgId } : null;
  for (const value of flagValues(args, DEVHUB_SPELLINGS)) {
    if (!value || value.dynamic || !value.text) return TARGET(value?.text, slotAlias);
    if (!isOrg(devHub, value.text)) return DEVHUB;
  }
  const testOrg = l.test.org ? { alias: l.test.org, orgId: l.test.orgId } : null;
  const testDryRun = ctx.stage === 'test' && isDeployStart && texts.includes('--dry-run');
  for (const value of targets) {
    if (!value || value.dynamic || !value.text) return TARGET(value?.text, slotAlias);
    if (isOrg(slot, value.text)) continue;
    if (testDryRun && isOrg(testOrg, value.text)) continue;
    if (isProd(value.text) && entry && !entry.devHubOnly) continue;
    return TARGET(value.text, slotAlias);
  }
  return null;
}

// A word's text before its first =, or all of it.
const varName = (t) => (t.includes('=') ? t.slice(0, t.indexOf('=')) : t);

// Whether giving `word` steps around the isolated home: FOREMAN_SF_HOME always, since sessions
// export it, and HOME, SF_DATA_DIR or PATH (which can put the real sf ahead of the wrapper) when
// the command names sf.
const movesHome = (word, ctx) => {
  const name = varName(word.text);
  return name === 'FOREMAN_SF_HOME' || (SF_PREFIX_VARS.has(name) && ctx.sf);
};

// Whether giving `word` sets sf's default org or dev hub, which a later sf would read with no -o.
// Outside sf's own prefix this counts only while a production org is marked, so projects with
// none behave as before.
const setsDefaults = (word, ctx) => ctx.production.length > 0 && DEFAULT_VARS.has(varName(word.text));

function checkSimple(words, ctx) {
  const prefix = [];
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    // launchers match in any case: macOS file names are case-insensitive; shell keywords are not
    const launcher = word.text.slice(word.text.lastIndexOf('/') + 1).toLowerCase();
    if (ASSIGNMENT.test(word.text)) prefix.push(word);
    else if (word.dynamic || !(RESERVED.has(word.text) || LAUNCHERS.has(launcher))) break;
    else if (LAUNCHERS.has(launcher)) {
      while (words[i + 1]?.text.startsWith('-')) i += 1;
      if (launcher === 'timeout' && words[i + 1]) i += 1; // the duration
    } else if (word.text === 'coproc' && words[i + 2]?.text === '{') i += 1; // the coproc NAME
    i += 1;
  }
  if (i >= words.length) return prefix.some((w) => movesHome(w, ctx)) ? ISOLATION : prefix.some((w) => setsDefaults(w, ctx)) ? DEFAULTS : null;
  const program = words[i];
  if (program.braces) return DYNAMIC;
  // the depth-cap word is always a one-word dynamic command, so it is the program here
  if (program.dynamic || program.text === 'eval') {
    if (program.sf || SF_WORD.test(program.text) || ctx.sf) return DYNAMIC;
    return prefix.some((w) => setsDefaults(w, ctx)) ? DEFAULTS : null;
  }
  const name = program.text.slice(program.text.lastIndexOf('/') + 1).toLowerCase();
  const rest = words.slice(i + 1);
  if (EXPORTS.has(program.text) && rest.some((w) => EXPORTED.test(w.text) && movesHome(w, ctx))) return ISOLATION;
  if (EXPORTS.has(program.text) && rest.some((w) => EXPORTED.test(w.text) && setsDefaults(w, ctx))) return DEFAULTS;
  if (name !== 'sf' && name !== 'sfdx' && prefix.some((w) => setsDefaults(w, ctx))) return DEFAULTS;
  if (['bash', 'sh', 'zsh'].includes(name)) {
    const flag = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
    const script = flag === -1 ? null : rest[flag + 1];
    if (!script) return null;
    const reason = check(script.text, ctx);
    if (reason) return reason;
    return script.dynamic && ctx.sf ? DYNAMIC : null;
  }
  if (name !== 'sf' && name !== 'sfdx' && ctx.production.length && deployEndpoint(words.slice(i).map((w) => w.text))) return RAW_DEPLOY;
  if (name !== 'sf' && name !== 'sfdx') return null;
  return checkSf(words.slice(i), prefix, ctx) ?? (program.text.includes('/') || prefix.some((w) => SF_PREFIX_VARS.has(varName(w.text))) ? ISOLATION : null);
}

function check(command, ctx) {
  for (const words of simpleCommands(command)) {
    const reason = checkSimple(words, ctx);
    if (reason) return reason;
  }
  return null;
}

// Null to allow the Bash command, or the reason to deny it. See packs/index.mjs for the contract.
export function guard(input) {
  const { command, stage, slot, config } = input ?? {};
  if (typeof command !== 'string' || !command) return null;
  // A net: scan cannot throw, but a config whose property access throws reaches this catch.
  try {
    if (namesKeyDir(command)) return KEY;
    const orgs = layout(config?.salesforce, config).orgs;
    const production = Object.entries(orgs).filter(([, org]) => org.production === true).map(([alias, org]) => ({ alias, orgId: org.orgId }));
    return check(command, { sf: namesSf(command), stage, slot, config, production });
  } catch {
    return DYNAMIC;
  }
}
