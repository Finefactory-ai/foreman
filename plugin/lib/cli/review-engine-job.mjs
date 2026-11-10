// The detached worker of `foreman review --start` (cli/commands/review.mjs):
//
//   node review-engine-job.mjs <stateDirPath> <id>
//
// It reads the relay's job and prompt (engine/review-engine.mjs), runs the engine's CLI in the
// folder the relay was started in, with its stdout and stderr in <id>.out and <id>.err, parses
// what it printed, and writes <id>.result.json for `foreman review --wait`.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { engineCommand, parseEngineOutput, quotaOutage, readRelay, relayFiles, writeEngineDown, writeRelayResult } from '../engine/review-engine.mjs';

const [stateDirPath, id] = process.argv.slice(2);
const files = relayFiles(stateDirPath, id);
const job = readRelay(stateDirPath, id);
const endedAt = () => new Date().toISOString();

if (!job) {
  writeRelayResult(stateDirPath, id, { ok: false, reason: 'the relay job file is missing', endedAt: endedAt() });
  process.exit(1);
}

let result;
let printed = '';
try {
  const prompt = readFileSync(files.prompt, 'utf8');
  const { cmd, args } = engineCommand(job.engine, prompt);
  const started = Date.now();
  const r = spawnSync(cmd, args, { cwd: job.cwd, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(files.out, r.stdout ?? '');
  writeFileSync(files.err, r.stderr ?? '');
  printed = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
  if (r.error) {
    result = { ok: false, reason: `could not run ${cmd}: ${r.error.message}` };
  } else if (r.status !== 0) {
    const tail = String(r.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    result = { ok: false, reason: `${cmd} ended with exit code ${r.status}${tail ? `: ${tail}` : ''}` };
  } else {
    const parsed = parseEngineOutput(r.stdout);
    result = parsed.ok ? { ...parsed, seconds: parsed.seconds ?? Math.round((Date.now() - started) / 1000) } : parsed;
  }
} catch (err) {
  result = { ok: false, reason: err?.message ?? String(err) };
}
if (!result.ok) {
  // Out of quota: note until when, so the next reviews skip the engine instead of failing too.
  const outage = quotaOutage(printed, new Date());
  if (outage) writeEngineDown(stateDirPath, { engine: job.engine?.name ?? null, ...outage, at: endedAt() });
}
writeRelayResult(stateDirPath, id, { ...result, endedAt: endedAt() });
