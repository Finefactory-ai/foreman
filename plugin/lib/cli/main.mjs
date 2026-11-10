// The `foreman` command line. It picks a command by name from the list below and hands it
// the rest of the arguments. To add a command, import its module and add it to COMMANDS. Each
// pack's commands (plugin/packs/index.mjs) follow the core ones, whatever the project's pack.
// With the branch state store, a command that reads or writes state syncs the state branch
// around it (lib/state-store/with-state.mjs says which); `sh` and `sleep` are for that sync.
// Inside a Foreman story session (FOREMAN_RUN=1) a command that writes the owner's files
// (lib/engine/run-guard.mjs GUARDED) acts on the repo around the current folder, or on the
// folder itself outside any repo, not on FOREMAN_PROJECT_DIR or FOREMAN_STATE_DIR, and refuses
// when that repo is the project the run builds: a session checks such commands in a scratch git
// repo or a plain temporary folder. Every other command run inside a scratch repo (a git repo
// that is not the run's project), or outside any repo, acts on that repo or folder too, and never
// on FOREMAN_STATE_DIR; from the slot worktree it acts on the run's project as before, because
// the story skill needs that. Wherever a command is moved, it refuses when the project it lands
// on keeps its state in the run's own state folder (run-guard.mjs refuseRunState), and every
// command refuses when git cannot say where the current folder is (a missing folder, a git error).
// Before anything else, the owner's controls (run-guard.mjs OWNER_CONTROLS: stop, pause, resume,
// run, slot, service install|uninstall, settings set|reset, features on|off and the rest) refuse
// in a story session whose FOREMAN_RUN is changed or unset while FOREMAN_STORY or FOREMAN_SLOT is
// still set, wherever it stands. With no session variable at all they refuse when the state
// folder they would act on has a live supervisor that started this process, so an environment
// stripped back to the owner's shape still cannot reach the run; `alive` and `parents` stand in
// for that check's process lookups in tests.

import config from './commands/config.mjs';
import story from './commands/story.mjs';
import stage from './commands/stage.mjs';
import lock from './commands/lock.mjs';
import ship from './commands/ship.mjs';
import release from './commands/release.mjs';
import health from './commands/health.mjs';
import workflowArgs from './commands/workflow-args.mjs';
import traits from './commands/traits.mjs';
import notify from './commands/notify.mjs';
import checks from './commands/checks.mjs';
import review from './commands/review.mjs';
import status from './commands/status.mjs';
import report from './commands/report.mjs';
import decide from './commands/decide.mjs';
import learn from './commands/learn.mjs';
import learning from './commands/learning.mjs';
import dashboard from './commands/dashboard.mjs';
import run from './commands/run.mjs';
import service from './commands/service.mjs';
import doctor from './commands/doctor.mjs';
import setup from './commands/setup.mjs';
import init from './commands/init.mjs';
import settings from './commands/settings.mjs';
import features from './commands/features.mjs';
import jira from './commands/jira.mjs';
import cloud from './commands/cloud.mjs';
import keys from './commands/keys.mjs';
import claude from './commands/claude.mjs';
import { CONTROL_COMMANDS } from './commands/control.mjs';
import { projectRoot } from '../engine/paths.mjs';
import { guardedWrite, refuseAnchorWrite, refuseOwnerControl, refuseRunState, sessionPlace, unknownPlace } from '../engine/run-guard.mjs';
import { PACKS, packCommands } from '../../packs/index.mjs';
import { stateMode, withState } from '../state-store/with-state.mjs';

// The core commands, then the packs' commands. Throws when a name is used twice.
export function commandList(core, packs = PACKS) {
  const all = [...core, ...packCommands(packs)];
  const seen = new Set();
  for (const command of all) {
    if (seen.has(command.name)) throw new Error(`pack command ${command.name} clashes with a command`);
    seen.add(command.name);
  }
  return all;
}

const CORE = [run, service, init, doctor, setup, config, settings, features, jira, cloud, keys, claude, story, stage, lock, checks, review, ship, release, health, notify, status, report, dashboard, ...CONTROL_COMMANDS, decide, learn, learning, workflowArgs, traits];
const COMMANDS = commandList(CORE);

const EXIT_USAGE = 64;
// Commands whose subcommand goes in the state commit's message.
const BY_SUB_NAMES = new Set(['decide', 'story', 'settings', 'learn', 'learning', 'release', 'claude']);
// The variables that point a command at the run's project; a guarded command in a run drops them.
const RUN_LOCATION = new Set(['FOREMAN_PROJECT_DIR', 'FOREMAN_STATE_DIR']);

export { projectRoot };

function usage() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map((c) => `${c.name.padEnd(width)}  ${c.summary}`);
  return ['usage: foreman <command> [args]', '', 'commands:', ...lines, ''].join('\n');
}

export async function main(argv, { cwd, env, stdout, stderr, now, sh, sleep, alive, parents }) {
  const [name, ...args] = argv;
  if (name === undefined || name === '--help' || name === 'help') {
    stdout.write(usage());
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    stderr.write(`unknown command: ${name}\nrun \`foreman --help\` to see the commands\n`);
    return EXIT_USAGE;
  }
  const refused = refuseOwnerControl({ env, cwd, name, args, ...(alive ? { alive } : {}), ...(parents ? { parents } : {}) });
  if (refused) {
    stderr.write(`${refused}\n`);
    return 1;
  }
  let root;
  let cmdEnv = env;
  if (env?.FOREMAN_RUN === '1') {
    const place = sessionPlace(cwd, env);
    const what = guardedWrite(name, args);
    if (place.kind === 'unknown') {
      stderr.write(`${unknownPlace(what ?? `foreman ${name}`, cwd, place.reason)}\n`);
      return 1;
    }
    let moved = false;
    if (what) {
      const target = place.kind === 'run' ? projectRoot({ cwd, env: {} }) : place.root;
      const refusal = refuseAnchorWrite(env, target, what);
      if (refusal) {
        stderr.write(`${refusal}\n`);
        return 1;
      }
      root = target;
      cmdEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !RUN_LOCATION.has(key)));
      moved = true;
    } else if (place.kind === 'scratch' || place.kind === 'plain') {
      // The command gets that repo or folder as its root and its own state folder there; it keeps
      // FOREMAN_PROJECT_DIR so its own guards (keys migrate) still know which project to protect.
      root = place.root;
      cmdEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'FOREMAN_STATE_DIR'));
      moved = true;
    } else {
      root = projectRoot({ cwd, env });
    }
    if (moved) {
      const refusal = refuseRunState(env, root, what ?? `foreman ${name}`);
      if (refusal) {
        stderr.write(`${refusal}\n`);
        return 1;
      }
    }
  } else {
    root = projectRoot({ cwd, env });
  }
  const run = () => command.run(args, { cwd, env: cmdEnv, stdout, stderr, root, now, sh, sleep });
  const mode = stateMode(argv);
  if (!mode) return run();
  const sub = args.find((a) => !a.startsWith('-'));
  const message = `foreman ${name}${BY_SUB_NAMES.has(name) && sub ? ` ${sub}` : ''}`;
  return withState({ root, env: cmdEnv, stderr, sh, sleep }, { write: mode === 'write', message }, run);
}
