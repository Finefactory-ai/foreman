// `foreman setup`: the guided set-up, from the set-up model (lib/setup/steps.mjs) and the
// doctor's own checks.
//
//   foreman setup [--no-open] [--port N]
//       serves the dashboard on 127.0.0.1 (so keys can be saved there) until Ctrl-C, and opens
//       the browser on it; --no-open only prints the address. With no working
//       foreman.config.json the dashboard is in set-up mode (lib/dashboard/server.mjs), and it
//       switches to full mode once set-up writes one.
//   foreman setup steps [--json] [--step <id>]
//       runs the doctor's checks and shows each step's status. With --step, only the step's own
//       checks run, plus any whose cached result counts against the step (the env check naming
//       it), so a key added since gives a current status; the other checks keep their last
//       results from this machine's cache. --json prints one line:
//       { steps: [{ ...step, applies, status, results }] }, skipped steps included.
//   foreman setup next
//       walks the steps that apply, in order, checking each in turn, and stops at the first that
//       needs the owner or is broken: its why, its guide, a fix line per failing result, and the
//       address of the step's page or section of the user guide on finefactory.ai. "All set"
//       when none is waiting.
//
// Results are cached per machine in <stateDir>/setup-checks.json, with checkedAt; a save drops the
// results of checks this config no longer has. No key's
// value is read, printed or cached: inputs say only whether each key is set.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { buildChecks } from '../../engine/doctor-checks.mjs';
import { stateDir as stateDirOf } from '../../engine/paths.mjs';
import { startDashboard } from '../../dashboard/server.mjs';
import { loadResolved } from '../../settings/load.mjs';
import { STEPS, serializeStep, stepById } from '../../setup/steps.mjs';
import { againstStep, checksForStep, envNames, readCache, resolveStep, runChecks, stepStatus, writeCache } from '../../setup/status.mjs';
import { doctorContext } from './doctor.mjs';
import { startFailure, untilSignal } from './dashboard.mjs';
import { openBrowser } from '../open-browser.mjs';

const EXIT_USAGE = 64;
const USAGE = 'usage: foreman setup [--no-open] [--port N] | foreman setup steps [--json] [--step <id>] | foreman setup next\n';
const WAITING = ['needs-you', 'broken'];

const resultsFor = (id, results) => results.filter((r) => r.step === id || r.fix?.step === id);

export function makeSetupCommand({ sh, sourceRoot, pluginsDir, fetch, packs, open = openBrowser } = {}) {
  // Everything both subcommands need: the checks, built once so the ones that share state
  // (the Jira sign-in, the Salesforce org queries) share it, and the steps resolved.
  function prepare({ cwd, env, root, now, stderr }) {
    const { config, dir, ctx } = doctorContext({ root, cwd, env, sh, sourceRoot, pluginsDir, fetch, packs, now });
    const clock = typeof now === 'function' ? now : () => new Date();
    const names = envNames({ root, config, env: ctx.env, fs });
    const steps = STEPS.map((step) => resolveStep(step, { config, envNames: names }));
    const checks = buildChecks(config, ctx);
    const keep = [...new Set(checks.map((c) => c.name))];
    const save = (results) => {
      try {
        writeCache(dir, results, { keep });
      } catch (err) {
        stderr.write(`could not save the check results in ${dir}: ${err?.message ?? err}\n`);
      }
    };
    return { dir, ctx, clock, checks, steps, save };
  }

  async function steps(args, io) {
    let parsed;
    try {
      parsed = parseArgs({ args, options: { json: { type: 'boolean' }, step: { type: 'string' } }, allowPositionals: false, strict: true });
    } catch (err) {
      io.stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    const only = parsed.values.step;
    if (only !== undefined && !stepById(only)) {
      io.stderr.write(`unknown step: ${only} (use ${STEPS.map((s) => s.id).join(', ')})\n${USAGE}`);
      return EXIT_USAGE;
    }
    const { dir, ctx, clock, checks, steps: resolved, save } = prepare(io);
    const before = only ? readCache(dir) : {};
    const fresh = await runChecks(only ? checksForStep(only, checks, before) : checks, ctx, { now: clock });
    save(fresh);
    const cache = readCache(dir);
    const ran = new Set(fresh.map((r) => r.name));
    const kept = [...new Set(checks.map((c) => c.name))].filter((name) => !ran.has(name) && Object.hasOwn(cache, name)).map((name) => cache[name]);
    const results = [...fresh, ...kept];
    const out = resolved.map((step) => ({ ...serializeStep(step), status: stepStatus(step, results), results: resultsFor(step.id, results) }));
    if (parsed.values.json) io.stdout.write(`${JSON.stringify({ steps: out })}\n`);
    else for (const step of out) io.stdout.write(`${step.status.padEnd(9)} ${step.title}\n`);
    return 0;
  }

  async function next(args, io) {
    if (args.length) {
      io.stderr.write(USAGE);
      return EXIT_USAGE;
    }
    const { ctx, clock, checks, steps: resolved, save } = prepare(io);
    const results = [];
    for (const step of resolved) {
      if (!step.applies) continue;
      // One step at a time runs sf-layout's 'salesforce test level' before sf-orgs' baseline
      // checks, which write the baselines it reads; doctor runs them the other way round. On a
      // first run test level only says 'no baseline yet' (ok). Revisit this if test level ever
      // fails without a baseline.
      const ran = await runChecks(checks.filter((c) => c.step === step.id), ctx, { now: clock });
      save(ran);
      results.push(...ran);
      const status = stepStatus(step, results);
      if (!WAITING.includes(status)) continue;
      const lines = [`Next: ${step.title} (${status})`, step.why];
      step.guide.forEach((g, i) => lines.push(`${i + 1}. ${g.text}${g.click?.length ? ` (click: ${g.click.join(' › ')})` : ''}`));
      for (const r of againstStep(step.id, results)) lines.push(`fix: ${r.fix?.hint ?? step.hint}`);
      if (step.more) lines.push(`More: ${step.more}`);
      io.stdout.write(`${[...new Set(lines)].join('\n')}\n`);
      return 0;
    }
    io.stdout.write('All set: every step is done.\n');
    return 0;
  }

  // The set-up page: the dashboard, in set-up mode when the project has no working config yet.
  async function page(args, { root, env, now, stdout, stderr, until }) {
    let values;
    try {
      ({ values } = parseArgs({ args, options: { 'no-open': { type: 'boolean' }, port: { type: 'string' } }, allowPositionals: false, strict: true }));
    } catch (err) {
      stderr.write(`${err.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535)) {
      stderr.write(`--port needs a port number from 0 to 65535, not ${values.port}.\n${USAGE}`);
      return EXIT_USAGE;
    }
    const loaded = loadResolved(root, { env });
    const config = loaded.config ?? null;
    let started;
    try {
      started = await startDashboard({
        root,
        config,
        stateDir: config ? loaded.dir : stateDirOf(root, null, env),
        env,
        now,
        host: '127.0.0.1',
        port: values.port === undefined ? undefined : Number(values.port),
      });
    } catch (err) {
      stderr.write(startFailure(err));
      return 1;
    }
    const { server, url } = started;
    stdout.write(`Set up: ${url}\n`);
    stdout.write('Ctrl-C stops it.\n');
    if (!values['no-open']) open(url);

    await (until ?? untilSignal());
    await new Promise((resolve) => server.close(() => resolve()));
    return 0;
  }

  return {
    name: 'setup',
    summary: 'set Foreman up in the browser (setup [--no-open] [--port N]), or one step at a time (setup next, setup steps [--json] [--step <id>])',

    async run(args, io) {
      const [sub, ...rest] = args;
      if (sub === 'steps') return steps(rest, io);
      if (sub === 'next') return next(rest, io);
      if (sub === undefined || sub.startsWith('-')) return page(args, io);
      io.stderr.write(USAGE);
      return EXIT_USAGE;
    },
  };
}

export default makeSetupCommand();
