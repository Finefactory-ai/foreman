// The sf calls behind the Salesforce story source (lib/adapters/stories/salesforce.mjs): Cases
// read from one sandbox, and the comments, Status changes and field writes made on them. Every
// call goes through runSf (sf.mjs) with the sh the caller gives, which is the isolated sf home's
// (isolation.mjs isolatedSh), never the owner's ~/.sf. Everything here is synchronous and keeps
// no state: the story source holds the cache, the overlay and the outbox.
//
//   listQuery({ fields, tail })     SELECT <fields, once each> FROM Case <tail>
//   whereTail({ where, orderBy })   WHERE (<where>) ORDER BY <orderBy, CreatedDate ASC> LIMIT 200
//   listViewTail(sh, org, name)     { ok: true, tail } or { ok: false, error, code? }: the SOQL a
//                                   Case list view holds, from the first FROM Case on (USING SCOPE
//                                   kept), its LIMIT replaced by 200. Two calls: the view's Id,
//                                   then its describe through the REST API (read without --json,
//                                   which `sf api request rest` does not take)
//   checkOrg(sh, org, orgId)        { ok: true } only when the server says the org is a sandbox
//                                   and its org ID (15 characters) is the one salesforce.orgs
//                                   names; else { ok: false, error, code? }. A wrong answer (not a
//                                   sandbox, another org ID) also has identity: true, which tells
//                                   it from an org that could not be reached
//   readCases(sh, org, opts)        { cases: [{ key, caseId, title, closed, status, ownerRaw,
//                                   depsRaw }], outside: { number: 'done' | 'open' | null } }; the
//                                   dependencies not in the list are looked up in one more query.
//                                   Throws an Error that carries sf's code (timeout, auth, ...)
//   readCase(sh, org, { number, doneWhenField })
//                                   one Case with its description and its last 10 comments by
//                                   internal users (CreatedBy.UserType Standard), or null
//   caseDescribe(sh, org)           { ok: true, fields: Set of names, statuses: active Status
//                                   values } or { ok: false, error, code? }
//   instanceUrlOf(sh, org)          the https URL of the org from the home's `sf org list`, or ''
//   sendCaseWrites(sh, org, ops)    one result per write: { status: 'sent' }, or { status:
//                                   'failed' | 'dropped', error }. Failed (a timeout, an
//                                   unreachable org, a lapsed sign-in, a login limit) is worth
//                                   trying again, and the writes after it are not tried now, so
//                                   the order holds; dropped (the org refused the write, or it was
//                                   not safe to send) is not
//   describeCaseOp(op)              a write in words, for events
//
// A write is { kind: 'comment', key, caseId?, body }, { kind: 'status', key, caseId?, name } or
// { kind: 'field', key, caseId?, field, value: [numbers] }. A comment is always private
// (IsPublished false): customers never see Foreman's notes. Without a caseId the Case is found by
// its number, so a note on a Case the filter no longer lists still lands.
//
// Nothing goes into a query unless it is safe there: a Case number passes SAFE_NUMBER, an Id
// CASE_ID, a field name FIELD, a Status name has no quote, backslash or newline. A value that is
// not is dropped before any sf call. sf's messages are kept to their first 300 characters by runSf
// and have any word holding an @ (a username) replaced, since a result, a token or a username
// is never shown or logged.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orgQuery, listOrgs } from './isolation.mjs';
import { isNotSignedIn, isUnreachable, runSf, stopsRetry } from './sf.mjs';

export const DEFAULT_ID_PATTERN = '\\d{8,10}';
export const LIST_LIMIT = 200;
export const API_VERSION = '62.0';
// The most characters CaseComment.CommentBody takes.
export const COMMENT_LIMIT = 4000;
// Every sf call here is given this long.
export const SF_TIMEOUT_MS = 60_000;
export const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
export const SAFE_NUMBER = /^[A-Za-z0-9-]+$/;
export const CASE_ID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;

const COMMENTS_READ = 10;
const OUTSIDE_LIMIT = 200;
const GROUPS = ['nonScratchOrgs', 'sandboxes', 'scratchOrgs', 'devHubs', 'other'];
const UNSAFE_NAME = /['"\\\r\n]/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');
const options = { timeoutMs: SF_TIMEOUT_MS };
const unique = (list) => [...new Set(list)];
const rowsOf = (r) => (isObject(r.result) && Array.isArray(r.result.records) ? r.result.records.filter(isObject) : []);
// A word holding an @ is a username, or a file named after one.
const scrub = (message) => String(message ?? '').replace(/\S+@\S+/g, 'an org');
const failure = (r) => ({ ok: false, error: scrub(r.error?.message ?? 'no answer from sf'), ...(r.code ? { code: r.code } : {}) });
const fault = (r) => Object.assign(new Error(failure(r).error), r.code ? { code: r.code } : {});

const query = (sh, org, soql, extra = {}) => runSf(sh, ['data', 'query', '--query', soql, '--target-org', org], { ...options, ...extra });

export const listQuery = ({ fields, tail }) => `SELECT ${unique(fields).join(', ')} FROM Case ${tail}`;

export const whereTail = ({ where, orderBy }) => `WHERE (${where}) ORDER BY ${orderBy ?? 'CreatedDate ASC'} LIMIT ${LIST_LIMIT}`;

export function listViewTail(sh, org, name) {
  if (typeof name !== 'string' || !FIELD.test(name)) return { ok: false, error: 'the list view name is not a valid name' };
  const found = query(sh, org, `SELECT Id FROM ListView WHERE SobjectType = 'Case' AND DeveloperName = '${name}' LIMIT 1`);
  if (!found.ok) return failure(found);
  const id = text(rowsOf(found)[0]?.Id);
  if (!CASE_ID.test(id)) return { ok: false, error: `no Case list view named ${name} in ${org}` };
  const view = runSf(sh, ['api', 'request', 'rest', `/services/data/v${API_VERSION}/sobjects/Case/listviews/${id}/describe`, '--target-org', org], { ...options, jsonFlag: false });
  if (!view.ok) return failure(view);
  const soql = isObject(view.result) ? text(view.result.query) : '';
  const from = /\sFROM\s+Case\b/i.exec(soql);
  if (!from) return { ok: false, error: `the list view ${name} gave no query on Case` };
  const rest = soql.slice(from.index + from[0].length).replace(/\s+LIMIT\s+\d+\s*$/i, '').trim();
  return { ok: true, tail: `${rest} LIMIT ${LIST_LIMIT}`.trim() };
}

export function checkOrg(sh, org, orgId) {
  const r = orgQuery(sh, org, options);
  if (!r.ok) return failure(r);
  const record = rowsOf(r)[0];
  if (record?.IsSandbox !== true) return { ok: false, identity: true, error: `${org} is not a sandbox; Foreman never reads stories from a production org` };
  const id = text(record.Id).slice(0, 15);
  if (typeof orgId !== 'string' || orgId === '' || id !== orgId.slice(0, 15)) return { ok: false, identity: true, error: `${org} is org ${id}, not the org ID salesforce.orgs names` };
  return { ok: true };
}

/** The case numbers a dependency field holds that match the id pattern, once each. */
export function dependencyNumbers(raw, idPattern = DEFAULT_ID_PATTERN) {
  const whole = new RegExp(`^(?:${idPattern})$`);
  return unique(String(raw ?? '').split(/[\s,;]+/).filter((n) => n !== '' && SAFE_NUMBER.test(n) && whole.test(n)));
}

export function readCases(sh, org, { tail, ownerField, dependsOnField, idPattern = DEFAULT_ID_PATTERN }) {
  const fields = ['Id', 'CaseNumber', 'Subject', 'IsClosed', 'Status', ownerField, dependsOnField].filter((f) => typeof f === 'string' && FIELD.test(f));
  const r = query(sh, org, listQuery({ fields, tail }));
  if (!r.ok) throw fault(r);
  const cases = rowsOf(r)
    .filter((row) => typeof row.CaseNumber === 'string' && typeof row.Id === 'string')
    .map((row) => ({
      key: row.CaseNumber,
      caseId: row.Id,
      title: text(row.Subject),
      closed: row.IsClosed === true,
      status: text(row.Status),
      ownerRaw: ownerField && row[ownerField] !== undefined ? row[ownerField] : null,
      depsRaw: dependsOnField && row[dependsOnField] != null ? String(row[dependsOnField]) : '',
    }));

  const listed = new Set(cases.map((c) => c.key));
  const wanted = unique(cases.flatMap((c) => dependencyNumbers(c.depsRaw, idPattern))).filter((n) => !listed.has(n)).slice(0, OUTSIDE_LIMIT);
  const outside = {};
  if (wanted.length) {
    const found = query(sh, org, `SELECT CaseNumber, IsClosed FROM Case WHERE CaseNumber IN (${wanted.map((n) => `'${n}'`).join(', ')})`);
    if (!found.ok) throw fault(found);
    const seen = new Map(rowsOf(found).map((row) => [row.CaseNumber, row.IsClosed === true]));
    for (const n of wanted) outside[n] = seen.has(n) ? (seen.get(n) ? 'done' : 'open') : null;
  }
  return { cases, outside };
}

export function readCase(sh, org, { number, doneWhenField } = {}) {
  if (typeof number !== 'string' || !SAFE_NUMBER.test(number)) return null;
  const fields = ['Id', 'CaseNumber', 'Subject', 'Description', 'IsClosed', 'Status', ...(typeof doneWhenField === 'string' && FIELD.test(doneWhenField) ? [doneWhenField] : [])];
  const r = query(sh, org, `SELECT ${unique(fields).join(', ')} FROM Case WHERE CaseNumber = '${number}' LIMIT 1`);
  if (!r.ok) throw fault(r);
  const row = rowsOf(r)[0];
  if (!row) return null;
  const caseId = text(row.Id);
  let comments = [];
  if (CASE_ID.test(caseId)) {
    const c = query(sh, org, `SELECT CommentBody, CreatedDate, CreatedBy.Name FROM CaseComment WHERE ParentId = '${caseId}' AND CreatedBy.UserType = 'Standard' ORDER BY CreatedDate DESC LIMIT ${COMMENTS_READ}`);
    if (!c.ok) throw fault(c);
    comments = rowsOf(c).map((x) => ({ author: text(x.CreatedBy?.Name) || 'someone', created: text(x.CreatedDate), body: text(x.CommentBody) }));
  }
  return {
    key: text(row.CaseNumber) || number,
    caseId,
    title: text(row.Subject),
    description: text(row.Description),
    closed: row.IsClosed === true,
    status: text(row.Status),
    doneWhen: typeof doneWhenField === 'string' && row[doneWhenField] != null ? String(row[doneWhenField]) : '',
    comments,
  };
}

export function caseDescribe(sh, org) {
  const r = runSf(sh, ['sobject', 'describe', '--sobject', 'Case', '--target-org', org], options);
  if (!r.ok) return failure(r);
  const fields = isObject(r.result) && Array.isArray(r.result.fields) ? r.result.fields.filter(isObject) : [];
  const status = fields.find((f) => f.name === 'Status');
  const values = Array.isArray(status?.picklistValues) ? status.picklistValues.filter((v) => isObject(v) && v.active !== false && typeof v.value === 'string') : [];
  return { ok: true, fields: new Set(fields.map((f) => f.name).filter((n) => typeof n === 'string')), statuses: values.map((v) => v.value) };
}

export function instanceUrlOf(sh, org) {
  const r = listOrgs(sh);
  if (!r.ok || !isObject(r.result)) return '';
  for (const group of GROUPS) {
    for (const entry of Array.isArray(r.result[group]) ? r.result[group] : []) {
      if (isObject(entry) && entry.alias === org && typeof entry.instanceUrl === 'string' && entry.instanceUrl.startsWith('https://')) return entry.instanceUrl.replace(/\/+$/, '');
    }
  }
  return '';
}

export function describeCaseOp(op) {
  if (op?.kind === 'comment') return `a comment on ${op.key}`;
  if (op?.kind === 'status') return `the status of ${op.key} to ${op.name}`;
  if (op?.kind === 'field') return `the field ${op.field} of ${op.key}`;
  return 'a write';
}

// Whether the failed call is worth trying again later.
const retryable = (r) => stopsRetry(r) || r.code === 'timeout' || isUnreachable(r.error) || isNotSignedIn(r.error);

// The Id of the Case a write is for: the one it carries, else the one its number finds.
function caseIdOf(sh, org, op) {
  if (op.caseId !== undefined) return CASE_ID.test(String(op.caseId)) ? { id: String(op.caseId) } : { dropped: 'the Case Id is not an Id' };
  if (typeof op.key !== 'string' || !SAFE_NUMBER.test(op.key)) return { dropped: 'the Case number is not safe to look up' };
  const r = query(sh, org, `SELECT Id FROM Case WHERE CaseNumber = '${op.key}' LIMIT 1`);
  if (!r.ok) return { result: r };
  const id = text(rowsOf(r)[0]?.Id);
  return CASE_ID.test(id) ? { id } : { dropped: `there is no Case ${op.key}` };
}

function writeComment(sh, org, caseId, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-case-'));
  try {
    const file = path.join(dir, 'comment.json');
    // IsPublished is always false: a customer never sees Foreman's notes.
    const record = { attributes: { type: 'CaseComment', referenceId: 'c1' }, ParentId: caseId, CommentBody: body, IsPublished: false };
    fs.writeFileSync(file, JSON.stringify({ records: [record] }));
    return runSf(sh, ['data', 'import', 'tree', '--files', file, '--target-org', org], options);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const update = (sh, org, caseId, values) => runSf(sh, ['data', 'update', 'record', '--sobject', 'Case', '--record-id', caseId, '--values', values, '--target-org', org], options);

// The sf call for one write that is safe to send, or why it is not.
function perform(sh, org, op, caseId) {
  if (op.kind === 'comment') {
    if (typeof op.body !== 'string' || op.body.trim() === '') return { dropped: 'the comment is empty' };
    return { r: writeComment(sh, org, caseId, op.body) };
  }
  if (op.kind === 'status') {
    if (typeof op.name !== 'string' || op.name === '' || UNSAFE_NAME.test(op.name)) return { dropped: 'the Status name is not safe to send' };
    return { r: update(sh, org, caseId, `Status='${op.name}'`) };
  }
  if (op.kind === 'field') {
    const numbers = Array.isArray(op.value) ? op.value.map(String) : null;
    if (typeof op.field !== 'string' || !FIELD.test(op.field) || !numbers || !numbers.every((n) => SAFE_NUMBER.test(n))) return { dropped: 'the field or its value is not safe to send' };
    return { r: update(sh, org, caseId, `${op.field}='${numbers.join(', ')}'`) };
  }
  return { dropped: 'not a write Foreman makes' };
}

export function sendCaseWrites(sh, org, ops) {
  const results = [];
  let held = null;
  for (const op of ops) {
    if (held) {
      results.push({ status: 'failed', error: held });
      continue;
    }
    const safe = isObject(op) ? op : {};
    const where = caseIdOf(sh, org, safe);
    let outcome = where.result;
    if (where.dropped) outcome = { dropped: where.dropped };
    else if (where.id) outcome = perform(sh, org, safe, where.id);
    if (outcome.dropped) {
      results.push({ status: 'dropped', error: outcome.dropped });
      continue;
    }
    const r = outcome.r ?? outcome;
    if (r.ok) {
      results.push({ status: 'sent' });
      continue;
    }
    const error = failure(r).error;
    if (retryable(r)) {
      held = error;
      results.push({ status: 'failed', error });
    } else results.push({ status: 'dropped', error });
  }
  return results;
}
