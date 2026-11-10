// Jira issues for the fake Atlassian (test/fake-atlassian.mjs): search with pagination,
// issue get, comments (read and add), transitions (list and apply), issue create and issue
// links (add and delete), over a store of issues the test fills.
//
// Two ways to run it:
//
//   startFakeJira()          the fake in a worker thread. Foreman's Jira story source makes its
//                            calls from a child process and waits for it synchronously, which
//                            blocks this thread, so a fake on this thread could never answer.
//                            The store is a JSON file the worker reads on each request and
//                            writes back after a change, so the test's own changes (addIssue and
//                            the rest) and reads (issue, comments) are synchronous.
//   startFakeJiraHere()      the fake on this thread, for code that calls Jira with await.
//
// Both return { url, cloudId, tokens: { accessToken, refreshToken }, requests(), close(), ...ops }
// where ops are:
//   addIssue({ key, summary, status: 'todo'|'in-progress'|'in-review'|'blocked'|'done', labels,
//              description, fields, inFilter = true })   description is ADF (or anything);
//                                           fields adds raw fields
//   setIssue(key, patch)                    patch the same shape
//   blocks(blocker, blocked)                a standard "Blocks" link, both sides
//   relates(a, b)                           a "Relates" link, both sides
//   addComment(key, { author, created, body })
//   setFilter(jql, keys)                    a search with exactly this JQL returns these keys, in
//                                           this order; any other JQL returns every issue in the
//                                           filter, in the order added
//   setWorkflow({ status: [transition name, ...] })  the transitions each status offers (a name
//                                           is also the status it leads to); WORKFLOW by default
//   setDown(status | false)                 every Jira REST call answers this status (500, say)
//   setDelay(ms)                            every Jira REST call waits this long first
//   refusePriority(on)                      while on, POST /issue with a priority answers 400
//                                           { errors: { priority: "Field 'priority' cannot be
//                                           set." } }, as a project whose create screen has no
//                                           priority does; reset() turns it off
//   reset()                                 empty the store
//   issue(key), comments(key), links()      what the store holds now, written ones included;
//                                           links() as { type, outward, inward }, without ids
// requests() resolves to [{ method, path, query, body }] for the Jira REST calls.
//
// Also GET /project/<key>/statuses -> [{ name: issue type, statuses: [{ name }] }] for a project
// that has issues, and a search whose JQL holds INVALID answers 400, as does one whose maxResults
// is outside 1 to 5000 (real Jira refuses 0).
//
// Search pages hold at most `pageSize` issues (default 50), whatever maxResults asks, as the
// real one may return fewer than asked.
//
// Writes follow the v3 API: POST /issue/<key>/comment { body: ADF } (201); GET
// /issue/<key>/transitions -> { transitions: [{ id, name, to }] } for the issue's status, and
// POST it { transition: { id } } (204, or 400 for one not offered); POST /issue { fields:
// { project: { key }, issuetype: { name }, summary, description, labels, priority? } } -> 201
// { id, key, self }, keeping the priority in the issue's fields when sent; POST /issueLink { type: { name }, inwardIssue: { key }, outwardIssue: { key } } (201),
// read as "outwardIssue <type.outward> inwardIssue", since Jira's docs call the outward issue
// the "from" issue; DELETE /issueLink/<id> (204, or 404 for no such link). Each link keeps the
// id it was given when made (a counter in the store, from 20000), so a delete renumbers none.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { startFakeAtlassian } from './fake-atlassian.mjs';

const CATEGORY = {
  todo: { name: 'To Do', key: 'new' },
  'in-progress': { name: 'In Progress', key: 'indeterminate' },
  'in-review': { name: 'In Review', key: 'indeterminate' },
  blocked: { name: 'Blocked', key: 'indeterminate' },
  done: { name: 'Done', key: 'done' },
};
const STATUS_BY_NAME = Object.fromEntries(Object.entries(CATEGORY).map(([k, c]) => [c.name.toLowerCase(), k]));
const TRANSITION_ID = { todo: '11', 'in-progress': '21', 'in-review': '31', blocked: '41', done: '51' };
/** The transitions each status offers, by name; a name is also the status it leads to. */
export const WORKFLOW = {
  todo: ['In Progress', 'Done'],
  'in-progress': ['To Do', 'In Review', 'Blocked', 'Done'],
  'in-review': ['In Progress', 'To Do', 'Done'],
  blocked: ['In Progress', 'To Do'],
  done: ['To Do'],
};
const BLOCKS = { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' };
const RELATES = { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' };
const LINK_TYPES = { Blocks: BLOCKS, Relates: RELATES };

export const emptyStore = (pageSize = 50) => ({ issues: [], links: [], nextLinkId: 20000, comments: {}, filters: {}, workflow: null, down: false, delayMs: 0, refusePriority: false, pageSize });

/** Adds a link with the store's next link id. */
function addLink(s, type, outward, inward) {
  s.nextLinkId ??= 20000;
  s.links.push({ id: String(s.nextLinkId), type, outward, inward });
  s.nextLinkId += 1;
}

function statusOf(status = 'todo') {
  const c = CATEGORY[status] ?? CATEGORY.todo;
  return { name: c.name, statusCategory: { key: c.key, name: c.name } };
}

/** The operations on a store. `load()` gives the store now; `save(store)` runs after each change. */
export function storeOps(load, save = () => {}) {
  const change = (fn) => {
    const s = load();
    const r = fn(s);
    save(s);
    return r;
  };
  const find = (s, key) => s.issues.find((i) => i.key === key);
  return {
    addIssue: ({ key, summary = key, status = 'todo', labels = [], description = null, fields = {}, inFilter = true }) =>
      change((s) => s.issues.push({ key, summary, status, labels, description, fields, inFilter })),
    setIssue: (key, patch) => change((s) => Object.assign(find(s, key), patch)),
    blocks: (blocker, blocked) => change((s) => addLink(s, BLOCKS, blocker, blocked)),
    relates: (a, b) => change((s) => addLink(s, RELATES, a, b)),
    addComment: (key, c) => change((s) => (s.comments[key] ??= []).push(c)),
    setFilter: (jql, keys) => change((s) => (s.filters[jql] = keys)),
    setWorkflow: (workflow) => change((s) => (s.workflow = workflow)),
    setDown: (status) => change((s) => (s.down = status)),
    setDelay: (ms) => change((s) => (s.delayMs = ms)),
    refusePriority: (on) => change((s) => (s.refusePriority = Boolean(on))),
    reset: () => change((s) => Object.assign(s, emptyStore(s.pageSize))),
    issue: (key) => structuredClone(find(load(), key) ?? null),
    comments: (key) => structuredClone(load().comments[key] ?? []),
    links: () => load().links.map(({ type, outward, inward }) => structuredClone({ type, outward, inward })),
  };
}

// A link { type, outward: X, inward: Y } reads "X <outward> Y" and "Y <inward> X". On Y's
// issue it is { inwardIssue: X } and Jira labels it with type.inward; on X's it is
// { outwardIssue: Y }, labelled with type.outward.
function issueJson(store, issue, wanted) {
  const ref = (key) => {
    const other = store.issues.find((i) => i.key === key);
    return { key, fields: { summary: other?.summary ?? key, status: statusOf(other?.status) } };
  };
  const issuelinks = store.links.flatMap((l) => [
    ...(l.inward === issue.key ? [{ id: l.id, type: l.type, inwardIssue: ref(l.outward) }] : []),
    ...(l.outward === issue.key ? [{ id: l.id, type: l.type, outwardIssue: ref(l.inward) }] : []),
  ]);
  const all = {
    summary: issue.summary,
    status: statusOf(issue.status),
    labels: issue.labels,
    issuelinks,
    description: issue.description,
    parent: undefined,
    ...issue.fields,
  };
  const fields = wanted ? Object.fromEntries(wanted.filter((f) => f in all).map((f) => [f, all[f]])) : all;
  return { id: String(10000 + store.issues.indexOf(issue)), key: issue.key, fields };
}

const notFound = { status: 404, body: { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextKey = (s, project) => {
  const used = s.issues.map((i) => new RegExp(`^${project}-(\\d+)$`).exec(i.key)).filter(Boolean).map((m) => Number(m[1]));
  return `${project}-${Math.max(0, ...used) + 1}`;
};
const offered = (s, issue) =>
  ((s.workflow ?? WORKFLOW)[issue.status] ?? []).map((name) => {
    const to = STATUS_BY_NAME[name.toLowerCase()] ?? 'in-progress';
    return { id: TRANSITION_ID[to] ?? '99', name, to };
  });

/**
 * Adds the Jira issue routes to a fake Atlassian. `store()` gives the current store and
 * `save(store)` keeps a change to it.
 */
export function installJiraRoutes(fake, store, log, save = () => {}) {
  const record = (req, body) => log.push({ method: req.method, path: req.path, query: Object.fromEntries(req.query ?? []), body });
  // Every route: logged, then the store's delay and down switches, then the handler.
  const on = (method, pattern, handler) =>
    fake.route(method, pattern, async (req, m, body) => {
      record(req, body);
      const before = store();
      if (before.delayMs) await sleep(before.delayMs);
      const s = before.delayMs ? store() : before;
      if (s.down) return { status: s.down, body: { errorMessages: ['Jira is having a bad day.'], errors: {} } };
      return handler(req, m, body, s);
    });

  on('POST', /^\/rest\/api\/3\/search\/jql$/, (req, _m, body, s) => {
    if (!body?.jql) return { status: 400, body: { errorMessages: ['JQL query is required.'] } };
    if (/INVALID/.test(body.jql)) return { status: 400, body: { errorMessages: [`Error in the JQL Query: '${body.jql}'`] } };
    if (body.maxResults !== undefined && !(body.maxResults >= 1 && body.maxResults <= 5000)) {
      return { status: 400, body: { errorMessages: ['The max results parameter has to be between 1 and 5,000.'], errors: {} } };
    }
    const keys = s.filters[body.jql];
    const hits = keys ? keys.map((k) => s.issues.find((i) => i.key === k)).filter(Boolean) : s.issues.filter((i) => i.inFilter);
    const start = Number(body.nextPageToken ?? 0);
    const size = Math.min(Number(body.maxResults ?? 50), s.pageSize);
    const page = hits.slice(start, start + size);
    const isLast = start + size >= hits.length;
    const fields = Array.isArray(body.fields) ? body.fields : ['id'];
    return { body: { issues: page.map((i) => issueJson(s, i, fields)), isLast, ...(isLast ? {} : { nextPageToken: String(start + size) }) } };
  });

  on('GET', /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/, (req, m, _b, s) => {
    const key = decodeURIComponent(m[1]);
    if (!s.issues.some((i) => i.key === key)) return notFound;
    const all = [...(s.comments[key] ?? [])].map((c, n) => ({
      id: String(n + 1),
      author: { accountId: `acct-${n}`, displayName: c.author },
      body: c.body,
      created: c.created,
      updated: c.created,
    }));
    const order = req.query.get('orderBy');
    if (order === '-created') all.sort((a, b) => b.created.localeCompare(a.created));
    else all.sort((a, b) => a.created.localeCompare(b.created));
    const max = Number(req.query.get('maxResults') ?? 100);
    return { body: { comments: all.slice(0, max), maxResults: max, startAt: 0, total: all.length } };
  });

  on('POST', /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/, (_req, m, body, s) => {
    const key = decodeURIComponent(m[1]);
    if (!s.issues.some((i) => i.key === key)) return notFound;
    const doc = body?.body;
    if (doc?.type !== 'doc' || doc.version !== 1 || !Array.isArray(doc.content)) {
      return { status: 400, body: { errorMessages: [], errors: { comment: 'Comment body is not valid Atlassian Document Format.' } } };
    }
    const list = (s.comments[key] ??= []);
    const created = new Date(Date.UTC(2026, 9, 17, 12, 0, list.length)).toISOString().replace('Z', '+0000');
    list.push({ author: fake.account.displayName, created, body: doc });
    save(s);
    return { status: 201, body: { id: String(list.length), body: doc, created, author: { displayName: fake.account.displayName } } };
  });

  on('GET', /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/, (_req, m, _b, s) => {
    const issue = s.issues.find((i) => i.key === decodeURIComponent(m[1]));
    if (!issue) return notFound;
    const transitions = offered(s, issue).map((t) => ({
      id: t.id,
      name: t.name,
      to: statusOf(t.to),
      hasScreen: false,
      isGlobal: false,
      isInitial: false,
      isAvailable: true,
      isConditional: false,
      isLooped: false,
    }));
    return { body: { transitions } };
  });

  on('POST', /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/, (_req, m, body, s) => {
    const issue = s.issues.find((i) => i.key === decodeURIComponent(m[1]));
    if (!issue) return notFound;
    const t = offered(s, issue).find((x) => x.id === String(body?.transition?.id ?? ''));
    if (!t) return { status: 400, body: { errorMessages: [`Transition id '${body?.transition?.id}' is not valid for this issue.`], errors: {} } };
    issue.status = t.to;
    save(s);
    return { status: 204 };
  });

  on('POST', /^\/rest\/api\/3\/issue$/, (_req, _m, body, s) => {
    const f = body?.fields ?? {};
    const project = f.project?.key;
    const errors = {};
    if (!project || !s.issues.some((i) => i.key.startsWith(`${project}-`))) errors.project = 'Specify a valid project ID or key';
    if (!f.issuetype?.name && !f.issuetype?.id) errors.issuetype = 'Specify an issue type';
    if (!f.summary) errors.summary = 'You must specify a summary of the issue.';
    if (f.description != null && f.description.type !== 'doc') errors.description = 'Operation value must be an Atlassian Document.';
    if (f.priority !== undefined && s.refusePriority) errors.priority = "Field 'priority' cannot be set.";
    if (Object.keys(errors).length) return { status: 400, body: { errorMessages: [], errors } };
    const key = nextKey(s, project);
    s.issues.push({
      key,
      summary: f.summary,
      status: 'todo',
      labels: Array.isArray(f.labels) ? f.labels : [],
      description: f.description ?? null,
      fields: { issuetype: { name: f.issuetype.name ?? f.issuetype.id }, ...(f.priority !== undefined ? { priority: f.priority } : {}) },
      inFilter: true,
    });
    save(s);
    return { status: 201, body: { id: String(10000 + s.issues.length - 1), key, self: `https://fake/rest/api/3/issue/${key}` } };
  });

  on('POST', /^\/rest\/api\/3\/issueLink$/, (_req, _m, body, s) => {
    const type = LINK_TYPES[body?.type?.name];
    if (!type) return { status: 404, body: { errorMessages: [`No issue link type with name '${body?.type?.name}' found.`], errors: {} } };
    const from = body?.outwardIssue?.key;
    const to = body?.inwardIssue?.key;
    if (![from, to].every((k) => s.issues.some((i) => i.key === k))) return notFound;
    addLink(s, type, from, to);
    save(s);
    return { status: 201 };
  });

  on('DELETE', /^\/rest\/api\/3\/issueLink\/([^/]+)$/, (_req, m, _b, s) => {
    const at = s.links.findIndex((l) => l.id === decodeURIComponent(m[1]));
    if (at === -1) return { status: 404, body: { errorMessages: ['No issue link with this id exists.'], errors: {} } };
    s.links.splice(at, 1);
    save(s);
    return { status: 204 };
  });

  on('GET', /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/, (_req, m, _b, s) => {
    const project = decodeURIComponent(m[1]);
    if (!s.issues.some((i) => i.key.startsWith(`${project}-`))) return { status: 404, body: { errorMessages: [`No project could be found with key '${project}'.`], errors: {} } };
    const statuses = Object.values(CATEGORY).map((c, n) => ({ id: String(n + 1), name: c.name, statusCategory: { key: c.key, name: c.name } }));
    return { body: [{ id: '10001', name: 'Task', subtask: false, statuses }] };
  });

  on('GET', /^\/rest\/api\/3\/issue\/([^/]+)$/, (req, m, _b, s) => {
    const issue = s.issues.find((i) => i.key === decodeURIComponent(m[1]));
    if (!issue) return notFound;
    const wanted = req.query.get('fields');
    return { body: issueJson(s, issue, wanted ? wanted.split(',') : null) };
  });
}

/** The fake on this thread. */
export async function startFakeJiraHere({ pageSize = 50 } = {}) {
  const fake = await startFakeAtlassian();
  const store = emptyStore(pageSize);
  const log = [];
  installJiraRoutes(fake, () => store, log);
  return {
    url: fake.url,
    cloudId: fake.sites[0].id,
    tokens: fake.issueTokens(),
    fake,
    ...storeOps(() => store),
    requests: async () => log,
    close: () => fake.close(),
  };
}

/** The fake in a worker thread, for code that waits on Jira synchronously. */
export async function startFakeJira({ pageSize = 50 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-jira-'));
  const file = path.join(dir, 'store.json');
  const load = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const save = (store) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(store));
    fs.renameSync(`${file}.tmp`, file);
  };
  save(emptyStore(pageSize));
  const worker = new Worker(new URL('./fake-jira-worker.mjs', import.meta.url), { workerData: { file } });
  const waiting = new Map();
  let next = 0;
  worker.on('message', (m) => {
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      w(m.value);
    }
  });
  const ask = (type) => new Promise((resolve) => {
    next += 1;
    waiting.set(next, resolve);
    worker.postMessage({ id: next, type });
  });
  const started = await ask('start');
  return {
    ...started,
    ...storeOps(load, save),
    requests: () => ask('requests'),
    close: async () => {
      await ask('close');
      await worker.terminate();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
