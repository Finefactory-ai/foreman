// What the supervisor reads when a story session ends, done in a child process of its own so the
// supervisor's loop never reads megabytes of log and transcripts, or hashes a large working tree,
// itself. The supervisor asks for it with runSessionClose and gets a plain, JSON-safe answer.
//
//   CLOSE_MS                6 minutes: the child's time limit
//   closeSession(request)   synchronous; runs only in the child (session-close-child.mjs):
//                           request { logFile, projects, record, keep, id, worktree, generated,
//                           roles }. It reads the log (empty when missing), classifies it
//                           (session.mjs result), reads and, unless `keep`, removes the session's
//                           own files under `projects` (session-files.mjs collectSessionTokens),
//                           takes the pipeline's finished stages out of the agents' transcripts
//                           (checkpoint.mjs stageOutputs) and, for a session that printed no
//                           result and whose transcripts were read, the working tree's hash
//                           (checkpoint.mjs worktreeTree). Returns { result, log, agents, kept,
//                           filesError, stages, stagesError, subagentsRead, tree }: agents is
//                           null when they are unknown; filesError and stagesError are the
//                           message of what threw, else null; subagentsRead is whether the
//                           transcripts could be read at all
//   fallbackAnswer(logFile) the same shape from the last 256 KB of the log alone (the
//                           supervisor uses it when the child fails): the result and log are
//                           read, nothing else is known
//   runSessionClose({ node, request, run, track, timeoutMs, tmp })
//                           runs the child on `node` with the request in a temporary
//                           foreman-close-* folder, and gives { ok: true, answer } or { ok:
//                           false, why } where why is `timed out`, `exit <status>`, `could not
//                           start: <error>` or `bad answer`. It never rejects and always removes
//                           the folder

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageOutputs, worktreeTree } from './checkpoint.mjs';
import { runAsync } from './run-async.mjs';
import { collectSessionTokens } from './session-files.mjs';
import { readSessionLog } from './session-log.mjs';
import { readTail } from './session-outlive.mjs';
import { result as sessionResult } from './session.mjs';

export const CLOSE_MS = 6 * 60_000;

const CHILD = fileURLToPath(new URL('./session-close-child.mjs', import.meta.url));
const why = (err) => String(err?.message ?? err).slice(0, 200);

export function closeSession({ logFile, projects, record, keep, id, worktree, generated, roles }) {
  let text = '';
  try {
    text = readFileSync(logFile, 'utf8');
  } catch {
    text = '';
  }
  const result = sessionResult(text);
  const log = readSessionLog(text);

  let agents = null;
  let subagents = null;
  let kept = [];
  let filesError = null;
  try {
    ({ agents, subagents, kept } = collectSessionTokens({ logText: text, projects, record, keep, withSubagents: true }));
  } catch (err) {
    agents = null;
    subagents = null;
    kept = [];
    filesError = why(err);
  }

  let stages = [];
  let stagesError = null;
  if (subagents) {
    try {
      stages = stageOutputs(subagents, id, roles);
    } catch (err) {
      stages = [];
      stagesError = why(err);
    }
  }

  // Only a session with no printed result reaches saveCheckpoint (sessionResult turns READY into
  // failed, never into null), and a tree is saved only with transcripts that could be read.
  const tree = subagents && result.result === null && worktree ? worktreeTree(worktree, generated) : null;
  return { result, log, agents, kept, filesError, stages, stagesError, subagentsRead: subagents !== null, tree };
}

export function fallbackAnswer(logFile) {
  const text = readTail(logFile);
  return { result: sessionResult(text), log: readSessionLog(text), agents: null, kept: [], filesError: null, stages: [], stagesError: null, subagentsRead: false, tree: null };
}

export async function runSessionClose({ node, request, run = runAsync, track, timeoutMs = CLOSE_MS, tmp = tmpdir() }) {
  let dir = null;
  try {
    mkdirSync(tmp, { recursive: true });
    dir = mkdtempSync(join(tmp, 'foreman-close-'));
    const requestFile = join(dir, 'request.json');
    const answerFile = join(dir, 'answer.json');
    writeFileSync(requestFile, JSON.stringify(request));
    const r = await run(node, [CHILD, requestFile, answerFile], { cwd: dir, timeoutMs, track });
    if (r.timedOut) return { ok: false, why: 'timed out' };
    if (r.error) return { ok: false, why: `could not start: ${r.error}` };
    if (r.status !== 0) return { ok: false, why: `exit ${r.status ?? r.signal ?? 'unknown'}` };
    try {
      const answer = JSON.parse(readFileSync(answerFile, 'utf8'));
      if (answer && typeof answer === 'object' && !Array.isArray(answer)) return { ok: true, answer };
    } catch {
      // falls through to bad answer
    }
    return { ok: false, why: 'bad answer' };
  } catch (err) {
    return { ok: false, why: `could not start: ${why(err)}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// For the child: writes the answer whole or not at all.
export function writeAnswer(file, answer) {
  writeFileSync(`${file}.tmp`, JSON.stringify(answer));
  renameSync(`${file}.tmp`, file);
}
