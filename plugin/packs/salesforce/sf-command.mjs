// `foreman sf`: the Salesforce pack's own commands.
//
//   foreman sf skills   installs the skills at salesforce.skills.tag from salesforce.skills.source
//                       into .agents/skills, links them from .claude/skills, and writes
//                       skills-lock.json (skills.mjs). It commits nothing: it says what to commit.
//                       The last line is JSON: { ok: true, source, tag, commit, installed,
//                       removed } plus movedFrom, the commit skills-lock.json recorded, when the
//                       tag moved upstream (with a warning on stderr), or { ok: false, reason }.
//   foreman sf deletes allow|keep-out <story id>
//                       records the owner's answer to the metadata deletes the sf-delta ship
//                       step is waiting on (deletes.mjs). An allow holds only for the
//                       destructiveChanges.xml the question was asked about. The last line is
//                       JSON: { ok: true, story, answer, sha256, deletes: <count> }, or
//                       { ok: false, reason } when no deletes wait for the story. It refuses
//                       inside a story session against the run's project (run-guard GUARDED),
//                       so only the owner's shell or the supervisor's answers path records an
//                       answer.
//   foreman sf baseline [--refresh|--story]
//                       without a flag, prints what each org in the layout (the build orgs,
//                       then each stage's, a shared org once) already fails, as the doctor saved
//                       it (baseline.mjs), and runs no sf. The last line is JSON: { ok: true,
//                       testOrg, orgs: [{ alias, roles, state: 'none' | 'running' | 'done' |
//                       'aborted', failing, coverage, finishedAt }] }; testOrg is the org the
//                       tester's dry run uses (the test stage's, else this slot's build org).
//                       With --story it reads the same, plus when this checkout's branch was
//                       last created or reset (its newest `branch: Created from` or `branch:
//                       Reset to` reflog entry, in ctx.cwd), and lists an org's failing tests
//                       only when the baseline finished and its file was written before then
//                       (baseline.mjs isTrusted), so a baseline saved during the story never
//                       counts. Each entry gets trusted, and the JSON gets branchStart (an ISO
//                       time, or null when it cannot be read: then nothing is trusted). It still
//                       runs no sf and exits 0. With --refresh it drops each saved baseline and starts the org's local
//                       tests again in the isolated sf home, sandboxes only. The last line is
//                       JSON: { ok, started: [{ alias, testRunId }], failed: [{ alias, reason }] },
//                       ok false (exit 1) when any org could not start.
//   foreman sf rollback <story id>
//                       rolls stage 1 back from the story's merge (rollback.mjs): reverts the
//                       merge on the branch and deploys the reverse delta to stage 1's org. It
//                       refuses a story that reached a later stage. It is the sf path's
//                       ship.rollback.command, so it runs inside the ship runner's synchronous
//                       `sh -c` and keeps the slot's heartbeat itself while it waits on the
//                       deploy. A line for people, one line per manual step, then the last line is JSON: the rollBack
//                       result, { ok: true, story, stage, org, merge, revert, jobId, components,
//                       deletes, held, manualSteps } or { ok: false, refused?, reason }.
//   foreman sf fixed <stage>
//                       after the owner fixed a halted stage by hand, records the stage's last
//                       deploy as the branch head and the org's newest real deploy
//                       (steps/sf-verify.mjs markFixed), so `foreman health` passes and "I've
//                       fixed it" clears the halt. A line for people, then the last line is JSON:
//                       { ok: true, stage, org, commit, jobId } or { ok: false, reason }.
//
// Exits 0 on success, 1 on a failure or a config that is not a salesforce one, 64 on usage.
// The config loader, the pack registry and the slot state (lib/engine/state.mjs) are imported
// when the command runs, not when this module loads: the config loader imports the pack
// registry, which imports this pack, and the slot state loads the config defaults.

import fs from 'node:fs';
import os from 'node:os';
import { installSkills } from './skills.mjs';
import { currentSlot, stateDir } from '../../lib/engine/paths.mjs';
import { ANSWERS, answerDeletes, readDeletes } from './deletes.mjs';
import { layout } from './config.mjs';
import { baselineWrittenAt, clearBaseline, isTrusted, readBaseline, startBaseline, writeBaseline } from './baseline.mjs';
import { isolatedSh, sfHome } from './isolation.mjs';
import { rollBack } from './rollback.mjs';
import { markFixed } from './steps/sf-verify.mjs';

const EXIT_USAGE = 64;
const BASELINE_MODES = Object.freeze({ '--refresh': 'refresh', '--story': 'story' });
const SHORT_COMMIT = 7;
const USAGE = 'usage: foreman sf skills\n       foreman sf deletes allow|keep-out <story id>\n       foreman sf baseline [--refresh|--story]\n       foreman sf rollback <story id>\n       foreman sf fixed <stage>\n';

const describeErrors = (errors) => errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('\n');

// When the branch checked out at cwd was last created or reset, in ms, or null when HEAD is
// detached, the reflog has no such entry, or git fails. `git checkout -B <branch> <start>`
// writes `branch: Created from <start>` or `branch: Reset to <start>`; the reflog is newest
// first, each line `<branch>@{<unix seconds>}<TAB><subject>`.
const CREATED = /^branch: (Created from|Reset to) /;
function storyStart(sh, cwd) {
  try {
    const head = sh('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    const branch = head.status === 0 ? String(head.stdout ?? '').trim() : '';
    if (!branch) return null;
    const log = sh('git', ['reflog', 'show', '--date=unix', '--format=%gd%x09%gs', `refs/heads/${branch}`], { cwd });
    if (log.status !== 0) return null;
    for (const line of String(log.stdout ?? '').split('\n')) {
      const [selector, subject = ''] = line.split('\t');
      if (!CREATED.test(subject)) continue;
      const at = /@\{(\d+)\}$/.exec(selector ?? '');
      return at ? Number(at[1]) * 1000 : null;
    }
    return null;
  } catch {
    return null;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Status keeping is best effort: it never fails a rollback.
const quiet = (fn) => {
  try {
    fn();
  } catch {
    // ignore
  }
};

export function makeSfCommand({ sh = null, packs = null, tmpDir, now = () => new Date(), sleep = wait, homedir = null } = {}) {
  // The resolved config of a salesforce project, or null after saying why on stderr.
  async function loadConfig({ env, stderr, root }) {
    const { loadResolved } = await import('../../lib/settings/load.mjs');
    const registry = packs ?? (await import('../index.mjs')).PACKS;
    const merged = { ...process.env, ...env };
    const { config, errors } = loadResolved(root, { env: merged, packs: registry });
    if (!config || errors?.length) {
      stderr.write(`${describeErrors(errors ?? [])}\n`);
      return null;
    }
    if (config.pack !== 'salesforce') {
      stderr.write('this project does not use the salesforce pack\n');
      return null;
    }
    return { config, merged };
  }

  async function deletes(answer, id, ctx) {
    const loaded = await loadConfig(ctx);
    if (!loaded) return 1;
    const dir = stateDir(ctx.root, loaded.config, loaded.merged);
    if (!readDeletes(dir, id)) {
      ctx.stdout.write(`${JSON.stringify({ ok: false, reason: `no deletes wait for ${id}` })}\n`);
      return 1;
    }
    const record = answerDeletes(dir, id, answer, now());
    const count = Array.isArray(record.deletes) ? record.deletes.length : 0;
    ctx.stdout.write(`${answer === 'allow' ? 'allowed' : 'kept out'} the ${count} delete(s) waiting for ${id}\n`);
    ctx.stdout.write(`${JSON.stringify({ ok: true, story: id, answer, sha256: record.sha256, deletes: count })}\n`);
    return 0;
  }

  // The given sh, or the real one the CLI uses.
  async function shellFor(root, merged) {
    if (sh) return sh;
    const { realSh } = await import('../../lib/cli/commands/ship.mjs');
    return realSh(root, { ...merged, GIT_TERMINAL_PROMPT: '0' });
  }

  async function rollback(id, ctx) {
    const loaded = await loadConfig(ctx);
    if (!loaded) return 1;
    const { config, merged } = loaded;
    const dir = stateDir(ctx.root, config, merged);
    const slot = currentSlot(merged);
    const { beat, setStage } = await import('../../lib/engine/state.mjs');
    const report = (detail) =>
      quiet(() => {
        setStage(dir, 'release', detail, now(), slot);
        beat(dir, slot, now());
      });
    const r = await rollBack({ root: ctx.root, config, env: merged, sh: await shellFor(ctx.root, merged), story: id, now, sleep, report });
    if (r.ok) {
      const deployed = r.jobId ? `deploy ${r.jobId}` : 'nothing to deploy';
      const by = r.manualSteps.length ? `; ${r.manualSteps.length} manual step(s) left` : '';
      ctx.stdout.write(`rolled ${id} back on ${r.org} (${r.stage}): reverted ${r.merge.slice(0, SHORT_COMMIT)} with ${r.revert.slice(0, SHORT_COMMIT)}, ${deployed}${by}\n`);
      for (const step of r.manualSteps) ctx.stdout.write(`  by hand: ${step}\n`);
    } else {
      ctx.stdout.write(`${r.refused ? 'refused to roll' : 'could not roll'} ${id} back: ${r.reason}\n`);
    }
    ctx.stdout.write(`${JSON.stringify(r)}\n`);
    return r.ok ? 0 : 1;
  }

  async function fixed(stage, ctx) {
    const loaded = await loadConfig(ctx);
    if (!loaded) return 1;
    const { config, merged } = loaded;
    const r = await markFixed({ root: ctx.root, config, env: merged, sh: await shellFor(ctx.root, merged), stage, now });
    if (r.ok) ctx.stdout.write(`recorded ${r.org} (${r.stage}) as fixed at ${r.commit.slice(0, SHORT_COMMIT)} with deploy ${r.jobId}; "I've fixed it" can clear the halt now\n`);
    else ctx.stdout.write(`could not record ${stage} as fixed: ${r.reason}\n`);
    ctx.stdout.write(`${JSON.stringify(r)}\n`);
    return r.ok ? 0 : 1;
  }

  // Each org in the layout once, with its roles: the build orgs, then each stage's.
  function layoutOrgs(l) {
    const orgs = new Map();
    const add = (alias, role) => {
      if (!orgs.has(alias)) orgs.set(alias, { alias, orgId: l.orgs[alias]?.orgId ?? null, roles: [] });
      orgs.get(alias).roles.push(role);
    };
    for (const alias of l.build.aliases) add(alias, 'build');
    for (const s of l.stages) add(s.org, `stage ${s.name}`);
    return [...orgs.values()];
  }

  // mode: 'list', 'story' (only baselines saved before the story branch count) or 'refresh'.
  async function baseline(mode, ctx) {
    const loaded = await loadConfig(ctx);
    if (!loaded) return 1;
    const { config, merged } = loaded;
    const dir = stateDir(ctx.root, config, merged);
    const l = layout(config.salesforce, config);
    const orgs = layoutOrgs(l);

    if (mode !== 'refresh') {
      const story = mode === 'story';
      const testOrg = l.test.org ?? l.slotOrg(merged.FOREMAN_SLOT)?.alias ?? null;
      const start = story ? storyStart(await shellFor(ctx.root, merged), ctx.cwd ?? ctx.root) : null;
      const entries = orgs.map((org) => {
        const rec = readBaseline(dir, org);
        const trusted = story && isTrusted(rec, baselineWrittenAt(dir, org.alias), start);
        const entry = {
          alias: org.alias,
          roles: org.roles,
          state: rec ? rec.state : 'none',
          failing: rec?.state === 'done' && Array.isArray(rec.failing) && (!story || trusted) ? rec.failing : [],
          coverage: rec?.state === 'done' && typeof rec.coverage === 'number' ? rec.coverage : null,
          finishedAt: typeof rec?.finishedAt === 'string' ? rec.finishedAt : null,
        };
        return story ? { ...entry, trusted } : entry;
      });
      const untrusted = start === null ? "this story's branch start could not be read" : "saved after this story's branch was created";
      for (const e of entries) {
        const what = e.state === 'done'
          ? `${e.failing.length ? `already fails ${e.failing.join(', ')}` : 'no failing tests'}, ${e.coverage === null ? 'no Apex' : `${e.coverage}% Apex coverage`}`
          : e.state === 'none' ? 'no baseline yet' : e.state;
        const not = story && e.state === 'done' && !e.trusted ? `; not counted as inherited: ${untrusted}` : '';
        ctx.stdout.write(`${e.alias} (${e.roles.join(', ')}): ${what}${not}\n`);
      }
      const branchStart = story ? { branchStart: start === null ? null : new Date(start).toISOString() } : {};
      ctx.stdout.write(`${JSON.stringify({ ok: true, testOrg, ...branchStart, orgs: entries })}\n`);
      return 0;
    }

    const home = homedir ?? os.homedir();
    const iso = isolatedSh(await shellFor(ctx.root, merged), merged, sfHome(merged, home), home);
    const started = [];
    const failed = [];
    for (const org of orgs) {
      clearBaseline(dir, org.alias);
      const r = startBaseline(iso, org, now());
      if (!r.ok) {
        failed.push({ alias: org.alias, reason: r.reason });
        ctx.stdout.write(`could not start the local tests of ${org.alias}: ${r.reason}\n`);
        continue;
      }
      writeBaseline(dir, r.record);
      started.push({ alias: org.alias, testRunId: r.record.testRunId });
      ctx.stdout.write(`started the local tests of ${org.alias} (test run ${r.record.testRunId}); \`foreman doctor\` records the result once they finish\n`);
    }
    ctx.stdout.write(`${JSON.stringify({ ok: failed.length === 0, started, failed })}\n`);
    return failed.length ? 1 : 0;
  }

  async function skills({ env, stdout, stderr, root }) {
    const loaded = await loadConfig({ env, stderr, root });
    if (!loaded) return 1;
    const { config, merged } = loaded;
    const shell = await shellFor(root, merged);
    const { source, tag } = config.salesforce?.skills ?? {};
    const r = installSkills({ root, source, tag, sh: shell, fs, ...(tmpDir ? { tmpDir } : {}) });
    if (!r.ok) {
      stdout.write(`${JSON.stringify({ ok: false, reason: r.reason })}\n`);
      return 1;
    }
    if (r.movedFrom) {
      stderr.write(`warning: tag ${tag} of ${source} now points at ${r.commit.slice(0, SHORT_COMMIT)}, not ${r.movedFrom.slice(0, SHORT_COMMIT)} as skills-lock.json recorded; it was moved upstream, so check what changed before you commit\n`);
    }
    stdout.write(`installed ${r.installed.length} skills from ${source} at ${tag} (${r.commit.slice(0, SHORT_COMMIT)}); commit skills-lock.json, .agents/skills and .claude/skills\n`);
    const moved = r.movedFrom ? { movedFrom: r.movedFrom } : {};
    stdout.write(`${JSON.stringify({ ok: true, source, tag, commit: r.commit, installed: r.installed.length, removed: r.removed, ...moved })}\n`);
    return 0;
  }

  return {
    name: 'sf',
    summary: 'Salesforce pack tools (sf skills, sf deletes allow|keep-out <id>, sf baseline [--refresh|--story], sf rollback <id>, sf fixed <stage>)',
    async run(args, ctx) {
      if (args.length === 1 && args[0] === 'skills') return skills(ctx);
      if (args[0] === 'baseline' && args.length === 1) return baseline('list', ctx);
      if (args[0] === 'baseline' && args.length === 2 && Object.hasOwn(BASELINE_MODES, args[1])) return baseline(BASELINE_MODES[args[1]], ctx);
      if (args.length === 3 && args[0] === 'deletes' && ANSWERS.includes(args[1]) && args[2] && !args[2].startsWith('-')) return deletes(args[1], args[2], ctx);
      if (args.length === 2 && args[0] === 'rollback' && args[1] && !args[1].startsWith('-')) return rollback(args[1], ctx);
      if (args.length === 2 && args[0] === 'fixed' && args[1] && !args[1].startsWith('-')) return fixed(args[1], ctx);
      ctx.stderr.write(USAGE);
      return EXIT_USAGE;
    },
  };
}

export default makeSfCommand();
