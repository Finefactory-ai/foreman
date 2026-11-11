// `foreman story <sub>`: every change to a story note and to the story's place in the
// command centre goes through here, so the build session never edits either by hand.
// For stories kept inside the repo the changes go to the state folder, and `finalize` marks
// the story done in the current checkout so the story's own commit carries it.
//
// Each change carries the event a story source may act on: start raises
// `started`, block `blocked`, done `shipped`, and `end failed` raises `failed` on the story
// it names (--story, else the slot's story). A Jira source comments and moves the issue; the
// markdown source ignores events.
//
// A start run again by the same session (same slot, same story, and the log the slot's session
// mark names) changes nothing and raises no event.
//
// `end ready-to-promote` records a release that finishes later (`foreman ship` exit 9). The
// ship command has already saved the park, marked the story and told its source, so end only
// frees the slot. It needs that park (or the story already done, the park watch having
// finished it): without it the end counts as failed and the command exits 1.
//
// `note <id> --kind design --file <plan file>` records the architect's design on the story itself,
// as a comment when features.jiraComments is on, or salesforceComments for a Case
// (engine/story-notes.mjs): the plan file is read, the design is worded for a person, and a design already recorded is not recorded again. A plan that
// changed since is recorded as a revision that lists only what changed. Kinds other than design are
// usage (64); a file that cannot be read, or holds no design, exits 1. With comments off it says so
// and exits 0.
//
// `depend` is how a dependency the architect asks for is applied at once, when
// features.autoApplyDependsOn is on: the ids join the story's depends_on (for Jira, "is blocked
// by" links), the story goes back to todo, and the owner is told with a decision titled
// "<ID> now waits for <ids>" whose Undo and Keep the supervisor applies (engine/answers.mjs) and
// Waiting on you shows as FYI. With the switch off it refuses and changes nothing.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadResolved } from '../../settings/load.mjs';
import { currentSlot, stateDir } from '../../engine/paths.mjs';
import { buildOrder, nextStory } from '../../engine/pick.mjs';
import { commentSwitch, doneChange, openStorySource } from '../../engine/story-source.mjs';
import { addEvent, endStory, readSlot, startStory } from '../../engine/state.mjs';
import { openConsole } from '../../engine/console.mjs';
import { readMark } from '../../engine/session-files.mjs';
import { confirmedResult, READY, readPark, UNPARKED } from '../../engine/parks.mjs';
import { noteOnStory } from '../../engine/story-notes.mjs';
import { designData } from '../../engine/story-notes-queue.mjs';
import { rolledBackAtOf } from '../../engine/resume-close.mjs';
import { packFor } from '../../../packs/index.mjs';

const EXIT_FAILED = 1;
const EXIT_USAGE = 64;
const RESULTS = ['shipped', 'ready-to-promote', 'blocked', 'failed', 'halted', 'deferred', 'held', 'empty'];

const USAGE = `usage: foreman story <sub>
  next [--id X] [--strict] [--skip a,b]   print the next story as one line of JSON
  plan                                    show the build order
  start <id>                              mark a story in-progress (again in the same session: no change)
  block <id> --reason <text>              mark a story blocked
  done <id> --note <text>                 mark a story done
  finalize <id> --note <text>             mark a story done in this checkout, for its commit
  todo <id> --note <text>                 put a story back to todo
  summary <id>                            print where the story's group summary goes, as one line of JSON
  set <id> --depends-on <ids>             replace a story's depends_on list (ids, comma-separated)
  depend <id> --on <ids> --reason <text>  add depends_on ids at once and tell the owner (features.autoApplyDependsOn)
  end <result> [pr] [reason...] [--findings <file>] [--story <id>] [--builder <name>] [--cause story|environment]
                                          record how the story ended (${RESULTS.join('|')})
  note <id> --kind design --file <plan>   record the architect's design on the story (features.jiraComments, or salesforceComments for Cases)
`;

const OPTIONS = {
  id: { type: 'string' },
  strict: { type: 'boolean' },
  skip: { type: 'string' },
  reason: { type: 'string' },
  note: { type: 'string' },
  findings: { type: 'string' },
  story: { type: 'string' },
  builder: { type: 'string' },
  cause: { type: 'string' },
  'depends-on': { type: 'string' },
  on: { type: 'string' },
  kind: { type: 'string' },
  file: { type: 'string' },
};

const dateOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Why `id` cannot depend on `ids`, as the line set and depend print, or null: an id that is
// malformed or not a story, the story itself, or a cycle (the story can already be reached from
// one of the new dependencies).
function dependsProblem(stories, id, ids, idPattern) {
  const isId = new RegExp(`^(?:${idPattern})$`);
  const bad = ids.filter((d) => !isId.test(d) || !stories.some((s) => s.id === d));
  if (bad.length) return `no such story: ${bad.join(', ')}`;
  if (ids.includes(id)) return `${id} cannot depend on itself`;
  const depsOf = new Map(stories.map((s) => [s.id, s.dependsOn ?? []]));
  const seen = new Set();
  const stack = [...ids];
  while (stack.length) {
    const next = stack.pop();
    if (next === id) return `that would make a cycle: ${id} is already needed by ${ids.join(', ')}`;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(depsOf.get(next) ?? []));
  }
  return null;
}

// The FYI's one-line summary: whitespace collapsed, and over 160 characters cut at the last
// space before 159, with "…".
function summaryOf(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= 160) return line;
  const space = line.lastIndexOf(' ', 158);
  return `${line.slice(0, space > 0 ? space : 159)}…`;
}

function readFindings(file, stderr) {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('not a JSON array');
    return list;
  } catch (err) {
    stderr.write(`warning: findings not recorded (${file}): ${err.message}\n`);
    return [];
  }
}

// The key of the session that runs `start` for `id` in `slot`: the name of the log its session mark
// names. Null outside a story session, or when the mark is for another story or names no log.
function sessionKey(env, dir, slot, id) {
  if (env?.FOREMAN_RUN !== '1') return null;
  const mark = readMark(dir, slot);
  if (mark?.story !== id || typeof mark.log !== 'string' || !mark.log) return null;
  return basename(mark.log);
}

export default {
  name: 'story',
  summary: 'read and change stories (story next|plan|start|block|done|finalize|todo|summary|set|depend|end|note)',

  async run(args, { root, cwd, env, stdout, stderr, now }) {
    const [sub, ...rest] = args;
    if (!['next', 'plan', 'start', 'block', 'done', 'finalize', 'todo', 'summary', 'set', 'depend', 'end', 'note'].includes(sub)) {
      stderr.write(USAGE);
      return EXIT_USAGE;
    }
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const { values: v, positionals: pos } = parsed;
    const clock = now ?? (() => new Date());

    const { config, errors } = loadResolved(root, { env });
    if (errors.length) {
      for (const { path, message } of errors) stdout.write(path ? `${path}: ${message}\n` : `${message}\n`);
      return EXIT_FAILED;
    }
    const dir = stateDir(root, config, env);
    const slot = currentSlot(env);
    const today = dateOf(clock());

    if (sub === 'end') {
      let [result, pr = '', ...reason] = pos;
      if (!RESULTS.includes(result)) {
        stderr.write(`result must be one of ${RESULTS.join('|')}\n`);
        return EXIT_USAGE;
      }
      if (v.cause !== undefined && v.cause !== 'story' && v.cause !== 'environment') {
        stderr.write('--cause must be story or environment\n');
        return EXIT_USAGE;
      }
      if (v.cause !== undefined && result !== 'failed') {
        stderr.write('--cause goes only with failed\n');
        return EXIT_USAGE;
      }
      const current = readSlot(dir, slot).story?.id;
      const story = v.story ?? current ?? '';
      let refused = false;
      if (result === READY) {
        // Trusted only with the park `foreman ship` saved, or the story already done.
        const park = story ? readPark(dir, story) : null;
        let status = null;
        if (!park && story) {
          try {
            const source = openStorySource({ root, config, now: clock, env });
            status = (await source.list()).find((s) => s.id === story)?.status ?? null;
          } catch {
            // an unreadable story source leaves the claim unconfirmed
          }
        }
        result = confirmedResult(result, { park, status });
        if (result !== READY) {
          refused = true;
          stderr.write(story ? `end: no release is parked for ${story}; recording it as failed\n` : 'end: no story id is known (no --story and no story in this slot), so no release is parked; recording it as failed\n');
          reason = [UNPARKED];
        }
      }
      const at = clock();
      try {
        endStory(dir, result, pr, reason.join(' '), at, slot, { cause: v.cause });
      } catch (err) {
        stderr.write(`end: ${err.message}\n`);
      }
      if (result === 'failed' && story) {
        // The story source hears of it too; a problem there never fails the command.
        const why = reason.join(' ').trim();
        try {
          const source = openStorySource({ root, config, now: clock, env });
          if (!(await source.update(story, { note: why ? `Failed: ${why}` : 'Failed.', event: 'failed' }))) stderr.write(`warning: the story source does not know ${story}\n`);
        } catch (err) {
          stderr.write(`warning: the story source was not told ${story} failed: ${err.message}\n`);
        }
      }
      if (v.findings) {
        const list = readFindings(v.findings, stderr);
        if (list.length) {
          try {
            mkdirSync(dir, { recursive: true });
            const builder = v.builder?.trim() ? { builder: v.builder.trim() } : {};
            const lines = list.map((f) => `${JSON.stringify({ at: at.toISOString(), story, result, ...f, ...builder })}\n`);
            appendFileSync(join(dir, 'findings.jsonl'), lines.join(''));
          } catch (err) {
            stderr.write(`warning: findings not recorded: ${err.message}\n`);
          }
        }
      }
      return refused ? EXIT_FAILED : 0;
    }

    if (sub === 'note') {
      const [id] = pos;
      if (!id || v.file === undefined || v.kind !== 'design') {
        stderr.write(`note needs a story id, --kind design and --file <plan file>\n${USAGE}`);
        return EXIT_USAGE;
      }
      let plan;
      try {
        plan = JSON.parse(readFileSync(resolve(cwd ?? root, v.file), 'utf8'));
      } catch (err) {
        stderr.write(`note: cannot read the plan ${v.file}: ${err.message}\n`);
        return EXIT_FAILED;
      }
      if (plan === null || typeof plan !== 'object' || Array.isArray(plan) || typeof plan.design !== 'string') {
        stderr.write(`note: ${v.file} is not an architect's plan (it has no design text)\n`);
        return EXIT_FAILED;
      }
      const status = noteOnStory({ root, config, env, now: clock }, id, 'design', designData(plan));
      const said = {
        posted: `Recorded the design on ${id}.`,
        revised: `Recorded the revised design on ${id}.`,
        repeat: `The design on ${id} is already recorded.`,
        queued: `Queued the design on ${id}; it is recorded once the process flushing the notes is done.`,
        off: `Comments are off (features.${commentSwitch(config)}); nothing recorded.`,
      };
      if (Object.hasOwn(said, status)) {
        stdout.write(`${said[status]}\n`);
        return 0;
      }
      stderr.write(status === 'unknown' ? `note: the story source does not know ${id}\n` : `note: could not record the design on ${id}; it stays queued\n`);
      return EXIT_FAILED;
    }

    // The ids depend was given, worked out once: an --on of only commas and spaces holds none.
    const onIds = [...new Set((v.on ?? '').split(/[\s,]+/).filter(Boolean))];
    if (sub === 'depend') {
      // Before the story source is opened, so a refusal writes nothing.
      if (config.features?.autoApplyDependsOn !== true) {
        stderr.write('features.autoApplyDependsOn is off: ask the owner with a decision instead.\n');
        return EXIT_FAILED;
      }
      if (!pos[0] || !onIds.length || !v.reason?.trim()) {
        stderr.write('depend needs --on <ids> and --reason <text>\n');
        return EXIT_USAGE;
      }
    }

    let source;
    let stories;
    try {
      source = openStorySource({ root, config, now: clock, env });
      stories = await source.list();
    } catch (err) {
      stderr.write(`${err.message}\n`);
      return EXIT_FAILED;
    }
    const idPattern = source.idPattern;

    if (sub === 'next') {
      const skip = v.skip ? v.skip.split(',').filter(Boolean) : [];
      const picked = nextStory(stories, { id: v.id, strict: v.strict, skip, idPattern });
      let out = picked ?? { none: true };
      if (picked) {
        // Its pull request may have merged before its release was rolled back; the skill reads this.
        let pack = null;
        try {
          pack = packFor(config);
        } catch {
          // no pack, no rollback record
        }
        const rolledBackAt = rolledBackAtOf(pack, { dir, story: picked.id });
        if (rolledBackAt !== null) out = { ...picked, rolledBackAt };
      }
      stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }

    if (sub === 'plan') {
      const { order, waiting, ownerTasks } = buildOrder(stories, { idPattern });
      const lines = [`The factory can build ${order.length} stories, in this order:`, `  ${order.join(' ')}`];
      lines.push('', `${waiting.length} open stories it cannot reach yet:`);
      for (const w of waiting) lines.push(`  ${w.id}  waits on: ${w.on.join('; ')}`);
      lines.push('', `${ownerTasks.length} open owner tasks:`);
      for (const t of ownerTasks) lines.push(`  ${t.id}  ${t.title}`);
      stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }

    // start | block | done | finalize | todo: all take a story id
    const id = pos[0];
    const found = stories.find((s) => s.id === id);
    if (!id || !found) {
      stderr.write(id ? `no such story: ${id}\n` : `usage: foreman story ${sub} <id>\n`);
      return id ? EXIT_FAILED : EXIT_USAGE;
    }
    if (sub === 'summary') {
      const info = found.group ? await source.groupSummary?.(found.group) : null;
      if (!info) {
        stdout.write(`${JSON.stringify({ none: true })}\n`);
        return 0;
      }
      const members = stories.filter((s) => s.group === found.group && s.status !== 'retired').map((s) => ({ id: s.id, title: s.title }));
      stdout.write(`${JSON.stringify({ group: found.group, groupName: found.groupName, groupLabel: source.groupLabel, path: info.path, needed: info.needed, stories: members })}\n`);
      return 0;
    }
    if (sub === 'set') {
      if (v['depends-on'] === undefined) { stderr.write('set needs --depends-on <ids>\n'); return EXIT_USAGE; }
      const ids = [...new Set(v['depends-on'].split(',').map((s) => s.trim()).filter(Boolean))];
      const problem = dependsProblem(stories, id, ids, idPattern);
      if (problem) { stderr.write(`${problem}\n`); return EXIT_FAILED; }
      try {
        await source.update(id, { fields: { dependsOn: ids } });
      } catch (err) {
        stderr.write(`${err.message}\n`);
        return EXIT_FAILED;
      }
      stdout.write(`${id} depends on: ${ids.length ? ids.join(', ') : '(nothing)'}\n`);
      return 0;
    }
    if (sub === 'depend') {
      const ids = onIds;
      const problem = dependsProblem(stories, id, ids, idPattern);
      if (problem) { stderr.write(`${problem}\n`); return EXIT_FAILED; }
      const current = found.dependsOn ?? [];
      const added = ids.filter((d) => !current.includes(d));
      if (!added.length) {
        stdout.write(`${id} already waits for ${ids.join(', ')}; nothing changed.\n`);
        return 0;
      }
      const reason = v.reason;
      const waits = `${id} now waits for ${added.join(', ')}`;
      try {
        await source.update(id, { status: 'todo', fields: { dependsOn: [...current, ...added] }, note: `Now waits for ${added.join(', ')}: ${reason}` });
      } catch (err) {
        stderr.write(`${err.message}\n`);
        return EXIT_FAILED;
      }
      let itemId;
      try {
        const { decisions } = openConsole({ config, ctx: { stateDir: dir, now: clock } });
        itemId = await decisions.add({
          story: id,
          kind: 'decision',
          title: waits,
          summary: summaryOf(`${waits}: ${reason}`),
          body: reason,
          options: ['Undo', 'Keep'],
          hints: ['Takes the dependency off again, so the story no longer waits for it.', 'Keeps the dependency and clears this note.'],
        });
      } catch (err) {
        stderr.write(`${waits}, but the owner was not told: ${err.message}\n`);
        return EXIT_FAILED;
      }
      try {
        addEvent(dir, `${waits} (added by Foreman; Undo on Waiting on you)`, 'info', clock(), slot);
      } catch {
        // the event log is a courtesy; the dependency is recorded
      }
      stdout.write(`${waits}. Told the owner: ${itemId}.\n`);
      return 0;
    }
    if (sub === 'finalize') {
      if (!v.note) { stderr.write('finalize needs --note <text>\n'); return EXIT_USAGE; }
      try {
        const { path } = typeof source.finalize === 'function' ? await source.finalize(id, { note: v.note, cwd: cwd ?? root }) : { path: null };
        stdout.write(path ? `${path}\n` : 'nothing to change for this story source\n');
        return 0;
      } catch (err) {
        stderr.write(`finalize: ${err.message}\n`);
        return EXIT_FAILED;
      }
    }
    const session = sub === 'start' ? sessionKey(env, dir, slot, id) : null;
    if (session) {
      const cur = readSlot(dir, slot).story;
      if (cur?.id === id && cur.session === session) return 0;
    }
    let change;
    if (sub === 'start') change = { status: 'in-progress', fields: { started: today }, note: 'Started.', event: 'started' };
    else if (sub === 'block') {
      if (!v.reason) { stderr.write('block needs --reason <text>\n'); return EXIT_USAGE; }
      change = { status: 'blocked', fields: { blockedBy: v.reason }, note: `Blocked: ${v.reason}`, event: 'blocked' };
    } else if (sub === 'done') {
      if (!v.note?.trim()) { stderr.write('done needs --note <text>\n'); return EXIT_USAGE; }
      change = doneChange(v.note, clock());
    } else {
      if (!v.note) { stderr.write('todo needs --note <text>\n'); return EXIT_USAGE; }
      change = { status: 'todo', note: v.note };
    }
    try {
      await source.update(id, change);
    } catch (err) {
      stderr.write(`${err.message}\n`);
      return EXIT_FAILED;
    }
    if (sub === 'start') {
      try {
        startStory(dir, { id, title: found.title, phase: found.group, phaseName: found.groupName, ...(session ? { session } : {}) }, clock(), slot);
      } catch (err) {
        stderr.write(`warning: start not recorded in state: ${err.message}\n`);
      }
    }
    return 0;
  },
};
