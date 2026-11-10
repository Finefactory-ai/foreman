// What each session leaves behind when it ends: its run record, its checkpoint, its session files and its check runs.
//
// Session files: when a session ends, the tokens each of its agents used are read from the files
// Claude Code kept for it into its run record, and then that session's files, and only those,
// are removed (session-files.mjs), with run records on or off. The folder is the session's own,
// <CLAUDE_CONFIG_DIR or HOME/.claude>/projects from the env it was started with (a slot
// environment or a pack may set either), kept on its entry. While it runs, a mark per slot
// (<stateDir>/session-files/<slot>.json: story, pid, log and that folder) names them; it goes
// when the ending is handled, and an adopted session finds its folder there. An interrupt sets
// keep on the mark, so a session that outlives the stop keeps its files too. At start,
// before the console, the marks of sessions that are neither this run's nor still running (the
// supervisor died before their ending) are swept: their files removed with an event, or with
// keep left in place with the same event an interrupt gives, and the marks removed. A mark this
// run would overwrite that names another session is kept as <slot>-<pid>.json and swept at a
// later start once that session has ended; a mark whose folder is not a `projects` folder is
// only removed.
//
// Check runs: `foreman checks --start` runs the checks detached, in their own process group and
// outside the session's, and keeps them in <stateDir>/check-jobs/ (engine/check-jobs.mjs). When a
// session ends, however it ends, the runs it left going are ended (SIGTERM, then SIGKILL after
// 10 s) and their files removed, with an event. At start, after the adopted sessions are known,
// the runs of slots with no session are ended the same way, so a restart keeps those of the
// sessions it adopted.
//
// Checkpoints: when a session ends with no result (the watchdog, a crash, an API limit), what
// its pipeline agents had finished is read from its transcripts before they are removed and
// merged into <stateDir>/checkpoints/<id>.json with the slot's working tree hash
// (checkpoint.mjs), and one event names the stages kept. Only transcripts whose phase and agent
// match the role the config gives them count, and each kept stage carries the tree its session
// ended on. `foreman workflow-args` then gives the next session the plan and, while the tree is
// the one the last build and its approvals were kept on, the finished build and approvals, so
// it carries on from the last finished stage. A result, Skip, Take over, Restart or an automatic
// resume closed because the story is settled removes the checkpoint; an interrupt leaves it.

import { claudeProjectsDir, markedProjects, readMark, sweepSessionFiles, unmarkSession } from './session-files.mjs';
import { clearCheckpoint, mergeCheckpoint, readCheckpoint, redoneWork, resumePoint, writeCheckpoint } from './checkpoint.mjs';
import { addToTotals, clearSpans, modelMismatches, roleModels, sessionSpans, stageMap } from './state.mjs';
import { readFindingsLines, runRecord, writeRun } from './run-record.mjs';
import { recordsRuns } from './live-settings.mjs';
import { sessionAlive } from './handover.mjs';
import { endCheckJobs, killLeftGroup } from './check-jobs.mjs';

// `sessions` is the supervisor's own map; `settings()` is the config in effect, replaced when the settings change.
export function sessionRecords({ dir: DIR, config: CONFIG, settings, sessions, event, guarded, now }) {
  const STAGE_OF = stageMap(CONFIG);

  // What ran in the slot's session and when; read before its agents are cleared.
  function takeSpans(slot) {
    try {
      return sessionSpans(DIR, slot, now());
    } catch {
      return [];
    }
  }

  // After a session ended with no result: what its agents finished, merged into the story's
  // checkpoint (checkpoint.mjs) with the slot's working tree as it was left, so the next session
  // carries on from the last finished stage. The stages and the tree come from the session-close
  // child's answer (session-close.mjs); with transcripts that could not be read, the tree is left
  // unknown, so the next session keeps only the plan. Returns { kept, tokens, minutes }: the stages
  // kept and the work of this session the next does again. A failure is a warn event, never thrown.
  function saveCheckpoint(slot, s, answer) {
    const id = s.id;
    if (answer.stagesError) {
      event(`Could not keep the finished stages of ${id} (${answer.stagesError}).`, 'warn', slot);
      return { kept: [], ...redoneWork([], []) };
    }
    const entries = answer.stages;
    try {
      const tree = answer.subagentsRead ? answer.tree : null;
      const cp = mergeCheckpoint(readCheckpoint(DIR, id), { story: id, entries, tree, at: now().toISOString() });
      writeCheckpoint(DIR, cp);
      const { kept, keys } = resumePoint(cp, { tree, reviewers: CONFIG.roles.reviewers.map((r) => r.name) });
      if (kept.length) event(`${id}: kept its finished stages (${kept.join(', ')}) for the resume.`, 'info', slot);
      return { kept, ...redoneWork(entries, keys) };
    } catch (err) {
      event(`Could not keep the finished stages of ${id} (${String(err?.message ?? err).slice(0, 200)}).`, 'warn', slot);
      return { kept: [], ...redoneWork(entries, []) };
    }
  }

  // A story's checkpoint is spent once it has a result or the owner moved it; a failure is an event.
  function dropCheckpoint(slot, id) {
    try {
      clearCheckpoint(DIR, id);
    } catch (err) {
      event(`Could not remove the checkpoint of ${id} (${String(err?.message ?? err).slice(0, 200)}).`, 'warn', slot);
    }
  }

  // Writes the session's record to runs/ and adds it to the run's totals. Returns the metrics
  // for the recent list. A failure here is an event, never the end of the supervisor. Each agent
  // that ran on another model family than its role is set to (settings(): the config with the local
  // settings, where the owner sets the models) is a warning and goes in the record; with
  // features.costMetrics off there are no agents, so there is no check.
  function recordRun({ slot, s, log, result, rounds, spans, learned, agents = null, cause, watchdog }) {
    try {
      // features.costMetrics off: no run record and no cost, but the run's counts still go up.
      if (!recordsRuns(settings())) {
        addToTotals(DIR, { story: s.id, result });
        clearSpans(DIR, slot);
        return {};
      }
      const mismatches = Array.isArray(agents) ? modelMismatches(agents, roleModels(settings())) : [];
      for (const m of mismatches) event(`${s.id}: ${m.text}; check the role's model with \`foreman settings list --group models\` and run \`foreman doctor\`.`, 'warn', slot);
      const record = runRecord({ story: s.id, slot, result, log, startedAt: new Date(s.startedAt), endedAt: now(), rounds, spans, stages: STAGE_OF, findings: readFindingsLines(DIR), learned, agents, cause, modelMismatches: mismatches, watchdog });
      writeRun(DIR, record);
      addToTotals(DIR, record);
      clearSpans(DIR, slot);
      return { costUsd: record.costUsd, minutes: record.minutes };
    } catch (err) {
      event(`Could not record what ${s.id} cost (${String(err?.message ?? err).slice(0, 200)}).`, 'warn', slot);
      return {};
    }
  }

  // The ended session's projects folder: its entry's, else (adopted) its own mark's, else ours.
  function projectsOf(slot, s) {
    if (typeof s.projects === 'string') return s.projects;
    return markedProjects(readMark(DIR, slot), s.log) ?? claudeProjectsDir(process.env);
  }

  // The slot's mark, once the session's ending is handled; only that session's, never a newer one's.
  function forgetMark(slot, s) {
    try {
      if (readMark(DIR, slot)?.log === s.log) unmarkSession(DIR, slot);
    } catch (err) {
      event(`Could not clear the mark of the session files of ${s.id} (${String(err?.message ?? err).slice(0, 200)}).`, 'warn', slot);
    }
  }

  // At start: the files of sessions whose ending no supervisor handled (see the header).
  const sweepLeftSessionFiles = guarded('the session files sweep', () => {
    const swept = sweepSessionFiles({ dir: DIR, skip: [...sessions.keys()], alive: (m) => sessionAlive({ pid: m.pid, id: m.id }) });
    for (const e of swept) {
      if (e.removed.length) event(`Removed the session files of ${e.story} (${e.slot}), left when its session ended unread: ${e.removed.join(', ')}`, 'info', e.slot);
      if (e.kept.length) event(`Kept the session files of ${e.story} (it ended in an interrupt): ${e.kept.join(', ')}`, 'warn', e.slot);
      if (e.error) event(`Could not clear the session files of ${e.story} (${String(e.error).slice(0, 200)}).`, 'warn', e.slot);
    }
  });

  // The check runs (`foreman checks --start`, engine/check-jobs.mjs) that `keep` does not name are
  // ended, whole process group, SIGTERM then SIGKILL after 10 s as killSession does: a detached run
  // is outside its session's group. `say` words the event from the ids.
  function endLeftCheckJobs(keep, say, slot) {
    const { ended } = endCheckJobs(DIR, { keep });
    if (!ended.length) return;
    event(say(ended.map((j) => j.id).join(', ')), 'info', slot);
    for (const j of ended)
      setTimeout(() => {
        // Only if it is still that run's group: its pid may have gone to another program since.
        killLeftGroup(j);
      }, 10_000).unref();
  }

  const endSlotCheckJobs = guarded('the check runs clean-up', (slot) => {
    endLeftCheckJobs((j) => j.slot !== slot, (ids) => `Slot ${slot}: ended the check run(s) ${ids} its session left running.`, slot);
  });

  // At start: the runs of sessions that had ended before (see the header). A run of no slot is kept.
  const sweepLeftCheckJobs = guarded('the check runs sweep', () => {
    endLeftCheckJobs((j) => !j.slot || sessions.has(j.slot), (ids) => `Ended the check run(s) ${ids} left running by sessions that had ended.`);
  });
  return { takeSpans, saveCheckpoint, dropCheckpoint, recordRun, projectsOf, forgetMark, sweepLeftSessionFiles, endLeftCheckJobs, endSlotCheckJobs, sweepLeftCheckJobs };
}
