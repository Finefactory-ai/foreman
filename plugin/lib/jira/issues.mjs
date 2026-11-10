// Reading issues from Jira Cloud for the Jira story source. Each function takes `request`,
// the call function from jiraClient (client.mjs), and returns plain JSON, so the story source
// can run it in a child process (sync.mjs) and wait for it.
//
//   readSnapshot(request, { jql })
//     -> { issues: [{ key, title, category, labels, blockedBy }], outside: { KEY: category|null } }
//     Every issue the JQL finds, in its order, through POST /rest/api/3/search/jql and its
//     nextPageToken. `category` is the status category key (new | indeterminate | done).
//     `blockedBy` holds the keys this issue "is blocked by". `outside` is the status category
//     of each blocker that is not in the result (null when Jira will not show it).
//   readBrief(request, { key, doneWhenField })
//     -> { key, title, category, statusName, description, doneWhen, comments: [{ author, created, body }] }
//     description, doneWhen and each comment body are as Jira returns them (ADF, or a string
//     for a text field). The comments are the last 10, newest first.
//
// Links: on an issue, a link { type, inwardIssue: X } reads "this issue <type.inward> X", and
// { type, outwardIssue: Y } reads "this issue <type.outward> Y". For the standard "Blocks" type
// (inward "is blocked by", outward "blocks"), only the inwardIssue side is a dependency.

export const LIST_FIELDS = ['summary', 'status', 'issuelinks', 'labels', 'parent'];
export const PAGE_SIZE = 100;
export const COMMENTS = 10;
// Enough for 20 000 issues; a token that never ends is a broken server, not a big filter.
const MAX_PAGES = 200;

const BLOCKED_BY = /^is blocked by$/i;
const categoryOf = (fields) => fields?.status?.statusCategory?.key ?? null;
const path = (key) => `/rest/api/3/issue/${encodeURIComponent(key)}`;

/** Every issue the JQL finds, in order, following nextPageToken. */
export async function searchAll(request, { jql, fields }) {
  const issues = [];
  let nextPageToken;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = { jql, fields, maxResults: PAGE_SIZE, ...(nextPageToken ? { nextPageToken } : {}) };
    const res = await request('POST', '/rest/api/3/search/jql', body);
    issues.push(...(res?.issues ?? []));
    if (res?.isLast !== false || !res?.nextPageToken) return issues;
    nextPageToken = res.nextPageToken;
  }
  throw new Error(`Jira search kept paging past ${MAX_PAGES} pages; narrow stories.jql`);
}

export const blockersOf = (fields) =>
  (fields?.issuelinks ?? [])
    .filter((l) => l?.inwardIssue?.key && BLOCKED_BY.test(String(l.type?.inward ?? '').trim()))
    .map((l) => l.inwardIssue.key);

export async function readSnapshot(request, { jql }) {
  const found = await searchAll(request, { jql, fields: LIST_FIELDS });
  const issues = found.map((i) => ({
    key: i.key,
    title: String(i.fields?.summary ?? ''),
    category: categoryOf(i.fields),
    labels: Array.isArray(i.fields?.labels) ? i.fields.labels.map(String) : [],
    blockedBy: [...new Set(blockersOf(i.fields))],
  }));
  const inResult = new Set(issues.map((i) => i.key));
  const outside = {};
  for (const key of new Set(issues.flatMap((i) => i.blockedBy))) {
    if (inResult.has(key)) continue;
    try {
      outside[key] = categoryOf((await request('GET', `${path(key)}?fields=status`))?.fields);
    } catch (err) {
      if (err?.status !== 404) throw err;
      outside[key] = null;
    }
  }
  return { issues, outside };
}

export async function readBrief(request, { key, doneWhenField }) {
  const fields = ['summary', 'status', 'description', ...(doneWhenField ? [doneWhenField] : [])];
  const issue = await request('GET', `${path(key)}?fields=${fields.join(',')}`);
  const page = await request('GET', `${path(key)}/comment?orderBy=-created&maxResults=${COMMENTS}`);
  const f = issue?.fields ?? {};
  return {
    key: issue?.key ?? key,
    title: String(f.summary ?? ''),
    category: categoryOf(f),
    statusName: String(f.status?.name ?? ''),
    description: f.description ?? null,
    doneWhen: doneWhenField ? (f[doneWhenField] ?? null) : null,
    comments: (page?.comments ?? []).slice(0, COMMENTS).map((c) => ({
      author: String(c.author?.displayName ?? 'someone'),
      created: String(c.created ?? ''),
      body: c.body ?? null,
    })),
  };
}
