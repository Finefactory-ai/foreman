// The Cloud runner set-up step behind the dashboard's /api/setup/cloud/ routes: GitHub Actions
// (the run state on a branch, the workflow, and its repository secrets set with gh), or a
// container (the runner file and its docker run line). Every word the owner sees is in
// lib/setup/cloud-screen.mjs CLOUD_SCREEN.
//
//   const cloud = cloudSetup({ root, env, sh, valueOf, setupFirst, checks });
//   RUNNER_FILE            '.env.runner', the container's env file (lib/cloud/actions.mjs)
//   cloud.current()        { mode, stateBranch, workflow: { exists, current }, runnerFile: { file,
//                          exists, ignored }, repo, names: { token, signIn, keys, runner },
//                          dockerRun }: mode is 'actions' with the workflow file, else
//                          'container' with the runner file, else null; ignored is isIgnored's
//                          answer; signIn, keys (the workflow's project keys) and runner (the
//                          dashboard token and the project's keys the container needs) are
//                          [{ name, stored, step }], stored whether valueOf has it and step the
//                          set-up step that saves it. Booleans and names only; no gh call.
//   cloud.stateBranch({})  writes state.store branch to foreman.config.json through the team
//                          layer; { ok, lines } with the commit reminder, or [nothingChanged]
//   cloud.workflow({ replace })
//                          writes .github/workflows/foreman.yml (409 needsBranch while the state is
//                          in files, 409 workflowExists when it is there and replace is false,
//                          409 workflowLink, writing nothing, when it or a folder above it is
//                          a link)
//   cloud.secrets({})      { ok, repo, rows: [{ name, set, stored }], missing } from
//                          `gh secret list`: missing is what is neither on GitHub nor saved here;
//                          { ok: false, error } when gh cannot list. 409 noRepo with no GitHub remote
//   cloud.setSecrets({ ghToken? })
//                          with a token: its shape (400 in checkShape's words), then the cloud
//                          doctor's local-safe checks with it as GH_TOKEN in their environment;
//                          any error-level failure answers { ok: false, error: tokenRefused,
//                          results } and sets nothing. Then `gh secret set` for FOREMAN_GH_TOKEN
//                          (the token), each sign-in and each project key saved here, the value
//                          on stdin, through the owner's own gh sign-in. Answers { ok, set,
//                          failed: [{ name, detail }], missing, results }; missing from a fresh
//                          list after the sets
//   cloud.runnerFile({ ghToken? })
//                          writes .env.runner (mode 600, its other lines kept) with FOREMAN_REPO,
//                          FOREMAN_BRANCH, the token, the sign-ins, the dashboard token and the
//                          project's keys saved here. 409 notIgnored with fix 'ignore', writing
//                          nothing, while git does not ignore it; then, with no fix and writing
//                          nothing, 409 runnerLink when it is a link (dangling too) and 409
//                          runnerTracked when git tracks it. Answers { ok, file, written,
//                          missing, dockerRun, lines }
//   cloud.ignoreRunnerFile({})
//                          adds .env.runner to .gitignore; { ok, lines }
//   cloud.check({})        the local-safe checks against .env.runner's values, with the dashboard
//                          beyond the container (FOREMAN_DASHBOARD_HOST 0.0.0.0); { ok, results }
//
// valueOf(name) is the stored value or null (the server passes secretValue). checks() lists the
// token checks (lib/cloud/doctor.mjs localRunnerChecks, the default; tests pass their own). The
// project is read
// afresh on each call. A failure is an Error with .status, the HTTP code to answer with: 409 with
// no config, 400 for a body with other keys than listed. No answer, argument, environment of a
// gh secret call, or file but .env.runner ever holds a value: every detail is redacted against
// the values in play. This file does not import steps.mjs: the server passes the set-up-first
// words in.

import nodeFs from 'node:fs';
import { join } from 'node:path';
import { RUNNER_FILE, WORKFLOW, listSecrets, missingSecrets, repoOf, setSecret, writeWorkflow } from '../cloud/actions.mjs';
import { localRunnerChecks } from '../cloud/doctor.mjs';
import { keyNames } from '../cloud/env-file.mjs';
import { runnerImage } from '../cloud/versions.mjs';
import { actionsWorkflow, workflowSecrets } from '../cloud/workflow-template.mjs';
import { addIgnoreLine, isIgnored, isTracked } from '../engine/foreman-keys.mjs';
import { parseEnvFile } from '../engine/env-text.mjs';
import { writeKeys } from '../secrets/env-store.mjs';
import { redact } from '../secrets/redact.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { loadResolved } from '../settings/load.mjs';
import { readTeam, teamSet } from '../settings/team.mjs';
import { CLOUD_SCREEN } from './cloud-screen.mjs';
import { checkShape, stepForKey } from './keys.mjs';

export { RUNNER_FILE };

const E = CLOUD_SCREEN.errors;
const DASHBOARD_TOKEN = 'FOREMAN_DASHBOARD_TOKEN';
// The runner's settings that are not secret, so a check's detail may name them.
const PLAIN = new Set(['FOREMAN_REPO', 'FOREMAN_REPO_URL', 'FOREMAN_BRANCH', 'FOREMAN_WORKERS', 'FOREMAN_MAX', 'FOREMAN_DASHBOARD_HOST']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSet = (v) => typeof v === 'string' && v !== '';
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status }, extra);
const hasKeys = (body, keys) => isPlain(body) && Object.keys(body).length === keys.length && keys.every((k) => Object.hasOwn(body, k));
const fill = (words, values) => Object.entries(values).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), words);

// {} or { ghToken }: the token, shape-checked, or null.
function tokenOf(body) {
  if (hasKeys(body, [])) return null;
  if (!hasKeys(body, ['ghToken'])) throw fail(400, E.badBody);
  const wrong = checkShape('GH_TOKEN', body.ghToken);
  if (wrong) throw fail(400, wrong);
  return body.ghToken;
}

const empty = (body) => {
  if (!hasKeys(body, [])) throw fail(400, E.badBody);
};

export function cloudSetup({ root, env = process.env, sh, valueOf = () => null, setupFirst = E.setupFirst, fs = nodeFs, checks = localRunnerChecks }) {
  function project() {
    const { config } = loadResolved(root, { env });
    if (!config) throw fail(409, setupFirst);
    return config;
  }
  const stored = (name) => {
    const v = valueOf(name);
    return isSet(v) ? v : null;
  };
  const named = (name) => ({ name, stored: stored(name) !== null, step: stepForKey(name) });
  const dockerRun = (config) =>
    `docker run -d --name foreman --restart on-failure --stop-timeout 900 --env-file ${RUNNER_FILE} -v foreman-work:/work -p 127.0.0.1:4317:4317 ${runnerImage(config)}`;
  // The container's keys saved on a step: the dashboard token, then the project's.
  const runnerKeys = (config) => [...new Set([DASHBOARD_TOKEN, ...keyNames(config)])];

  // The cloud doctor's local-safe checks. The shell they run gh through has GH_TOKEN set to the
  // given token, or none, so the owner's own sign-in is never what is checked.
  async function localChecks(checkEnv, token, values) {
    const shellEnv = { ...env };
    delete shellEnv.GH_TOKEN;
    if (isSet(token)) shellEnv.GH_TOKEN = token;
    const wrapped = (cmd, args, o = {}) => sh(cmd, args, { ...o, env: shellEnv });
    const results = [];
    for (const check of checks()) {
      let r;
      try {
        r = await check.run({ env: checkEnv, sh: wrapped, fs });
      } catch (err) {
        r = { ok: false, level: 'error', detail: `the check crashed: ${err?.message ?? err}` };
      }
      results.push({ name: check.name, ok: r?.ok === true, level: r?.level === 'warn' ? 'warn' : 'error', detail: redact(String(r?.detail ?? ''), { values }) });
    }
    return results;
  }
  const refused = (results) => results.some((r) => !r.ok && r.level !== 'warn');

  function current() {
    const config = project();
    const workflowFile = join(root, WORKFLOW);
    const hasWorkflow = fs.existsSync(workflowFile);
    let isCurrent = false;
    if (hasWorkflow) {
      try {
        isCurrent = String(fs.readFileSync(workflowFile, 'utf8')) === actionsWorkflow({ config });
      } catch {
        isCurrent = false;
      }
    }
    const hasRunner = fs.existsSync(join(root, RUNNER_FILE));
    const { token, signIn, keys } = workflowSecrets(config);
    return {
      mode: hasWorkflow ? 'actions' : hasRunner ? 'container' : null,
      stateBranch: config.state?.store === 'branch',
      workflow: { exists: hasWorkflow, current: isCurrent },
      runnerFile: { file: RUNNER_FILE, exists: hasRunner, ignored: isIgnored({ root, file: RUNNER_FILE, sh }) },
      repo: repoOf({ root, config, sh }),
      names: { token, signIn: signIn.map(named), keys: keys.map(named), runner: runnerKeys(config).map(named) },
      dockerRun: dockerRun(config),
    };
  }

  function stateBranch(body) {
    project();
    empty(body);
    const team = readTeam(root);
    if (team.errors) throw fail(409, setupFirst);
    if (isPlain(team.raw.state) && team.raw.state.store === 'branch') return { ok: true, lines: [E.nothingChanged] };
    let errors;
    try {
      ({ errors } = teamSet(root, 'state.store', 'branch'));
    } catch (err) {
      errors = [err.message];
    }
    if (errors.length) throw fail(400, errors.join('; '));
    return { ok: true, lines: ['set state.store to branch', COMMIT_REMINDER] };
  }

  function workflow(body) {
    const config = project();
    if (!hasKeys(body, ['replace']) || typeof body.replace !== 'boolean') throw fail(400, E.badBody);
    if (config.state?.store !== 'branch') throw fail(409, E.needsBranch);
    const r = writeWorkflow({ root, config, force: body.replace });
    if (r.link) throw fail(409, E.workflowLink);
    if (!r.written) throw fail(409, E.workflowExists);
    return { ok: true, lines: [`wrote ${WORKFLOW}`, CLOUD_SCREEN.workflow.commit] };
  }

  function repoFor(config) {
    const repo = repoOf({ root, config, sh });
    if (!repo) throw fail(409, E.noRepo);
    return repo;
  }

  function secrets(body) {
    const config = project();
    empty(body);
    const repo = repoFor(config);
    const list = listSecrets({ repo, sh, cwd: root });
    const { token, signIn, keys } = workflowSecrets(config);
    const values = [token, ...signIn, ...keys].map(stored).filter((v) => v !== null);
    if (!list.ok) return { ok: false, error: fill(E.ghFailed, { name: 'gh secret list', detail: redact(list.detail, { values }) }) };
    const on = new Set(list.names);
    const rows = [token, ...signIn, ...keys].map((name) => ({ name, set: on.has(name), stored: stored(name) !== null }));
    const here = [token, ...signIn, ...keys].filter((name) => stored(name) !== null);
    return { ok: true, repo, rows, missing: missingSecrets(config, [...list.names, ...here]) };
  }

  async function setSecrets(body) {
    const config = project();
    const ghToken = tokenOf(body);
    const repo = repoFor(config);
    const { token, signIn, keys } = workflowSecrets(config);
    const sends = [];
    if (ghToken !== null) sends.push([token, ghToken]);
    for (const name of [...signIn, ...keys]) {
      const value = stored(name);
      if (value !== null) sends.push([name, value]);
    }
    const values = sends.map(([, v]) => v);

    let results = [];
    if (ghToken !== null) {
      results = await localChecks({ FOREMAN_REPO: repo, GH_TOKEN: ghToken }, ghToken, values);
      if (refused(results)) return { ok: false, error: E.tokenRefused, results };
    }

    const set = [];
    const failed = [];
    for (const [name, value] of sends) {
      const r = setSecret({ repo, name, value, sh, cwd: root });
      if (r.ok) set.push(name);
      else failed.push({ name, detail: redact(r.detail, { values }) });
    }
    const after = listSecrets({ repo, sh, cwd: root });
    const missing = missingSecrets(config, after.ok ? after.names : set);
    return { ok: failed.length === 0, set, failed, missing, results };
  }

  function runnerFile(body) {
    const config = project();
    const ghToken = tokenOf(body);
    if (isIgnored({ root, file: RUNNER_FILE, sh }) !== 'ignored') throw fail(409, fill(E.notIgnored, { file: RUNNER_FILE }), { fix: 'ignore' });
    // writeKeys follows a link, and creates a dangling one's target, so every link is refused.
    let link = false;
    try {
      link = fs.lstatSync(join(root, RUNNER_FILE)).isSymbolicLink();
    } catch {
      // nothing there yet
    }
    if (link) throw fail(409, fill(E.runnerLink, { file: RUNNER_FILE }));
    if (isTracked({ root, file: RUNNER_FILE, sh }) === 'tracked') throw fail(409, fill(E.runnerTracked, { file: RUNNER_FILE }));
    const { signIn } = workflowSecrets(config);
    const repo = repoOf({ root, config, sh });
    const values = {};
    if (repo) values.FOREMAN_REPO = repo;
    values.FOREMAN_BRANCH = config.baseBranch ?? 'main';
    if (ghToken !== null) values.GH_TOKEN = ghToken;
    for (const name of [...signIn, ...runnerKeys(config)]) {
      const value = stored(name);
      if (value !== null) values[name] = value;
    }
    const file = join(root, RUNNER_FILE);
    const { written } = writeKeys(file, values, { fs });

    const have = parseEnvFile(file, fs);
    const keys = keyNames(config);
    const missing = ['FOREMAN_REPO', 'GH_TOKEN'].filter((n) => !isSet(have[n]));
    if (!signIn.some((n) => isSet(have[n]))) missing.push(...signIn);
    for (const name of [DASHBOARD_TOKEN, ...keys]) if (!isSet(have[name]) && !missing.includes(name)) missing.push(name);
    return { ok: true, file: RUNNER_FILE, written, missing, dockerRun: dockerRun(config), lines: [`wrote ${written.join(', ')} to ${RUNNER_FILE}`] };
  }

  function ignoreRunnerFile(body) {
    project();
    empty(body);
    const state = isIgnored({ root, file: RUNNER_FILE, sh });
    if (state === 'ignored') return { ok: true, lines: [`git already ignores ${RUNNER_FILE}`] };
    const added = state === 'not-ignored' && addIgnoreLine(root, RUNNER_FILE, fs);
    if (isIgnored({ root, file: RUNNER_FILE, sh }) !== 'ignored') throw fail(409, fill(E.notIgnored, { file: RUNNER_FILE }));
    return { ok: true, lines: [added ? `added ${RUNNER_FILE} to .gitignore` : `git already ignores ${RUNNER_FILE}`] };
  }

  async function check(body) {
    project();
    empty(body);
    const values = parseEnvFile(join(root, RUNNER_FILE), fs);
    const secret = Object.entries(values).filter(([name]) => !PLAIN.has(name)).map(([, v]) => v);
    const results = await localChecks({ ...values, FOREMAN_DASHBOARD_HOST: '0.0.0.0' }, values.GH_TOKEN, secret);
    return { ok: results.every((r) => r.ok), results };
  }

  return { current, stateBranch, workflow, secrets, setSecrets, runnerFile, ignoreRunnerFile, check };
}
