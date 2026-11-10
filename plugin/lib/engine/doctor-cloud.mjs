// The `foreman doctor` checks of the Cloud runner set-up step, each added only when its file is
// there, so a project that runs only on a laptop gets none:
//
//   cloud workflow     (.github/workflows/foreman.yml) the run state is on a branch, which the
//                      workflow needs, and the file is what this Foreman writes for this config;
//                      a warning when it is from another version or was changed by hand
//   cloud secrets      (the workflow) GitHub has every secret the workflow reads, asked with
//                      `gh secret list`; a warning when there is no GitHub remote or gh cannot list
//   cloud runner file  (.env.runner, a link to one too, even dangling) it is a plain file, not a
//                      link; git ignores it and does not track it; and only its owner can read it
//
// cloudChecks(config, ctx) returns them as { name, step: 'cloud-runner', run(ctx) }; buildChecks
// (doctor-checks.mjs) passes them through withFix. Names only: no result carries a value.

import path from 'node:path';
import { RUNNER_FILE, WORKFLOW, listSecrets, missingSecrets, repoOf } from '../cloud/actions.mjs';
import { actionsWorkflow } from '../cloud/workflow-template.mjs';
import { isIgnored, isTracked } from './foreman-keys.mjs';

const STEP = 'cloud-runner';
const ok = (detail = '') => ({ ok: true, level: 'error', detail });
const fail = (detail, fix) => ({ ok: false, level: 'error', detail, fix });
const warn = (detail, fix) => ({ ok: false, level: 'warn', detail, fix });
const hint = (text) => ({ hint: text });

export function cloudChecks(config, ctx) {
  const checks = [];
  const add = (name, run) => checks.push({ name, step: STEP, run });
  const workflowFile = path.join(ctx.root, WORKFLOW);
  const runnerFile = path.join(ctx.root, RUNNER_FILE);

  if (ctx.fs.existsSync(workflowFile)) {
    add('cloud workflow', () => {
      if (config.state?.store !== 'branch') {
        return fail(`${WORKFLOW} needs the run state on a branch, but state.store is not branch`, hint('keep the run state on a branch from Set up > Cloud runner'));
      }
      let text;
      try {
        text = String(ctx.fs.readFileSync(workflowFile, 'utf8'));
      } catch {
        return warn(`could not read ${WORKFLOW}`, hint('check the file, or rewrite it from Set up > Cloud runner'));
      }
      return text === actionsWorkflow({ config })
        ? ok()
        : warn(`${WORKFLOW} is not what this Foreman writes for this config: it is from another Foreman version, or was changed by hand`, hint('rewrite the workflow from Set up > Cloud runner'));
    });

    add('cloud secrets', () => {
      const repo = repoOf({ root: ctx.root, config, sh: ctx.sh });
      if (!repo) return warn('git has no GitHub remote, so the Actions secrets cannot be checked', hint('push the project to GitHub, then check again'));
      const list = listSecrets({ repo, sh: ctx.sh, cwd: ctx.root });
      if (!list.ok) return warn(`gh could not list the Actions secrets of ${repo}: ${list.detail}`, hint('check that `gh` is signed in and can read the repository'));
      const missing = missingSecrets(config, list.names);
      return missing.length ? fail(`not set on ${repo}: ${missing.join(', ')}`, hint('set the secrets from Set up > Cloud runner')) : ok();
    });
  }

  // existsSync follows a link, so a dangling one is seen through lstat.
  const isLink = () => {
    try {
      return ctx.fs.lstatSync?.(runnerFile)?.isSymbolicLink() === true;
    } catch {
      return false;
    }
  };
  if (ctx.fs.existsSync(runnerFile) || isLink()) {
    add('cloud runner file', () => {
      if (isLink()) return fail(`${RUNNER_FILE} is a link to another file, so its keys could land in a file git tracks`, hint(`replace ${RUNNER_FILE} with a plain file`));
      if (isIgnored({ root: ctx.root, file: RUNNER_FILE, sh: ctx.sh }) !== 'ignored') {
        return fail(`git does not ignore ${RUNNER_FILE}, so its keys could be committed`, hint(`add ${RUNNER_FILE} to .gitignore from Set up > Cloud runner`));
      }
      if (isTracked({ root: ctx.root, file: RUNNER_FILE, sh: ctx.sh }) === 'tracked') {
        return fail(`git tracks ${RUNNER_FILE}, so its keys could be committed`, hint(`run \`git rm --cached ${RUNNER_FILE}\` and commit`));
      }
      let mode = null;
      try {
        mode = ctx.fs.statSync(runnerFile).mode;
      } catch {
        // gone since it was seen
      }
      return mode !== null && mode & 0o077 ? warn(`${RUNNER_FILE} can be read by other users; run chmod 600 ${RUNNER_FILE}`, hint(`run \`chmod 600 ${RUNNER_FILE}\``)) : ok();
    });
  }

  return checks;
}
