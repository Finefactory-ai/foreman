// Whether a Bash call inside a factory run may go ahead. Pure: the hook in
// lib/hooks/agent-events.mjs does the I/O. Six guards, in order:
//
//   1. The host guard (production-hosts.mjs): keeps the tester and reviewers off production
//      hosts. features.productionGuard false switches it off.
//   2. The project-files guard (anchor-files.mjs): denies a command that would write the
//      config, local settings or key files of the project the run builds, or the check records
//      in its state folder (check-runs.jsonl), given as `protect`
//      (paths already resolved the way `resolve` resolves a command's paths; `cwd` is where the
//      command runs and `vars` expands $NAME). With `foreman` it also denies a Foreman CLI call
//      that writes the owner's files from that project or a worktree of it, whatever the
//      command does to the FOREMAN_* variables. Every agent, every stage, the foreman included;
//      no setting switches it off. Without `protect` it does nothing.
//   3. The check guard (check-guard.mjs): denies a command that runs one of the project's
//      configured checks by hand, because only `foreman checks` records a run (check-runs.mjs).
//      Every agent, every stage, the foreman included; no setting switches it off, and
//      features.productionGuard does not touch it. A targeted run of a single test stays free.
//   4. The scan guard (scan-guard.mjs): denies a `find`, `du`, `ls -R`, `grep -r`, `rg` or
//      `mdfind` that starts outside `roots` (the project, its state folder, ~/.claude, the temp
//      folder), because a scan of the disk or the home folder makes macOS ask the owner for
//      access to private folders. Every agent, every stage, the foreman included; no setting
//      switches it off. Without `roots` it does nothing. It fails closed.
//   5. The kill guard (kill-guard.mjs): allows only `kill [-TERM|-KILL|-9|-15|-s TERM|-s KILL]
//      <numeric pid>...` of the session's own processes. Every other kill, `pkill`, `killall` and
//      indirect kill (`xargs kill`, `find -exec kill`) is denied, and so is a PID that `signals`
//      (the hook's killLook) says is not a process this session started or is the Foreman
//      supervisor, its service or the dashboard, because one such signal stops every story.
//      Every agent, every stage, the foreman included; no setting switches it off, and
//      features.productionGuard does not touch it. Without `signals` a pid is allowed. It fails
//      closed.
//   6. The active pack's own guard, asked in every stage, including the foreman's (stage null).
//      No setting switches it off. It fails closed: a guard that throws, or answers with
//      something other than null or a reason, denies the command.
//
// A guard that denies ends the decision: the ones after it are not asked.
// `packs` stands in for the real registry in tests.

import { guardBash, productionHosts } from './production-hosts.mjs';
import { anchorWriteReason } from './anchor-files.mjs';
import { handRun, handRunReason } from './check-guard.mjs';
import { scanCommandReason } from './scan-guard.mjs';
import { killReason } from './kill-guard.mjs';
import { PACKS, packFor } from '../../packs/index.mjs';

// Null to allow, or the reason to deny. Never throws.
export function bashDecision({ command, agentType, config, stages, slot, packs = PACKS, cwd, protect, vars, resolve, foreman, roots, signals }) {
  // agent_type is set on a subagent's tool calls; the foreman itself has none.
  // Own keys only: an agent type such as 'constructor' must not reach Object.prototype.
  const stage = stages && Object.hasOwn(stages, agentType) ? stages[agentType] : null;
  if (config?.features?.productionGuard !== false) {
    const reason = guardBash({ command, stage, hosts: productionHosts(config) });
    if (reason) return reason;
  }
  if (Array.isArray(protect) && protect.length) {
    let reason;
    try {
      reason = anchorWriteReason({ command, cwd, protect, vars, foreman, ...(resolve ? { resolve } : {}) });
    } catch {
      reason = 'The Foreman project-files guard failed, so Foreman denies this command.';
    }
    if (reason) return reason;
  }
  if (typeof command !== 'string' || !command) return null;
  try {
    const hit = handRun({ command, checks: config?.checks, vars: vars ?? {} });
    if (hit) return handRunReason(hit.run);
  } catch {
    return 'The Foreman check guard failed, so Foreman denies this command.';
  }
  if (Array.isArray(roots) && roots.length) {
    try {
      const reason = scanCommandReason({ command, cwd, vars: vars ?? {}, roots, ...(resolve ? { resolve } : {}) });
      if (reason) return reason;
    } catch {
      return 'The Foreman scan guard failed, so Foreman denies this command.';
    }
  }
  try {
    const reason = killReason({ command, cwd, vars: vars ?? {}, signals });
    if (reason) return reason;
  } catch {
    return 'The Foreman kill guard failed, so Foreman denies this command.';
  }
  let pack = null;
  try {
    pack = packFor(config, packs);
  } catch {
    // a config naming an unknown pack fails validation elsewhere; here it means no pack
  }
  if (!pack || typeof pack.guard !== 'function') return null;
  let answer;
  try {
    answer = pack.guard({ command, stage, slot, config });
  } catch (err) {
    // The thrown value may itself throw when read or turned into text; still deny, never throw.
    let detail;
    try {
      detail = String(err?.message ?? err);
    } catch {
      detail = 'unknown error';
    }
    return `The ${pack.name} pack guard failed (${detail}), so Foreman denies this command.`;
  }
  if (answer === null || answer === undefined || answer === false || answer === '') return null;
  if (typeof answer === 'string') return answer;
  return `The ${pack.name} pack guard gave no reason, so Foreman denies this command.`;
}
