// Where each set-up step stands, from the doctor's own checks.
//
//   envNames({ root, config, env, fs })    the key names set in the env file, Foreman's own names in
//                                          .env.foreman, or the environment (non-empty). Names
//                                          only: no value is ever read out.
//   resolveStep(step, { config, envNames })
//                                          the step with applies and optional worked out, and
//                                          each input's required and present
//   stepStatus(resolvedStep, results)      'skipped' | 'optional' | 'needs-you' | 'broken' | 'done'
//   runCheck(check, ctx, { now })          one doctor check, awaited; a crash becomes an error
//   runChecks(checks, ctx, { now })        each in turn: { name, step, ...result, checkedAt }
//   checksForStep(id, checks, cache)       a step's own checks, plus any check whose last cached
//                                          result counts against the step through fix.step (the
//                                          env check), so Test it gives a current result
//   readCache(dir) / writeCache(dir, results, { keep })
//                                          the last result of each check on this machine, in
//                                          <stateDir>/setup-checks.json, merged by check name;
//                                          with keep (check names), earlier results of any other
//                                          check are dropped first
//   STEP_CHECK_MS                          the time limit for one step's checks run from the
//                                          dashboard (15 minutes)
//   shareable(result)                      a copy fit to send over HTTP: a crashed check's raw
//                                          message (a path, a spawn error) becomes CRASH_SHOWN;
//                                          any other result, or undefined, comes back as it is
//
// A result that is not ok counts against the step its fix names, else the step of its check:
// the env check runs under "Project keys" but a missing RESEND_API_KEY counts against
// "Notifications". Warnings show but never stop a step being done.

import nodeFs from 'node:fs';
import path from 'node:path';
import { namesInEnvFile } from '../engine/doctor-checks.mjs';
import { foremanEnvPath, foremanKeysIn, projectEnvPath } from '../engine/foreman-keys.mjs';

export const CACHE_FILE = 'setup-checks.json';
// How long one step's checks may run when the dashboard's Test it asks for them. The project's own
// checks are among them, and a full `npm test` takes 4 to 8 minutes on a busy machine.
export const STEP_CHECK_MS = 15 * 60_000;
const CRASH_HINT = 'run `foreman doctor` again; if it repeats, report it';
// How a crashed check's detail starts; the CLI and the cache keep the raw message after it.
export const CRASHED = 'the check crashed: ';
// What the dashboard shows instead of a crashed check's raw message.
export const CRASH_SHOWN = 'the check crashed; run `foreman setup steps` on this computer for the detail';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function envNames({ root, config, env = {}, fs = nodeFs }) {
  const fromFile = [
    ...namesInEnvFile(fs, projectEnvPath(root, config)),
    ...foremanKeysIn(foremanEnvPath(root, config), fs),
  ];
  const fromEnv = Object.entries(env ?? {}).filter(([, v]) => typeof v === 'string' && v !== '').map(([k]) => k);
  return [...new Set([...fromFile, ...fromEnv])];
}

// The value at a dotted path such as 'notify.adapter', or undefined.
function valueAt(config, dotted) {
  let v = config;
  for (const part of String(dotted ?? '').split('.')) {
    if (!isPlain(v) || !Object.hasOwn(v, part)) return undefined;
    v = v[part];
  }
  return v;
}

const hasValue = (v) => {
  if (v === undefined || v === null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlain(v)) return Object.keys(v).length > 0;
  return true;
};

export function resolveStep(step, { config, envNames: names = [] }) {
  const set = new Set(names);
  const raw = typeof step.inputs === 'function' ? step.inputs(config) : step.inputs ?? [];
  const inputs = raw.map((input) => {
    const required = typeof input.required === 'function' ? Boolean(input.required(config)) : input.required ?? true;
    const present = input.kind === 'key' ? set.has(input.name) : hasValue(valueAt(config, input.configPath ?? input.name));
    return { ...input, required, present };
  });
  return {
    ...step,
    applies: Boolean(step.applies(config)),
    optional: Boolean(step.optional?.(config)),
    inputs,
  };
}

// The results that are not ok and count against `id`.
export const againstStep = (id, results) => results.filter((r) => r && r.ok === false && (r.fix?.step ?? r.step) === id);

export function stepStatus(step, results) {
  if (!step.applies) return 'skipped';
  const broken = againstStep(step.id, results).some((r) => r.level !== 'warn');
  if (step.optional) return broken ? 'broken' : 'optional';
  if (step.inputs.some((i) => i.required && !i.present)) return 'needs-you';
  return broken ? 'broken' : 'done';
}

export async function runCheck(check, ctx, { now = () => new Date() } = {}) {
  const crashed = (detail) => ({ ok: false, level: 'error', detail, fix: { step: check.step, hint: CRASH_HINT } });
  let result;
  try {
    result = await check.run(ctx);
  } catch (err) {
    result = crashed(`${CRASHED}${err?.message ?? err}`);
  }
  if (!isPlain(result)) result = crashed('the check gave no result');
  return { name: check.name, step: check.step, ...result, checkedAt: now().toISOString() };
}

// Matching on the prefix also covers crash results already in an older setup-checks.json.
export const shareable = (result) =>
  isPlain(result) && typeof result.detail === 'string' && result.detail.startsWith(CRASHED) ? { ...result, detail: CRASH_SHOWN } : result;

export async function runChecks(checks, ctx, opts = {}) {
  const out = [];
  for (const check of checks) out.push(await runCheck(check, ctx, opts));
  return out;
}

export const checksForStep = (id, checks, cache = {}) =>
  checks.filter((c) => c.step === id || (Object.hasOwn(cache ?? {}, c.name) && cache[c.name]?.ok === false && cache[c.name]?.fix?.step === id));

export function readCache(dir) {
  try {
    const raw = JSON.parse(nodeFs.readFileSync(path.join(dir, CACHE_FILE), 'utf8'));
    if (isPlain(raw) && raw.version === 1 && isPlain(raw.results)) return raw.results;
  } catch {
    // A missing or broken file reads as empty; the next write replaces it.
  }
  return {};
}

export function writeCache(dir, results, { keep } = {}) {
  const merged = { ...readCache(dir) };
  if (Array.isArray(keep)) {
    const kept = new Set(keep);
    for (const name of Object.keys(merged)) if (!kept.has(name)) delete merged[name];
  }
  for (const r of results) merged[r.name] = r;
  nodeFs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CACHE_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  nodeFs.writeFileSync(tmp, `${JSON.stringify({ version: 1, results: merged }, null, 2)}\n`, { mode: 0o600 });
  nodeFs.chmodSync(tmp, 0o600);
  nodeFs.renameSync(tmp, file);
}
