// A review run through another agent CLI instead of a Claude subagent. A reviewer in the config
// with `engine: { name, model, minutes? }` is relayed: the pipeline hands the review prompt to
// the review-relay agent, which writes it to a file and runs `foreman review --start` and
// `--wait` (cli/commands/review.mjs). The detached worker (cli/review-engine-job.mjs) runs the
// engine's CLI headless with the verdict schema and saves what it answered. Today's one engine:
//
//   antigravity   the Antigravity CLI, `agy -p`, on the model the config names (`agy models`
//                 lists them), in plan mode so it edits nothing, with the Bash tool's leave to
//                 run the targeted tests the reviewer prompt asks for
//
//   engineCommand(engine, prompt) -> { cmd, args } to run in the slot's worktree
//   parseEngineOutput(text) -> { ok: true, verdict, seconds, usage } or { ok: false, reason }
//       The CLI's `structured_output` first; else its `response` text, with a code fence or
//       narration around the JSON tolerated. A verdict of the wrong shape is refused, so a bad
//       answer sends the review to the Claude reviewer instead of passing as a verdict.
//
// When the engine's CLI says its quota is used up (a 429 / RESOURCE_EXHAUSTED, "Individual quota
// reached ... Resets in 4h16m58s"), the worker writes <stateDir>/review-engine/down.json:
// { engine, until, reason, at }. Until then `foreman review --start` answers unavailable at once
// and `foreman workflow-args` leaves the reviewers' engine out, so no relay is started only to
// fail. Without a reset time in the message the engine is down for DEFAULT_OUTAGE_MS.
//
//   quotaOutage(text, now)       { until, reason } when `text` reports a quota outage, else null
//   writeEngineDown / readEngineDown(stateDirPath, now)
//                                the record while its `until` is ahead of `now`, else null
//
// A relay's files live in <stateDir>/review-engine/, named by its id:
//   <id>.json        { id, pid, slot, story, reviewer, engine, cwd, startedAt }
//   <id>.prompt.md   the review prompt, copied at start so the agent's own file may go
//   <id>.out, .err   what the engine CLI printed
//   <id>.result.json { ok, verdict?, reason?, seconds?, usage?, endedAt }
// Files are written through a temp file renamed into place, so a reader never sees half of one.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pidAlive } from './check-jobs.mjs';

export const REVIEW_ENGINE_DIR = 'review-engine';
export const RELAY_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,80}$/;
export const ENGINE_CLI = { antigravity: 'agy' };
export const DEFAULT_MINUTES = 20;
const SEVERITIES = ['blocker', 'major', 'minor'];
const DAY_MS = 24 * 60 * 60 * 1000;

// The same shape the pipeline's VERDICT has (workflows/pipeline.js; test/workflow.test.mjs
// checks the two copies match).
export const VERDICT_SCHEMA = {
  type: 'object',
  required: ['approved', 'findings', 'checked'],
  properties: {
    approved: { type: 'boolean', description: 'true only with no blocker and no major finding' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'rule', 'where', 'observed', 'fix'],
        properties: {
          severity: { type: 'string', enum: SEVERITIES },
          rule: { type: 'string' },
          where: { type: 'string', description: 'file:line' },
          observed: { type: 'string' },
          fix: { type: 'string' },
          repeats: { type: 'string', description: 'only when this finding is another case of the same kind of bug as an earlier finding listed in the prompt: that finding\'s id, such as E2' },
        },
      },
    },
    checked: { type: 'string', description: 'what you ran or read, and what you observed' },
  },
};

export function engineCommand(engine, prompt) {
  const cmd = ENGINE_CLI[engine?.name];
  if (!cmd) throw new Error(`unknown review engine: ${engine?.name}`);
  const minutes = Number.isInteger(engine.minutes) && engine.minutes > 0 ? engine.minutes : DEFAULT_MINUTES;
  return {
    cmd,
    args: [
      '-p', prompt,
      '--model', engine.model,
      '--mode', 'plan',
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(VERDICT_SCHEMA),
      '--print-timeout', `${minutes}m`,
    ],
  };
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

// The verdict in the pipeline's shape, or a reason it is not one.
function verdictOf(v) {
  if (!isPlain(v)) return { reason: 'the verdict is not an object' };
  if (typeof v.approved !== 'boolean') return { reason: 'the verdict has no boolean approved' };
  if (!Array.isArray(v.findings)) return { reason: 'the verdict has no findings list' };
  const findings = [];
  for (const f of v.findings) {
    if (!isPlain(f) || !SEVERITIES.includes(f.severity)) return { reason: `a finding has no severity of ${SEVERITIES.join(', ')}` };
    const repeats = str(f.repeats).trim();
    findings.push({ severity: f.severity, rule: str(f.rule), where: str(f.where, '-') || '-', observed: str(f.observed), fix: str(f.fix), ...(repeats ? { repeats } : {}) });
  }
  return { verdict: { approved: v.approved, findings, checked: str(v.checked) } };
}

// The JSON object in a text: whole, inside a code fence, or the last `{"approved"` to the end.
function jsonIn(text) {
  const t = String(text ?? '').trim();
  const tries = [t, t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const at = t.lastIndexOf('{"approved"');
  if (at > 0) tries.push(t.slice(at).replace(/\s*```$/, ''));
  for (const s of tries) {
    try {
      return JSON.parse(s);
    } catch {
      // next
    }
  }
  return undefined;
}

export function parseEngineOutput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: 'the engine printed nothing' };
  // The CLI may print a notice line before its JSON.
  const at = raw.indexOf('{');
  let out;
  try {
    out = at === -1 ? undefined : JSON.parse(raw.slice(at));
  } catch {
    out = undefined;
  }
  if (!isPlain(out)) return { ok: false, reason: 'the engine did not print JSON' };
  if (out.status !== undefined && out.status !== 'SUCCESS') {
    return { ok: false, reason: `the engine answered ${String(out.status)}${out.error ? `: ${String(out.error)}` : ''}` };
  }
  const candidate = isPlain(out.structured_output) ? out.structured_output : jsonIn(out.response);
  const { verdict, reason } = verdictOf(candidate);
  if (!verdict) return { ok: false, reason: `the engine's answer is not a verdict: ${reason}` };
  const seconds = typeof out.duration_seconds === 'number' ? out.duration_seconds : null;
  return { ok: true, verdict, seconds, usage: isPlain(out.usage) ? out.usage : null };
}

export const relayDir = (stateDirPath) => join(stateDirPath, REVIEW_ENGINE_DIR);
export const DOWN_FILE = (stateDirPath) => join(relayDir(stateDirPath), 'down.json');
export const DEFAULT_OUTAGE_MS = 60 * 60 * 1000;
export const OUTAGE_MARGIN_MS = 60 * 1000;
const QUOTA = /RESOURCE_EXHAUSTED|quota (?:reached|exceeded|exhausted)|\b429\b/i;
const RESETS = /resets? in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i;

export function quotaOutage(text, now = new Date()) {
  const t = String(text ?? '');
  if (!QUOTA.test(t)) return null;
  const m = RESETS.exec(t);
  const told = m && (m[1] || m[2] || m[3]);
  const ms = told ? ((Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0)) * 1000 : DEFAULT_OUTAGE_MS;
  const line = t.split('\n').map((l) => l.trim()).find((l) => QUOTA.test(l)) ?? 'quota reached';
  return { until: new Date(now.getTime() + ms + OUTAGE_MARGIN_MS).toISOString(), reason: line.slice(0, 200) };
}

export function relayFiles(stateDirPath, id) {
  const base = join(relayDir(stateDirPath), id);
  return { job: `${base}.json`, prompt: `${base}.prompt.md`, out: `${base}.out`, err: `${base}.err`, result: `${base}.result.json` };
}

export function newRelayId({ slot, now, random = () => randomBytes(3).toString('hex') }) {
  return `${slot || 'here'}-${now.getTime().toString(36)}-${random()}`;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return isPlain(v) ? v : null;
  } catch {
    return null;
  }
}

export function writeRelay(stateDirPath, job) {
  const { id, pid, slot, story, reviewer, engine, cwd, startedAt } = job;
  writeJson(relayFiles(stateDirPath, id).job, { id, pid, slot, story, reviewer, engine, cwd, startedAt });
}
export const readRelay = (stateDirPath, id) => readJson(relayFiles(stateDirPath, id).job);
export const writeRelayResult = (stateDirPath, id, result) => writeJson(relayFiles(stateDirPath, id).result, result);
export const readRelayResult = (stateDirPath, id) => readJson(relayFiles(stateDirPath, id).result);

export function writeEngineDown(stateDirPath, { engine, until, reason, at }) {
  writeJson(DOWN_FILE(stateDirPath), { engine, until, reason, at });
}

export function readEngineDown(stateDirPath, now = new Date()) {
  const v = readJson(DOWN_FILE(stateDirPath));
  if (!v || typeof v.until !== 'string') return null;
  const until = Date.parse(v.until);
  return Number.isFinite(until) && until > now.getTime() ? v : null;
}

export function removeRelay(stateDirPath, id) {
  for (const file of Object.values(relayFiles(stateDirPath, id))) rmSync(file, { force: true });
}

// Relays older than a day go, whatever state they are in.
export function pruneRelays(stateDirPath, { now = new Date(), maxAgeMs = DAY_MS } = {}) {
  let names;
  try {
    names = readdirSync(relayDir(stateDirPath));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.result.json')) continue;
    const job = readJson(join(relayDir(stateDirPath), name));
    const started = Date.parse(job?.startedAt);
    if (job && RELAY_ID.test(String(job.id)) && Number.isFinite(started) && now.getTime() - started > maxAgeMs) removeRelay(stateDirPath, job.id);
  }
}

const realPs = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// The process with this relay's pid is its worker, not a program that got the pid since.
export function relayAlive(job, { kill = process.kill, ps = realPs } = {}) {
  if (!job || !pidAlive(job.pid, kill)) return false;
  const r = ps('ps', ['-p', String(job.pid), '-o', 'command=']);
  if (r.error) return true;
  const command = ` ${String(r.stdout ?? '').trim()} `;
  return r.status === 0 && command.includes('review-engine-job.mjs') && command.includes(` ${job.id} `);
}
