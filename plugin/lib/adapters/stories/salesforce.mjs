// Story source: the Cases a filter finds in one Salesforce sandbox (`stories.adapter:
// "salesforce"`). It needs the Salesforce pack (`pack: "salesforce"`) and an org in
// `salesforce.orgs`, and never reads a production org.
//
// Options (the `stories` block of foreman.config.json):
//   org            the alias in salesforce.orgs of the sandbox that holds the Cases (required)
//   where          a SOQL condition on Case, such as IsClosed = false AND Type = 'Foreman'; or
//   listView       the DeveloperName of a Case list view; give exactly one of the two
//   orderBy        with where only: the ORDER BY (default CreatedDate ASC), the pick order
//   pollSeconds    how long list() reuses its last answer (default 60; 0 asks every time)
//   idPattern      what a Case number looks like (default \d{8,10})
//   doneWhenField  a Case field holding "Done when" (HTML is turned into text)
//   dependsOnField a Case field holding the numbers of the Cases this one waits for
//   ownerField     a Case field that marks owner tasks (a picklist or multi-select), with
//   ownerValue     the value that does; without them a Subject with "(owner task)" is one
//   statuses       { event: Case Status name }: the Status update() sets for each event
//                  (started, blocked, review, failed, shipped)
//   briefsDir      where briefs are written, relative to the project (default <stateDir>/stories)
//
// Mapping: id = the CaseNumber; title = Subject; the brief = Description; order = position in the
// query's answer (at most 200 Cases); group empty; dependsOn = the numbers in dependsOnField (the
// overlay's list wins once Foreman has written one); a blocker outside the filter that Salesforce
// says is closed is dropped, being met; one that is open stays and holds the story, and
// externalDeps names it, { number: 'not done' } ('not found' when no such Case); ownerTask as
// above; status = done when the Case is closed, else the overlay's status, else todo; ref = the
// Case in Lightning. Status, blockedBy, fields and notes Foreman records live in the state
// overlay (overlay.mjs), the same files the Jira source uses. There is no create(): a Case is
// made in Salesforce.
//
// Every sf call goes through packs/salesforce/cases.mjs, run synchronously in Foreman's own sf
// home (isolation.mjs), never the owner's ~/.sf, and gives up after 60 s. Before it reads a
// Case, each poll and each brief read asks the org whether it is a sandbox with the org ID
// salesforce.orgs names (a brief read reuses a good answer for pollSeconds, as a write does);
// create() and checkConfig refuse a production org too. list() keeps its answer in
// <stateDir>/salesforce/list.json for pollSeconds, so separate CLI calls and the supervisor share
// one poll; when the org cannot be reached it falls back to the last answer of any age. That is
// only for an org that did not answer: one that answers "not a sandbox" or "another org ID" is an
// error from list(), update() and note(), never a cache. Every write is checked the same way
// first (once per pollSeconds), including the outbox's replay; when the check fails the writes
// stay queued, with a warn event, and nothing is sent.
//
// Writing back, in update(id, { status, fields, note, event }): the overlay first; then, when
// fields.dependsOn is given and dependsOnField is set, that field (always sent); then, with
// ctx.features.salesforceComments on, the note as a private CaseComment "Foreman: <note>"
// (IsPublished false, so a customer never sees it); then, with ctx.features.salesforceStatuses on
// and the event in `statuses`, the Case's Status. The same event with the same note twice in a
// row writes nothing new. A write the org does not take goes to the outbox
// (<stateDir>/salesforce-outbox, the Jira outbox's code) and is replayed, in order, before the
// next write or after the next poll that reaches the org; one the org refuses (a Status the
// picklist lacks) is dropped with a warn event.
//
// note(id, { kind, title, summary, text }) records one story note as a comment "Foreman: <title>",
// a blank line, the summary, a blank line and the text; false for a Case the filter does not list
// and Foreman never tracked, true with no write when salesforceComments is off. A comment holds
// 4000 characters, so a longer one is split into parts, each headed "Foreman: <title> (part i of
// n)" (commentParts in jira.mjs); the parts go in one send.
//
// ctx.cacheOnly (the supervisor, which must never wait on sf): list() reads only the cache,
// brief() gives a brief already written (or null), and update() queues its writes, calling
// ctx.onQueued; salesforce-refresher.mjs polls, sends and fetches briefs in a child process
// (salesforce-worker.mjs) instead. refresh() is a poll that ignores pollSeconds, for the worker.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { jiraEvent, outbox } from '../../jira/outbox.mjs';
import { ALIAS, reservedAlias } from '../../../packs/salesforce/config.mjs';
import {
  CASE_ID, COMMENT_LIMIT, DEFAULT_ID_PATTERN, FIELD, checkOrg, dependencyNumbers, describeCaseOp, instanceUrlOf, listViewTail, readCase, readCases, sendCaseWrites, whereTail,
} from '../../../packs/salesforce/cases.mjs';
import { isolatedSh, sfHome } from '../../../packs/salesforce/isolation.mjs';
import { commentParts, splitDoneWhen } from './jira.mjs';
import { readText } from '../../engine/read-cache.mjs';
import { bulletOf, localDate, overlayStore, safeId, writeAtomic } from './overlay.mjs';

export const DEFAULT_POLL_SECONDS = 60;
const CACHE_VERSION = 1;
const OPTION_KEYS = ['adapter', 'org', 'where', 'listView', 'orderBy', 'pollSeconds', 'idPattern', 'doneWhenField', 'dependsOnField', 'ownerField', 'ownerValue', 'statuses', 'briefsDir'];
const STATUS_EVENTS = ['started', 'blocked', 'review', 'failed', 'shipped'];
const STATUSES = ['todo', 'in-progress', 'blocked', 'ready-to-promote', 'done', 'retired'];
const MAX_WHERE = 4000;
const MAX_STATUS_NAME = 255;
const PRODUCTION = /^(prod|production)$/i;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

export function checkOptions(options) {
  if (!isPlain(options)) throw new Error('stories options must be an object');
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) throw new Error(`stories.${key} is not a known option`);
  }
  const { org, where, listView, orderBy, pollSeconds, idPattern, ownerField, ownerValue, statuses, briefsDir } = options;
  if (org === undefined || org === '') throw new Error('stories.org is required');
  if (typeof org !== 'string' || !ALIAS.test(org) || reservedAlias(org)) throw new Error('stories.org must be an org alias from salesforce.orgs');
  if (where === undefined && listView === undefined) throw new Error('stories.where or stories.listView is required');
  if (where !== undefined && listView !== undefined) throw new Error('give stories.where or stories.listView, not both');
  if (where !== undefined && !(nonEmpty(where) && where.length <= MAX_WHERE)) throw new Error(`stories.where must be a SOQL condition of at most ${MAX_WHERE} characters`);
  if (listView !== undefined && !(typeof listView === 'string' && FIELD.test(listView))) throw new Error('stories.listView must be the name of a Case list view (letters, digits and underscores)');
  if (orderBy !== undefined) {
    if (where === undefined) throw new Error('stories.orderBy goes with stories.where; a list view has its own order');
    if (!(typeof orderBy === 'string' && /^[A-Za-z0-9_., ]+$/.test(orderBy) && orderBy.trim() !== '')) throw new Error('stories.orderBy must be field names with ASC or DESC, such as Priority DESC, CreatedDate');
  }
  if (pollSeconds !== undefined && !(Number.isInteger(pollSeconds) && pollSeconds >= 0)) throw new Error('stories.pollSeconds must be a whole number of seconds, 0 or more');
  if (idPattern !== undefined) {
    try {
      new RegExp(`^(?:${idPattern})$`);
    } catch {
      throw new Error('stories.idPattern is not a valid pattern');
    }
    if (!nonEmpty(idPattern)) throw new Error('stories.idPattern is not a valid pattern');
  }
  for (const key of ['doneWhenField', 'dependsOnField', 'ownerField']) {
    if (options[key] !== undefined && !(typeof options[key] === 'string' && FIELD.test(options[key]))) throw new Error(`stories.${key} must be a Case field name (letters, digits and underscores)`);
  }
  if (ownerField !== undefined && !nonEmpty(ownerValue)) throw new Error('stories.ownerValue is required with stories.ownerField');
  if (ownerField === undefined && ownerValue !== undefined) throw new Error('stories.ownerValue needs stories.ownerField');
  if (statuses !== undefined) {
    if (!isPlain(statuses)) throw new Error('stories.statuses must map events to Case Status names');
    for (const [event, name] of Object.entries(statuses)) {
      if (!STATUS_EVENTS.includes(event)) throw new Error(`stories.statuses.${event} is not an event (use ${STATUS_EVENTS.join(', ')})`);
      if (!(nonEmpty(name) && name.length <= MAX_STATUS_NAME && !/['"\\\r\n]/.test(name))) {
        throw new Error(`stories.statuses.${event} must be a Case Status name of at most ${MAX_STATUS_NAME} characters, with no quote, backslash or line break`);
      }
    }
  }
  if (briefsDir !== undefined && !nonEmpty(briefsDir)) throw new Error('stories.briefsDir must be a non-empty string');
}

// ---- the poll cache: <stateDir>/salesforce/list.json ----
export const cacheFile = (stateDir) => join(stateDir, 'salesforce', 'list.json');

// What an answer is for: it is reused only while all of this is the same.
export const cacheKey = (o) => ({
  org: o.org,
  filter: o.where ?? `list view ${o.listView}`,
  orderBy: o.where === undefined ? null : (o.orderBy ?? 'CreatedDate ASC'),
  shape: `${o.ownerField ?? ''}|${o.dependsOnField ?? ''}|${o.idPattern ?? DEFAULT_ID_PATTERN}`,
});

/** The cached answer for these options, of any age, or null. */
export function readCache(stateDir, options) {
  try {
    const c = JSON.parse(readText(cacheFile(stateDir)));
    const k = cacheKey(options);
    return c?.version === CACHE_VERSION && c.org === k.org && c.filter === k.filter && c.orderBy === k.orderBy && c.shape === k.shape && Array.isArray(c.cases) ? c : null;
  } catch {
    return null;
  }
}

// Case HTML (a rich-text field) as plain text: <br> a line break, other tags gone, entities decoded.
export function htmlToText(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function errorOf(r) {
  return Object.assign(new Error(r.error), r.code ? { code: r.code } : {}, r.identity ? { identity: true } : {});
}

export function create(options, ctx = {}) {
  checkOptions(options);
  const stateDir = ctx.stateDir;
  if (!stateDir) throw new Error('the Salesforce story source needs a state folder (ctx.stateDir)');
  const { org } = options;
  const orgs = ctx.salesforceOrgs;
  if (!isPlain(orgs) || !Object.hasOwn(orgs, org)) throw new Error(`stories.org: ${org} is not in salesforce.orgs`);
  if (PRODUCTION.test(org) || orgs[org]?.production === true) throw new Error(`stories.org: ${org} is a production org; Foreman reads stories only from a sandbox`);
  const orgId = orgs[org]?.orgId;

  const root = ctx.root ?? process.cwd();
  const now = ctx.now ?? (() => new Date());
  const env = ctx.env ?? process.env;
  const homedir = ctx.homedir ?? os.homedir();
  const real = (cmd, args, opts) => spawnSync(cmd, args, { ...opts, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const sh = ctx.sh ?? isolatedSh(real, env, sfHome(env, homedir), homedir);
  const { doneWhenField, dependsOnField, ownerField, ownerValue } = options;
  const idPattern = options.idPattern ?? DEFAULT_ID_PATTERN;
  const pollMs = (options.pollSeconds ?? DEFAULT_POLL_SECONDS) * 1000;
  const statuses = options.statuses ?? {};
  // The switches as the resolved config has them; on unless turned off, as the defaults are.
  const features = { salesforceComments: true, salesforceStatuses: true, ...(ctx.features ?? {}) };
  const cacheOnly = ctx.cacheOnly === true;
  const briefsDir = options.briefsDir ? resolve(root, options.briefsDir) : join(stateDir, 'stories');
  const overlay = overlayStore(stateDir);
  const box = outbox(stateDir, { now, slot: env.FOREMAN_SLOT || null, folder: 'salesforce-outbox', label: 'Salesforce', describe: describeCaseOp });
  const briefPath = (id) => join(briefsDir, `${safeId(id)}.md`);
  const key = cacheKey(options);

  // ---- the org check: no read from a cache and no write goes to an org that is not the sandbox ----
  // The last time the org passed it; a write within pollSeconds of that does not ask again.
  let verifiedAt = null;
  function verify(at) {
    if (verifiedAt !== null && pollMs > 0 && at >= verifiedAt && at - verifiedAt < pollMs) return { ok: true };
    const identity = checkOrg(sh, org, orgId);
    verifiedAt = identity.ok ? at : null;
    return identity;
  }

  // ---- writes: the queued ones first, then `ops`; never throws ----
  // `verified`: the org passed its check a moment ago (the poll that called this).
  function send(ops = [], { verified = false } = {}) {
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
        // Before any write, the same check a poll makes: a Case keeps its Id and number across a
        // refresh, so a write to an alias that now holds production would land on a real Case.
        const identity = verified ? { ok: true } : verify(+now());
        if (identity.ok) results = sendCaseWrites(sh, org, batch.map((b) => b.op));
        else {
          results = batch.map(() => ({ status: 'failed', error: identity.error }));
          const waiting = batch.filter((b) => b.file).length;
          if (waiting) jiraEvent(stateDir, `Salesforce: not sending ${waiting} queued writes: ${identity.error}`, 'warn', { now, slot: env.FOREMAN_SLOT || null });
        }
      } catch (err) {
        const error = String(err?.message ?? err);
        results = batch.map(() => ({ status: 'failed', error }));
      }
      box.settle(batch, results);
    } finally {
      release();
    }
  }

  // ---- the poll ----
  const readCached = () => readCache(stateDir, options);
  const EMPTY = { cases: [], outside: {}, instanceUrl: '' };

  // One poll: the org must be a sandbox with the right org ID before any Case is read.
  function poll(at) {
    const identity = checkOrg(sh, org, orgId);
    verifiedAt = identity.ok ? at : null;
    if (!identity.ok) throw errorOf(identity);
    let tail;
    if (options.where !== undefined) tail = whereTail({ where: options.where, orderBy: options.orderBy });
    else {
      const view = listViewTail(sh, org, options.listView);
      if (!view.ok) throw errorOf(view);
      tail = view.tail;
    }
    const { cases, outside } = readCases(sh, org, { tail, ownerField, dependsOnField, idPattern });
    const entry = { version: CACHE_VERSION, ...key, fetchedAt: at, instanceUrl: instanceUrlOf(sh, org), cases, outside };
    writeAtomic(join(stateDir, 'salesforce', 'list.json'), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  // With `fallback`, an answer of any age stands in when the org cannot be reached.
  const snapshot = ({ fallback = false, force = false } = {}) => {
    const cached = readCached();
    if (cacheOnly) return cached ?? EMPTY;
    const at = +now();
    if (!force && cached && pollMs > 0 && at >= cached.fetchedAt && at - cached.fetchedAt < pollMs) return cached;
    let fresh;
    try {
      fresh = poll(at);
    } catch (err) {
      // Only an org that could not be reached stands in with its cache; one that answered "not the
      // sandbox" is an error, whatever the cache holds.
      if (fallback && cached && !err.identity) return cached;
      throw err;
    }
    // The org answered: send what waits for it.
    if (!box.isEmpty()) send([], { verified: true });
    return fresh;
  };

  // ---- the mapping ----
  const statusOf = (closed, ov) => {
    if (closed) return 'done';
    return STATUSES.includes(ov?.status) ? ov.status : 'todo';
  };

  const isOwnerTask = (c) => {
    if (ownerField === undefined) return /\(owner task\)/i.test(c.title);
    if (c.ownerRaw === null || c.ownerRaw === undefined) return false;
    const raw = String(c.ownerRaw);
    return raw === ownerValue || raw.split(';').map((v) => v.trim()).includes(ownerValue);
  };

  const refOf = (instanceUrl, caseId) => (typeof instanceUrl === 'string' && instanceUrl.startsWith('https://') && CASE_ID.test(caseId) ? `${instanceUrl}/lightning/r/Case/${caseId}/view` : '');

  const toStory = (c, order, snap) => {
    const ov = overlay.read(c.key);
    const status = statusOf(c.closed, ov);
    const outside = snap.outside ?? {};
    const deps = Array.isArray(ov?.fields?.dependsOn) ? ov.fields.dependsOn.map(String) : dependencyNumbers(c.depsRaw, idPattern);
    const isOutside = (k) => Object.hasOwn(outside, k);
    // A blocker outside the filter is met when Salesforce says it is closed.
    const dependsOn = deps.filter((k) => !(isOutside(k) && outside[k] === 'done'));
    return {
      id: c.key,
      title: c.title,
      ref: refOf(snap.instanceUrl, c.caseId),
      status,
      group: '',
      groupName: '',
      order,
      dependsOn,
      blockedBy: status === 'done' ? '' : String(ov?.blockedBy ?? ''),
      ownerTask: isOwnerTask(c),
      resources: [],
      followUpOf: '',
      externalDeps: Object.fromEntries(dependsOn.filter(isOutside).map((k) => [k, outside[k] === null ? 'not found' : 'not done'])),
    };
  };

  const list = () => {
    const snap = snapshot({ fallback: true });
    return snap.cases.map((c, i) => toStory(c, i, snap));
  };

  const caseOf = (snap, id) => snap.cases.find((c) => c.key === id);
  const known = (id) => caseOf(snapshot({ fallback: true }), id) !== undefined;

  // ---- the brief ----
  function writeBrief(id, b) {
    const ov = overlay.read(id);
    const snap = readCached() ?? EMPTY;
    const status = statusOf(b.closed, ov);
    const title = b.title || id;
    const fromField = doneWhenField ? htmlToText(b.doneWhen) : '';
    const split = fromField ? { what: b.description.trim(), doneWhen: fromField } : splitDoneWhen(b.description);
    const lines = [
      '---',
      `id: ${JSON.stringify(id)}`,
      `title: ${JSON.stringify(title)}`,
      `status: ${status}`,
      `url: ${refOf(snap.instanceUrl, b.caseId)}`,
      '---',
      '',
      `# ${id} · ${title}`,
      '',
      '## What',
      '',
      split.what || '_No description in the Case._',
      '',
      '## Done when',
      '',
      split.doneWhen || '_Not given in the Case._',
      '',
    ];
    if (b.comments?.length) {
      lines.push('## Comments', '', '_The last 10, newest first._', '');
      for (const c of b.comments) lines.push(`### ${c.author}, ${String(c.created).slice(0, 10)}`, '', c.body.trim() || '_(empty)_', '');
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
    const identity = verify(+now());
    if (!identity.ok) throw errorOf(identity);
    const b = readCase(sh, org, { number: id, doneWhenField });
    return b ? writeBrief(id, b) : null;
  }

  // The overlay only: what Foreman knows that Salesforce does not (yet).
  function record(id, { status, fields = {}, note, event } = {}) {
    const ov = overlay.load(id);
    if (status !== undefined) ov.status = status;
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'blockedBy') ov.blockedBy = value;
      else ov.fields[name] = value;
    }
    if (note) ov.notes.unshift({ date: localDate(now()), text: note });
    if (event) ov.lastEvent = { event, note: note ?? '' };
    overlay.write(id, ov);
  }

  const withCase = (id, caseId) => ({ key: id, ...(caseId ? { caseId } : {}) });

  function update(id, change = {}) {
    const snap = snapshot({ fallback: true });
    const found = caseOf(snap, id);
    if (!found) return false;
    const last = overlay.read(id)?.lastEvent;
    const repeat = !!change.event && last?.event === change.event && last?.note === (change.note ?? '');
    const at = withCase(id, found.caseId);
    const ops = [];
    // The depends_on list is always sent, as Jira's links are: whatever the switches, and for a repeat.
    if (dependsOnField && Array.isArray(change.fields?.dependsOn)) {
      ops.push({ kind: 'field', ...at, field: dependsOnField, value: [...new Set(change.fields.dependsOn.map(String))] });
    }
    record(id, change);
    if (!repeat) {
      if (features.salesforceComments === true && nonEmpty(change.note)) ops.push({ kind: 'comment', ...at, body: `Foreman: ${change.note}`.slice(0, COMMENT_LIMIT) });
      const name = change.event ? statuses[change.event] : undefined;
      if (features.salesforceStatuses === true && nonEmpty(name)) ops.push({ kind: 'status', ...at, name });
    }
    send(ops);
    return true;
  }

  // A story note as a private comment: see the header. A write the org does not take is queued, and
  // note() throws only from a source that polls: a poll that fails for a Case never seen before, or
  // the org's identity error ('not a sandbox' or 'another org ID') for any Case. The story-note
  // engine keeps the entry and retries it, so this is safe.
  function note(id, { title, summary, text } = {}) {
    const found = caseOf(snapshot({ fallback: true }), id);
    // A story Foreman tracked (it has an overlay) counts even when the filter no longer lists it:
    // a shipped story still gets the follow-ups made from it.
    if (!found && overlay.read(id) === null) return false;
    if (features.salesforceComments !== true) return true;
    const body = [summary, text].filter(nonEmpty).map((t) => String(t).trim()).join('\n\n');
    const at = withCase(id, found?.caseId);
    send(commentParts(String(title ?? 'note'), body, COMMENT_LIMIT).map((part) => ({ kind: 'comment', ...at, body: part })));
    return true;
  }

  // A poll that ignores pollSeconds (the worker's); gives the number of Cases.
  function refresh() {
    return snapshot({ force: true }).cases.length;
  }

  // Nothing to carry into the story's commit: the Case lives in Salesforce.
  const finalize = (id) => (known(id) ? { path: null } : null);

  return { list, update, note, brief, finalize, refresh, flush: () => send([]), idPattern, groupLabel: 'Group', org, pollSeconds: options.pollSeconds ?? DEFAULT_POLL_SECONDS };
}
