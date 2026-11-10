// Writing to Jira for the Jira story source. Like issues.mjs, each function takes `request`
// from jiraClient (client.mjs) and returns plain JSON, so it runs the same in the child
// process behind runJiraSync (the CLI) and with await in the supervisor's refresher.
//
//   sendWrites(request, { ops }) -> [result, ...], one per op, in order
//     An op is one of
//       { kind: 'comment', key, body }             POST /issue/<key>/comment { body: ADF }
//       { kind: 'transition', key, name, comment }  move the issue by the transition's name
//       { kind: 'link', type, outward, inward }    POST /issueLink, "outward <type> inward"
//       { kind: 'unlink', type, outward, inward }  remove every such link: read inward's links,
//                                                  DELETE each of the type (ignoring case) from
//                                                  outward; none there counts as sent
//     A result is
//       { status: 'sent' }
//       { status: 'unavailable', from }   no such transition from the issue's status `from`;
//                                         with op.comment, a comment says so on the issue
//       { status: 'dropped', error }      Jira refused it for good (a 4xx other than 401 and 429)
//       { status: 'failed', error }       not sent, to try again later. After the first one,
//                                         the ops left are not tried, so the order holds.
//   createIssue(request, { origin, title, description, issueType, dropLabels, priority })
//     -> { key }: a new issue in the origin's project, with the origin's labels (less
//     dropLabels), and the priority by name when `priority` is a non-empty string. When Jira
//     refuses that priority (a 400 whose errors name `priority`: the field is not on the
//     project's create screen, or no priority has that name), it is made once more without one.
//     Throws when Jira refuses it otherwise.
//
// API facts relied on (Jira Cloud REST v3):
//   GET  /issue/<key>/transitions -> { transitions: [{ id, name, to: { name }, isAvailable }] },
//        the transitions open from the issue's current status
//   POST /issue/<key>/transitions { transition: { id } } -> 204
//   POST /issue/<key>/comment { body: ADF } -> 201
//   POST /issue { fields: { project: { key }, issuetype: { name }, summary, description: ADF,
//        labels, priority?: { name } } } -> 201 { id, key, self }; 400 { errorMessages,
//        errors: { <field>: <why> } } for a field it refuses
//   POST /issueLink { type: { name }, inwardIssue: { key }, outwardIssue: { key } } -> 201;
//        Jira's docs call outwardIssue the issue the link goes from, so a Blocks link from X
//        to Y reads "X blocks Y" (Y "is blocked by" X).
//   GET  /issue/<key>?fields=issuelinks -> { fields: { issuelinks: [{ id, type: { name },
//        inwardIssue?: { key }, outwardIssue?: { key } }] } }; on Y's issue the link "X blocks Y"
//        is the one whose inwardIssue is X
//   DELETE /issueLink/<link id> -> 204

import { markdownToAdf } from './adf.mjs';

const issuePath = (key) => `/rest/api/3/issue/${encodeURIComponent(key)}`;
const lower = (s) => String(s ?? '').trim().toLowerCase();

/** A 4xx Jira will refuse every time: not 401 (sign-in) and not 429 (rate limit). */
export const isPermanent = (err) =>
  err?.name !== 'JiraLoginExpired' && Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429;

async function transition(request, op) {
  const want = lower(op.name);
  const res = await request('GET', `${issuePath(op.key)}/transitions`);
  const open = (res?.transitions ?? []).filter((t) => t && t.isAvailable !== false);
  // By the transition's name, else by the status it leads to.
  const t = open.find((x) => lower(x.name) === want) ?? open.find((x) => lower(x.to?.name) === want);
  if (t) {
    await request('POST', `${issuePath(op.key)}/transitions`, { transition: { id: String(t.id) } });
    return { status: 'sent' };
  }
  const issue = await request('GET', `${issuePath(op.key)}?fields=status`);
  const from = String(issue?.fields?.status?.name ?? '') || 'its current status';
  // Already there: nothing to move.
  if (lower(from) === want) return { status: 'sent' };
  if (op.comment) await request('POST', `${issuePath(op.key)}/comment`, { body: markdownToAdf(`Foreman: could not move to ${op.name} from ${from}`) });
  return { status: 'unavailable', from };
}

async function unlink(request, op) {
  const issue = await request('GET', `${issuePath(op.inward)}?fields=issuelinks`);
  const links = Array.isArray(issue?.fields?.issuelinks) ? issue.fields.issuelinks : [];
  const gone = links.filter((l) => lower(l?.type?.name) === lower(op.type) && l?.inwardIssue?.key === op.outward);
  for (const l of gone) await request('DELETE', `/rest/api/3/issueLink/${encodeURIComponent(String(l.id))}`);
  return { status: 'sent' };
}

async function sendOne(request, op) {
  if (op?.kind === 'comment') {
    await request('POST', `${issuePath(op.key)}/comment`, { body: op.body });
    return { status: 'sent' };
  }
  if (op?.kind === 'transition') return transition(request, op);
  if (op?.kind === 'link') {
    await request('POST', '/rest/api/3/issueLink', { type: { name: op.type }, outwardIssue: { key: op.outward }, inwardIssue: { key: op.inward } });
    return { status: 'sent' };
  }
  if (op?.kind === 'unlink') return unlink(request, op);
  return { status: 'dropped', error: `not a Jira write: ${JSON.stringify(op?.kind ?? null)}` };
}

export async function sendWrites(request, { ops = [] } = {}) {
  const results = [];
  let stopped = null;
  for (const op of ops) {
    if (stopped !== null) {
      results.push({ status: 'failed', error: stopped });
      continue;
    }
    try {
      results.push(await sendOne(request, op));
    } catch (err) {
      const error = String(err?.message ?? err);
      if (isPermanent(err)) results.push({ status: 'dropped', error });
      else {
        stopped = error;
        results.push({ status: 'failed', error });
      }
    }
  }
  return results;
}

// Whether err is Jira refusing the priority field of a create.
const refusesPriority = (err) => err?.status === 400 && Boolean(err.errors) && typeof err.errors === 'object' && Object.hasOwn(err.errors, 'priority');

export async function createIssue(request, { origin, title, description, issueType = 'Task', dropLabels = [], priority }) {
  let project = String(origin).slice(0, String(origin).lastIndexOf('-'));
  let labels = [];
  try {
    const o = await request('GET', `${issuePath(origin)}?fields=labels,project`);
    labels = Array.isArray(o?.fields?.labels) ? o.fields.labels.map(String) : [];
    project = o?.fields?.project?.key ?? project;
  } catch (err) {
    if (err?.status !== 404) throw err;
  }
  const fields = { project: { key: project }, issuetype: { name: issueType }, summary: title, description, labels: labels.filter((l) => !dropLabels.includes(l)) };
  const named = typeof priority === 'string' && priority.trim() !== '';
  let made;
  try {
    made = await request('POST', '/rest/api/3/issue', { fields: named ? { ...fields, priority: { name: priority.trim() } } : fields });
  } catch (err) {
    if (!named || !refusesPriority(err)) throw err;
    made = await request('POST', '/rest/api/3/issue', { fields });
  }
  if (!made?.key) throw new Error('Jira made the issue but did not say its key');
  return { key: made.key };
}
