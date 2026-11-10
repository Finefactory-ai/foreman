// What a story session's pipeline agents had finished when the session was stopped without a
// result (the watchdog, a crash), so the next session carries on from the last finished stage
// instead of starting again at the architect. The pipeline workflow cannot write files, but the
// session's Claude transcripts hold every agent's answer (session-files.mjs readSubagents), and
// the supervisor reads them before it removes them.
//
//   CHECKPOINT(dir, id)          <dir>/checkpoints/<id>.json, the id reduced to a safe file
//                                name. Machine-local, like the worktree it describes: it is not
//                                kept on the state branch
//   structuredOutput(text)       the input of the transcript's last StructuredOutput call whose
//                                result came back without an error; null when there is none (an
//                                agent killed mid-answer). Torn lines are skipped
//   stageOutputs(subagents, id, roles)
//                                [{ label, role, name, round, at, endAt, tokens, output }] for the
//                                pipeline's architect, builder, tester and reviewer agents of
//                                story `id` (their labels, tokens.mjs agentOf), at and endAt the
//                                first and last line timestamps, sorted by at. `roles` has the
//                                shape of config.roles. A transcript counts only when the pipeline
//                                itself started it: its meta.workflowPhase is its role's phase
//                                (Architect, Build for a build or fix, Test, Review, as
//                                workflows/pipeline.js gives them) and its meta.agentType names
//                                the agent the config gives that role (any builder's for a
//                                builder; for a reviewer, the agent of the reviewer whose name is
//                                the label's prefix, so an unconfigured reviewer counts for
//                                nothing). An agent is named by itself, its part after the last
//                                ':' or foreman:<that part>, the forms state.mjs stageMap takes.
//                                Any other transcript is dropped; no roles gives []
//   mergeCheckpoint(previous, { story, entries, tree, at })
//                                the same story's earlier entries plus these, each kept as
//                                { label, role, name, round, at, tree, output }; another story's
//                                are dropped. `tree` is the worktree's content when this session
//                                stopped: the checkpoint's tree, and the tree of each of these
//                                entries. Earlier entries keep their own (null in an older file)
//   resumePoint(checkpoint, { tree, reviewers })
//                                { plan, resume, kept, keys }: the last ready plan, whatever its
//                                tree, and, when the tree is the one the checkpoint saw and the
//                                one the last builder's session ended on, that build (or fix)
//                                with the tester and reviewers that approved it after it on the
//                                same tree (only minor findings; reviewers only with the tester)
//                                as the pipeline's `resume` arg. kept is the labels used, for the
//                                event, the run record and workflow-args; keys their entryKey
//   entryKey(entry)              one entry's identity, its label and `at`: labels repeat across
//                                sessions, since a resumed pipeline starts again at round 1
//   redoneWork(entries, keys)    { tokens, minutes } of the entries whose entryKey is not in keys:
//                                the work the next session does again
//   readCheckpoint(dir, id), writeCheckpoint(dir, cp), clearCheckpoint(dir, id)
//   worktreeTree(cwd, generated) a hash of the working tree's content, untracked files included
//                                and the generated paths left out, from a copy of the index so
//                                the real one is untouched; null outside a repo or on a failure.
//                                Its `git add -A` on the copied index writes loose blobs for the
//                                untracked files into the repo's object store (git gc removes them
//                                later). It runs in the session-close child (session-close.mjs),
//                                never in the supervisor's process, only for a session that
//                                ended with no result, with up to 120 s for each git call, so a
//                                very large worktree never holds the supervisor's loop
//
// Which code an approval covers: each entry's tree is the worktree when its session ended, not
// when its verdict was given. A carried approval is still one on that code only because the story
// skill sends every edit made after a review through a builder (skills/story/fix-round.md), and
// resumePoint drops approvals given before the last builder. So only builder agents may change
// the tree after an approval.
//
// The checkpoint file is trusted like the rest of the state dir (locks, waits, stages) and is not
// signed. A key held in the supervisor's memory would be lost when it restarts on new code, which
// would end every resume, so there is no HMAC, and the folder stays where it is.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { agentOf, total, transcriptUsage } from './tokens.mjs';

// The phase pipeline.js gives each role's agent() calls.
const PHASES = { architect: 'Architect', builder: 'Build', tester: 'Test', reviewer: 'Review' };
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = (iso) => Date.parse(iso) || 0;
const byAt = (a, b) => time(a.at) - time(b.at);

export const CHECKPOINT = (dir, id) => join(dir, 'checkpoints', `${String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[.]+/, '') || 'none'}.json`);

const lines = (text) => {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    try {
      const v = JSON.parse(line);
      if (isPlain(v)) out.push(v);
    } catch {
      // a torn line
    }
  }
  return out;
};

const contentOf = (event) => (Array.isArray(event?.message?.content) ? event.message.content : []);

export function structuredOutput(text) {
  const calls = [];
  const results = new Map(); // tool_use_id -> is_error
  for (const event of lines(text)) {
    for (const part of contentOf(event)) {
      if (!isPlain(part)) continue;
      if (event.type === 'assistant' && part.type === 'tool_use' && part.name === 'StructuredOutput' && part.id) calls.push(part);
      if (event.type === 'user' && part.type === 'tool_result' && part.tool_use_id) results.set(part.tool_use_id, part.is_error === true);
    }
  }
  for (let i = calls.length - 1; i >= 0; i--) {
    if (results.has(calls[i].id) && results.get(calls[i].id) !== true) return calls[i].input ?? null;
  }
  return null;
}

// The story id in a pipeline label: between the ':' and an optional '#n'.
const labelId = (label) => {
  const colon = label.indexOf(':');
  return colon === -1 ? null : label.slice(colon + 1).replace(/#\d+\s*$/, '').trim();
};

const isoOrNull = (ms) => (ms === null ? null : new Date(ms).toISOString());

// Whether `agentType` names the configured `agent`: itself, its part after the last ':', or
// foreman:<that part>.
const names = (agentType, agent) => {
  if (typeof agent !== 'string' || !agent || typeof agentType !== 'string') return false;
  const plain = agent.slice(agent.lastIndexOf(':') + 1);
  return agentType === agent || agentType === plain || agentType === `foreman:${plain}`;
};

// The agents the config gives this role (and, for a reviewer, this name).
const configured = (roles, { role, name }) => {
  if (role === 'architect') return [roles.architect?.agent];
  if (role === 'builder') return Object.values(isPlain(roles.builders) ? roles.builders : {}).map((b) => b?.agent);
  if (role === 'tester') return [roles.tester?.agent];
  if (role === 'reviewer') return [(Array.isArray(roles.reviewers) ? roles.reviewers : []).find((r) => r?.name === name)?.agent];
  return [];
};

// The pipeline started it: its role's phase and one of its role's agents.
const startedBy = (roles, meta, a) => Object.hasOwn(PHASES, a.role) && meta?.workflowPhase === PHASES[a.role] && configured(roles, a).some((agent) => names(meta.agentType, agent));

export function stageOutputs(subagents, id, roles) {
  const out = [];
  if (!isPlain(roles)) return out;
  for (const { meta, text } of Array.isArray(subagents) ? subagents : []) {
    const a = agentOf(meta);
    if (!startedBy(roles, meta, a)) continue;
    const label = typeof meta?.description === 'string' ? meta.description.trim() : '';
    if (labelId(label) !== id) continue;
    const stamps = lines(text)
      .map((e) => (typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN))
      .filter(Number.isFinite);
    out.push({
      label,
      role: a.role,
      name: a.name,
      round: a.round,
      at: isoOrNull(stamps.length ? stamps[0] : null),
      endAt: isoOrNull(stamps.length ? stamps.at(-1) : null),
      tokens: total(transcriptUsage(text)),
      output: structuredOutput(text),
    });
  }
  return out.sort(byAt);
}

export const entryKey = (e) => JSON.stringify([e?.label, e?.at ?? null]);

const kept = ({ label, role, name, round, at, tree, output }) => ({ label, role, name, round, at, tree: tree ?? null, output });

export function mergeCheckpoint(previous, { story, entries = [], tree = null, at }) {
  const before = previous?.story === story && Array.isArray(previous.entries) ? previous.entries : [];
  return { story, tree, at, entries: [...before.map(kept), ...entries.map((e) => kept({ ...e, tree }))] };
}

const isPlan = (o) => isPlain(o) && o.ready === true && typeof o.builder === 'string' && typeof o.design === 'string';
const isBuild = (o) => isPlain(o) && o.complete === true && typeof o.summary === 'string' && Array.isArray(o.files);
const approved = (o) => isPlain(o) && o.approved === true && Array.isArray(o.findings) && o.findings.every((f) => f?.severity === 'minor');

export function resumePoint(checkpoint, { tree = null, reviewers = [] } = {}) {
  const entries = (Array.isArray(checkpoint?.entries) ? [...checkpoint.entries] : []).filter(isPlain).sort(byAt);
  const architect = entries.filter((e) => e.role === 'architect' && isPlan(e.output)).at(-1);
  if (!architect) return { plan: null, resume: null, kept: [], keys: [] };
  const plan = architect.output;
  const planOnly = { plan, resume: null, kept: [architect.label], keys: [entryKey(architect)] };
  if (tree == null || tree !== checkpoint.tree) return planOnly;

  // The build must be on the tree the next session finds, and so must every approval of it.
  const last = entries.findLastIndex((e) => e.role === 'builder');
  if (last === -1 || entries[last].tree !== tree || !isBuild(entries[last].output)) return planOnly;
  const builder = entries[last];
  const after = entries.slice(last + 1).filter((e) => e.tree === tree);
  const resume = { build: { summary: builder.output.summary, files: builder.output.files }, verdicts: {} };
  const used = [architect, builder];
  const tester = after.filter((e) => e.role === 'tester' && approved(e.output)).at(-1);
  if (tester) {
    resume.verdicts.tester = { findings: tester.output.findings };
    used.push(tester);
    for (const name of reviewers) {
      const r = after.filter((e) => e.role === 'reviewer' && e.name === name && approved(e.output)).at(-1);
      if (!r) continue;
      resume.verdicts[name] = { findings: r.output.findings };
      used.push(r);
    }
  }
  return { plan, resume, kept: used.map((e) => e.label), keys: used.map(entryKey) };
}

export function redoneWork(entries, keys) {
  const keep = new Set(keys ?? []);
  let tokens = 0;
  let ms = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (keep.has(entryKey(e))) continue;
    tokens += Number(e.tokens) || 0;
    const span = time(e.endAt) - time(e.at);
    if (e.at && e.endAt && span > 0) ms += span;
  }
  return { tokens, minutes: Math.round(ms / 6000) / 10 };
}

export function readCheckpoint(dir, id) {
  try {
    const cp = JSON.parse(readFileSync(CHECKPOINT(dir, id), 'utf8'));
    return isPlain(cp) && cp.story === id && Array.isArray(cp.entries) ? cp : null;
  } catch {
    return null;
  }
}

export function writeCheckpoint(dir, cp) {
  const file = CHECKPOINT(dir, cp.story);
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cp, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

export function clearCheckpoint(dir, id) {
  rmSync(CHECKPOINT(dir, id), { force: true });
}

export function worktreeTree(cwd, generated = [], sh = spawnSync) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const git = (args, extra = {}) => sh('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, env: { ...env, ...extra } });
  let temp = null;
  try {
    const where = git(['rev-parse', '--git-path', 'index']);
    if (where.status !== 0) return null;
    const index = resolve(cwd, String(where.stdout).trim());
    temp = mkdtempSync(join(tmpdir(), 'foreman-tree-'));
    const copy = join(temp, 'index');
    if (existsSync(index)) copyFileSync(index, copy);
    const excludes = (Array.isArray(generated) ? generated : []).filter((g) => typeof g?.path === 'string' && g.path).map((g) => `:(exclude,glob)${g.path}`);
    if (git(['add', '-A', '--', '.', ...excludes], { GIT_INDEX_FILE: copy }).status !== 0) return null;
    const tree = git(['write-tree'], { GIT_INDEX_FILE: copy });
    const sha = String(tree.stdout ?? '').trim();
    return tree.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}
