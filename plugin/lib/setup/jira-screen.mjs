// The Jira screens of Set up: their words, the filter the project picker writes, and the
// transitions suggested from a project's statuses.
//
//   JIRA_SCREEN                    plain data, deep-frozen, in three parts, each with `part`:
//                                  app (the jira-app step: the callback to copy), signin (the
//                                  jira-signin step: the sign-in and the site pick) and filter
//                                  (the jira-site step: project, JQL, preview, moves, owner
//                                  label). The page fills in {site}, {account}, {count}, {key}
//   jqlFor(key)                    the filter's template with the project's key in it
//   suggestTransitions(statuses)   [{ name, category }] -> { started, blocked, review, failed,
//                                  shipped }, each a status name or null (leave it where it is)
//
// A status name is a safe suggestion: the adapter (lib/jira/writes.mjs) and the doctor
// (lib/engine/doctor-jira.mjs) take a status name as well as a transition name.
//
// This file imports nothing from steps.mjs or jira.mjs: jira.mjs imports steps.mjs, and
// steps.mjs imports this.

import { DEFAULT_PORT } from '../jira/login.mjs';
import { TRANSITION_EVENTS } from '../settings/registry.mjs';

const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

const EVENT_LABELS = {
  started: 'a story starts',
  blocked: 'a story is blocked',
  review: "a story's pull request is open",
  failed: 'a story fails',
  shipped: 'a story ships',
};

export const JIRA_SCREEN = freeze({
  app: {
    part: 'app',
    callback: `http://localhost:${DEFAULT_PORT}/callback`,
    copy: 'Copy the address',
    copied: 'Copied.',
    copyFailed: 'Copying did not work: select the address and copy it.',
  },
  signin: {
    part: 'signin',
    idle: 'Foreman is not signed in to Jira on this computer yet.',
    waiting: 'Approve access in the Atlassian tab. This page notices when you are done.',
    open: 'Open the Atlassian sign-in',
    signedIn: 'Signed in to {site} as {account}.',
    again: 'Sign in again',
    pickSite: 'Your sign-in reaches more than one Jira site. Pick the one this project uses.',
    useSite: 'Use this site',
    localOnly:
      'Jira sign-in works only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
  },
  filter: {
    part: 'filter',
    project: 'Jira project',
    pickProject: 'Pick a project',
    moreProjects: 'Your site has more projects than this list shows. If yours is missing, type its key into the filter.',
    jql: 'JQL filter',
    jqlHelp: 'Foreman builds the issues this filter finds, in its ORDER BY order. Picking by label also picks up the follow-ups Foreman makes.',
    jqlTemplate: 'project = {key} AND labels = foreman AND statusCategory != Done ORDER BY Rank',
    previewing: 'Asking Jira which issues match…',
    count: 'About {count} issues match. The first ones:',
    firstOnes: 'The first issues that match:',
    none: 'No issues match this filter yet.',
    columns: { key: 'Key', title: 'Title', status: 'Status' },
    moves: 'Move the Jira issue when',
    leave: 'Leave where it is',
    events: TRANSITION_EVENTS.map((id) => ({ id, label: EVENT_LABELS[id] })),
    ownerLabel: 'Owner label',
    ownerHelp: 'Issues with this label are tasks for you. Foreman never builds them.',
    save: 'Save the Jira settings',
    saving: 'Saving the Jira settings…',
    nothing: 'Nothing changed.',
  },
});

export const jqlFor = (key) => JIRA_SCREEN.filter.jqlTemplate.split('{key}').join(String(key));

export function suggestTransitions(statuses) {
  const list = (Array.isArray(statuses) ? statuses : []).filter((s) => s && typeof s.name === 'string' && s.name !== '');
  const working = list.filter((s) => s.category === 'indeterminate');
  const done = list.filter((s) => s.category === 'done');
  const name = (s) => s?.name ?? null;
  return {
    started: name(working.find((s) => /progress/i.test(s.name)) ?? working.find((s) => !/review|block/i.test(s.name))),
    blocked: name(list.find((s) => /block/i.test(s.name))),
    review: name(working.find((s) => /review/i.test(s.name))),
    failed: null,
    shipped: name(done.find((s) => s.name.toLowerCase() === 'done') ?? done[0]),
  };
}
