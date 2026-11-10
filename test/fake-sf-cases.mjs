// A fake Salesforce org that holds Cases, for the Salesforce story source's tests. It answers the
// sf calls plugin/packs/salesforce/cases.mjs makes, by regex on the arguments, and is built on
// the fake sh of test/fake-sf.mjs.
//
//   const org = fakeCasesOrg({ orgId, sandbox = true, instanceUrl, alias = 'acme-qa' });
//   org.sh                        the sh to give runSf (also ctx.sh of the story source)
//   org.routes                    the Case calls as routes for acmeSfRoutes(...), see fakeSfShell
//   org.addCase({ number, subject, status, closed, description, fields, listed = true })
//                                 a Case; `fields` are extra columns (Depends_On__c, Type, ...);
//                                 listed: false keeps it out of the filter's answer, but it can
//                                 still be looked up by number
//   org.addListView(name, soql)   a Case list view and the SOQL its describe gives
//   org.addComment(number, { body, author, created, userType = 'Standard', published = false })
//                                 a comment on that Case by a user of that UserType; the CaseComment
//                                 query keeps only 'Standard' ones when it has the filter
//                                 `CreatedBy.UserType = 'Standard'`, and returns all without it
//   org.comments(number)          the comments posted on that Case: [{ body, published }]
//   org.statusOf(number)          the Case's Status now
//   org.fieldOf(number, name)     a field Foreman wrote
//   org.calls                     every sf call: [{ line, args, json }], `line` the args joined
//   org.queries()                 the SOQL of each `data query`, in order
//   org.failNext(match, answer, times = 1)
//                                 the next `times` calls whose line holds `match` get `answer`
//                                 (an sh result such as sfError(...) or TIMEOUT) instead
//   org.setStatuses(list)         the active Status picklist values
//   org.setSandbox(bool)          what the Organization query says from now on (a refresh can change it)
//   org.setOrgId(id)              the org ID the alias answers with from now on
//   org.setFields(names)          the fields `sobject describe` lists
//
// It refuses a comment that is not private (IsPublished other than false) and a list view
// describe with --json, so the code under test cannot get either wrong without a test failing.

import fs from 'node:fs';
import { ACME_QA_ID, acmeOrg, fakeSfShell, orgList, orgRecord, sfError, sfOk, sfRaw } from './fake-sf.mjs';

// What sh gives for a call sf's watcher killed at its time limit.
export const TIMEOUT = { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' };

const DEFAULT_FIELDS = ['Id', 'CaseNumber', 'Subject', 'Description', 'Status', 'IsClosed', 'Type', 'Done_When__c', 'Depends_On__c'];
const DEFAULT_STATUSES = ['New', 'Working', 'Escalated', 'On Hold', 'Closed'];

export function fakeCasesOrg({ orgId: initialOrgId = ACME_QA_ID, sandbox: initialSandbox = true, instanceUrl = 'https://acme--qa.sandbox.my.salesforce.com', alias = 'acme-qa' } = {}) {
  let orgId = initialOrgId;
  let sandbox = initialSandbox;
  const cases = [];
  const views = new Map();
  const calls = [];
  const failures = [];
  let statuses = [...DEFAULT_STATUSES];
  let describeFields = [...DEFAULT_FIELDS];

  const idFor = (n) => `500${String(n).padStart(12, '0')}AAA`;
  const byId = (id) => cases.find((c) => c.Id === id);
  const byNumber = (n) => cases.find((c) => c.CaseNumber === n);
  const record = (c, full = false) => ({
    attributes: { type: 'Case', url: `/services/data/v62.0/sobjects/Case/${c.Id}` },
    Id: c.Id,
    CaseNumber: c.CaseNumber,
    Subject: c.Subject,
    IsClosed: c.IsClosed,
    Status: c.Status,
    ...(full ? { Description: c.Description } : {}),
    ...c.fields,
  });

  function dataQuery(soql) {
    if (/FROM Organization/.test(soql)) return orgRecord(orgId, sandbox);
    let m = /FROM ListView WHERE .*DeveloperName = '([^']*)'/.exec(soql);
    if (m) {
      const rows = views.has(m[1]) ? [{ attributes: { type: 'ListView' }, Id: views.get(m[1]).id }] : [];
      return sfOk({ records: rows, totalSize: rows.length, done: true });
    }
    m = /FROM CaseComment WHERE ParentId = '([^']*)'/.exec(soql);
    if (m) {
      const c = byId(m[1]);
      const internal = soql.includes("CreatedBy.UserType = 'Standard'");
      const rows = (c?.comments ?? [])
        .filter((x) => !internal || x.userType === 'Standard')
        .reverse()
        .slice(0, 10)
        .map((x) => ({ attributes: { type: 'CaseComment' }, CommentBody: x.body, CreatedDate: x.created, CreatedBy: { attributes: { type: 'User' }, Name: x.author } }));
      return sfOk({ records: rows, totalSize: rows.length, done: true });
    }
    m = /FROM Case WHERE CaseNumber IN \(([^)]*)\)/.exec(soql);
    if (m) {
      const numbers = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      const rows = numbers.map(byNumber).filter(Boolean).map((c) => ({ attributes: { type: 'Case' }, CaseNumber: c.CaseNumber, IsClosed: c.IsClosed }));
      return sfOk({ records: rows, totalSize: rows.length, done: true });
    }
    m = /FROM Case WHERE CaseNumber = '([^']*)'/.exec(soql);
    if (m) {
      const c = byNumber(m[1]);
      const rows = c ? [record(c, true)] : [];
      return sfOk({ records: rows, totalSize: rows.length, done: true });
    }
    if (/^SELECT .+ FROM Case /.test(soql)) {
      const rows = cases.filter((c) => c.listed).map((c) => record(c));
      return sfOk({ records: rows, totalSize: rows.length, done: true });
    }
    return sfError('MALFORMED_QUERY', `the fake org does not know: ${soql}`);
  }

  function importTree(args) {
    const file = args[args.indexOf('--files') + 1];
    let body;
    try {
      body = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return sfError('FileError', 'the fake org could not read the file');
    }
    const results = [];
    for (const r of body.records ?? []) {
      if (r.attributes?.type !== 'CaseComment') return sfError('INVALID_TYPE', 'only CaseComment is expected');
      if (r.IsPublished !== false) return sfError('NotPrivate', 'a comment must have IsPublished false');
      const c = byId(r.ParentId);
      if (!c) return sfError('INVALID_CROSS_REFERENCE_KEY', 'no such Case');
      c.comments.push({ body: r.CommentBody, published: r.IsPublished, created: '2026-11-01T10:00:00.000+0000', author: 'Foreman Bot', userType: 'Standard' });
      results.push({ refId: r.attributes.referenceId, type: 'CaseComment', id: '00a000000000001AAA' });
    }
    return sfOk(results);
  }

  function updateRecord(args) {
    const c = byId(args[args.indexOf('--record-id') + 1]);
    if (!c) return sfError('NOT_FOUND', 'no such Case');
    const values = args[args.indexOf('--values') + 1];
    const m = /^([A-Za-z0-9_]+)='(.*)'$/.exec(values);
    if (!m) return sfError('BadValues', 'the fake org could not read --values');
    if (m[1] === 'Status') {
      if (!statuses.includes(m[2])) return sfError('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', `bad value for restricted picklist field: ${m[2]}`);
      c.Status = m[2];
      c.IsClosed = m[2] === 'Closed';
    } else {
      c.fields[m[1]] = m[2];
      c.written[m[1]] = m[2];
    }
    return sfOk({ id: c.Id, success: true, errors: [] });
  }

  function answer(args) {
    const [a, b] = args;
    if (a === 'org' && b === 'list') {
      const entry = acmeOrg(alias, orgId);
      return orgList([{ ...entry, instanceUrl }]);
    }
    if (a === 'sobject' && b === 'describe') {
      return sfOk({
        name: 'Case',
        fields: describeFields.map((name) => ({
          name,
          ...(name === 'Status' ? { picklistValues: [...statuses.map((value) => ({ value, active: true })), { value: 'Retired', active: false }] } : {}),
        })),
      });
    }
    if (a === 'api' && b === 'request') {
      const m = /\/sobjects\/Case\/listviews\/([^/]+)\/describe$/.exec(args[3] ?? '');
      const view = m ? [...views.values()].find((v) => v.id === m[1]) : undefined;
      if (args.includes('--json')) return sfError('JsonFlag', 'the list view describe must be read without --json');
      return view ? sfRaw({ id: view.id, query: view.soql, columns: [] }) : sfError('NOT_FOUND', 'no such list view');
    }
    if (a === 'data' && b === 'import' && args[2] === 'tree') return importTree(args);
    if (a === 'data' && b === 'update' && args[2] === 'record') return updateRecord(args);
    if (a === 'data' && b === 'query') return dataQuery(args[args.indexOf('--query') + 1]);
    return sfError('UnexpectedCommand', `the fake org does not know: ${args.join(' ')}`);
  }

  // One route for every call: it records the call, then answers it (or the failure queued for it).
  const route = (args) => {
    const line = args.join(' ');
    calls.push({ line, args: [...args], json: args.includes('--json') });
    const i = failures.findIndex((f) => f.times > 0 && line.includes(f.match));
    if (i >= 0) {
      failures[i].times -= 1;
      return failures[i].answer;
    }
    return answer(args);
  };
  const sh = fakeSfShell({ '': route });
  // The same answers as routes for fakeSfShell / acmeSfRoutes, for a test that also needs the
  // rest of an Acme org set (the doctor): the Case calls go to this org, the rest to the caller.
  const routes = Object.fromEntries(['FROM Case', 'FROM ListView', 'sobject describe', 'api request', 'data import tree', 'data update record'].map((key) => [key, route]));

  let counter = 0;
  return {
    sh,
    routes,
    calls,
    queries: () => calls.filter((c) => c.args[0] === 'data' && c.args[1] === 'query').map((c) => c.args[c.args.indexOf('--query') + 1]),
    addCase({ number, subject = 'A case', status = 'New', closed = false, description = '', fields = {}, listed = true }) {
      counter += 1;
      cases.push({ Id: idFor(counter), CaseNumber: number, Subject: subject, Status: status, IsClosed: closed, Description: description, fields: { ...fields }, listed, comments: [], written: {} });
    },
    addComment(number, { body, author = 'Someone', created = '2026-11-01T09:00:00.000+0000', userType = 'Standard', published = false } = {}) {
      byNumber(number).comments.push({ body, author, created, userType, published });
    },
    addListView(name, soql) {
      views.set(name, { id: `00B${String(views.size + 1).padStart(12, '0')}AAA`, soql });
    },
    comments: (number) => (byNumber(number)?.comments ?? []).map((c) => ({ body: c.body, published: c.published })),
    statusOf: (number) => byNumber(number)?.Status,
    fieldOf: (number, name) => byNumber(number)?.written[name],
    failNext(match, answerWith, times = 1) {
      failures.push({ match, answer: answerWith, times });
    },
    setStatuses(list) {
      statuses = [...list];
    },
    setSandbox(value) {
      sandbox = value;
    },
    setOrgId(value) {
      orgId = value;
    },
    setFields(names) {
      describeFields = [...names];
    },
    caseId: (number) => byNumber(number)?.Id,
  };
}
