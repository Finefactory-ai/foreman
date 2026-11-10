import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  API_VERSION, CASE_ID, COMMENT_LIMIT, DEFAULT_ID_PATTERN, FIELD, LIST_LIMIT, SAFE_NUMBER, SF_TIMEOUT_MS,
  caseDescribe, checkOrg, dependencyNumbers, describeCaseOp, instanceUrlOf, listQuery, listViewTail, readCase, readCases, sendCaseWrites, whereTail,
} from './cases.mjs';
import { ACME_QA_ID, ACME_UAT_ID, sfError } from '../../../test/fake-sf.mjs';
import { TIMEOUT, fakeCasesOrg } from '../../../test/fake-sf-cases.mjs';

const ORG = 'acme-qa';

describe('cases: constants and queries', () => {
  it('has the documented limits and patterns', () => {
    expect({ DEFAULT_ID_PATTERN, LIST_LIMIT, API_VERSION, COMMENT_LIMIT, SF_TIMEOUT_MS }).toEqual({ DEFAULT_ID_PATTERN: '\\d{8,10}', LIST_LIMIT: 200, API_VERSION: '62.0', COMMENT_LIMIT: 4000, SF_TIMEOUT_MS: 60_000 });
    expect(FIELD.test('Done_When__c')).toBe(true);
    expect(FIELD.test('1abc')).toBe(false);
    expect(FIELD.test("a'b")).toBe(false);
    expect(SAFE_NUMBER.test('00001026')).toBe(true);
    expect(SAFE_NUMBER.test("1' OR '1")).toBe(false);
    expect(CASE_ID.test('500000000000001AAA')).toBe(true);
    expect(CASE_ID.test('500000000000001')).toBe(true);
    expect(CASE_ID.test("500'; DROP")).toBe(false);
  });

  it('listQuery lists each field once', () => {
    expect(listQuery({ fields: ['Id', 'Subject', 'Id'], tail: 'WHERE (x) LIMIT 200' })).toBe('SELECT Id, Subject FROM Case WHERE (x) LIMIT 200');
  });

  it('whereTail wraps the filter, orders and limits', () => {
    expect(whereTail({ where: "IsClosed = false AND Type = 'Foreman'" })).toBe("WHERE (IsClosed = false AND Type = 'Foreman') ORDER BY CreatedDate ASC LIMIT 200");
    expect(whereTail({ where: 'a = 1', orderBy: 'Priority DESC, CreatedDate' })).toBe('WHERE (a = 1) ORDER BY Priority DESC, CreatedDate LIMIT 200');
  });

  it('dependencyNumbers splits on spaces, commas and semicolons, keeps only ids, once each', () => {
    expect(dependencyNumbers('00000001, 00000002;00000001 junk 12', DEFAULT_ID_PATTERN)).toEqual(['00000001', '00000002']);
    expect(dependencyNumbers(null, DEFAULT_ID_PATTERN)).toEqual([]);
    expect(dependencyNumbers("00000001' OR '1", DEFAULT_ID_PATTERN)).toEqual([]);
  });

  it('describeCaseOp says each write in words', () => {
    expect(describeCaseOp({ kind: 'comment', key: '00001026' })).toBe('a comment on 00001026');
    expect(describeCaseOp({ kind: 'status', key: '00001026', name: 'Working' })).toBe('the status of 00001026 to Working');
    expect(describeCaseOp({ kind: 'field', key: '00001026', field: 'Depends_On__c' })).toBe('the field Depends_On__c of 00001026');
    expect(describeCaseOp({})).toBe('a write');
  });
});

describe('cases: listViewTail', () => {
  const view = (soql) => {
    const org = fakeCasesOrg();
    org.addListView('Foreman_Stories', soql);
    return org;
  };

  it('takes what follows FROM Case, keeps USING SCOPE, and replaces the LIMIT', () => {
    const org = view("SELECT Id, CaseNumber FROM Case USING SCOPE everything WHERE Type = 'Foreman' ORDER BY CaseNumber LIMIT 25");
    expect(listViewTail(org.sh, ORG, 'Foreman_Stories')).toEqual({ ok: true, tail: "USING SCOPE everything WHERE Type = 'Foreman' ORDER BY CaseNumber LIMIT 200" });
  });

  it('adds a LIMIT when the view has none', () => {
    const org = view('SELECT Id FROM Case WHERE IsClosed = false');
    expect(listViewTail(org.sh, ORG, 'Foreman_Stories').tail).toBe('WHERE IsClosed = false LIMIT 200');
  });

  it('reads the describe without --json, through the REST API at the pinned version', () => {
    const org = view('SELECT Id FROM Case');
    listViewTail(org.sh, ORG, 'Foreman_Stories');
    const rest = org.calls.find((c) => c.args[0] === 'api');
    expect(rest.json).toBe(false);
    expect(rest.args.slice(0, 4)).toEqual(['api', 'request', 'rest', expect.stringMatching(/^\/services\/data\/v62\.0\/sobjects\/Case\/listviews\/00B\w+\/describe$/)]);
    expect(rest.args).toContain('--target-org');
  });

  it('names a view that does not exist', () => {
    const r = listViewTail(fakeCasesOrg().sh, ORG, 'Missing_View');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Missing_View');
  });

  it('never puts a name that is not a field name into a query', () => {
    const org = fakeCasesOrg();
    const r = listViewTail(org.sh, ORG, "x' OR Id != '");
    expect(r.ok).toBe(false);
    expect(org.calls).toEqual([]);
  });

  it('passes an sf failure through with its code', () => {
    const org = view('SELECT Id FROM Case');
    org.failNext('FROM ListView', TIMEOUT);
    expect(listViewTail(org.sh, ORG, 'Foreman_Stories')).toMatchObject({ ok: false, code: 'timeout' });
  });
});

describe('cases: checkOrg', () => {
  it('is ok for the sandbox with the org ID salesforce.orgs names (15 or 18 characters)', () => {
    expect(checkOrg(fakeCasesOrg().sh, ORG, ACME_QA_ID)).toEqual({ ok: true });
    expect(checkOrg(fakeCasesOrg().sh, ORG, ACME_QA_ID.slice(0, 15))).toEqual({ ok: true });
  });

  it('refuses an org whose server says it is not a sandbox', () => {
    const r = checkOrg(fakeCasesOrg({ sandbox: false }).sh, ORG, ACME_QA_ID);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('acme-qa is not a sandbox; Foreman never reads stories from a production org');
  });

  it('refuses another org than the one named', () => {
    const r = checkOrg(fakeCasesOrg({ orgId: ACME_UAT_ID }).sh, ORG, ACME_QA_ID);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toBe(`acme-qa is org ${ACME_UAT_ID.slice(0, 15)}, not the org ID salesforce.orgs names`);
  });

  it('passes an sf failure through with its code, and uses the time limit', () => {
    const org = fakeCasesOrg();
    org.failNext('FROM Organization', TIMEOUT);
    expect(checkOrg(org.sh, ORG, ACME_QA_ID)).toMatchObject({ ok: false, code: 'timeout' });
    expect(org.sh.calls[0].opts.timeout).toBe(SF_TIMEOUT_MS + 15_000);
  });

  it('does not name a username an sf error holds', () => {
    const org = fakeCasesOrg();
    org.failNext('FROM Organization', sfError('NamedOrgNotFoundError', 'No authorization information found for admin@acme.example.'));
    const r = checkOrg(org.sh, ORG, ACME_QA_ID);
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('admin@acme.example');
  });
});

describe('cases: readCases', () => {
  const org = () => {
    const o = fakeCasesOrg();
    o.addCase({ number: '00000001', subject: 'First', fields: { Depends_On__c: '00000002, 00000050, 00000060, 99', Type: 'Owner task' } });
    o.addCase({ number: '00000002', subject: 'Second', closed: true, status: 'Closed' });
    o.addCase({ number: '00000050', subject: 'Outside closed', closed: true, status: 'Closed', listed: false });
    o.addCase({ number: '00000060', subject: 'Outside open', listed: false });
    return o;
  };
  const tail = whereTail({ where: 'IsClosed = false' });

  it('reads the Cases in order, and looks up the dependencies outside the list in one query', () => {
    const o = org();
    const { cases, outside } = readCases(o.sh, ORG, { tail, ownerField: 'Type', dependsOnField: 'Depends_On__c', idPattern: DEFAULT_ID_PATTERN });
    expect(cases.map((c) => c.key)).toEqual(['00000001', '00000002']);
    expect(cases[0]).toMatchObject({ title: 'First', closed: false, status: 'New', ownerRaw: 'Owner task', depsRaw: '00000002, 00000050, 00000060, 99' });
    expect(cases[0].caseId).toMatch(CASE_ID);
    expect(outside).toEqual({ '00000050': 'done', '00000060': 'open' });
    const queries = o.queries();
    expect(queries[0]).toBe(`SELECT Id, CaseNumber, Subject, IsClosed, Status, Type, Depends_On__c FROM Case ${tail}`);
    expect(queries[1]).toBe("SELECT CaseNumber, IsClosed FROM Case WHERE CaseNumber IN ('00000050', '00000060')");
    expect(queries).toHaveLength(2);
  });

  it('marks a dependency Salesforce does not show as null', () => {
    const o = fakeCasesOrg();
    o.addCase({ number: '00000001', fields: { Depends_On__c: '00000077' } });
    const { outside } = readCases(o.sh, ORG, { tail, dependsOnField: 'Depends_On__c', idPattern: DEFAULT_ID_PATTERN });
    expect(outside).toEqual({ '00000077': null });
  });

  it('makes no second query when nothing depends on a Case outside the list', () => {
    const o = fakeCasesOrg();
    o.addCase({ number: '00000001' });
    readCases(o.sh, ORG, { tail, dependsOnField: 'Depends_On__c', idPattern: DEFAULT_ID_PATTERN });
    expect(o.queries()).toHaveLength(1);
  });

  it('throws an error that carries the sf code', () => {
    const o = org();
    o.failNext('FROM Case', TIMEOUT);
    expect(() => readCases(o.sh, ORG, { tail, idPattern: DEFAULT_ID_PATTERN })).toThrowError(expect.objectContaining({ code: 'timeout' }));
  });

  it('leaves a field name that is not a field out of the query', () => {
    const o = org();
    readCases(o.sh, ORG, { tail, ownerField: "Type FROM User --", idPattern: DEFAULT_ID_PATTERN });
    expect(o.queries()[0]).not.toContain('FROM User');
  });
});

describe('cases: readCase', () => {
  it('reads one Case by number with its last comments', () => {
    const o = fakeCasesOrg();
    o.addCase({ number: '00000001', subject: 'First', description: 'Build it.', fields: { Done_When__c: '<p>Works</p>' } });
    const id = o.caseId('00000001');
    const c = readCase(o.sh, ORG, { number: '00000001', doneWhenField: 'Done_When__c' });
    expect(c).toMatchObject({ key: '00000001', caseId: id, title: 'First', description: 'Build it.', doneWhen: '<p>Works</p>', closed: false, status: 'New', comments: [] });
    expect(o.queries()[0]).toBe("SELECT Id, CaseNumber, Subject, Description, IsClosed, Status, Done_When__c FROM Case WHERE CaseNumber = '00000001' LIMIT 1");
    expect(o.queries()[1]).toBe(`SELECT CommentBody, CreatedDate, CreatedBy.Name FROM CaseComment WHERE ParentId = '${id}' AND CreatedBy.UserType = 'Standard' ORDER BY CreatedDate DESC LIMIT 10`);
  });

  it('is null for a Case that is not there', () => {
    expect(readCase(fakeCasesOrg().sh, ORG, { number: '00000009' })).toBeNull();
  });

  it('makes no call for a number that is not safe in a query', () => {
    const o = fakeCasesOrg();
    expect(readCase(o.sh, ORG, { number: "1' OR '1'='1" })).toBeNull();
    expect(o.calls).toEqual([]);
  });

  it('asks for no comments when the Id sf gave is not an Id', () => {
    const o = fakeCasesOrg();
    o.addCase({ number: '00000001' });
    o.failNext("CaseNumber = '00000001'", { status: 0, stdout: JSON.stringify({ status: 0, result: { records: [{ Id: "x' OR '1", CaseNumber: '00000001', Subject: 'S', IsClosed: false, Status: 'New' }], totalSize: 1, done: true } }), stderr: '' });
    const c = readCase(o.sh, ORG, { number: '00000001' });
    expect(c.comments).toEqual([]);
    expect(o.queries()).toHaveLength(1);
  });
});

describe('cases: caseDescribe', () => {
  it('gives the field names and the active Status values', () => {
    const o = fakeCasesOrg();
    const d = caseDescribe(o.sh, ORG);
    expect(d.ok).toBe(true);
    expect(d.fields.has('Depends_On__c')).toBe(true);
    expect(d.statuses).toEqual(['New', 'Working', 'Escalated', 'On Hold', 'Closed']);
    expect(o.calls[0].args.slice(0, 5)).toEqual(['sobject', 'describe', '--sobject', 'Case', '--target-org']);
  });

  it('gives sf failure as an error', () => {
    const o = fakeCasesOrg();
    o.failNext('sobject describe', TIMEOUT);
    expect(caseDescribe(o.sh, ORG)).toMatchObject({ ok: false, code: 'timeout' });
  });
});

describe('cases: instanceUrlOf', () => {
  it('gives the https URL of the alias from the org list', () => {
    expect(instanceUrlOf(fakeCasesOrg().sh, ORG)).toBe('https://acme--qa.sandbox.my.salesforce.com');
  });
  it('gives nothing for a URL that is not https, or an alias that is not listed', () => {
    expect(instanceUrlOf(fakeCasesOrg({ instanceUrl: 'http://acme.example' }).sh, ORG)).toBe('');
    expect(instanceUrlOf(fakeCasesOrg().sh, 'acme-other')).toBe('');
  });
});

describe('cases: sendCaseWrites', () => {
  const orgWithCase = () => {
    const o = fakeCasesOrg();
    o.addCase({ number: '00000001' });
    return o;
  };
  const comment = (o, body = 'Foreman: hello') => ({ kind: 'comment', key: '00000001', caseId: o.caseId('00000001'), body });

  it('posts a comment as a private CaseComment through data import tree', () => {
    const o = orgWithCase();
    expect(sendCaseWrites(o.sh, ORG, [comment(o)])).toEqual([{ status: 'sent' }]);
    expect(o.comments('00000001')).toEqual([{ body: 'Foreman: hello', published: false }]);
    const call = o.calls.at(-1);
    expect(call.args.slice(0, 4)).toEqual(['data', 'import', 'tree', '--files']);
    expect(call.args).toContain('--target-org');
  });

  it('removes its temporary folder after a comment, sent or not', () => {
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-case-tmp-'));
    vi.stubEnv('TMPDIR', mine);
    try {
      const o = orgWithCase();
      sendCaseWrites(o.sh, ORG, [comment(o)]);
      o.failNext('data import tree', TIMEOUT);
      sendCaseWrites(o.sh, ORG, [comment(o)]);
      const files = o.calls.filter((c) => c.line.startsWith('data import tree')).map((c) => c.args[c.args.indexOf('--files') + 1]);
      expect(files).toHaveLength(2);
      for (const f of files) expect(f.startsWith(mine + path.sep)).toBe(true);
      expect(fs.readdirSync(mine)).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(mine, { recursive: true, force: true });
    }
  });

  it('sets a Status, and a field to the numbers joined by ", "', () => {
    const o = orgWithCase();
    const caseId = o.caseId('00000001');
    const r = sendCaseWrites(o.sh, ORG, [
      { kind: 'status', key: '00000001', caseId, name: 'Working' },
      { kind: 'field', key: '00000001', caseId, field: 'Depends_On__c', value: ['00000002', '00000003'] },
    ]);
    expect(r).toEqual([{ status: 'sent' }, { status: 'sent' }]);
    expect(o.statusOf('00000001')).toBe('Working');
    expect(o.fieldOf('00000001', 'Depends_On__c')).toBe('00000002, 00000003');
    const values = o.calls.filter((c) => c.args[1] === 'update').map((c) => c.args[c.args.indexOf('--values') + 1]);
    expect(values).toEqual(["Status='Working'", "Depends_On__c='00000002, 00000003'"]);
  });

  it('is failed for a timeout, an unreachable org and a lapsed sign-in', () => {
    const cases = [
      [TIMEOUT, 'timed out'],
      [sfError('Error', 'getaddrinfo ENOTFOUND acme.my.salesforce.com'), 'ENOTFOUND'],
      [sfError('NamedOrgNotFoundError', 'No authorization information found for acme-qa.'), 'No authorization'],
    ];
    for (const [answer, text] of cases) {
      const o = orgWithCase();
      o.failNext('data import tree', answer);
      const [r] = sendCaseWrites(o.sh, ORG, [comment(o)]);
      expect(r.status).toBe('failed');
      expect(r.error).toContain(text);
    }
  });

  it('is failed, with no further call, for a login that stopped sf', () => {
    const o = orgWithCase();
    o.failNext('data import tree', { status: 1, stdout: JSON.stringify({ name: 'Error', message: 'x', cause: 'invalid_grant' }), stderr: '' });
    const caseId = o.caseId('00000001');
    const r = sendCaseWrites(o.sh, ORG, [comment(o), { kind: 'status', key: '00000001', caseId, name: 'Working' }]);
    expect(r.map((x) => x.status)).toEqual(['failed', 'failed']);
    expect(o.statusOf('00000001')).toBe('New');
    expect(o.calls.filter((c) => c.args[1] === 'update')).toEqual([]);
  });

  it('stops at the first failure: later writes wait behind it, in order', () => {
    const o = orgWithCase();
    o.failNext('data import tree', TIMEOUT);
    const caseId = o.caseId('00000001');
    const r = sendCaseWrites(o.sh, ORG, [comment(o), { kind: 'status', key: '00000001', caseId, name: 'Working' }]);
    expect(r.map((x) => x.status)).toEqual(['failed', 'failed']);
    expect(o.statusOf('00000001')).toBe('New');
  });

  it('drops a status the org refuses (a restricted picklist)', () => {
    const o = orgWithCase();
    const [r] = sendCaseWrites(o.sh, ORG, [{ kind: 'status', key: '00000001', caseId: o.caseId('00000001'), name: 'Nonsense' }]);
    expect(r.status).toBe('dropped');
    expect(r.error).toContain('restricted picklist');
  });

  it('drops a write whose Case Id is not an Id, without a call', () => {
    const o = orgWithCase();
    const r = sendCaseWrites(o.sh, ORG, [
      { kind: 'comment', key: '00000001', caseId: "5'; DELETE", body: 'x' },
      { kind: 'status', key: '00000001', caseId: 'nope', name: 'Working' },
    ]);
    expect(r.map((x) => x.status)).toEqual(['dropped', 'dropped']);
    expect(o.calls).toEqual([]);
  });

  it('drops a write with a field, value or status that is not safe, without a call', () => {
    const o = orgWithCase();
    const caseId = o.caseId('00000001');
    const r = sendCaseWrites(o.sh, ORG, [
      { kind: 'field', key: '00000001', caseId, field: "Depends_On__c' OR", value: ['00000002'] },
      { kind: 'field', key: '00000001', caseId, field: 'Depends_On__c', value: ["1' OR '1"] },
      { kind: 'status', key: '00000001', caseId, name: "Wor'king" },
      { kind: 'what' },
    ]);
    expect(r.map((x) => x.status)).toEqual(['dropped', 'dropped', 'dropped', 'dropped']);
    expect(o.calls).toEqual([]);
  });

  it('finds the Case by number when the write has no Id (a note on a Case the filter dropped)', () => {
    const o = orgWithCase();
    const r = sendCaseWrites(o.sh, ORG, [{ kind: 'comment', key: '00000001', body: 'Foreman: late' }]);
    expect(r).toEqual([{ status: 'sent' }]);
    expect(o.comments('00000001')).toHaveLength(1);
  });

  it('drops a write on a number that is not a Case', () => {
    const o = orgWithCase();
    const [r] = sendCaseWrites(o.sh, ORG, [{ kind: 'comment', key: '00000099', body: 'x' }]);
    expect(r.status).toBe('dropped');
    expect(r.error).toContain('00000099');
  });
});
