// `foreman cloud`: running Foreman away from a laptop.
//
//   foreman cloud run                     the container runner: clone, then build until
//                                         stopped (lib/cloud/run.mjs); settings from the environment
//   foreman cloud doctor                  is this machine ready for that (lib/cloud/doctor.mjs)
//   foreman cloud tick [--story <id>]     one scheduled job: at most one story, with the state
//                                         branch synced around it (lib/cloud/tick.mjs)
//   foreman cloud sync                    push the state folder to the state branch; the
//                                         workflow's last step, so a cancelled job keeps its state
//   foreman cloud actions init [--force]  write .github/workflows/foreman.yml
//                                         (lib/cloud/workflow-template.mjs), never through a link
//
// These commands sync the state themselves, so lib/state-store/with-state.mjs leaves them alone.
//
// `run` and `tick` write the project's key files (.env.foreman, the envFile), so they refuse
// inside a Foreman story session (FOREMAN_RUN=1, lib/engine/run-guard.mjs).

import fs, { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openProject } from './console-shared.mjs';
import { startSupervisor } from './run.mjs';
import { startDashboard } from '../../dashboard/server.mjs';
import { loadResolved } from '../../settings/load.mjs';
import { cloudRun as realCloudRun } from '../../cloud/run.mjs';
import { projectChecks, runChecks, runnerChecks, workDir } from '../../cloud/doctor.mjs';
import { tick as realTick } from '../../cloud/tick.mjs';
import { WORKFLOW, writeWorkflow } from '../../cloud/actions.mjs';
import { keyNames } from '../../cloud/env-file.mjs';
import { refuseInRun } from '../../engine/run-guard.mjs';
import { changedFiles as realChangedFiles, defaultSh, syncState as realSyncState } from '../../state-store/branch.mjs';

const EXIT_USAGE = 64;
const USAGE = `usage: foreman cloud <sub>
  run                     the container runner: clone the project, then build until stopped
  doctor                  check this machine is ready for \`cloud run\`
  tick [--story <id>]     build at most one story, syncing the state branch around it
  sync                    push the state folder to the state branch
  actions init [--force]  write ${WORKFLOW}, the GitHub Actions workflow
`;
const NEEDS_BRANCH = 'needs the run state on a branch, since nothing on a runner outlives its job: set "state": { "store": "branch" } in foreman.config.json';

function usage(stderr, message = '') {
  stderr.write(`${message ? `${message}\n` : ''}${USAGE}`);
  return EXIT_USAGE;
}

function actionsInit(args, { root, env, stdout, stderr }) {
  let opts;
  try {
    opts = parseArgs({ args, options: { force: { type: 'boolean' } }, strict: true }).values;
  } catch (err) {
    return usage(stderr, err.message);
  }
  const project = openProject({ root, env, stderr });
  if (!project) return 1;
  const { config } = project;
  if (config.state?.store !== 'branch') {
    stderr.write(`foreman cloud actions init ${NEEDS_BRANCH}.\n`);
    return 1;
  }
  const r = writeWorkflow({ root, config, force: opts.force });
  if (r.link) {
    stderr.write(`${WORKFLOW} or a folder above it is a link; Foreman does not write through links. Delete the link and run again.\n`);
    return 1;
  }
  if (!r.written) {
    stderr.write(`${WORKFLOW} already exists; run with --force to rewrite it.\n`);
    return 1;
  }
  const keys = keyNames(config);
  stdout.write(
    [
      `Wrote ${WORKFLOW}.`,
      'Add these repository secrets (Settings > Secrets and variables > Actions):',
      '  FOREMAN_GH_TOKEN         a classic token with the `repo` scope (and `workflow`, if a story may change .github/workflows), or a fine-grained token for this repository with Contents and Pull requests read and write, and Actions and Commit statuses read (and Workflows read and write, if a story may change .github/workflows; Deployments read, if ship.steps has deploy-github). A fine-grained token cannot read check runs, so Foreman waits on GitHub Actions jobs and commit statuses instead: a check that other apps post is not seen. While the Foreman repository is private, the token must be able to read that too.',
      '  ANTHROPIC_API_KEY        a Console API key, or instead',
      '  CLAUDE_CODE_OAUTH_TOKEN  a subscription token from `claude setup-token` (your own projects only)',
      ...keys.map((k) => `  ${k}`),
      'Then commit the workflow and run it from the Actions tab, or wait for the schedule.',
      '',
    ].join('\n'),
  );
  return 0;
}

async function sync(args, { root, env, stderr }, { syncState, changedFiles }) {
  if (args.length) return usage(stderr, `unknown argument: ${args[0]}`);
  const project = openProject({ root, env, stderr });
  if (!project) return 1;
  const { config, dir } = project;
  if (config.state?.store !== 'branch') {
    stderr.write(`foreman cloud sync ${NEEDS_BRANCH}.\n`);
    return 1;
  }
  const store = { root, stateDir: dir, branch: config.state.branch, remote: config.remote };
  try {
    const r = await syncState({ ...store, direction: 'push', message: 'foreman cloud sync', writes: changedFiles(store) });
    if (r.refused?.length) stderr.write(`warning: not sent to the state branch, because they look like they hold a secret: ${r.refused.join(', ')}\n`);
    return 0;
  } catch (err) {
    stderr.write(`foreman: the state did not reach ${store.remote}/${store.branch}: ${err.message}\n`);
    return 1;
  }
}

// The runner checks, then the project checks for the project here, or the runner's clone.
async function doctor(args, { root, env, stdout, stderr }, sh) {
  if (args.length) return usage(stderr, `unknown argument: ${args[0]}`);
  const ctx = { env, sh, fs };
  let failed = await runChecks(runnerChecks(), ctx, stdout);
  const project = [root, join(workDir(env), 'repo')].find((dir) => dir && existsSync(join(dir, 'foreman.config.json')));
  if (project) {
    const { config } = loadResolved(project, { env });
    if (config) failed = (await runChecks(projectChecks(config, { ...ctx, root: project }), { ...ctx, root: project }, stdout)) || failed;
  }
  return failed ? 1 : 0;
}

export function makeCloudCommand({ tick = realTick, syncState = realSyncState, changedFiles = realChangedFiles, cloudRun = realCloudRun, sh = null } = {}) {
  return {
    name: 'cloud',
    summary: 'run in the cloud: run, doctor, tick, sync, actions init',
    async run(args, ctx) {
      const [sub, ...rest] = args;
      const shell = sh ?? ((cmd, argv, opts = {}) => defaultSh(cmd, argv, { ...opts, env: { ...ctx.env, ...(opts.env ?? {}) } }));
      const refusal = sub === 'run' || sub === 'tick' ? refuseInRun(ctx.env, `foreman cloud ${sub}`) : null;
      if (refusal) {
        ctx.stderr.write(`${refusal}\n`);
        return 1;
      }
      if (sub === 'run') {
        if (rest.length) return usage(ctx.stderr, 'foreman cloud run takes no arguments; its settings come from the environment (runner/README.md).');
        // Not unref'd: while idle with no dashboard, this timer is what keeps the runner alive.
        // An abort (a stop while idle) clears it, so the process can exit.
        const wait = (ms, { signal } = {}) => new Promise((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        return cloudRun({ env: ctx.env, stdout: ctx.stdout, stderr: ctx.stderr, sh: shell, fs, proc: process, startSupervisor, startDashboard, wait, ...(ctx.now ? { now: ctx.now } : {}) });
      }
      if (sub === 'doctor') return doctor(rest, ctx, shell);
      if (sub === 'tick') {
        let values;
        try {
          values = parseArgs({ args: rest, options: { story: { type: 'string' } }, strict: true }).values;
        } catch (err) {
          return usage(ctx.stderr, err.message);
        }
        return tick({ root: ctx.root, env: ctx.env, story: values.story ?? null, stdout: ctx.stdout, stderr: ctx.stderr, ...(ctx.now ? { now: ctx.now } : {}), startSupervisor });
      }
      if (sub === 'sync') return sync(rest, ctx, { syncState, changedFiles });
      if (sub === 'actions' && rest[0] === 'init') return actionsInit(rest.slice(1), ctx);
      return usage(ctx.stderr);
    },
  };
}

export default makeCloudCommand();
