// `foreman decide`: what waits on the owner, through the project's console. The files console
// (and the dashboard) keep it in <stateDir>/decisions through lib/console/decisions.mjs; the
// artifacts console queues adds and applies for its next push and is answered on its page. The
// story skill adds items and applies the answers; the owner answers here (or on the dashboard).
//
//   decide add --story <id> --kind decision|task --title <t> [--option <o>]... [--urgent] [--body <text>]
//              [--summary <t>] [--hint <h>]... [--recommend <option>]
//              [--purpose <t> --happened <t> [--damage <t>] --recommendation <t>]
//                                       prints the new item's id; the hints pair with --option by
//                                       position, one per option or none. A task always offers
//                                       "Retry the story" and "Close the task" (with their hints)
//                                       and takes no --option or --hint. The last four are the
//                                       plain-words explanation (decisions.mjs explain); a file
//                                       path, variable name or function call in it is a
//                                       `warning:` line on stderr and a warn event, and the item
//                                       is still added; a --body that is a ship JSON line (the story
//                                       skill passes one) is stored as its reason and pull request
//                                       (engine/halt-reason.mjs shipLineBody), never as the object
//   decide pending                      JSON array of items not yet applied, each with its answer or null
//   decide list [--all]                 the open items in words, grouped as the Waiting on you
//                                       tab groups them: Needs you now, Quick decisions (each
//                                       bundle with the command that answers it whole), FYI (the
//                                       dependency notes and learned changes Foreman made itself,
//                                       Undo | Keep, Undo the change | Keep the change), then
//                                       Answered, not yet applied; with --all every item, flat
//   decide answer <item> <option-or-text> [--note <t>]
//   decide answer --bundle follow-ups|traits <option>
//                                       answers every unanswered item in the bundle with the
//                                       option (lib/console/bundles.mjs answerBundle)
//   decide applied <item>
//
// After an add or an answer it posts the notes that queued for the stories (engine/story-notes.mjs):
// the question, and the answer. It prints nothing for them and a failure never fails the command.

import { parseArgs } from 'node:util';
import { answerBundle, BUNDLES, bundleMessage } from '../../console/bundles.mjs';
import { bundleOf, isFyiNote } from '../../console/waiting.mjs';
import { openConsole } from '../../engine/console.mjs';
import { EXPLAIN_PARTS, explainLine, explainProblems } from '../../console/decisions.mjs';
import { shipLineBody } from '../../engine/halt-reason.mjs';
import { addEvent, ownerWaiting } from '../../engine/state.mjs';
import { flushStoryNotes } from '../../engine/story-notes.mjs';
import { openProject, STORY_ID } from './console-shared.mjs';

const USAGE = `usage: foreman decide <sub>
  add --story <id> --kind decision|task --title <t> [--option <o>]... [--urgent] [--body <text>]
      [--summary <t>] [--hint <h>]... [--recommend <option>]
      [--purpose <t> --happened <t> [--damage <t>] --recommendation <t>]
                                           one --hint per --option, in the same order, or none; a task
                                           always offers "Retry the story" and "Close the task", so
                                           give it no --option or --hint;
                                           the explanation in plain words, each part one line
  pending                                  items not yet applied, as JSON
  list [--all]                             open items grouped, or every item with --all
  answer <item> <option-or-text> [--note <t>]
  answer --bundle follow-ups|traits <option>
                                           answers every unanswered item in the bundle
  applied <item>
`;

const OPTIONS = {
  story: { type: 'string' },
  kind: { type: 'string' },
  title: { type: 'string' },
  option: { type: 'string', multiple: true },
  urgent: { type: 'boolean' },
  body: { type: 'string' },
  note: { type: 'string' },
  summary: { type: 'string' },
  hint: { type: 'string', multiple: true },
  recommend: { type: 'string' },
  purpose: { type: 'string' },
  happened: { type: 'string' },
  damage: { type: 'string' },
  recommendation: { type: 'string' },
  all: { type: 'boolean' },
  bundle: { type: 'string' },
};

function stateOf(item) {
  if (item.appliedAt) return 'applied';
  if (item.answer) return `answered: ${item.answer.option ?? item.answer.note}`;
  return 'waiting';
}

const isText = (v) => typeof v === 'string' && v.trim() !== '';

// The head line, the summary, the explanation's parts as labelled lines, then the options: on
// one line when nothing more is known about them, else one per line with (recommended) and each
// option's hint under it, headed "Your options:" when the item is explained.
function describeItem(item) {
  const lines = [`${item.id}  ${item.urgent ? 'URGENT ' : ''}${item.kind} for ${item.story}: ${item.title}  [${stateOf(item)}]`];
  if (isText(item.summary)) lines.push(`    ${item.summary}`);
  const explained = item.explain !== null && typeof item.explain === 'object';
  if (explained) for (const part of EXPLAIN_PARTS) if (isText(item.explain[part])) lines.push(`    ${explainLine(part, item.explain[part])}`);
  const hints = Array.isArray(item.hints) ? item.hints : [];
  if (item.options.length && !explained && !hints.length && !isText(item.recommend)) lines.push(`    options: ${item.options.join(' | ')}`);
  else if (item.options.length) {
    lines.push(explained ? '    Your options:' : '    options:');
    item.options.forEach((o, i) => {
      lines.push(`      - ${o}${o === item.recommend ? ' (recommended)' : ''}`);
      if (isText(hints[i])) lines.push(`          ${hints[i]}`);
    });
  }
  return lines.join('\n');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const BUNDLE_NOUN = { 'follow-ups': ['follow-up', 'follow-ups'], traits: ['trait proposal', 'trait proposals'] };

// The open items (not yet applied) in groups, each only when it has something: the unanswered
// ones in the tab's order (`rank`, the ids of ownerWaiting's list; others after, oldest first),
// split into Needs you now, Quick decisions and FYI (the dependency notes and learned changes),
// then the answered ones.
function describeOpen(items, rank) {
  const open = items.filter((i) => !i.appliedAt);
  if (!items.length) return 'Nothing has been asked of you.\n';
  if (!open.length) {
    return `Nothing waits on you. \`foreman decide list --all\` shows the ${items.length === 1 ? 'one' : items.length} answered before.\n`;
  }
  const place = (i) => (rank.has(i.id) ? rank.get(i.id) : rank.size);
  const unanswered = open.filter((i) => !i.answer).map((i, n) => ({ i, n })).sort((a, b) => place(a.i) - place(b.i) || a.n - b.n).map(({ i }) => i);
  const lines = [];
  const needs = unanswered.filter((i) => !bundleOf(i) && !isFyiNote(i));
  if (needs.length) lines.push(`Needs you now (${needs.length}):`, ...needs.map(describeItem));
  const bundles = new Map();
  for (const i of unanswered.filter((i) => bundleOf(i))) bundles.set(bundleOf(i), [...(bundles.get(bundleOf(i)) ?? []), i]);
  if (bundles.size) {
    lines.push(`Quick decisions (${bundles.size}):`);
    for (const [name, list] of bundles) {
      const options = BUNDLES[name];
      lines.push(`  ${plural(list.length, ...BUNDLE_NOUN[name])} · answer all: foreman decide answer --bundle ${name} "${options['create-all']}" (or "${options['ignore-all']}" to drop them all)`, ...list.map(describeItem));
    }
  }
  const notes = unanswered.filter(isFyiNote);
  if (notes.length) lines.push(`FYI (${notes.length}):`, ...notes.map(describeItem));
  const answered = open.filter((i) => i.answer);
  if (answered.length) lines.push(`Answered, not yet applied (${answered.length}):`, ...answered.map(describeItem));
  return `${lines.join('\n')}\n`;
}

export default {
  name: 'decide',
  summary: 'what waits on the owner (decide add|pending|list|answer|applied)',

  async run(args, { root, env, stdout, stderr, now }) {
    const fail = (line) => {
      stderr.write(line.endsWith('\n') ? line : `${line}\n`);
      return 1;
    };
    const [sub, ...rest] = args;
    if (!['add', 'pending', 'list', 'answer', 'applied'].includes(sub)) return fail(USAGE);
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
      return fail(`${err.message}\n${USAGE}`);
    }
    const { values, positionals } = parsed;
    if (values.bundle !== undefined && sub !== 'answer') return fail(USAGE);
    if (values.all !== undefined && sub !== 'list') return fail(USAGE);
    const project = openProject({ root, env, stderr });
    if (!project) return 1;
    const clock = (now ?? (() => new Date()))();
    const flush = () => {
      try {
        flushStoryNotes({ dir: project.dir, config: project.config, root, env, now: () => clock });
      } catch {
        // a note on the story is never worth failing the command
      }
    };

    try {
      const { decisions } = openConsole({ config: project.config, ctx: { stateDir: project.dir, now: () => clock } });
      if (sub === 'add') {
        if (!values.story || !values.kind || !values.title) return fail(USAGE);
        if (!STORY_ID.test(values.story)) return fail(`${values.story} is not a story id.`);
        const given = EXPLAIN_PARTS.filter((part) => values[part] !== undefined);
        const explain = given.length ? Object.fromEntries(given.map((part) => [part, values[part]])) : undefined;
        const body = shipLineBody(values.body ?? '') ?? (values.body ?? '');
        const id = await decisions.add({ story: values.story, kind: values.kind, title: values.title, options: values.option ?? [], urgent: values.urgent === true, body, summary: values.summary, hints: values.hint ?? [], recommend: values.recommend, explain });
        stdout.write(`${id}\n`);
        flush();
        // The writing check: the skill learns to write plainer, and the item stands.
        for (const problem of explainProblems(explain).filter((p) => p.kind !== 'long')) {
          stderr.write(`warning: ${problem.message}\n`);
          try {
            addEvent(project.dir, `${values.story}: ${problem.message}`, 'warn', clock, env?.FOREMAN_SLOT || null);
          } catch {
            // the event log is a courtesy; the item is added
          }
        }
        return 0;
      }
      if (sub === 'pending') {
        stdout.write(`${JSON.stringify(await decisions.pending(), null, 2)}\n`);
        return 0;
      }
      if (sub === 'list') {
        const items = await decisions.list();
        if (values.all) {
          stdout.write(items.length ? `${items.map(describeItem).join('\n')}\n` : 'Nothing has been asked of you.\n');
          return 0;
        }
        const ranked = items.some((i) => !i.appliedAt && !i.answer) ? (await ownerWaiting(project.dir, clock, { root, env, slots: project.config.slots })).items : [];
        stdout.write(describeOpen(items, new Map(ranked.map((w, n) => [w.id, n]))));
        return 0;
      }
      if (sub === 'answer' && values.bundle !== undefined) {
        if (positionals.length !== 1 || values.note !== undefined) return fail(USAGE);
        const adapter = project.config.console?.adapter;
        // A console that keeps its decisions elsewhere answers them there; its answer() says where.
        if (adapter && adapter !== 'dashboard' && adapter !== 'files') await decisions.answer();
        const name = values.bundle;
        if (!Object.hasOwn(BUNDLES, name)) return fail(`Unknown bundle; one of ${Object.keys(BUNDLES).join(', ')}.`);
        const [text] = positionals;
        const action = Object.entries(BUNDLES[name]).find(([, o]) => o === text)?.[0];
        if (!action) return fail(`"${text}" is not an answer for ${name}; one of ${Object.values(BUNDLES[name]).map((o) => `"${o}"`).join(', ')}.`);
        const result = answerBundle(project.dir, name, action, clock);
        flush();
        stdout.write(`${[bundleMessage(result), ...result.answered.map((a) => `  ${a} answered: ${text}`)].join('\n')}\n`);
        for (const f of result.failed) stderr.write(`  ${f.id}: ${f.error}\n`);
        return result.failed.length ? 1 : 0;
      }
      const [id, text] = positionals;
      if (sub === 'answer') {
        if (!id || text === undefined) return fail(USAGE);
        const given = await decisions.answer(id, { option: text, note: values.note });
        flush();
        stdout.write(`${id} answered: ${given.option ?? given.note}\n`);
        return 0;
      }
      if (!id) return fail(USAGE);
      await decisions.applied(id);
      stdout.write(`${id} marked applied.\n`);
      return 0;
    } catch (err) {
      return fail(err.message);
    }
  },
};
