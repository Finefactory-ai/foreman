// Story source: the issues a Jira Cloud JQL filter finds (`stories.adapter: "jira"`).
//
// Options (the `stories` block of foreman.config.json):
//   site           the Jira Cloud site's host, such as acme.atlassian.net (required)
//   jql            the filter (required); its ORDER BY is the pick order
//   pollSeconds    how long list() reuses its last answer (default 60; 0 asks every time)
//   doneWhenField  a custom field id holding "Done when", such as customfield_10050
//   ownerLabel     issues with this label are owner tasks, never picked (default foreman-owner)
//   newIssueType   issue type for follow-ups made by create (default Task)
//   transitions    { event: transition name }: the move update() makes for each event
//   briefsDir      where briefs are written, relative to the project (default <stateDir>/stories)
//
// Mapping: id = the issue key; title = summary; order = position in the JQL result; group
// empty; dependsOn = the keys this issue "is blocked by" (a blocker outside the filter that
// Jira says is done is dropped, being met; one that is not done stays and holds the story);
// externalDeps names each blocker outside the filter that is not done, { KEY: 'not done' }
// ('not found' when Jira will not show it), so the build plan can say why the story waits;
// ownerTask = has ownerLabel; status = done when the status category is done, else the
// overlay's status, else todo; followUpOf = the origin of an issue create() made. followUpOf(id)
// gives the same origin for any key, from the overlay alone, including issues the filter leaves
// out. Status, blockedBy, fields and notes Foreman records live in the state overlay
// (overlay.mjs), the same files the markdown source uses in state mode.
//
// Every Jira call runs synchronously through a child process (lib/jira/sync.mjs), since
// story sources are synchronous, and gives up after 30 s. list() keeps its answer in
// <stateDir>/jira/list.json (lib/jira/cache.mjs) for pollSeconds, so separate CLI calls and
// the supervisor share one poll; when Jira cannot be reached it falls back to the last answer
// of any age, so a story under way can still record its progress. brief() asks Jira each
// time. The Jira client gets ctx.env over the Jira keys in Foreman's own keys file
// (ctx.foremanEnvFile) over the project's env file (ctx.envFile), for JIRA_CLIENT_ID and
// JIRA_CLIENT_SECRET when the token needs a refresh.
//
// Writing back (§2.3), in update(id, { status, fields, note, event }): the overlay first, so
// nothing is lost; then, when fields.dependsOn is given, the "is blocked by" links it changes:
// a Blocks link from each new id that neither the old list (the overlay's, else Jira's) nor Jira
// has, and the removal of the link from each id the old list had and the new one has not (never
// a blocker outside the filter that is done, which list() leaves out). These are always sent,
// whatever the switches and even for a repeated event, as create()'s links are.
// Then, with ctx.features.jiraComments on, the note as a comment
// "Foreman: <note>"; then, with ctx.features.jiraTransitions on and the event in
// `transitions`, the move of the issue. The same event with the same note twice in a row (a
// release run again) writes nothing new. A write Jira does not take goes to the outbox
// (lib/jira/outbox.mjs) and is replayed, in order, before the next write or after the next
// poll that reaches Jira. create() makes a follow-up issue (see createFollowUp).
//
// note(id, { kind, title, summary, text }) records one story note (engine/story-notes.mjs) as
// a comment "Foreman: <title>", a blank line, the summary, a blank line and the text; false for
// a key Jira does not list and Foreman never tracked, true with no write when ctx.features.jiraComments is off. A comment
// is limited (ctx.commentLimit characters, default COMMENT_LIMIT, well under Jira's 32,767), so
// a longer one is split into parts, each headed "Foreman: <title> (part i of n)", on the blank
// lines between blocks (never inside a ``` fence while a block fits), and a block longer than a
// part is cut at a line or a space. The parts go in one send, in order: through the outbox when
// cacheOnly, so the footer ends the last part.
//
// ctx.cacheOnly (the supervisor, which must never wait on Jira): list() reads only the cache,
// brief() gives a brief already written (or null), and update() queues its Jira writes in the
// outbox, calling ctx.onQueued; lib/jira/refresher.mjs polls, sends and fetches briefs with
// await instead.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeSite } from '../../jira/auth.mjs';
import { adfToMarkdown, markdownToAdf } from '../../jira/adf.mjs';
import { clearListCache, jiraEnv, readListCache, writeListCache } from '../../jira/cache.mjs';
import { outbox } from '../../jira/outbox.mjs';
import { runJiraSync } from '../../jira/sync.mjs';
import { bulletOf, localDate, overlayStore, safeId, writeAtomic } from './overlay.mjs';

export const JIRA_ID_PATTERN = '[A-Z][A-Z0-9_]+-\\d+';
export const DEFAULT_POLL_SECONDS = 60;
export const DEFAULT_OWNER_LABEL = 'foreman-owner';
export const DEFAULT_ISSUE_TYPE = 'Task';
// Characters of one comment; Jira refuses 32,767.
export const COMMENT_LIMIT = 16000;
const TRANSITION_EVENTS = ['started', 'blocked', 'review', 'failed', 'shipped'];
const OPTION_KEYS = ['adapter', 'site', 'jql', 'pollSeconds', 'doneWhenField', 'ownerLabel', 'newIssueType', 'transitions', 'briefsDir'];
const STATUSES = ['todo', 'in-progress', 'blocked', 'ready-to-promote', 'done', 'retired'];

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export function checkOptions(options) {
  if (!isPlain(options)) throw new Error('stories options must be an object');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) throw new Error(`stories.${key} is not a known option`);
  }
  const { site, jql, pollSeconds, doneWhenField, ownerLabel, newIssueType, transitions, briefsDir } = options;
  if (site === undefined || site === '') throw new Error('stories.site is required');
  try {
    normalizeSite(site);
  } catch (err) {
    throw new Error(`stories.site: ${err.message}`);
  }
  if (!nonEmpty(jql)) throw new Error('stories.jql is required');
  if (pollSeconds !== undefined && !(Number.isInteger(pollSeconds) && pollSeconds >= 0)) throw new Error('stories.pollSeconds must be a whole number of seconds, 0 or more');
  for (const [key, value] of Object.entries({ doneWhenField, ownerLabel, newIssueType, briefsDir })) {
    if (value !== undefined && !nonEmpty(value)) throw new Error(`stories.${key} must be a non-empty string`);
  }
  if (transitions !== undefined) {
    if (!isPlain(transitions)) throw new Error('stories.transitions must map events to transition names');
    for (const [event, name] of Object.entries(transitions)) {
      if (!TRANSITION_EVENTS.includes(event)) throw new Error(`stories.transitions.${event} is not an event (use ${TRANSITION_EVENTS.join(', ')})`);
      if (!nonEmpty(name)) throw new Error(`stories.transitions.${event} must be a transition name`);
    }
  }
}

// "## Done when" (any level) inside a description: { what, doneWhen } with the section,
// down to the next heading of its level or higher, taken out of what.
export function splitDoneWhen(markdown) {
  const lines = String(markdown ?? '').split('\n');
  let fence = false;
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!h) continue;
    if (start === -1) {
      if (/^done\s+when\b[\s:]*$/i.test(h[2])) {
        start = i;
        level = h[1].length;
      }
    } else if (h[1].length <= level) {
      end = i;
      break;
    }
  }
  if (start === -1) return { what: String(markdown ?? '').trim(), doneWhen: '' };
  const what = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { what, doneWhen: lines.slice(start + 1, end).join('\n').trim() };
}

// Blocks of markdown, split on blank lines outside ``` fences.
function blocksOf(text) {
  const blocks = [];
  let current = [];
  let fence = false;
  const close = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && line.trim() === '' && !/^\s*```/.test(line)) close();
    else current.push(line);
  }
  close();
  return blocks;
}

// One block cut into pieces of at most `max` characters, at a line or a space where there is one.
// A fenced block's pieces are fenced again, so each reads as code.
function cutBlock(block, max) {
  const fenced = /^\s*```/.test(block);
  const open = fenced ? `${block.split('\n')[0].trim()}\n` : '';
  const room = fenced ? max - open.length - 4 : max;
  let rest = fenced ? block.split('\n').slice(1).join('\n').replace(/\n?\s*```\s*$/, '') : block;
  const pieces = [];
  while (rest.length > room) {
    let at = Math.max(rest.lastIndexOf('\n', room), rest.lastIndexOf(' ', room));
    if (at < room / 2) at = room;
    pieces.push(rest.slice(0, at).replace(/\s+$/, ''));
    rest = rest.slice(at).replace(/^[ \t]*\n?/, '');
  }
  if (rest !== '') pieces.push(rest);
  return fenced ? pieces.map((p) => `${open}${p}\n\`\`\``) : pieces;
}

// The comment's parts, in order: the whole when it fits, else numbered parts. The Salesforce
// story source (salesforce.mjs) splits its Case comments the same way.
export function commentParts(title, body, limit) {
  const head = `Foreman: ${title}`;
  const whole = `${head}\n\n${body}`;
  if (whole.length <= limit) return [whole];
  const blocks = blocksOf(body);
  const pack = (budget) => {
    const parts = [];
    let current = '';
    for (const block of blocks.flatMap((b) => (b.length > budget ? cutBlock(b, budget) : [b]))) {
      if (current !== '' && current.length + 2 + block.length > budget) {
        parts.push(current);
        current = '';
      }
      current = current === '' ? block : `${current}\n\n${block}`;
    }
    if (current !== '') parts.push(current);
    return parts;
  };
  // The header grows with the number of parts, so settle on a count that its own header fits.
  let n = 2;
  for (;;) {
    const budget = Math.max(40, limit - `${head} (part ${n} of ${n})`.length - 2);
    const parts = pack(budget);
    if (parts.length <= n) return parts.map((p, i) => `${head} (part ${i + 1} of ${parts.length})\n\n${p}`);
    n = parts.length;
  }
}

export function create(options, ctx = {}) {
  checkOptions(options);
  const root = ctx.root ?? process.cwd();
  const now = ctx.now ?? (() => new Date());
  const env = ctx.env ?? process.env;
  const stateDir = ctx.stateDir;
  if (!stateDir) throw new Error('the Jira story source needs a state folder (ctx.stateDir)');
  const site = normalizeSite(options.site);
  const { jql, doneWhenField } = options;
  const pollMs = (options.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
  const ownerLabel = options.ownerLabel ?? DEFAULT_OWNER_LABEL;
  const transitions = options.transitions ?? {};
  // The switches as the resolved config has them; on unless turned off, as the defaults are.
  const features = { jiraComments: true, jiraTransitions: true, ...(ctx.features ?? {}) };
  const cacheOnly = ctx.cacheOnly === true;
  const commentLimit = Number.isInteger(ctx.commentLimit) && ctx.commentLimit > 0 ? ctx.commentLimit : COMMENT_LIMIT;
  const briefsDir = options.briefsDir ? resolve(root, options.briefsDir) : join(stateDir, 'stories');
  const overlay = overlayStore(stateDir);
  const box = outbox(stateDir, { now, slot: env.FOREMAN_SLOT || null });
  const browse = (key) => `https://${site}/browse/${key}`;
  const briefPath = (id) => join(briefsDir, `${safeId(id)}.md`);

  let clientEnv = null;
  const call = (job, args) => runJiraSync(job, { site, env: (clientEnv ??= jiraEnv(env, ctx.envFile, ctx.foremanEnvFile)), args, ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) });

  // ---- writes: the queued ones first, then `ops`, in one child process; never throws ----
  function send(ops = []) {
    if (cacheOnly) {
      for (const op of ops) box.add(op);
      if (ops.length) ctx.onQueued?.();
      return;
    }
    const release = box.lock();
    if (!release) {
      // Another process is sending the queue; these go behind it.
      for (const op of ops) box.add(op);
      return;
    }
    try {
      const batch = [...box.entries(), ...ops.map((op) => ({ op }))];
      if (!batch.length) return;
      let results;
      try {
        results = call('writes', { ops: batch.map((b) => b.op) });
      } catch (err) {
        const error = String(err?.message ?? err);
        results = batch.map(() => ({ status: 'failed', error }));
      }
      box.settle(batch, results);
    } finally {
      release();
    }
  }

  // ---- the poll cache ----
  const readCache = () => readListCache(stateDir, { site, jql });
  const EMPTY = { issues: [], outside: {} };
  // With `fallback`, an answer of any age stands in when Jira cannot be reached.
  const snapshot = ({ fallback = false } = {}) => {
    const cached = readCache();
    if (cacheOnly) return cached ?? EMPTY;
    const at = +now();
    if (cached && pollMs > 0 && at >= cached.fetchedAt && at - cached.fetchedAt < pollMs) return cached;
    let fresh;
    try {
      fresh = writeListCache(stateDir, { site, jql, fetchedAt: at, ...call('snapshot', { jql }) });
    } catch (err) {
      if (fallback && cached) return cached;
      throw err;
    }
    // Jira answered: send what waits for it.
    if (!box.isEmpty()) send();
    return fresh;
  };

  const statusOf = (category, ov) => {
    if (category === 'done') return 'done';
    return STATUSES.includes(ov?.status) ? ov.status : 'todo';
  };

  // The origin create() recorded for `id`, from the overlay alone: no Jira call and no check that
  // the filter lists it, so a shipped follow-up the filter leaves out still counts. '' for none.
  const followUpOf = (id) => String(overlay.read(id)?.fields?.followUpOf ?? '');

  const toStory = (issue, order, outside = {}) => {
    const ov = overlay.read(issue.key);
    const status = statusOf(issue.category, ov);
    const deps = Array.isArray(ov?.fields?.dependsOn) ? ov.fields.dependsOn.map(String) : issue.blockedBy;
    const isOutside = (k) => Object.hasOwn(outside, k);
    // A blocker outside the filter is met when Jira says it is done.
    const dependsOn = deps.filter((k) => !(isOutside(k) && outside[k] === 'done'));
    return {
      id: issue.key,
      title: issue.title,
      ref: browse(issue.key),
      status,
      group: '',
      groupName: '',
      order,
      dependsOn,
      blockedBy: status === 'done' ? '' : String(ov?.blockedBy ?? ''),
      ownerTask: issue.labels.includes(ownerLabel),
      resources: [],
      followUpOf: followUpOf(issue.key),
      externalDeps: Object.fromEntries(dependsOn.filter(isOutside).map((k) => [k, outside[k] === null ? 'not found' : 'not done'])),
    };
  };

  const list = () => {
    const snap = snapshot({ fallback: true });
    return snap.issues.map((issue, i) => toStory(issue, i, snap.outside));
  };

  const known = (id) => snapshot({ fallback: true }).issues.some((i) => i.key === id);

  // The brief file from what readBrief (lib/jira/issues.mjs) gave for the issue.
  function writeBrief(id, b) {
    const issue = readCache()?.issues.find((i) => i.key === id) ?? {};
    const ov = overlay.read(id);
    const status = statusOf(b.category ?? issue.category, ov);
    const title = b.title || issue.title || id;
    const description = adfToMarkdown(b.description);
    const fromField = doneWhenField ? adfToMarkdown(b.doneWhen) : '';
    const split = fromField ? { what: description, doneWhen: fromField } : splitDoneWhen(description);

    const lines = [
      '---',
      `id: ${id}`,
      `title: ${JSON.stringify(title)}`,
      `status: ${status}`,
      `url: ${browse(id)}`,
      '---',
      '',
      `# ${id} · ${title}`,
      '',
      '## What',
      '',
      split.what || '_No description in the issue._',
      '',
      '## Done when',
      '',
      split.doneWhen || '_Not given in the issue._',
      '',
    ];
    if (b.comments?.length) {
      lines.push('## Comments', '', '_The last 10, newest first._', '');
      for (const c of b.comments) lines.push(`### ${c.author}, ${String(c.created).slice(0, 10)}`, '', adfToMarkdown(c.body) || '_(empty)_', '');
    }
    if (ov?.notes?.length) {
      lines.push('## Progress notes', '', '_Newest first._', '');
      for (const n of ov.notes) lines.push(bulletOf(n), '');
    }
    const path = briefPath(id);
    writeAtomic(path, lines.join('\n'));
    return { path };
  }

  function brief(id) {
    if (cacheOnly) return known(id) && existsSync(briefPath(id)) ? { path: briefPath(id) } : null;
    if (!known(id)) return null;
    return writeBrief(id, call('brief', { key: id, doneWhenField }));
  }

  // The overlay only: what Foreman knows that Jira does not (yet).
  function record(id, { status, fields = {}, note, event } = {}) {
    const ov = overlay.load(id);
    if (status !== undefined) ov.status = status;
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'blockedBy') ov.blockedBy = value;
      else ov.fields[key] = value;
    }
    if (note) ov.notes.unshift({ date: localDate(now()), text: note });
    if (event) ov.lastEvent = { event, note: note ?? '' };
    overlay.write(id, ov);
  }

  // The Jira writes a change makes: its note as a comment, then its event's move.
  const writesFor = (id, { note, event } = {}) => {
    const ops = [];
    if (features.jiraComments === true && nonEmpty(note)) ops.push({ kind: 'comment', key: id, body: markdownToAdf(`Foreman: ${note}`) });
    const name = event ? transitions[event] : undefined;
    if (features.jiraTransitions === true && nonEmpty(name)) ops.push({ kind: 'transition', key: id, name, comment: features.jiraComments === true });
    return ops;
  };

  // The link changes a new depends_on list makes, worked out before the overlay records it. A
  // blocker outside the filter that Jira says is done is never unlinked: list() leaves it out as
  // met, so a list built from list() leaves it out too.
  const linksFor = (id, next) => {
    const snap = snapshot({ fallback: true });
    const issue = snap.issues.find((i) => i.key === id);
    const inJira = issue?.blockedBy ?? [];
    const met = (k) => Object.hasOwn(snap.outside ?? {}, k) && snap.outside[k] === 'done';
    const saved = overlay.read(id)?.fields?.dependsOn;
    const old = Array.isArray(saved) ? saved.map(String) : inJira;
    const want = [...new Set(next.map(String))];
    return [
      ...want.filter((dep) => !old.includes(dep) && !inJira.includes(dep)).map((dep) => ({ kind: 'link', type: 'Blocks', outward: dep, inward: id })),
      ...old.filter((dep) => !want.includes(dep) && !met(dep)).map((dep) => ({ kind: 'unlink', type: 'Blocks', outward: dep, inward: id })),
    ];
  };

  function update(id, change = {}) {
    if (!known(id)) return false;
    const last = overlay.read(id)?.lastEvent;
    const repeat = !!change.event && last?.event === change.event && last?.note === (change.note ?? '');
    const links = Array.isArray(change.fields?.dependsOn) ? linksFor(id, change.fields.dependsOn) : [];
    record(id, change);
    send([...links, ...(repeat ? [] : writesFor(id, change))]);
    return true;
  }

  // A story note as a comment: see the header. Never throws; a write Jira does not take is queued.
  function note(id, { title, summary, text } = {}) {
    // A story Foreman tracked (it has an overlay) counts even when the filter no longer lists it:
    // a shipped story still gets the follow-ups made from it.
    if (!known(id) && overlay.read(id) === null) return false;
    if (features.jiraComments !== true) return true;
    const body = [summary, text].filter(nonEmpty).map((t) => String(t).trim()).join('\n\n');
    send(commentParts(String(title ?? 'note'), body, commentLimit).map((part) => ({ kind: 'comment', key: id, body: markdownToAdf(part) })));
    return true;
  }

  // A follow-up as a new issue in the origin's project, of type newIssueType, with the
  // origin's labels (less ownerLabel), What and "Done when" as its description, the priority
  // by name when one is given (made without it when the project refuses it), a Relates link to
  // the origin and a Blocks link from each dependency. A link Jira refuses is an event; the
  // issue still counts as made.
  function createFollowUp({ title, what = '', doneWhen = '', dependsOn = [], origin, priority } = {}) {
    if (!nonEmpty(title)) throw new Error('a new story needs a title');
    if (!new RegExp(`^(?:${JIRA_ID_PATTERN})$`).test(String(origin ?? ''))) throw new Error('a new Jira issue needs the key of the issue it follows up (origin)');
    const text = [String(what ?? '').trim(), nonEmpty(doneWhen) ? `## Done when\n\n${doneWhen.trim()}` : ''].filter(Boolean).join('\n\n');
    const { key } = call('create', {
      origin,
      title: title.trim(),
      description: markdownToAdf(text),
      issueType: options.newIssueType ?? DEFAULT_ISSUE_TYPE,
      dropLabels: [ownerLabel],
      ...(nonEmpty(priority) ? { priority: priority.trim() } : {}),
    });
    clearListCache(stateDir);
    const ov = overlay.load(key);
    ov.fields.followUpOf = origin;
    overlay.write(key, ov);
    const deps = [...new Set((dependsOn ?? []).map(String))];
    send([{ kind: 'link', type: 'Relates', outward: key, inward: origin }, ...deps.map((d) => ({ kind: 'link', type: 'Blocks', outward: d, inward: key }))]);
    return { id: key, path: null };
  }

  // Nothing to carry into the story's commit: the issue lives in Jira.
  const finalize = (id) => (known(id) ? { path: null } : null);

  return { list, update, note, brief, writeBrief, finalize, create: createFollowUp, followUpOf, idPattern: JIRA_ID_PATTERN, groupLabel: 'Group', site, jql, pollSeconds: options.pollSeconds ?? DEFAULT_POLL_SECONDS };
}
