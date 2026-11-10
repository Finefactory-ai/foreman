// The artifacts console. The owner watches and steers the run on two claude.ai artifact pages,
// a command centre and a decisions page.
//
//   publish(snapshot)   one push: the snapshot goes to the command centre, the page's controls
//                       come back to <stateDir>/control.json, queued decisions go to the
//                       decisions page, and every ten minutes that page is copied to
//                       <stateDir>/sync/decisions/{items,answers}/<id>.json
//   controls()          reads control.json
//   decisions           pending/list read the copy; add/applied queue in <stateDir>/sync/outbox/
//                       for the next push; answering is done on the page
//
// The pages' databases can only be written through Claude's ArtifactData tool, so each push is
// one small headless Claude call in safe mode (no CLAUDE.md, hooks, skills or MCP), on Haiku by
// default. A plain `claude -p` started from a terminal does not get that tool; it appears when
// CLAUDE_CODE_ENTRYPOINT is claude-vscode, as in the VS Code extension. That variable is
// undocumented (found 2026-10-14), so if pushes start failing after a Claude Code update, check
// this first: <stateDir>/sync.log shows the answer that came back. About 8 seconds and a few
// cents of usage each (measured 2026-10-14). A failed push is logged and rejects; the caller
// (lib/engine/sync.mjs) retries next round, and it never stops the run.
//
// Options: { adapter: 'artifacts', commandCenterUrl, decisionsUrl, model = 'haiku', everySeconds = 60 }.
// ctx: { stateDir, now, config (for the slot count and the story id pattern), spawnSync }.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readControl, saveControl } from '../../console/control.mjs';
import { KINDS } from '../../console/decisions.mjs';
import { decisionNote, queueStoryNote } from '../../engine/story-notes-queue.mjs';
import { ACTIONS, slotIdsFor } from '../../engine/scheduler.mjs';
import { DEFAULT_ID_PATTERN } from '../stories/markdown.mjs';

const OPTION_KEYS = ['adapter', 'commandCenterUrl', 'decisionsUrl', 'model', 'everySeconds'];
const DECISIONS_EVERY_MS = 10 * 60_000;
// Outbox operations sent in one push; the rest wait for the next.
const MAX_OPS = 10;
// A page document id, safe to put in a prompt.
const DOC_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const OP_FILE = /^(\d{17}-[0-9a-f]+)\.json$/;

// ── the reply ─────────────────────────────────────────────────────────────────────────────

// The end of the balanced {...} starting at `start`, or -1. Braces inside strings do not count.
function closeOf(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

// The last complete JSON object in `text` that has a `set` key, wherever it sits: one line, a
// code fence, prose around it, or spread over several lines. null when there is none.
export function findReply(text) {
  const s = String(text ?? '');
  let best = null;
  let bestEnd = -1;
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    const end = closeOf(s, i);
    if (end === -1 || end <= bestEnd) continue;
    try {
      const value = JSON.parse(s.slice(i, end + 1));
      if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'set')) {
        best = value;
        bestEnd = end;
      }
    } catch {
      // not JSON; try the next brace
    }
  }
  return best;
}

// What `claude -p --output-format json` printed: Claude Code may print a warning line first,
// so the last JSON line with a `result` is the answer; the reply is found anywhere inside it.
export function parseReply(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const out = JSON.parse(line);
      if (out && typeof out === 'object' && Object.hasOwn(out, 'result')) return findReply(out.result);
    } catch {
      // not the result line
    }
  }
  return null;
}

// ── the controls ──────────────────────────────────────────────────────────────────────────

const stamp = (v) => (typeof v === 'string' && v ? v.slice(0, 40) : null);

// Only the fields the run understands are kept; the rest of the page's data is ignored. Slot
// commands and the fixed button are honoured once each, by their `at` (scheduler.mjs).
// `slots` is the configured slot count (w1..wN), and the worker count may go up to it; a
// hand-back id must match the story source's `idPattern` as a whole.
export function cleanControl(raw, { slots = 3, idPattern = DEFAULT_ID_PATTERN } = {}) {
  const ids = slotIdsFor(slots);
  const storyId = new RegExp(`^(?:${idPattern})$`);
  const control = raw && typeof raw === 'object' ? raw : {};
  const commands = {};
  for (const [slot, cmd] of Object.entries(control.slots && typeof control.slots === 'object' ? control.slots : {})) {
    if (ids.includes(slot) && ACTIONS.has(cmd?.action) && stamp(cmd?.at)) commands[slot] = { action: cmd.action, at: stamp(cmd.at) };
  }
  const back = control.handBack;
  const backId = typeof back?.id === 'string' ? back.id : '';
  return {
    paused: control.paused === true,
    nextStory: typeof control.nextStory === 'string' ? control.nextStory.slice(0, 20) : null,
    requestedAt: stamp(control.requestedAt),
    workers: Number.isInteger(control.workers) && control.workers >= 1 && control.workers <= ids.length ? control.workers : null,
    workersAt: stamp(control.workersAt),
    fixedAt: stamp(control.fixedAt),
    // Resume after the run paused itself (scheduler.mjs afterOutcome).
    resumeAt: stamp(control.resumeAt),
    slots: commands,
    handBack: backId.length <= 40 && storyId.test(backId) && stamp(back.at) ? { id: backId, at: stamp(back.at) } : null,
  };
}

// ── the decisions page's shapes ───────────────────────────────────────────────────────────

const isText = (v) => typeof v === 'string' && v.trim() !== '';

// A page item ({ kind, title, story, options, input, ask, urgent, order, ... }) and its answer
// ({ item, choice, text, at, applied }) in the files console's shape (lib/console/decisions.mjs).
function toItem(id, item, answer) {
  return {
    id,
    story: typeof item.story === 'string' ? item.story : '',
    kind: item.kind === 'task' ? 'task' : 'decision',
    title: String(item.title ?? id),
    options: Array.isArray(item.options) ? item.options.filter((o) => typeof o === 'string') : [],
    urgent: item.urgent === true,
    body: typeof item.ask === 'string' ? item.ask : '',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
    answer: answer ? { option: isText(answer.choice) ? answer.choice : null, note: typeof answer.text === 'string' ? answer.text : '', at: answer.at ?? null } : null,
    appliedAt: answer?.applied ?? null,
  };
}

// What `decide add` takes, as a page item.
function toPageItem({ story, kind, title, options = [], urgent = false, body = '' } = {}, now) {
  if (!isText(story)) throw new Error('A decision needs the story it is about.');
  if (!KINDS.includes(kind)) throw new Error(`The kind must be decision or task, not ${kind}.`);
  if (!isText(title)) throw new Error('A decision needs a title.');
  if (!Array.isArray(options) || !options.every(isText)) throw new Error('Each option must be some text.');
  const opts = options.map((o) => o.trim());
  return {
    kind,
    title: title.trim(),
    story: story.trim(),
    options: opts,
    // A decision with no options needs words; anything else may carry a note.
    input: kind === 'decision' && !opts.length ? 'required' : 'optional',
    ask: typeof body === 'string' ? body : '',
    urgent: urgent === true,
    createdAt: now.toISOString(),
  };
}

const byAge = (a, b) =>
  String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || (a.order ?? 99) - (b.order ?? 99) || a.id.localeCompare(b.id);

// ── the console ───────────────────────────────────────────────────────────────────────────

export function create(options = {}, ctx = {}) {
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unknown.length) throw new Error(`console artifacts: unknown option ${unknown.join(', ')}`);
  for (const key of ['commandCenterUrl', 'decisionsUrl']) {
    if (!isText(options[key]) || /["\s]/.test(options[key])) throw new Error(`console artifacts: ${key} is required (the page's claude.ai artifact url)`);
  }
  const { commandCenterUrl, decisionsUrl, model = 'haiku', everySeconds = 60 } = options;
  if (!isText(model) || /\s/.test(model)) throw new Error('console artifacts: model must be a model name');
  if (typeof everySeconds !== 'number' || !Number.isFinite(everySeconds) || everySeconds < 20) throw new Error('console artifacts: everySeconds must be a number of at least 20');
  const dir = ctx.stateDir;
  if (!dir) throw new Error('console artifacts: ctx.stateDir is required');
  const now = ctx.now ?? (() => new Date());
  const run = ctx.spawnSync ?? nodeSpawnSync;
  const limits = { slots: ctx.config?.slots ?? 3, idPattern: ctx.config?.stories?.idPattern ?? DEFAULT_ID_PATTERN };

  const work = join(dir, 'sync');
  const snapshotFile = join(work, 'status.json');
  const copyDir = join(work, 'decisions');
  const newCopyDir = join(work, 'decisions-new');
  const outboxDir = join(work, 'outbox');
  const dataDir = join(work, 'outbox-data');
  let decisionsAt = 0;

  const log = (line) => {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'sync.log'), `${now().toISOString()} ${line}\n`);
  };
  const fail = (line) => {
    log(line);
    throw new Error(line);
  };

  // ── the outbox ──

  function queued() {
    if (!existsSync(outboxDir)) return [];
    return readdirSync(outboxDir)
      .map((f) => f.match(OP_FILE)?.[1])
      .filter(Boolean)
      .sort()
      .map((opId) => {
        try {
          return { ...JSON.parse(readFileSync(join(outboxDir, `${opId}.json`), 'utf8')), opId };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  // <yyyymmddhhmmssSSS>-<random>, always later than the last one queued, so the order holds
  // even on a frozen clock.
  function queue(op) {
    mkdirSync(outboxDir, { recursive: true });
    const last = queued().at(-1)?.opId.slice(0, 17) ?? '';
    let time = now().toISOString().replace(/\D/g, '').slice(0, 17);
    if (time <= last) time = String(BigInt(last) + 1n).padStart(17, '0');
    const opId = `${time}-${randomBytes(3).toString('hex')}`;
    const file = join(outboxDir, `${opId}.json`);
    writeFileSync(`${file}.tmp`, `${JSON.stringify(op, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    return opId;
  }

  // ── the copy of the decisions page ──

  function docs(collection) {
    const folder = join(copyDir, collection);
    if (!existsSync(folder)) return {};
    const out = {};
    for (const f of readdirSync(folder)) {
      if (!f.endsWith('.json')) continue;
      try {
        out[f.slice(0, -5)] = JSON.parse(readFileSync(join(folder, f), 'utf8'));
      } catch {
        // unreadable: left out
      }
    }
    return out;
  }

  function writeDoc(collection, id, value) {
    mkdirSync(join(copyDir, collection), { recursive: true });
    writeFileSync(join(copyDir, collection, `${id}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }

  // A confirmed operation, applied to the local copy too, so it shows before the next copy.
  function applyLocally(op) {
    if (op.type === 'add') {
      const { id, ...item } = op.item;
      writeDoc('items', id, item);
    } else if (op.type === 'applied') {
      writeDoc('answers', op.id, { item: op.id, ...(docs('answers')[op.id] ?? {}), applied: op.at });
    }
  }

  // Every item: the copy, plus adds still queued, with applies still queued counted as done.
  function all() {
    const items = docs('items');
    const answers = docs('answers');
    const ops = queued();
    for (const op of ops) if (op.type === 'add' && op.item?.id && !items[op.item.id]) items[op.item.id] = { ...op.item };
    const appliedSoon = new Map(ops.filter((op) => op.type === 'applied').map((op) => [op.id, op.at]));
    return Object.entries(items)
      .map(([id, item]) => {
        const mapped = toItem(id, item, answers[id]);
        if (!mapped.appliedAt && appliedSoon.has(id)) mapped.appliedAt = appliedSoon.get(id);
        return { mapped, order: item.order };
      })
      .sort((a, b) => byAge({ ...a.mapped, order: a.order }, { ...b.mapped, order: b.order }))
      .map(({ mapped }) => mapped);
  }

  // ── the push ──

  function step(n, op) {
    const tag = `${n}. (outbox ${op.opId}) On url ${decisionsUrl}:`;
    if (op.type === 'add') {
      const { id, ...item } = op.item;
      mkdirSync(dataDir, { recursive: true });
      const file = join(dataDir, `${op.opId}.json`);
      writeFileSync(file, JSON.stringify(item));
      return `${tag} action "set", collection "items", doc_id "${id}", file_path "${file}".`;
    }
    const data = JSON.stringify({ applied: op.at });
    return `${tag} action "update", collection "answers", doc_id "${op.id}", data ${data}. If there is no such document, use action "set" with data ${JSON.stringify({ item: op.id, applied: op.at })} instead.`;
  }

  function prompt(ops, withDecisions) {
    const steps = [
      `1. On url ${commandCenterUrl}: action "get", collection "factory", doc_id "status".`,
      `2. On the same url: action "set", collection "factory", doc_id "status", file_path "${snapshotFile}". Pass if_version set to the version step 1 returned; leave if_version out only if step 1 found no document. If the set is refused because the version changed, do step 1 and this step once more.`,
      `3. On the same url: action "get", collection "factory", doc_id "control".`,
    ];
    for (const op of ops) steps.push(step(steps.length + 1, op));
    if (withDecisions) {
      steps.push(`${steps.length + 1}. On url ${decisionsUrl}: action "list", collection "items", query {"limit": 500}, out_dir "${newCopyDir}".`);
      steps.push(`${steps.length + 1}. On url ${decisionsUrl}: action "list", collection "answers", query {"limit": 500}, out_dir "${newCopyDir}".`);
    }
    const outbox = ops.length ? ', "outbox": [<the outbox ids, in quotes, of the steps marked (outbox ...) that succeeded>]' : ', "outbox": []';
    return `Do exactly these steps with the ArtifactData tool (load it with ToolSearch "select:ArtifactData" first if it is not loaded), and nothing else.
${steps.join('\n')}
Then reply with exactly one line of compact JSON and nothing else: {"set": <the version number step 2 returned, or null if step 2 did not succeed>, "problem": "<the exact error or refusal text if step 2 did not succeed, else empty>", "control": <the control document's data from step 3, or {}>${outbox}}.`;
  }

  async function publish(snapshot) {
    mkdirSync(work, { recursive: true });
    writeFileSync(snapshotFile, JSON.stringify(snapshot));
    const ops = queued().slice(0, MAX_OPS);
    const withDecisions = now().getTime() - decisionsAt >= DECISIONS_EVERY_MS;
    if (withDecisions) rmSync(newCopyDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    const text = prompt(ops, withDecisions);
    const result = run(
      'claude',
      ['-p', text, '--safe-mode', '--model', model, '--max-turns', String(8 + ops.length * 2), '--allowedTools', 'ArtifactData', 'ToolSearch', '--permission-prompts', 'none', '--output-format', 'json'],
      { cwd: work, encoding: 'utf8', timeout: 120_000 + ops.length * 15_000, input: '', env: { ...process.env, FOREMAN_RUN: '', CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' } },
    );
    if (result.status !== 0) fail(`push failed (exit ${result.status ?? 'timeout'})`);
    const reply = parseReply(result.stdout);
    if (!reply) fail(`no readable answer: ${String(result.stdout ?? '').slice(-300).replace(/\s+/g, ' ')}`);

    // Only the operations the reply confirms leave the outbox.
    const confirmed = new Set(Array.isArray(reply.outbox) ? reply.outbox.map(String) : []);
    const done = ops.filter((op) => confirmed.has(op.opId));

    const written = typeof reply.set === 'number';
    if (written) {
      saveControl(dir, cleanControl(reply.control, limits));
      // Swap in the fresh copy of the decisions page only if both lists arrived.
      if (withDecisions && existsSync(join(newCopyDir, 'items'))) {
        writeFileSync(join(newCopyDir, 'checked.json'), JSON.stringify({ at: now().toISOString() }));
        rmSync(copyDir, { recursive: true, force: true });
        renameSync(newCopyDir, copyDir);
        decisionsAt = now().getTime();
      }
    }
    for (const op of done) {
      applyLocally(op);
      rmSync(join(outboxDir, `${op.opId}.json`), { force: true });
    }
    // A write to the page needs an approval that only a Claude session with a person behind it
    // can give; started from a plain terminal, it is refused. Say so plainly.
    if (!written) fail(`write refused: ${String(reply.problem || 'the page did not confirm the write').slice(0, 300)}`);
  }

  return {
    everySeconds,
    // True when a push has work beyond the snapshot: queued decisions, or a copy of the page due.
    due: () => queued().length > 0 || now().getTime() - decisionsAt >= DECISIONS_EVERY_MS,
    publish,
    async controls() {
      return readControl(dir);
    },
    decisions: {
      async add(item) {
        const pageItem = toPageItem(item, now());
        const ids = new Set([...Object.keys(docs('items')), ...queued().filter((op) => op.type === 'add').map((op) => op.item?.id)]);
        const stamp14 = pageItem.createdAt.replace(/\D/g, '').slice(0, 14);
        let id;
        do id = `d-${stamp14}-${randomBytes(2).toString('hex')}`;
        while (ids.has(id));
        queue({ type: 'add', item: { id, ...pageItem } });
        // The story hears of it too (engine/story-notes-queue.mjs); never fails the add.
        try {
          queueStoryNote(dir, { ...decisionNote({ id, ...item }), at: now(), slot: process.env.FOREMAN_SLOT || null });
        } catch {
          // a note is never worth failing an add
        }
        return id;
      },
      async pending() {
        return all().filter((item) => !item.appliedAt);
      },
      async list() {
        return all();
      },
      async applied(id) {
        if (!DOC_ID.test(String(id))) throw new Error(`There is no decision ${id}.`);
        queue({ type: 'applied', id, at: now().toISOString() });
      },
      async answer() {
        throw new Error(`With the artifacts console, answer on the decisions page: ${decisionsUrl}`);
      },
    },
  };
}
