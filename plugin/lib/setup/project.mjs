// The "This project" set-up step's own form: the words the Set up tab shows, the config the
// form's answers make, and the check command run once from the page. The config is the one
// `foreman init write --answers` writes for the same answers.
//
//   PROJECT_FORM                       plain data, deep-frozen: { fields, save, running, saving,
//                                      saved, retry, change }, each field { id, kind, label, help?,
//                                      placeholder?, options?, action?, empty?, when? }; `when`
//                                      shows a field only for that answer of another. `change`
//                                      is the form on a project that has a config already:
//                                      { title, fields, save, saving, saved }, its `when` read
//                                      against { sfdx, pack (the answer), packNow (the config's) }
//   WORDS                              the errors and results, in plain words (frozen)
//   STARTER_JQL, STARTER_WHERE, SANDBOX_STAGE
//                                      the filter a switch to Jira starts with, the one a switch
//                                      to Salesforce Cases starts with, and the stage name of the
//                                      one sandbox a switch to the Salesforce pack adds
//   MAX_RUN, CHECK_RUN_MS, TAIL_CHARS, TAIL_LINES, KEEP_BYTES
//                                      the check command's length, its time limit, and how much
//                                      of its output is kept and shown
//   KILL_GRACE_MS                      how long after the time limit the answer waits for the
//                                      output to close
//   checkRunError(run) -> null | reason
//                                      a check command is text, not blank, one line, at most
//                                      MAX_RUN characters
//   projectConfig(detected, answers) -> { ok: true, config } | { ok: false, errors }
//                                      detected is lib/engine/init-helpers.mjs detect()'s answer;
//                                      answers { name, source, dir, site, jql, check, ci }
//   projectChange(raw, change, { sfdx, site, packs, root })
//                                      -> { ok: true, edits, lines } | { ok: false, errors }
//                                      (a switch to Salesforce Cases needs the pack, on already or
//                                      turned on by the same change, and reads the Cases in the
//                                      pack's first sandbox, never a production org; turning the
//                                      pack off while the stories are Cases is refused; given root, the
//                                      pack reads that folder's workflows and leaves ci out of the
//                                      steps when none runs on pull requests)
//                                      raw is foreman.config.json as it is (settings/team.mjs
//                                      readTeam); change { source?, pack?, alias?, orgId? } is the
//                                      change form's; edits are for settings/team.mjs teamApply,
//                                      which checks the whole config before it writes
//   fileSecrets({ root, config })      every value of 4 characters or more in .env.foreman and
//                                      the env file (their configured names, else the defaults)
//   envSecrets(env) -> [values]        each value of 8 characters or more, once, of an env entry
//                                      named in SECRET_NAMES, a secret key of keys.mjs KEYS, or
//                                      matching KEY, SECRET, TOKEN, PASSWORD or URL
//   runCheckCommand(run, { cwd, env, timeoutMs, graceMs, secrets, track })
//                                      -> { passed, exitCode, timedOut, seconds, tail, detail }
//
// The command runs in its own process group, so the time limit kills everything it started,
// and anything still left in the group when sh exits is killed then. The answer comes at most
// graceMs after the time limit, even when something outside the group still holds the output
// open. Its output is redacted first (the env's secret names and secret-looking values, the
// files' values, then anything that looks like a key) and only then cut to its tail; the
// command still runs with the whole env. Nothing here stores the output or echoes a value the
// owner sent: a refused CI job or command is never repeated.
//
// This file imports nothing from steps.mjs (which imports it) or record.mjs, so no cycle forms.

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import { foremanEnvPath, projectEnvPath } from '../engine/foreman-keys.mjs';
import { redact as redactLooksSecret } from '../engine/state.mjs';
import { normalizeSite } from '../jira/auth.mjs';
import { SECRET_NAMES, redact } from '../secrets/redact.mjs';
import { KEYS } from './keys.mjs';
import { DEFAULTS } from '../config/defaults.mjs';
import { PACKS } from '../../packs/index.mjs';
import { ROLLBACK_COMMAND } from '../../packs/salesforce/config.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';

export const MAX_RUN = 1000;
export const CHECK_RUN_MS = 180_000;
export const TAIL_CHARS = 4000;
export const TAIL_LINES = 40;
export const KEEP_BYTES = 64 * 1024;
// After the time limit's kill, how long the answer waits for the output to close.
export const KILL_GRACE_MS = 2000;
// A switch to Jira saves this filter; the Jira site and filter screen then narrows it.
export const STARTER_JQL = 'labels = foreman AND statusCategory != Done ORDER BY Rank';
// A switch to Salesforce Cases saves this filter: the open Cases of Type Foreman. The owner edits it
// in foreman.config.json.
export const STARTER_WHERE = "IsClosed = false AND Type = 'Foreman'";
// The stage of the one sandbox a switch to the Salesforce pack adds.
export const SANDBOX_STAGE = 'qa';
// As lib/setup/jira.mjs MAX_JQL; not imported, since that file imports steps.mjs, which imports this.
const MAX_JQL = 4000;

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

export const PROJECT_FORM = deepFreeze({
  fields: [
    { id: 'name', kind: 'text', label: 'Project name', help: 'The name Foreman shows for this project.' },
    {
      id: 'source',
      kind: 'choice',
      label: 'Where the stories come from',
      options: [
        { value: 'markdown', label: 'Story files in this repository (markdown)' },
        { value: 'jira', label: 'Jira' },
      ],
    },
    { id: 'dir', kind: 'text', label: 'Story folder', help: 'A folder inside this project, such as stories. Foreman adds an example story to it when it has none.', when: { source: 'markdown' } },
    { id: 'site', kind: 'text', label: 'Jira site', help: 'Its host only, such as acme.atlassian.net.', when: { source: 'jira' } },
    {
      id: 'jql',
      kind: 'text',
      label: 'JQL filter',
      placeholder: 'project = KEY AND labels = foreman AND statusCategory != Done ORDER BY Rank',
      help: "Put your project's key in place of KEY. Picking by label also picks up the follow-ups Foreman makes, since they copy their story's labels. Once the config is saved, the Jira steps can try the filter.",
      when: { source: 'jira' },
    },
    { id: 'check', kind: 'command', label: 'Check command', help: 'The command that must pass before a story ships. Run it once here to see it work.', action: 'Run it' },
    {
      id: 'ci',
      kind: 'jobs',
      label: 'CI jobs that must pass before a merge',
      help: 'Read from .github/workflows. Untick a job Foreman should not wait for.',
      empty: 'No CI jobs were found in .github/workflows, so Foreman waits for none.',
    },
  ],
  save: 'Save foreman.config.json',
  running: 'Running the check command…',
  saving: 'Saving foreman.config.json…',
  saved: 'Saved foreman.config.json and the files that go with it.',
  retry: 'Try again',
  change: {
    title: 'What Foreman uses',
    fields: [
      {
        id: 'source',
        kind: 'choice',
        label: 'Story source',
        options: [
          { value: 'markdown', label: 'Markdown files' },
          { value: 'jira', label: 'Jira' },
          { value: 'salesforce', label: 'Salesforce Cases' },
        ],
        help: 'Jira: Foreman saves a starter filter, then the Jira steps sign you in and set the filter. Salesforce Cases: needs the Salesforce pack; Foreman saves a starter filter of open Cases of Type Foreman.',
      },
      {
        id: 'pack',
        kind: 'choice',
        label: 'Salesforce pack',
        options: [
          { value: 'none', label: 'Off' },
          { value: 'salesforce', label: 'On' },
        ],
        when: { sfdx: true },
        help: 'For a project with sfdx-project.json. On adds the Salesforce steps.',
      },
      {
        id: 'alias',
        kind: 'text',
        label: 'Sandbox alias',
        help: 'The name Foreman uses for the one sandbox it builds and releases in, such as dev. Add more sandboxes later.',
        when: { pack: 'salesforce', packNow: 'none' },
      },
      {
        id: 'orgId',
        kind: 'text',
        label: 'Sandbox org ID',
        help: "It starts with 00D. In the sandbox's Setup, open Company Information.",
        when: { pack: 'salesforce', packNow: 'none' },
      },
    ],
    save: 'Save the changes',
    saving: 'Saving foreman.config.json…',
    saved: 'Saved foreman.config.json.',
  },
});

const secondsText = (n) => `${n} second${n === 1 ? '' : 's'}`;

export const WORDS = Object.freeze({
  localOnly:
    'The check command can be run only from a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
  badAnswers: 'Send the answers as a JSON object.',
  unknownAnswer: 'The form sent an answer Foreman does not take.',
  notText: 'Each answer must be text, and the CI jobs a list of names.',
  needName: 'Give the project a name.',
  pickSource: 'Pick where the stories come from: story files in this repository, or Jira.',
  badDir: 'The story folder must be a folder inside this project, such as stories.',
  needSite: 'Give the Jira site: its host only, such as acme.atlassian.net.',
  needJql: 'Give the JQL filter that picks the stories.',
  jqlTooLong: `The JQL filter is over ${MAX_JQL} characters.`,
  needCheck: 'Give the command that must pass before a story ships, such as npm test.',
  checkTooLong: `The check command is over ${MAX_RUN} characters.`,
  checkOneLine: 'The check command must be one line.',
  badJobs: 'Pick CI jobs from the list read from .github/workflows.',
  oneOf: 'Send the answers or the config, not both.',
  passed: (seconds) => `Passed in ${secondsText(seconds)}.`,
  failed: (code, seconds) => `Failed: it stopped with exit code ${code} after ${secondsText(seconds)}.`,
  stopped: (signal) => `Stopped by ${signal} before it finished.`,
  timedOut: (limitText) => `Stopped after ${limitText}: it took too long.`,
  couldNotStart: 'The command could not be started in this project.',
  badChange: 'Send the changes as { change: { source, pack, alias, orgId } }, and nothing else.',
  unknownChange: 'The form sent a change Foreman does not take.',
  changeNotText: 'Each change must be text.',
  noSalesforce: 'This project has no sfdx-project.json, so the Salesforce pack does not fit it.',
  needSandbox: "Give the sandbox's alias and its org ID.",
  nothingChanged: 'Nothing changed: foreman.config.json already has these.',
  needSalesforcePack: 'Salesforce Cases need the Salesforce pack: turn it on, with the sandbox that holds the Cases.',
  noCasesOrg: 'Add a sandbox to salesforce.orgs first: Foreman never reads Cases from a production org.',
  casesNeedPack: 'The stories come from Salesforce Cases: pick another story source before turning the pack off.',
});

const ANSWERS = new Set(['name', 'source', 'dir', 'site', 'jql', 'check', 'ci']);
// The first-run form offers these; the change form also offers Salesforce Cases, which needs an org in salesforce.orgs.
const SOURCES = ['markdown', 'jira'];
const CHANGE_SOURCES = ['markdown', 'jira', 'salesforce'];
const PRODUCTION_NAME = /^(prod|production)$/i;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function checkRunError(run) {
  if (typeof run !== 'string' || run.trim() === '') return WORDS.needCheck;
  if (/[\r\n]/.test(run)) return WORDS.checkOneLine;
  if (run.length > MAX_RUN) return WORDS.checkTooLong;
  return null;
}

// The story folder, trimmed and without a trailing slash, or null when it is not a folder inside
// the project: not the project itself, and not in .git or Foreman's state folder.
function storyDir(value) {
  const dir = String(value ?? '').trim().replace(/\/+$/, '');
  if (dir === '' || isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) return null;
  const real = dir.split(/[\\/]/).filter((p) => p !== '' && p !== '.');
  if (real.length === 0 || real[0] === '.git' || real[0] === DEFAULTS.stateDir) return null;
  return dir;
}

export function projectConfig(detected, answers) {
  if (!isPlain(answers)) return { ok: false, errors: [WORDS.badAnswers] };
  const errors = [];
  const add = (e) => {
    if (!errors.includes(e)) errors.push(e);
  };
  for (const [key, value] of Object.entries(answers)) {
    if (!ANSWERS.has(key)) add(WORDS.unknownAnswer);
    else if (key === 'ci' ? !Array.isArray(value) : typeof value !== 'string') add(key === 'ci' ? WORDS.badJobs : WORDS.notText);
  }
  if (errors.length) return { ok: false, errors };

  const suggested = detected?.suggested ?? {};
  const jobs = Array.isArray(detected?.found?.ciJobs) ? detected.found.ciJobs : [];

  const name = (answers.name ?? '').trim();
  if (!name) add(WORDS.needName);

  let stories = null;
  const source = answers.source ?? '';
  if (!SOURCES.includes(source)) add(WORDS.pickSource);
  else if (source === 'markdown') {
    const dir = storyDir(answers.dir);
    if (dir === null) add(WORDS.badDir);
    else stories = { adapter: 'markdown', dir };
  } else {
    let site = null;
    if ((answers.site ?? '').trim() === '') add(WORDS.needSite);
    else {
      try {
        site = normalizeSite(answers.site);
      } catch (err) {
        add(`Jira site: ${err.message}`);
      }
    }
    const jql = (answers.jql ?? '').trim();
    if (!jql) add(WORDS.needJql);
    else if (jql.length > MAX_JQL) add(WORDS.jqlTooLong);
    if (site !== null && jql && jql.length <= MAX_JQL) stories = { adapter: 'jira', site, jql };
  }

  let checks;
  const check = answers.check ?? '';
  if (check.trim() === '') {
    if (Object.hasOwn(suggested, 'checks')) add(WORDS.needCheck);
  } else {
    const wrong = checkRunError(check.trim());
    if (wrong) add(wrong);
    else checks = [{ run: check.trim(), when: 'always' }];
  }

  let required = suggested.ship?.ci?.required ?? [];
  if (Object.hasOwn(answers, 'ci')) {
    if (!answers.ci.every((j) => typeof j === 'string' && jobs.includes(j))) add(WORDS.badJobs);
    else required = [...new Set(answers.ci)];
  }

  if (errors.length) return { ok: false, errors };
  const { version, project, pack, install, checks: _checks, stories: _stories, ship, ...rest } = suggested;
  const config = {
    version,
    project: { ...project, name },
    ...(pack !== undefined ? { pack } : {}),
    ...(install !== undefined ? { install } : {}),
    ...(checks ? { checks } : {}),
    stories,
    ship: { ...ship, ci: { ...ship?.ci, required } },
    ...rest,
  };
  return { ok: true, config };
}

const CHANGES = new Set(['source', 'pack', 'alias', 'orgId']);

// The first alias in the file's salesforce.orgs that is not marked production and not named prod or
// production: where the Cases are read. null when there is none.
function casesOrg(file) {
  const orgs = isPlain(file.salesforce) && isPlain(file.salesforce.orgs) ? file.salesforce.orgs : {};
  const found = Object.entries(orgs).find(([alias, org]) => !PRODUCTION_NAME.test(alias) && !(isPlain(org) && org.production === true));
  return found ? found[0] : null;
}

export function projectChange(raw, change, { sfdx, site, packs = PACKS, root } = {}) {
  if (!isPlain(change)) return { ok: false, errors: [WORDS.badChange] };
  for (const [key, value] of Object.entries(change)) {
    if (!CHANGES.has(key)) return { ok: false, errors: [WORDS.unknownChange] };
    if (typeof value !== 'string') return { ok: false, errors: [WORDS.changeNotText] };
  }
  const file = isPlain(raw) ? raw : {};
  const edits = [];
  const lines = [];

  const turnsOn = change.pack === 'salesforce' && file.pack !== 'salesforce';
  // A file with no stories block takes its stories from markdown files, the default.
  const adapter = isPlain(file.stories) && typeof file.stories.adapter === 'string' ? file.stories.adapter : DEFAULTS.stories.adapter;

  if (Object.hasOwn(change, 'source')) {
    if (!CHANGE_SOURCES.includes(change.source)) return { ok: false, errors: [WORDS.pickSource] };
    if (change.source === 'jira' && adapter !== 'jira') {
      edits.push({ name: 'stories', value: { adapter: 'jira', ...(site ? { site } : {}), jql: STARTER_JQL } });
      lines.push('set stories.adapter to jira');
      if (site) lines.push(`set stories.site to ${site}`);
      lines.push('set stories.jql to a starter filter; narrow it on the Jira site and filter screen');
    } else if (change.source === 'markdown' && adapter !== 'markdown') {
      edits.push({ name: 'stories', value: { adapter: 'markdown', dir: 'stories' } });
      lines.push('set stories.adapter to markdown (folder stories)');
    } else if (change.source === 'salesforce' && adapter !== 'salesforce') {
      // The pack must be on when the change is saved, or be turned on by this very change.
      if (!(file.pack === 'salesforce' && change.pack !== 'none') && !turnsOn) return { ok: false, errors: [WORDS.needSalesforcePack] };
      const org = turnsOn ? (change.alias ?? '').trim() : casesOrg(file);
      if (!org) return { ok: false, errors: [turnsOn ? WORDS.needSandbox : WORDS.noCasesOrg] };
      edits.push({ name: 'stories', value: { adapter: 'salesforce', org, where: STARTER_WHERE } });
      lines.push(`set stories.adapter to salesforce (Cases in ${org})`, 'set stories.where to a starter filter: open Cases of Type Foreman; change it in foreman.config.json');
    }
  }
  // The Cases need the pack, so it stays on unless this change moves the stories elsewhere.
  if (change.pack === 'none' && file.pack === 'salesforce' && adapter === 'salesforce' && (change.source ?? 'salesforce') === 'salesforce') {
    return { ok: false, errors: [WORDS.casesNeedPack] };
  }

  if ((Object.hasOwn(change, 'alias') || Object.hasOwn(change, 'orgId')) && !turnsOn) return { ok: false, errors: [WORDS.unknownChange] };
  if (Object.hasOwn(change, 'pack')) {
    if (change.pack !== 'salesforce' && change.pack !== 'none') return { ok: false, errors: [WORDS.unknownChange] };
    if (turnsOn) {
      if (!sfdx) return { ok: false, errors: [WORDS.noSalesforce] };
      const alias = (change.alias ?? '').trim();
      const orgId = (change.orgId ?? '').trim();
      if (!alias || !orgId) return { ok: false, errors: [WORDS.needSandbox] };
      const block = { orgs: { [alias]: { orgId } }, build: alias, stages: [{ name: SANDBOX_STAGE, org: alias }] };
      // The pack's ship steps start with sf-org-guard; Foreman's own steps would leave it out.
      // With the project folder, the pack leaves out ci when no workflow runs on pull requests.
      const view = typeof root === 'string' ? { root, fs: { readdirSync, readFileSync }, file: raw } : undefined;
      const ship = packs.salesforce.defaults(structuredClone(block), view).ship;
      edits.push({ name: 'pack', value: 'salesforce' }, { name: 'salesforce', value: block }, { name: 'ship.steps', value: ship.steps });
      if (ship.rollback !== undefined) edits.push({ name: 'ship.rollback', value: ship.rollback });
      lines.push('set pack to salesforce', `added the salesforce block: sandbox ${alias} builds and releases (stage ${SANDBOX_STAGE})`, "set ship.steps to the Salesforce pack's steps");
    } else if (change.pack === 'none' && file.pack === 'salesforce') {
      edits.push({ name: 'pack', remove: true });
      if (Object.hasOwn(file, 'salesforce')) edits.push({ name: 'salesforce', remove: true });
      edits.push({ name: 'ship.steps', value: [...DEFAULTS.ship.steps] });
      if (isPlain(file.ship) && isPlain(file.ship.rollback) && file.ship.rollback.command === ROLLBACK_COMMAND) edits.push({ name: 'ship.rollback', remove: true });
      if (isPlain(file.env) && file.env.adapter === 'sandbox-pool') edits.push({ name: 'env', remove: true });
      lines.push('removed pack and the salesforce block', "set ship.steps to Foreman's own steps");
    }
  }

  if (!edits.length) return { ok: true, edits: [], lines: [WORDS.nothingChanged] };
  lines.push(COMMIT_REMINDER);
  return { ok: true, edits, lines };
}

function fileValues(file) {
  try {
    return Object.values(parseEnv(readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

export function fileSecrets({ root, config }) {
  const values = [...fileValues(foremanEnvPath(root, config)), ...fileValues(projectEnvPath(root, config))];
  return [...new Set(values.filter((v) => typeof v === 'string' && v.length >= 4))];
}

const SECRET_KEYS = new Set([...SECRET_NAMES, ...KEYS.filter((k) => k.secret).map((k) => k.name)]);
const LOOKS_SECRET = /KEY|SECRET|TOKEN|PASSWORD|URL/i;

// Under 8 characters a value is more likely a flag (X_KEY=1, true) than a secret.
export function envSecrets(env) {
  const values = Object.entries(env ?? {})
    .filter(([name, v]) => typeof v === 'string' && v.length >= 8 && (SECRET_KEYS.has(name) || LOOKS_SECRET.test(name)))
    .map(([, v]) => v);
  return [...new Set(values)];
}

const limitText = (ms) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : secondsText(ms / 1000));

// The output's last lines, redacted before it is cut.
function tailOf(text, env, secrets) {
  const longestFirst = [...secrets].sort((a, b) => b.length - a.length);
  const clean = redactLooksSecret(redact(text, { env, values: longestFirst }));
  const lines = clean.replace(/\s+$/, '').split(/\r?\n/);
  const tail = lines.slice(-TAIL_LINES).join('\n');
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

export function runCheckCommand(run, { cwd, env = process.env, timeoutMs = CHECK_RUN_MS, graceMs = KILL_GRACE_MS, secrets = [], track } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const seconds = () => Math.round((Date.now() - started) / 100) / 10;
    let kept = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    let timer = null;
    let grace = null;
    let child;
    const hidden = [...secrets, ...envSecrets(env)];

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (child) track?.delete(child);
      resolve(result);
    };
    const notStarted = () => settle({ passed: false, exitCode: null, timedOut: false, seconds: seconds(), tail: '', detail: WORDS.couldNotStart });
    const keep = (chunk) => {
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > KEEP_BYTES) kept = kept.subarray(kept.length - KEEP_BYTES);
    };

    try {
      child = spawn('sh', ['-c', run], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      notStarted();
      return;
    }
    track?.add(child);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', notStarted);
    child.on('close', (code, signal) => {
      // What the command left running in its group, such as a job sent to the background.
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // the group is empty
        }
      }
      const took = seconds();
      const detail = timedOut ? WORDS.timedOut(limitText(timeoutMs)) : signal ? WORDS.stopped(signal) : code === 0 ? WORDS.passed(took) : WORDS.failed(code, took);
      settle({ passed: !timedOut && code === 0, exitCode: code, timedOut, seconds: took, tail: tailOf(kept.toString('utf8'), env, hidden), detail });
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // the group is gone already
      }
      // A process that left the group can hold the output open, so 'close' may never come.
      grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle({ passed: false, exitCode: null, timedOut: true, seconds: seconds(), tail: tailOf(kept.toString('utf8'), env, hidden), detail: WORDS.timedOut(limitText(timeoutMs)) });
      }, graceMs);
    }, timeoutMs);
  });
}
