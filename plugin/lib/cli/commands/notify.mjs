// `foreman notify`: tell the owner something happened, through the project's notifier
// (config `notify`). The supervisor runs this when the run stops, a story is blocked or fails,
// a slot parks or goes down, or the factory pauses. The wording is in lib/notify/email.mjs.
//
//   foreman notify --kind <halted|stopped|blocked|failed|noresult|parked|down|paused|config|credits|standby|owner-task|unexpected-stop|stuck>
//        [--slot wN] [--parked-for crash|dirty|owner] [--story <id>] [--reason <text>]
//        [--stories n] [--shipped n] [--log file]
//
// Foreman's own keys from .env.foreman (config `foremanEnvFile`; its registry names only), then
// the project's env file (config `envFile`), are loaded for the notifier's keys, the
// environment winning over both; they are never printed. Exits 1 with one line when nothing
// was sent; the loop carries on either way. With features.notifications off (local layer
// included) it writes to the outbox only. The config kind says the run is on the last good config
// because foreman.config.json turned invalid. While a run is on it, an invalid file gives that
// config (lib/settings/load.mjs loadResolvedOrLastGood); otherwise nothing is sent. The stuck kind
// says the run is going but not making progress (the supervisor's progress watchdog). The credits
// kind says the platform credits ran out and the run moved to the subscription
// (engine/claude-fallback.mjs); its reason is the line Waiting on you shows. The unexpected-stop
// kind says something other than the owner asked the run to stop; its reason names who
// (console/stopper.mjs). The standby kind says the run has nothing to build while things wait on
// the owner; its reason is the Standby line from console/waiting.mjs standbyNews, and --story is
// the story an answer would start. The owner-task kind says an owner task has held a story past
// watchdog.ownerTaskHours; its reason is engine/owner-task-watch.mjs ownerTaskText and --story
// is the story it holds.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openNotifier } from '../../engine/notifier.mjs';
import { loadResolvedOrLastGood } from '../../settings/load.mjs';
import { foremanEnvName, loadForemanKeys } from '../../engine/foreman-keys.mjs';
import { nextStory } from '../../engine/pick.mjs';
import { openStorySource } from '../../engine/story-source.mjs';
import { buildEmail } from '../../notify/email.mjs';
import { readSessionLog } from '../../engine/session-log.mjs';
import { validSlot } from '../../console/commands.mjs';

// Any configured step's options may carry rollbackHint; the first in ship.steps order wins.
// `ship.deploy` is the older name, read last.
function rollbackHintOf(config) {
  for (const name of config.ship?.steps ?? []) {
    const hint = config.ship?.[name]?.rollbackHint;
    if (typeof hint === 'string' && hint.trim()) return hint;
  }
  return config.ship?.deploy?.rollbackHint;
}

export const KINDS = ['halted', 'stopped', 'blocked', 'failed', 'noresult', 'parked', 'down', 'paused', 'config', 'credits', 'standby', 'owner-task', 'unexpected-stop', 'stuck'];

const USAGE = `usage: foreman notify --kind <${KINDS.join('|')}> [--slot wN] [--parked-for crash|dirty|owner] [--story id] [--reason text] [--stories n] [--shipped n] [--log file]`;

const arg = (args, name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? '' : (args[i + 1] ?? '');
};

// "2026-10-14T10:10:26Z {json}" as written by the ship runner.
function readHalt(dir) {
  const file = join(dir, 'HALT');
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const json = JSON.parse(raw.slice(raw.indexOf('{')));
    return { stage: json.stage ?? '', reason: json.reason ?? '', pr: json.pr ?? '', ...(typeof json.rolledBack === 'boolean' ? { rolledBack: json.rolledBack } : {}) };
  } catch {
    return null;
  }
}

// w1..wN, N being config.slots.
export { validSlot };

export function makeNotifyCommand({ fetch, gitEmail } = {}) {
  return {
    name: 'notify',
    summary: 'tell the owner the run stopped, a story is blocked, a slot parked (notify --kind <k>)',

    async run(args, { env, stdout, stderr, root, now }) {
      const clock = now ?? (() => new Date());
      const fail = (line) => {
        stderr.write(`${line}\n`);
        return 1;
      };

      const kind = arg(args, 'kind');
      if (!KINDS.includes(kind)) return fail(USAGE);

      const { config, errors, dir } = loadResolvedOrLastGood(root, { env });
      if (!config) return fail(`Not sent: ${errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')}`);

      try {
        loadForemanKeys({ root, config, target: env });
      } catch {
        return fail(`Not sent: could not read ${foremanEnvName(config)}.`);
      }
      const envFile = join(root, config.envFile);
      if (existsSync(envFile)) {
        try {
          process.loadEnvFile(envFile);
        } catch {
          return fail(`Not sent: could not read ${config.envFile}.`);
        }
      }

      // The story id is checked against the source's id pattern; a source that will not open
      // means no story in the email.
      let source = null;
      try {
        source = openStorySource({ root, config, now: clock, env });
      } catch {
        // no story in the email
      }
      const wanted = arg(args, 'story');
      const storyId = source && wanted && new RegExp(`^(?:${source.idPattern})$`).test(wanted) ? wanted : '';
      let story = null;
      if (storyId) {
        try {
          const s = nextStory(source.list(), { id: storyId, idPattern: source.idPattern });
          story = { id: storyId, title: s?.title ?? '' };
        } catch {
          story = { id: storyId, title: '' };
        }
      }

      const logFile = arg(args, 'log');
      const slot = validSlot(arg(args, 'slot'), config.slots) ? arg(args, 'slot') : '';
      const parkedFor = ['crash', 'dirty', 'owner'].includes(arg(args, 'parked-for')) ? arg(args, 'parked-for') : 'crash';
      const links = {};
      if (config.console?.commandCenterUrl) links.commandCenter = config.console.commandCenterUrl;
      if (config.console?.decisionsUrl) links.decisions = config.console.decisionsUrl;

      const mail = buildEmail({
        kind,
        slot,
        parkedFor,
        reason: arg(args, 'reason'),
        story,
        halt: kind === 'halted' ? readHalt(dir) : null,
        run: { stories: Number(arg(args, 'stories')) || 0, shipped: Number(arg(args, 'shipped')) || 0 },
        // The session's own final message, out of its stream-json log.
        report: logFile && existsSync(logFile) ? readSessionLog(readFileSync(logFile, 'utf8')).finalText : '',
        project: config.project,
        rollbackHint: rollbackHintOf(config),
        links,
        now: clock(),
      });

      let result;
      try {
        const notifier = openNotifier({ config, ctx: { stateDir: dir, env, now: clock, fetch, gitEmail } });
        result = await notifier.send({ kind, subject: mail.subject, text: mail.text, html: mail.html });
      } catch (err) {
        return fail(`Not sent: ${err?.message ?? err}`);
      }
      if (!result.sent) return fail(`Not sent: ${result.reason}.`);
      stdout.write(result.file ? `Wrote ${result.file}\n` : `Emailed ${result.to}: ${mail.subject}\n`);
      return 0;
    },
  };
}

export default makeNotifyCommand();
