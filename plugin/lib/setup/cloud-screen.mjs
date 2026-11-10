// The Cloud runner screen of Set up: its words, as plain data the page draws from.
//
//   CLOUD_SCREEN   deep-frozen, with part 'cloud':
//                  the heading; the choice between GitHub Actions and a container (`modes`),
//                  and the step's guide ids each one shows (`guides`); the line and button that
//                  put the run state on a branch; the workflow's lines (none yet, current, from
//                  another version) with Write, Rewrite and the commit line; the GitHub token
//                  field's label and note; Set the secrets, its busy line and the secrets
//                  table's headings and cells; the missing line ({names}) and the save-first
//                  line ({name}); Write the runner file, its busy line, the line when git does
//                  not ignore it ({file}) with the ignore button, and the docker run caption;
//                  Check the runner and its busy line; the line shown on a dashboard beyond
//                  this computer; and `errors`, what lib/setup/cloud.mjs answers with
//                  ({name} and {detail} in ghFailed, {file} in notIgnored, runnerTracked and
//                  runnerLink).
//
// No click path and no guide text: those are the step's guide, in steps.mjs. This file
// imports nothing: steps.mjs imports it, and cloud.mjs imports it.

const freeze = (v) => {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

export const CLOUD_SCREEN = freeze({
  part: 'cloud',
  heading: 'Where should Foreman build while your laptop is off?',
  modes: [
    { value: 'actions', label: 'GitHub Actions: one story per scheduled job, with no machine of yours' },
    { value: 'container', label: 'A container: runs all the time on a server of yours, with the dashboard' },
  ],
  guides: {
    actions: ['state-branch', 'workflow', 'token', 'secrets'],
    container: ['runner-file', 'docker-run'],
  },

  stateBranch: {
    line: 'A GitHub Actions job keeps nothing once it ends, so the run state must live on a branch. This project keeps it in files.',
    button: 'Keep the run state on a branch',
  },

  workflow: {
    none: 'There is no workflow yet.',
    current: '.github/workflows/foreman.yml is the one this Foreman writes.',
    old: '.github/workflows/foreman.yml is from another Foreman version, or was changed by hand.',
    write: 'Write the workflow',
    rewrite: 'Rewrite the workflow',
    commit: 'Commit .github/workflows/foreman.yml and push it, so GitHub runs it.',
  },

  token: {
    label: 'GitHub token for the runner',
    note:
      'A classic token with the repo scope (add workflow if a story may change .github/workflows), or a fine-grained token for this repository with Contents and Pull requests read and write, and Actions and Commit statuses read (add Workflows read and write if a story may change .github/workflows, and Deployments read if ship.steps has deploy-github). A fine-grained token cannot read check runs, so Foreman then waits on GitHub Actions jobs and commit statuses: a check that other apps post is not seen. While the Foreman repository is private, the token must be able to read it too. Foreman checks the token, then hands it on; it is never saved here.',
  },

  secrets: {
    set: 'Set the secrets',
    setting: 'Setting the secrets…',
    reading: 'Reading the secrets on GitHub…',
    table: { name: 'Secret', github: 'On GitHub', stored: 'Saved here' },
    yes: 'Yes',
    no: 'No',
    done: 'Set on GitHub: {names}',
  },

  missing: 'Not set yet: {names}',
  saveFirst: 'Save {name} on its step first.',

  runner: {
    write: 'Write the runner file',
    writing: 'Writing the runner file…',
    notIgnored: 'git does not ignore {file}, so its keys could be committed.',
    ignore: 'Add to .gitignore',
    dockerRun: 'Start the runner on your server, from the folder that holds .env.runner:',
  },

  check: 'Check the runner',
  checking: 'Checking the runner…',
  results: 'What the checks found',

  localOnly:
    'Secrets and the runner file can be set and checked only from a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',

  errors: {
    setupFirst: 'Finish set-up first: this project has no working foreman.config.json yet.',
    badBody: 'Foreman could not read that request.',
    noRepo: 'git has no GitHub remote for this project, so Foreman cannot tell which repository gets the secrets. Push the project to GitHub first.',
    needsBranch: 'The workflow needs the run state on a branch. Keep it on a branch first.',
    workflowExists: '.github/workflows/foreman.yml is there already. Rewrite it to replace it.',
    badToken: 'This does not look like a GitHub token: it starts with ghp_ or github_pat_.',
    tokenRefused: 'The checks did not pass with this token, so no secret was set. See what failed below.',
    ghFailed: '{name}: {detail}',
    notIgnored: 'git does not ignore {file}, so nothing was written. Add it to .gitignore first.',
    nothingChanged: 'Nothing changed.',
    runnerTracked: 'git tracks {file}, so nothing was written: its keys could be committed. Run git rm --cached {file}, commit, then write it again.',
    runnerLink: '{file} is a link to another file, so nothing was written. Delete the link, then write it again.',
    workflowLink: '.github/workflows/foreman.yml, or a folder above it, is a link, so nothing was written. Delete the link, then write it again.',
  },
});
