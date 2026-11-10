// The learner: a short, read-only Claude session that turns one lesson (engine/lessons.mjs)
// into a proposal, and the code that checks that proposal. Nothing here writes a learned item
// or the learning ledger; applying a checked lesson is the caller's job.
//
//   learnerInput(candidate, { root, stateDir, config, env, values, run, home })
//       { text, roles, skillIds }: markdown with the lesson, the fix diffs of the `where` files
//       (commits whose subject starts "<story id> ", at most 20 KB), CLAUDE.md, the current
//       traits and the skills with their descriptions; every part scrubbed (engine/scrub.mjs)
//   learnerPrompt(input, mode)        the prompt; mode 'decide' (a skill verdict may leave out
//                                     the body) or 'skill' (the reply must carry the skill)
//   learnerCommand({ prompt, model, maxUsd })
//                                     `claude -p` in safe mode (no CLAUDE.md, hooks or
//                                     plugins, so the input carries CLAUDE.md itself), with
//                                     Read, Grep and Glob only, JSON output and a budget; the
//                                     LEARNER_DENY rules keep Read (and so Grep and Glob) off
//                                     the home folder's key and config places, /etc and every
//                                     .env* file
//   parseLearnerReply(stdout)         { reply, costUsd, isError, error, envelope, tokens }: the
//                                     envelope (the whole output, else its last line with a
//                                     `result`), then the last JSON object with a `verdict`
//                                     anywhere in the result; tokens from the envelope
//                                     (tokens.mjs resultTokens), or null
//   runLearner({ input, config, spentUsd, run, env, root, stateDir, now, skills, newSkills, values, home })
//       { ok, reply, calls, error }: one call with learning.model; a skill verdict (or a merge
//       into a learned skill) makes a second with learning.skillModel, unless skills is false.
//       A second reply that is not a skill or a merge into a learned skill fails with
//       NO_SKILL. newSkills false (the learning tick at learning.maxSkills) skips the second
//       call for a new skill only; a merge into a learned skill still gets it. Call errors are
//       scrubbed (scrub.mjs, with `values`, the project's file secrets by default, and
//       learning.redact) before they are cut to 200 characters. Each call first checks
//       what is left of learning.maxUsdPerDay and gets that as its budget. The session runs in
//       the project, without the run's FOREMAN_* variables, with Foreman's session keys. Once
//       the platform credits ran out (claude-fallback.mjs, read from stateDir) it runs without
//       ANTHROPIC_API_KEY too, as the story sessions do.
//   checkContext({ root, stateDir, config, env, values, now, home })
//                                     what checkLesson needs, read from the files
//   checkLesson(output, ctx)          { ok: true, lesson } or { ok: false, reason }; pure.
//                                     The secret check runs on the raw reply; the text that
//                                     passes is scrubbed. Caps: 400 characters a trait, 3 KB a
//                                     role file, 6 KB a skill, and the learning block's counts.
//                                     A skill slug may not start with foreman-learned- (Foreman
//                                     adds it).
//   capProblem({ items, ledger, learning, now, target })
//                                     the trial and per-day caps checkLesson ends with, as a
//                                     reason, or null; `target` (a merge's id) is not on trial
//   learnerSpentToday(stateDir, now)  the dollars spent on learner calls on now's UTC day
//   recordLearnerCall(stateDir, line) appends { at, key, stories?, model, costUsd, verdict, error,
//                                     tokens } to <stateDir>/learner.jsonl; stories (how many stories
//                                     the lesson had) only when given
//   readLearnerCalls(stateDir)        its lines, torn ones skipped; [] with no file. The token
//                                     view (token-report.mjs) counts them as the learner's

import fs from 'node:fs';
import { join } from 'node:path';
import { readLock } from '../../packs/salesforce/skills.mjs';
import { DEFAULTS } from '../config/defaults.mjs';
import { fileSecrets } from '../setup/project.mjs';
import { defaultSh } from '../state-store/branch.mjs';
import { sessionKeys, withSessionKeys } from './foreman-keys.mjs';
import { readSignIn } from './claude-fallback.mjs';
import { currentItems, itemText, readLedger, skillPath, SLUG, SLUG_MAX } from './learning-store.mjs';
import { holdsSecret, scrub, scrubDeep } from './scrub.mjs';
import { resultTokens } from './tokens.mjs';
import { LEARNED_MAX_BYTES, resolveTraits, roleNames } from './traits.mjs';

export const LEARNER_LOG = 'learner.jsonl';
export const DIFF_MAX_BYTES = 20 * 1024;
export const SKILL_MAX_BYTES = 6 * 1024;
export const TRAIT_MAX = 400;
export const DESCRIPTION_MAX = 300;
export const REASON_MAX = 300;
export const STEPS_MAX = 12;
export const VERDICTS = ['none', 'trait', 'skill', 'merge'];

const RUN_VARS = ['FOREMAN_RUN', 'FOREMAN_STORY', 'FOREMAN_SLOT', 'FOREMAN_SUPERVISOR_PID'];
const STORY_ID = /^[A-Za-z0-9_-]+$/;
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PREFIX = 'foreman-learned-';
const DECIDE_MS = 300_000;
const SKILL_MS = 600_000;
const MAX_BUFFER = 64 * 1024 * 1024;
const NONE_FOUND = '(none found)';
const NOT_INSTALLED = 'claude is not installed or not on PATH';
const NO_LESSON = 'the learner gave no lesson JSON';
const NO_SKILL = 'the skill session gave no skill';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const idNumber = (id) => Number(/^L-(\d+)$/.exec(String(id))?.[1] ?? 0);
const byId = (a, b) => idNumber(a.id) - idNumber(b.id);
const inForce = (items) => items.filter((i) => Number(i.v) > 0);
const dayOf = (at) => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};
const learningOf = (config) => ({ ...DEFAULTS.learning, ...(isPlain(config?.learning) ? config.learning : {}) });
const slugOf = (item) => String(item?.path ?? '').split('/').at(-2)?.slice(PREFIX.length) ?? '';

const readOr = (file, fallback) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
};

// A code fence longer than any backtick run inside `text`.
const fenced = (text, lang = '') => {
  const run = Math.max(0, ...(String(text).match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, run + 1));
  return `${fence}${lang}\n${String(text).replace(/\n+$/, '')}\n${fence}`;
};

// The frontmatter `description:` value, unquoted, or '': the same parse as slot-prepare's.
function description(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
  const line = front?.[1].split(/\r?\n/).find((l) => /^description:/.test(l));
  if (!line) return '';
  let v = line.slice('description:'.length).trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
  return v.trim();
}

// ---- the input ----

// The distinct project-relative files the evidence's `where` names: the leading path, without
// a `:line` or `(…)` suffix. Absolute paths and paths with `..` are left out.
export function whereFiles(evidence) {
  const files = [];
  for (const e of Array.isArray(evidence) ? evidence : []) {
    const token = String(e?.where ?? '').trim().split(/\s+/)[0] ?? '';
    const path = token.replace(/^[`'"]+/, '').replace(/[:(].*$/, '').replace(/[`'",;]+$/, '');
    if (!path || path.startsWith('/') || path.startsWith('~') || path.split(/[\\/]/).includes('..')) continue;
    if (!files.includes(path)) files.push(path);
  }
  return files;
}

// The commits of the lesson's stories that touched `files`, as one diff text, or null.
function fixDiffs(candidate, { root, run }) {
  const files = whereFiles(candidate?.evidence);
  const stories = (Array.isArray(candidate?.stories) ? candidate.stories : []).map(String).filter((id) => STORY_ID.test(id));
  if (!files.length || !stories.length) return null;
  const git = (args) => run('git', args, { cwd: root, maxBuffer: MAX_BUFFER });
  const shas = [];
  for (const id of stories) {
    const r = git(['log', '--format=%H', '--grep', `^${id} `, '--', ...files]);
    if (r?.status !== 0) return null;
    for (const sha of String(r.stdout ?? '').split('\n').map((s) => s.trim())) if (/^[0-9a-f]{7,64}$/.test(sha) && !shas.includes(sha)) shas.push(sha);
  }
  const diffs = [];
  for (const sha of shas) {
    const r = git(['show', '--no-color', '--format=commit %h %s', sha, '--', ...files]);
    if (r?.status !== 0) return null;
    diffs.push(String(r.stdout ?? '').trimEnd());
  }
  return diffs.length ? diffs.join('\n\n') : null;
}

// `text` cut to `max` bytes (never mid-character), with the marker when it was cut.
function capBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  const cut = Buffer.from(text).subarray(0, max).toString('utf8').replace(/�+$/, '');
  return `${cut}\n(cut at 20 KB)`;
}

function traitsPart({ root, config, stateDir, items }) {
  let owner = {};
  try {
    owner = resolveTraits({ root, config }).traits;
  } catch {
    owner = {};
  }
  const ownerText = roleNames(config)
    .filter((role) => owner[role])
    .map((role) => `### ${role}\n\n${owner[role]}`)
    .join('\n\n');
  const learned = inForce(items)
    .filter((i) => i.kind === 'trait')
    .sort(byId)
    .map((i) => {
      let text = null;
      try {
        text = itemText(stateDir, i);
      } catch {
        text = null;
      }
      return text === null ? null : `[${i.id}] ${i.roles[0]}: ${text.trim()}`;
    })
    .filter(Boolean);
  return [`Owner traits (each role's own rules):\n\n${ownerText || '(none)'}`, `Learned traits in force (Foreman's own):\n\n${learned.join('\n') || '(none)'}`].join('\n\n');
}

function skillsPart({ root, stateDir, items }) {
  const learned = inForce(items)
    .filter((i) => i.kind === 'skill')
    .sort(byId)
    .map((i) => {
      let text = '';
      try {
        text = itemText(stateDir, i) ?? '';
      } catch {
        text = '';
      }
      return `- ${PREFIX}${slugOf(i)} (${i.id}, for ${i.roles.join(', ')}): ${description(text) || '(no description)'}`;
    });
  const skillsDir = join(root, '.claude', 'skills');
  const descOf = (name) => description(readOr(join(skillsDir, name, 'SKILL.md'), '') || readOr(join(root, '.agents', 'skills', name, 'SKILL.md'), '')) || '(no description)';
  const lock = readLock(root, fs);
  const locked = Object.keys(lock.lock?.skills ?? {}).filter((n) => SKILL_NAME.test(n));
  let folders = [];
  try {
    folders = fs.readdirSync(skillsDir).sort();
  } catch {
    folders = [];
  }
  const project = folders.filter((n) => SKILL_NAME.test(n) && !n.startsWith(PREFIX) && !locked.includes(n) && fs.existsSync(join(skillsDir, n, 'SKILL.md')));
  const list = (lines) => (lines.length ? lines.join('\n') : '(none)');
  return [
    `Learned skills in force:\n\n${list(learned)}`,
    `Pack skills (skills-lock.json; never changed by Foreman):\n\n${list(locked.map((n) => `- ${n}: ${descOf(n)}`))}`,
    `Project skills (.claude/skills):\n\n${list(project.map((n) => `- ${n}: ${descOf(n)}`))}`,
  ].join('\n\n');
}

export function learnerInput(candidate, { root, stateDir, config, env = {}, values, run = defaultSh, home } = {}) {
  const learning = learningOf(config);
  const opts = { env, values: values ?? fileSecrets({ root, config }), redact: learning.redact ?? [], root, home };
  const clean = (text) => scrub(text, opts);
  const items = [...currentItems(readLedger(stateDir)).values()];
  const c = candidate ?? {};
  const stories = Array.isArray(c.stories) ? c.stories.map(String) : [];
  const lesson = [
    `key: ${c.key ?? ''}`,
    `source: ${c.source ?? ''}`,
    `role: ${c.role ?? ''}`,
    `cluster: ${c.cluster ?? ''}`,
    `stories: ${stories.join(', ')}`,
    '',
    'Evidence:',
    '',
    fenced(JSON.stringify(c.evidence ?? [], null, 2), 'json'),
  ].join('\n');
  const diffs = fixDiffs(c, { root, run });
  const claude = readOr(join(root, 'CLAUDE.md'), null);
  const roles = [...roleNames(config), 'all'];
  const parts = [
    ['The lesson', clean(lesson)],
    // Not fenced: every diff line starts with a marker, so none reads as a heading here.
    ['Fix diffs', diffs === null ? NONE_FOUND : capBytes(clean(diffs), DIFF_MAX_BYTES)],
    ['CLAUDE.md', claude === null ? '(none)' : fenced(clean(claude), 'markdown')],
    ['Current traits', clean(`Roles: ${roles.join(', ')}\n\n${traitsPart({ root, config, stateDir, items })}`)],
    ['Skills', clean(skillsPart({ root, stateDir, items }))],
  ];
  const skillIds = inForce(items)
    .filter((i) => i.kind === 'skill')
    .sort(byId)
    .map((i) => i.id);
  return { text: `${parts.map(([name, body]) => `## ${name}\n\n${body}`).join('\n\n')}\n`, roles, skillIds };
}

// ---- the prompt and the command ----

const SCHEMA = `{
  "verdict": "none" | "trait" | "skill" | "merge",
  "reason": "<one sentence, at most 300 characters>",
  "trait": { "role": "<one role>", "text": "<at most 400 characters>" },
  "skill": { "slug": "<lowercase-words-joined-by-dashes>", "description": "Use when …", "roles": ["<role>"], "steps": ["<step>"], "example": "<from the real finding and fix diff>" },
  "merge": { "id": "L-<n>", "trait": "<the new trait text>" },
  "conflicts": []
}`;

export function learnerPrompt(input, mode) {
  const roles = Array.isArray(input?.roles) && input.roles.length ? input.roles.join(', ') : 'the roles listed above';
  const modeRule =
    mode === 'skill'
      ? 'This lesson was judged worth a learned skill. Your reply must carry the skill: verdict "skill" with the whole skill (slug, description, roles, steps and example), or verdict "merge" with merge.skill when it improves a learned skill in force.'
      : 'For a "skill" verdict you may leave out the skill body (description, steps and example); a second session writes it. Give its slug and roles when you can.';
  return `${input?.text ?? ''}
## Your task

You are Foreman's learner. Foreman builds stories with agents in the roles above, and the lesson above is a mistake they keep making. Decide whether a short trait or a learned skill would stop it happening again. Use what is above, and Read, Grep and Glob to look at the project. Propose nothing ("none") when the lesson is a one-off, or when CLAUDE.md, a trait or a skill above already covers it.

Rules:
- "trait": one rule for one role (one of: ${roles}), at most 400 characters, written as an instruction to that role.
- "skill": a how-to for one or more of those roles. Its slug is lowercase words joined by dashes, at most 40 characters. Its description starts "Use when", is at most 300 characters on one line, and says when to reach for the skill. Its steps (1 to 12) and its example are taken from the real finding and fix diff above. The whole skill is at most 6 KB.
- "merge": change a learned item in force (an L-n above) instead of adding a new one: { "id", "trait": "<new text>" } for a trait item, or { "id", "skill": { "description", "steps", "example" } } for a skill item.
- reason is one sentence of at most 300 characters.
- conflicts lists every CLAUDE.md or trait rule the proposal contradicts, quoted; it is [] when there is none. A proposal with a conflict is refused.
- Never write a secret, an email address or an absolute path.
- ${modeRule}

Schema (only the field for your verdict is needed, besides verdict, reason and conflicts):

${SCHEMA}

Think it through if you need to, then reply with one JSON object.
`;
}

// Places the session may not read: Claude Code permission rules, where `~/` is the home folder,
// `//` an absolute path and a bare pattern is relative to the project (the session's cwd). Read
// rules also hold for Grep and Glob. Not Read(~/**): deny beats allow, and the project itself
// usually lives under the home folder.
export const LEARNER_DENY = ['Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.gnupg/**)', 'Read(~/.config/**)', 'Read(~/.docker/**)', 'Read(~/.kube/**)', 'Read(~/.claude/**)', 'Read(~/.claude.json)', 'Read(~/.netrc)', 'Read(~/.npmrc)', 'Read(~/.git-credentials)', 'Read(//etc/**)', 'Read(**/.env*)'];

export function learnerCommand({ prompt, model, maxUsd }) {
  return {
    cmd: 'claude',
    // --disallowedTools and --allowedTools both take a list, so the deny rules come just before
    // --allowedTools, and --allowedTools stays last.
    args: ['-p', prompt, '--safe-mode', '--model', model, '--tools', 'Read,Grep,Glob', '--permission-prompts', 'none', '--no-session-persistence', '--output-format', 'json', '--max-budget-usd', maxUsd.toFixed(2), '--disallowedTools', ...LEARNER_DENY, '--allowedTools', 'Read', 'Grep', 'Glob'],
  };
}

// ---- the reply ----

// A Map from the index of each `{` in `s` to the index of the `}` that closes it, ignoring braces
// inside strings, or -1 if none. Each scan starts from a `{` no earlier scan resolved, with fresh
// string state, and resolves every `{` it meets outside a string: such a `{` has the same state
// a scan of its own would start with, so its match is the same, and a run of unclosed braces
// costs one scan instead of one each.
function closings(s) {
  const close = new Map();
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    if (close.has(i)) continue;
    const open = [];
    let inString = false;
    for (let k = i; k < s.length; k++) {
      const ch = s[k];
      if (inString) {
        if (ch === '\\') k++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') open.push(k);
      else if (ch === '}') {
        close.set(open.pop(), k);
        if (!open.length) break;
      }
    }
    for (const k of open) close.set(k, -1);
  }
  return close;
}

// The last complete JSON object in `text` with a `verdict`, wherever it sits; null when none.
function lessonObject(text) {
  const s = String(text ?? '');
  const close = closings(s);
  let best = null;
  let bestEnd = -1;
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    const end = close.get(i) ?? -1;
    if (end === -1 || end <= bestEnd) continue;
    try {
      const value = JSON.parse(s.slice(i, end + 1));
      if (isPlain(value) && Object.hasOwn(value, 'verdict')) {
        best = value;
        bestEnd = end;
      }
    } catch {
      // not JSON; try the next brace
    }
  }
  return best;
}

// The `claude --output-format json` envelope: the whole output, else the last line that parses
// and has a `result` (a warning line may come first).
function envelopeOf(stdout) {
  const text = String(stdout ?? '').trim();
  try {
    const whole = JSON.parse(text);
    if (isPlain(whole)) return whole;
  } catch {
    // not one JSON value; look line by line
  }
  for (const line of text.split('\n').map((l) => l.trim()).reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const v = JSON.parse(line);
      if (isPlain(v) && Object.hasOwn(v, 'result')) return v;
    } catch {
      // not the envelope
    }
  }
  return null;
}

export function parseLearnerReply(stdout) {
  const env = envelopeOf(stdout);
  if (!env) return { reply: null, costUsd: 0, isError: false, error: 'no envelope', envelope: false, tokens: null };
  const costUsd = Math.max(0, Number(env.total_cost_usd) || 0);
  const tokens = resultTokens(env);
  const result = typeof env.result === 'string' ? env.result : '';
  if (env.is_error === true) {
    const subtype = typeof env.subtype === 'string' && env.subtype && env.subtype !== 'success' ? env.subtype : '';
    return { reply: null, costUsd, isError: true, error: subtype || result.trim().split('\n')[0] || 'is_error', envelope: true, tokens };
  }
  const reply = lessonObject(result);
  return { reply, costUsd, isError: false, error: reply ? null : 'no lesson JSON', envelope: true, tokens };
}

// ---- the session ----

// The session's env: the caller's without the run's variables, plus Foreman's session keys.
// defaultSh lays it over process.env, so the run variables are set to undefined, which a
// spawn leaves out, to keep them from coming back that way. On the subscription the Console
// key is set to undefined the same way.
function learnerEnv(env, { root, config, stateDir }) {
  const base = Object.fromEntries(Object.entries(env ?? {}).filter(([k]) => !RUN_VARS.includes(k)));
  const out = withSessionKeys(base, root ? sessionKeys({ root, config }) : {});
  for (const k of RUN_VARS) out[k] = undefined;
  if (stateDir && readSignIn(stateDir).using === 'subscription') out.ANTHROPIC_API_KEY = undefined;
  return out;
}

// Scrubbed before it is cut, so a cut never leaves part of a secret behind.
function callError(r, parsed, scrubOpts) {
  if (r?.status === 127 || (!parsed.envelope && /\bENOENT\b/.test(String(r?.stderr ?? '')))) return NOT_INSTALLED;
  if (parsed.isError) return `the learner session failed: ${scrub(parsed.error, scrubOpts).slice(0, 200)}`;
  if (!parsed.envelope && r?.status !== 0) {
    const line = String(r?.stderr || r?.stdout || '').trim().split('\n').pop() ?? '';
    return `the learner session failed: ${scrub(line, scrubOpts).slice(0, 200) || 'no output'}`;
  }
  if (!parsed.reply) return NO_LESSON;
  return null;
}

// Is `reply` a merge into a learned skill?
const intoSkill = (reply, input) => reply?.verdict === 'merge' && (input?.skillIds ?? []).includes(reply?.merge?.id);

// Does `reply` need the skill model? A skill verdict, or a merge into a learned skill. With one
// model for both, only when the first reply left the skill body out. With newSkills false, a
// skill verdict does not: no new skill may be written.
function needsSkill(reply, input, learning, newSkills = true) {
  const merge = intoSkill(reply, input);
  if (reply?.verdict !== 'skill' && !merge) return false;
  if (!merge && !newSkills) return false;
  if (learning.skillModel !== learning.model) return true;
  return merge ? !isPlain(reply.merge.skill) : !isPlain(reply.skill) || typeof reply.skill.description !== 'string';
}

export function runLearner({ input, config, spentUsd = 0, run = defaultSh, env = process.env, root, stateDir, skills = true, newSkills = true, values = root ? fileSecrets({ root, config }) : [], home } = {}) {
  const learning = learningOf(config);
  const scrubOpts = { env, values, redact: learning.redact ?? [], root, home };
  const cap = Number(learning.maxUsdPerDay) || 0;
  const before = Math.max(0, Number(spentUsd) || 0);
  const sessionEnv = learnerEnv(env, { root, config, stateDir });
  const calls = [];
  let spent = 0;
  const budgetError = () => `the learning budget for today is spent ($${(before + spent).toFixed(2)} of $${cap.toFixed(2)})`;

  const call = (model, mode, timeout) => {
    // Whole cents, rounded down, so the session's budget never passes what is left.
    const remaining = Math.floor((cap - before - spent) * 100 + 1e-9) / 100;
    if (!(remaining >= 0.01)) return { stop: budgetError() };
    const { cmd, args } = learnerCommand({ prompt: learnerPrompt(input, mode), model, maxUsd: remaining });
    const r = run(cmd, args, { cwd: root, env: sessionEnv, timeout, maxBuffer: MAX_BUFFER });
    const parsed = parseLearnerReply(r?.stdout);
    spent += parsed.costUsd;
    const error = callError(r, parsed, scrubOpts);
    calls.push({ model, costUsd: parsed.costUsd, verdict: typeof parsed.reply?.verdict === 'string' ? parsed.reply.verdict.slice(0, 20) : null, error, tokens: parsed.tokens });
    return { reply: error ? null : parsed.reply, error };
  };

  const first = call(learning.model, 'decide', DECIDE_MS);
  if (first.stop || first.error) return { ok: false, reply: null, calls, error: first.stop ?? first.error };
  if (!skills || !needsSkill(first.reply, input, learning, newSkills)) return { ok: true, reply: first.reply, calls, error: null };
  const second = call(learning.skillModel, 'skill', SKILL_MS);
  if (second.stop) return { ok: false, reply: first.reply, calls, error: second.stop };
  if (second.error) return { ok: false, reply: null, calls, error: second.error };
  if (second.reply.verdict !== 'skill' && !intoSkill(second.reply, input)) {
    calls.at(-1).error = NO_SKILL;
    return { ok: false, reply: null, calls, error: NO_SKILL };
  }
  return { ok: true, reply: second.reply, calls, error: null };
}

// ---- checking a lesson ----

export function checkContext({ root, stateDir, config, env = {}, values, now = new Date(), home } = {}) {
  const learning = learningOf(config);
  const ledger = readLedger(stateDir);
  const lock = readLock(root, fs);
  let projectSkills = [];
  try {
    projectSkills = fs.readdirSync(join(root, '.claude', 'skills'));
  } catch {
    projectSkills = [];
  }
  return {
    roles: [...roleNames(config), 'all'],
    items: [...currentItems(ledger).values()],
    ledger,
    locked: new Set(Object.keys(lock.lock?.skills ?? {})),
    lockError: lock.error ?? null,
    projectSkills,
    roleFileBytes: (role) => {
      try {
        return fs.statSync(join(stateDir, 'learned', 'traits', `${role}.md`)).size;
      } catch {
        return 0;
      }
    },
    itemText: (item) => {
      try {
        return itemText(stateDir, item);
      } catch {
        return null;
      }
    },
    learning,
    scrubOpts: { env, values: values ?? fileSecrets({ root, config }), redact: learning.redact ?? [], root, home },
    now,
  };
}

const REASONS = {
  object: 'the reply is not a JSON object',
  secret: 'looks like it holds a secret',
  verdict: 'verdict must be none, trait, skill or merge',
  reason: `reason must be a sentence of at most ${REASON_MAX} characters`,
  conflicts: 'conflicts must be a list',
  role: 'a trait needs one known role',
  trait: `a trait is at most ${TRAIT_MAX} characters`,
  slug: `a skill slug must be lowercase words joined by dashes, at most ${SLUG_MAX} characters`,
  description: `a skill description must start with "Use when" and be at most ${DESCRIPTION_MAX} characters`,
  roles: 'a skill needs known roles',
  steps: `a skill needs 1 to ${STEPS_MAX} steps`,
  example: 'a skill needs an example',
  size: 'a learned skill is at most 6 KB',
  lock: 'skills-lock.json could not be read, so a skill slug cannot be checked',
  prefix: `a skill slug must not start with ${PREFIX} (Foreman adds it)`,
};

const fail = (reason) => ({ ok: false, reason });
const nextId = (ledger) => `L-${Math.max(0, ...ledger.filter((l) => l.action !== 'refused').map((l) => idNumber(l.id))) + 1}`;

// The trimmed trait text, or null when it is empty or too long.
const traitText = (text) => {
  const t = typeof text === 'string' ? text.trim() : '';
  return t && t.length <= TRAIT_MAX ? t : null;
};

export function renderSkill({ slug, description: desc, steps, example }) {
  const list = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `---\nname: ${PREFIX}${slug}\ndescription: ${JSON.stringify(desc)}\n---\n\n# ${slug.replace(/-/g, ' ')}\n\n## Steps\n\n${list}\n\n## Example\n\n${example}\n`;
}

// The checked skill body for `slug`, or { problem }. `rolesProblem` is the roles' own problem,
// reported after the description's, or null.
function skillBody(s, slug, rolesProblem) {
  const desc = typeof s.description === 'string' ? s.description.trim() : '';
  if (!desc.startsWith('Use when') || /[\r\n]/.test(desc) || desc.length > DESCRIPTION_MAX) return { problem: REASONS.description };
  if (rolesProblem) return { problem: rolesProblem };
  const steps = Array.isArray(s.steps) ? s.steps.map((x) => (typeof x === 'string' ? x.trim() : '')) : [];
  if (!steps.length || steps.length > STEPS_MAX || steps.some((x) => !x)) return { problem: REASONS.steps };
  const example = typeof s.example === 'string' ? s.example.trim() : '';
  if (!example) return { problem: REASONS.example };
  const text = renderSkill({ slug, description: desc, steps, example });
  if (Buffer.byteLength(text) > SKILL_MAX_BYTES) return { problem: REASONS.size };
  return { body: { description: desc, steps, example, text } };
}

// The checked trait for `role`, or { problem }. `fileBytes` is the role file's size with the
// new entry's text left out (and the old one taken out, for a merge).
function traitFor(role, text, { id, fileBytes }) {
  const t = traitText(text);
  if (!t) return { problem: REASONS.trait };
  if (fileBytes + Buffer.byteLength(`[${id}] ${t}`) > LEARNED_MAX_BYTES) return { problem: `the learned traits for ${role} would pass 3 KB` };
  return { text: t };
}

function checkTrait(o, ctx, live) {
  const t = isPlain(o.trait) ? o.trait : {};
  const role = typeof t.role === 'string' && ctx.roles.includes(t.role) ? t.role : null;
  if (!role) return fail(REASONS.role);
  if (!traitText(t.text)) return fail(REASONS.trait);
  const max = Number(ctx.learning.maxPerRole);
  const n = live.filter((i) => i.kind === 'trait' && i.roles[0] === role).length;
  if (!(n < max)) return fail(`${role} already has ${n} learned traits (the most is ${max})`);
  const r = traitFor(role, t.text, { id: nextId(ctx.ledger), fileBytes: ctx.roleFileBytes(role) + 2 });
  return r.problem ? fail(r.problem) : { ok: true, part: { trait: { role, text: r.text } } };
}

function checkSkill(o, ctx, live) {
  if (ctx.lockError) return fail(REASONS.lock);
  const s = isPlain(o.skill) ? o.skill : {};
  const slug = typeof s.slug === 'string' ? s.slug : '';
  if (!SLUG.test(slug) || slug.length > SLUG_MAX) return fail(REASONS.slug);
  // `${slug}-` so the bare foreman-learned is refused too.
  if (`${slug}-`.startsWith(PREFIX)) return fail(REASONS.prefix);
  const names = [`${PREFIX}${slug}`, slug];
  const owner = live.find((i) => i.kind === 'skill' && i.path === skillPath(slug));
  const clash = names.some((n) => ctx.locked.has(n)) ? 'a pack skill' : names.some((n) => ctx.projectSkills.includes(n)) ? 'a project skill' : owner?.id;
  if (clash) return fail(`the slug ${slug} clashes with ${clash}`);
  const roles = Array.isArray(s.roles) && s.roles.length && s.roles.every((r) => typeof r === 'string' && ctx.roles.includes(r)) ? [...new Set(s.roles)] : null;
  const r = skillBody(s, slug, roles ? null : REASONS.roles);
  if (r.problem) return fail(r.problem);
  const max = Number(ctx.learning.maxSkills);
  const n = live.filter((i) => i.kind === 'skill').length;
  if (!(n < max)) return fail(`Foreman already has ${n} learned skills (the most is ${max})`);
  return { ok: true, part: { skill: { slug, name: `${PREFIX}${slug}`, description: r.body.description, roles, steps: r.body.steps, example: r.body.example, text: r.body.text } } };
}

function checkMerge(o, ctx, live) {
  const m = isPlain(o.merge) ? o.merge : {};
  const id = typeof m.id === 'string' ? m.id : String(m.id ?? '');
  const item = live.find((i) => i.id === id);
  if (!item) return fail(`${id || 'the merge id'} is not in force`);
  if (item.kind === 'trait') {
    const role = item.roles[0];
    const text = isPlain(m.trait) ? m.trait.text : m.trait;
    const old = ctx.itemText(item);
    const fileBytes = old === null ? ctx.roleFileBytes(role) + 2 : ctx.roleFileBytes(role) - Buffer.byteLength(`[${id}] ${old.trim()}`);
    const r = traitFor(role, text, { id, fileBytes });
    return r.problem ? fail(r.problem) : { ok: true, part: { merge: { id, kind: 'trait', text: r.text } } };
  }
  const slug = slugOf(item);
  const r = skillBody(isPlain(m.skill) ? m.skill : {}, slug, null);
  if (r.problem) return fail(r.problem);
  return { ok: true, part: { merge: { id, kind: 'skill', skill: { slug, name: `${PREFIX}${slug}`, description: r.body.description, roles: [...item.roles], steps: r.body.steps, example: r.body.example, text: r.body.text } } } };
}

export function checkLesson(output, ctx) {
  if (!isPlain(output)) return fail(REASONS.object);
  // On the raw reply: a token the scrub below would blank still means the reply is refused.
  if (holdsSecret(output)) return fail(REASONS.secret);
  const { verdict } = output;
  if (!VERDICTS.includes(verdict)) return fail(REASONS.verdict);
  if (typeof output.reason !== 'string' || !output.reason.trim() || output.reason.trim().length > REASON_MAX) return fail(REASONS.reason);
  if (!Array.isArray(output.conflicts)) return fail(REASONS.conflicts);
  if (output.conflicts.length) {
    const first = output.conflicts[0];
    return fail(`the learner found a conflict: ${scrub(typeof first === 'string' ? first : JSON.stringify(first), ctx.scrubOpts).slice(0, 120)}`);
  }
  const o = scrubDeep(output, ctx.scrubOpts);
  const reason = o.reason.trim();
  if (verdict === 'none') return { ok: true, lesson: { verdict, reason, conflicts: [] } };

  const live = inForce(ctx.items);
  const checked = verdict === 'trait' ? checkTrait(o, ctx, live) : verdict === 'skill' ? checkSkill(o, ctx, live) : checkMerge(o, ctx, live);
  if (!checked.ok) return checked;

  const capped = capProblem({ items: ctx.items, ledger: ctx.ledger, learning: ctx.learning, now: ctx.now, target: verdict === 'merge' ? checked.part.merge.id : null });
  if (capped) return fail(capped);
  return { ok: true, lesson: { verdict, reason, conflicts: [], ...checked.part } };
}

// Why no learned item may be added or changed now, or null: too many on trial (not counting
// `target`, the item a merge changes), or Foreman made too many changes on now's UTC day.
export function capProblem({ items = [], ledger = [], learning, now, target = null } = {}) {
  const maxEvaluating = Number(learning?.maxEvaluating);
  const onTrial = inForce(items).filter((i) => i.status === 'evaluating' && i.id !== target).length;
  if (!(onTrial < maxEvaluating)) return `${onTrial} learned items are already on trial (the most is ${maxEvaluating})`;
  const maxPerDay = Number(learning?.maxPerDay);
  const day = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  const today = ledger.filter((l) => (l.action === 'add' || l.action === 'update') && l.by === 'foreman' && dayOf(l.at) === day).length;
  if (!(today < maxPerDay)) return `Foreman already made ${today} learned changes today (the most is ${maxPerDay})`;
  return null;
}

// ---- the spend ----

// The plain-object lines of `text`, torn ones skipped.
const callLines = (text) =>
  text
    .split('\n')
    .filter((raw) => raw.trim())
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null; // a torn line
      }
    })
    .filter(isPlain);

export function learnerSpentToday(stateDir, now = new Date()) {
  let text;
  try {
    text = fs.readFileSync(join(stateDir, LEARNER_LOG), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
  const day = now.toISOString().slice(0, 10);
  let sum = 0;
  for (const line of callLines(text)) if (dayOf(line.at) === day) sum += Math.max(0, Number(line.costUsd) || 0);
  return Math.round(sum * 1e6) / 1e6;
}

export function readLearnerCalls(stateDir) {
  try {
    return callLines(fs.readFileSync(join(stateDir, LEARNER_LOG), 'utf8'));
  } catch {
    return [];
  }
}

// A torn last line (no newline) gets one first, so it never swallows the new line.
export function recordLearnerCall(stateDir, { at, key = null, stories = null, model = null, costUsd = 0, verdict = null, error = null, tokens = null } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, LEARNER_LOG);
  let lead = '';
  try {
    const size = fs.statSync(file).size;
    if (size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, size - 1);
        if (b[0] !== 0x0a) lead = '\n';
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const count = Number.isInteger(stories) && stories >= 0 ? { stories } : {};
  const line = { at: at ?? new Date().toISOString(), key, ...count, model, costUsd: Math.max(0, Number(costUsd) || 0), verdict, error, tokens: isPlain(tokens) ? tokens : null };
  fs.appendFileSync(file, `${lead}${JSON.stringify(line)}\n`);
  return line;
}
