// `foreman report [--since YYYY-MM-DD] [--tokens] [--json]`: what the story sessions cost and
// how long they took, per day and per result, from the records in <stateDir>/runs/
// (run-record.mjs). Days are UTC, by when the session ended. A session that died before Claude
// reported its cost counts toward time but not cost, and the total says how many there were.
// Each day ends with its sessions' average first-turn context ("first turn 21.1 k") and the
// total says the average over all of them, counting only the sessions whose record has it
// (older records do not); --json carries it as firstTurnTokens, null when none has it.
//
// --tokens prints the tokens each agent role used instead (engine/token-report.mjs tokenView:
// today, 7 days, this run and the last 14 days per role, a line per story and the hints), and
// with --json the view itself. The plain report ends with that section when there are token
// counts.
//
// The plain report also has a Learning section, after the totals (or the "No story sessions"
// line) and before Tokens, when there is learning to count (engine/learning-health.mjs
// learningTotals): the learner's calls and spend from <stateDir>/learner.jsonl, and the learned
// changes added, kept, rolled back, retired and undone from <stateDir>/learning.jsonl, from
// --since on. An unreadable learning.jsonl counts as no changes; `foreman doctor` warns about it.
// Its --json is the summary, with those totals under `learning` when there are any.
//
// A Watchdog section comes after the totals and before Learning when the watchdog stopped any
// session from --since on (engine/run-record.mjs watchdogTotals): the stories and sessions it
// stopped, how many at the hard limit, and the work done again, in tokens and agent time. A
// stopped session never reports its cost, so the redone work is measured in tokens and time,
// not dollars. --json carries the totals under `watchdog` then.
//
// An Environment endings section comes after Watchdog and before Learning when any failed session
// from --since on said the environment ended it (`foreman story end failed --cause environment`,
// run-record.mjs environmentTotals): how many, out of the failed sessions, and which stories. The
// learning evaluation leaves those runs out, so a count that keeps growing is worth a look. --json
// carries it under `environment`.
//
// After Learning and before Tokens comes a Checks section when any story has full-suite check
// lines in <stateDir>/check-runs.jsonl (engine/check-runs.mjs checkTotals), also when there are
// no sessions: per story, the real full-suite runs, their minutes, the quick runs (a run of a
// check's `quick` command, counted apart from the full-suite runs and shown only when there are
// some) with their minutes, the reuses of a record, the
// waits on a run in progress in another slot (a reuse that waited, shown only when there are
// some) and, when the story has run records, its build rounds, and the hand runs of a check the
// Bash guard denied (the story session ran the check's command itself instead of `foreman
// checks`), from --since on. --json adds them under `checks` when there are any, with `quickRuns`,
// `quickMinutes`, `waited` and `denied` in each entry.
//
// A Models section comes after Checks and before Tokens when any session from --since on has
// agents that ran on another model family than their role is set to (run-record.mjs modelTotals,
// from the record's modelMismatches): a line per agent, "ACME-1  2026-10-15  test
// (foreman:tester) is set to Haiku but ran on Opus 5.5". --json adds them under `models`.
// `foreman doctor` warns about the last story session's mismatches. --tokens is unchanged.

import { checkTotals, readCheckRuns } from '../../engine/check-runs.mjs';
import { readLearnerCalls } from '../../engine/learner.mjs';
import { learningTotals } from '../../engine/learning-health.mjs';
import { readLedger } from '../../engine/learning-store.mjs';
import { environmentTotals, modelTotals, readFindingsLines, readRuns, summarise, watchdogTotals } from '../../engine/run-record.mjs';
import { readState } from '../../engine/state.mjs';
import { tokenView, units } from '../../engine/token-report.mjs';
import { openProject } from './console-shared.mjs';
import { dollars, duration } from './status.mjs';

const USAGE = 'usage: foreman report [--since YYYY-MM-DD] [--tokens] [--json]\n';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// learning.jsonl as report reads it: an unreadable ledger (a directory, no permission) counts as
// empty, so the report still prints, as it did before it read the ledger. The doctor warns about it.
function ledgerOrEmpty(dir) {
  try {
    return readLedger(dir);
  } catch {
    return [];
  }
}

function parseArgs(args) {
  const opts = { since: '', json: false, tokens: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') opts.json = true;
    else if (args[i] === '--tokens') opts.tokens = true;
    else if (args[i] === '--since' && /^\d{4}-\d{2}-\d{2}$/.test(args[i + 1] ?? '') && !Number.isNaN(Date.parse(args[i + 1]))) opts.since = args[++i];
    else return null;
  }
  return opts;
}

export function describeReport(summary) {
  const lines = ['Per day (UTC):'];
  for (const d of summary.days) {
    const first = typeof d.firstTurnTokens === 'number' ? `  first turn ${units(d.firstTurnTokens)}` : '';
    lines.push(`  ${d.day}  ${plural(d.sessions, 'session').padEnd(12)} ${plural(d.stories, 'story', 'stories').padEnd(11)} ${`${d.shipped} shipped`.padEnd(11)} ${dollars(d.costUsd).padStart(9)}  ${duration(d.minutes)}${first}`);
  }
  lines.push('By result:');
  const width = Math.max(...summary.results.map((r) => r.result.length));
  for (const r of summary.results) {
    lines.push(`  ${r.result.padEnd(width)}  ${plural(r.sessions, 'session').padEnd(12)} ${dollars(r.costUsd).padStart(9)}  ${duration(r.minutes)}`);
  }
  const t = summary.total;
  const unpriced = t.unpriced ? ` (${plural(t.unpriced, 'session')} without a cost)` : '';
  const first = typeof t.firstTurnTokens === 'number' ? `, first turn ${units(t.firstTurnTokens)} on average` : '';
  lines.push(`Total: ${plural(t.sessions, 'session')}, ${plural(t.stories, 'story', 'stories')}, ${t.shipped} shipped, ${dollars(t.costUsd)}, ${duration(t.minutes)}${first}${unpriced}`);
  return `${lines.join('\n')}\n`;
}

// The learning totals as text: the learner's calls and spend, then the learned changes.
export function describeLearning(t) {
  return `Learning\n  Learner: ${plural(t.calls, 'call')}, ${dollars(t.costUsd)}\n  Changes: ${t.added} added, ${t.kept} kept, ${t.rolledBack} rolled back, ${t.retired} retired, ${t.undone} undone\n`;
}

// The check totals as text: a line per story.
export function describeChecks(totals) {
  const width = Math.max(...totals.map((t) => t.story.length));
  const lines = totals.map((t) => {
    const rounds = t.rounds === null ? '' : `  ${plural(t.rounds, 'round')}`;
    const waited = t.waited > 0 ? `  ${t.waited} waited on a run in progress` : '';
    const denied = t.denied > 0 ? `  ${plural(t.denied, 'hand run')} denied` : '';
    const quick = t.quickRuns > 0 ? `  ${plural(t.quickRuns, 'quick run')}  ${duration(t.quickMinutes)}` : '';
    return `  ${t.story.padEnd(width)}  ${plural(t.fullRuns, 'full-suite run')}  ${duration(t.minutes)}${quick}  ${t.reused} reused${waited}${rounds}${denied}`;
  });
  return `Checks (per story)\n${lines.join('\n')}\n`;
}

// The watchdog's totals as text.
export function describeWatchdog(t) {
  return `Watchdog\n  Stopped: ${plural(t.stories, 'story', 'stories')}, ${plural(t.sessions, 'session')} (${t.ceiling} at the hard limit)\n  Redone work: ${units(t.redoneTokens)} tokens, ${duration(t.redoneMinutes)} of agent time\n`;
}

// The environment endings as text: how many failed sessions said so, and which stories.
export function describeEnvironment(t) {
  return `Environment endings\n  ${t.sessions} of ${plural(t.failed, 'failed session')} said the environment ended them: ${t.stories.join(', ')}. The learned-rule checks leave them out.\n`;
}

// The model mismatches as text: a line per agent that ran on another model than its role is set to.
export function describeModels(list) {
  const width = Math.max(...list.map((m) => m.story.length));
  return `Models (set and ran differ)\n${list.map((m) => `  ${m.story.padEnd(width)}  ${m.endedAt.slice(0, 10)}  ${m.text}`).join('\n')}\n`;
}

// The token view as text: the role table, each role's 7-day line, a line per story, the hints
// and how many sessions have no counts. Every number comes from the view already written.
// A role or story agent's label, with the models its sessions recorded when there are any.
const withModels = (x) => (x.modelsText ? `${x.label} (${x.modelsText})` : x.label);

export function describeTokens(view) {
  const head = ['role', 'today', '7 days', 'this run', 'last 14 days'];
  const rows = view.roles.map((r) => [r.label, r.todayText, r.weekText, r.runText, r.sparkText]);
  const width = (i) => Math.max(head[i].length, ...rows.map((r) => r[i].length));
  const cells = (r) => `  ${r[0].padEnd(width(0))}  ${r[1].padStart(width(1))}  ${r[2].padStart(width(2))}  ${r[3].padStart(width(3))}  ${r[4]}`;
  const lines = [cells(head), ...rows.map(cells)];
  if (view.roles.length) {
    lines.push('Last 7 days:');
    for (const r of view.roles) lines.push(`  ${withModels(r)}: ${r.weekLine}`);
  }
  if (view.stories.length) {
    lines.push('Per story (last 14 days):');
    const id = Math.max(...view.stories.map((s) => s.story.length));
    const size = Math.max(...view.stories.map((s) => s.totalText.length));
    for (const s of view.stories) lines.push(`  ${s.story.padEnd(id)}  ${s.totalText.padStart(size)}  ${s.agents.map((a) => `${withModels(a)} ${a.totalText}`).join(' · ')}`);
  }
  if (view.hints.length) {
    lines.push('Hints:');
    for (const h of view.hints) lines.push(`  - ${h.text}`);
  }
  if (view.unknown > 0) lines.push(`${plural(view.unknown, 'session')} without token counts`);
  return `${lines.join('\n')}\n`;
}

export default {
  name: 'report',
  summary: 'cost, time, full-suite check runs and tokens per agent of the story sessions (report [--since YYYY-MM-DD] [--tokens] [--json])',

  async run(args, { root, env, stdout, stderr, now }) {
    const opts = parseArgs(args);
    if (!opts) {
      stderr.write(USAGE);
      return 1;
    }
    const project = openProject({ root, env, stderr });
    if (!project) return 1;
    const runs = readRuns(project.dir);
    const tokens = () =>
      tokenView({
        runs,
        learner: readLearnerCalls(project.dir),
        findings: readFindingsLines(project.dir),
        now: typeof now === 'function' ? now() : new Date(),
        runSince: readState(project.dir).totals?.since ?? null,
        since: opts.since,
      });
    if (opts.tokens) {
      const view = tokens();
      if (opts.json) stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      else stdout.write(view.empty ? 'No token counts recorded yet.\n' : describeTokens(view));
      return 0;
    }
    const summary = summarise(runs, { since: opts.since });
    const learning = learningTotals({ ledger: ledgerOrEmpty(project.dir), calls: readLearnerCalls(project.dir), since: opts.since });
    const any = Object.values(learning).some((n) => n > 0);
    const watchdog = watchdogTotals(runs, { since: opts.since });
    const stopped = watchdog.sessions > 0;
    const environment = environmentTotals(runs, { since: opts.since });
    const claimed = environment.sessions > 0;
    const checks = checkTotals(readCheckRuns(project.dir), { since: opts.since, runs });
    const models = modelTotals(runs, { since: opts.since });
    if (opts.json) {
      stdout.write(`${JSON.stringify({ since: opts.since || null, ...summary, ...(stopped ? { watchdog } : {}), ...(claimed ? { environment } : {}), ...(any ? { learning } : {}), ...(checks.length ? { checks } : {}), ...(models.length ? { models } : {}) }, null, 2)}\n`);
      return 0;
    }
    const watched = stopped ? `\n${describeWatchdog(watchdog)}` : '';
    const claimedText = claimed ? `\n${describeEnvironment(environment)}` : '';
    const learned = any ? `\n${describeLearning(learning)}` : '';
    const checked = checks.length ? `\n${describeChecks(checks)}` : '';
    const modelled = models.length ? `\n${describeModels(models)}` : '';
    const view = tokens();
    const section = `${watched}${claimedText}${learned}${checked}${modelled}${view.empty ? '' : `\nTokens\n${describeTokens(view)}`}`;
    if (!summary.total.sessions) {
      stdout.write(`${opts.since ? `No story sessions recorded since ${opts.since}.\n` : 'No story sessions recorded yet.\n'}${section}`);
      return 0;
    }
    stdout.write(`${describeReport(summary)}${section}`);
    return 0;
  },
};
