// Opens the project's story source: the adapter named by `stories.adapter` in the config,
// built from the rest of the `stories` block. Callers get { list, update, brief, finalize,
// idPattern } and, for a source that can hold comments or notes, note(id, { kind, title, summary,
// text }) -> boolean: the story note engine/story-notes.mjs posts (a Jira comment, a private
// Salesforce Case comment, one progress line for the markdown source), queued first by
// engine/story-notes-queue.mjs. The state folder goes to the source too, for stories it tracks
// there, the project's env file (config `envFile`) and Foreman's own keys file (config
// `foremanEnvFile`) for sources that call a service with its keys, the config's `features` (the
// Jira source's jiraComments and jiraTransitions switches, the Salesforce source's
// salesforceComments and salesforceStatuses), and the orgs of `salesforce.orgs` for the
// Salesforce source, which reads Cases only from one of them.
//
// commentSwitch(config) names the switch that governs the comments a story source posts:
// salesforceComments for the Salesforce source, jiraComments for every other (the markdown
// source's progress lines follow the Jira switch too). storyCommentsOn(config) says whether it is on.
//
// preferCachedStories({ onQueued }) makes every source this process opens afterwards read
// only what is cached and queue its writes (the Jira and Salesforce sources' `cacheOnly`). The
// supervisor calls it, so neither its loop nor the dashboard it serves ever waits on Jira or sf;
// its refresher (lib/jira/refresher.mjs, adapters/stories/salesforce-refresher.mjs) does the
// calls with await. The CLI never calls it.
//
// openStorySource({ ..., cacheOnly: true }) does the same for one source: the dashboard's task
// details read the cache-only brief(), the brief file's path when there is one, and never wait
// on Jira or sf. The markdown source ignores it.

import { resolve } from 'node:path';
import { create as jira } from '../adapters/stories/jira.mjs';
import { create as markdown } from '../adapters/stories/markdown.mjs';
import { create as salesforce } from '../adapters/stories/salesforce.mjs';
import { loadResolved, loadResolvedOrLastGood } from '../settings/load.mjs';
import { stateDir } from './paths.mjs';
import { foremanEnvName } from './foreman-keys.mjs';

const REGISTRY = { markdown, jira, salesforce };

/** The feature switch that governs the comments this config's story source posts. */
export const commentSwitch = (config) => (config?.stories?.adapter === 'salesforce' ? 'salesforceComments' : 'jiraComments');

/** Whether those comments are switched on. */
export const storyCommentsOn = (config) => config?.features?.[commentSwitch(config)] === true;

let cached = null;
export function preferCachedStories({ onQueued } = {}) {
  cached = { cacheOnly: true, onQueued };
}

export function openStorySource({ root, config, now, env = process.env, cacheOnly = false }) {
  const { adapter, ...options } = config?.stories ?? {};
  const make = Object.hasOwn(REGISTRY, adapter) ? REGISTRY[adapter] : null;
  if (!make) throw new Error(`unknown story source: ${adapter}`);
  const envFile = config?.envFile ? resolve(root, config.envFile) : undefined;
  const foremanEnvFile = resolve(root, foremanEnvName(config));
  return make(options, { root, now, env, envFile, foremanEnvFile, stateDir: stateDir(root, config, env), features: config?.features ?? {}, salesforceOrgs: config?.salesforce?.orgs, ...(cached ?? {}), ...(cacheOnly ? { cacheOnly: true } : {}) });
}

// The same, reading the project's foreman.config.json with this machine's local settings on
// top. With no usable config it says why. With lastGood, a run on the last good config opens
// the stories from that config (loadResolvedOrLastGood); only the status readers pass it
// (state.mjs snapshot and ownerWaiting), and every other caller refuses an invalid file.
export function openProjectStories({ root, now, env = process.env, lastGood = false }) {
  const { config, errors } = (lastGood ? loadResolvedOrLastGood : loadResolved)(root, { env });
  if (!config) throw new Error(`cannot open stories: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  return openStorySource({ root, config, now, env });
}

// What the supervisor's old note-editing calls mean for source.update: `fields.status` is the
// status, `progress` is the dated note.
export function storyUpdate({ fields = {}, progress } = {}) {
  const { status, ...rest } = fields;
  return { ...(status === undefined ? {} : { status }), fields: rest, ...(progress === undefined ? {} : { note: progress }) };
}

// The change `foreman story done` makes, and the dashboard's "Mark done" with it: done, with
// the local date it was completed and the `shipped` event. The note becomes one progress
// bullet, so it is folded to one line and cut to 500 characters.
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const oneLine = (text, max = 500) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export function doneChange(note, at) {
  return { status: 'done', fields: { completed: localDate(at) }, note: oneLine(note), event: 'shipped' };
}
