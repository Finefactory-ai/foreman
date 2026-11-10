// `foreman cloud doctor`: is this machine ready to run Foreman unattended? Two lists of
// { name, run(ctx) -> { ok, level, detail } }, as lib/engine/doctor-checks.mjs:
//
//   runnerChecks()             before the project is cloned: FOREMAN_REPO, GH_TOKEN, the
//                              Claude sign-in, that the token works and reaches the repo, that
//                              it can read the newest pull request's checks as the ci ship step
//                              does, that Claude answers, the plugin folder's version, the work
//                              folder, the dashboard token when the dashboard listens beyond
//                              loopback
//   projectChecks(config, ctx) once it is: the Docker socket when the slot environment needs
//                              it, for the branch store that its branch can be fetched and
//                              pushed, and with "pack": "salesforce" the tools the pack needs
//                              (sf and its plugins, Python 3.10+, Java 11+), which the
//                              -salesforce runner image holds
//   LOCAL_SAFE, localRunnerChecks()
//                              the runner checks that are safe on the owner's own machine, for
//                              the Set up tab's Cloud runner step: the repo, the token and what it
//                              reaches, and the dashboard token. Not 'claude sign-in', which would
//                              fall back to the local login there; not 'claude answers', which
//                              spends tokens; not 'plugin' or 'work folder', which are the runner's
//   runChecks(checks, ctx, out) prints `ok|warn|FAIL  name — detail` lines; true if any failed
//
// ctx: { env, sh(cmd, args, opts?), fs, root?, dockerSocket? }. No value is ever printed: the
// secrets in env are blanked out of anything a command says.

import { join } from 'node:path';
import { claudeSignIn } from '../engine/claude-signin.mjs';
import { isLoopback } from '../dashboard/server.mjs';
import { foremanVersion, runnerImage } from './versions.mjs';
import { readChecks } from '../adapters/ship/ci.mjs';
import { atLeast, toolsCheck } from '../../packs/salesforce/doctor-salesforce.mjs';
// The last line a command said, with every secret blanked.
import { lastLine as said } from '../secrets/redact.mjs';

const ok = (detail = '') => ({ ok: true, level: 'error', detail });
const fail = (detail) => ({ ok: false, level: 'error', detail });

const SF_MAX_BUFFER = 64 * 1024 * 1024;
const set = (env, name) => typeof env[name] === 'string' && env[name] !== '';
export const workDir = (env) => env.FOREMAN_WORK || '/work';

export function runnerChecks() {
  const checks = [];
  const add = (name, run) => checks.push({ name, run });

  add('FOREMAN_REPO', ({ env }) => (/^[\w.-]+\/[\w.-]+$/.test(env.FOREMAN_REPO ?? '') ? ok() : fail('set FOREMAN_REPO to the project repository, as owner/name')));

  add('GH_TOKEN', ({ env }) => (set(env, 'GH_TOKEN') ? ok() : fail('set GH_TOKEN to a GitHub token for the project repository')));

  add('claude sign-in', ({ env, sh }) => {
    const r = claudeSignIn({ env, sh });
    return { ok: r.ok, level: r.level, detail: r.detail };
  });

  add('github token', ({ env, sh }) => {
    if (!set(env, 'GH_TOKEN')) return fail('no GH_TOKEN to check');
    const user = sh('gh', ['api', 'user', '--jq', '.login']);
    if (user.status !== 0) return fail(`the token does not work: ${said(user, env)}`);
    const repo = env.FOREMAN_REPO;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return ok();
    const r = sh('gh', ['api', `repos/${repo}`, '--jq', '.permissions.push']);
    if (r.status !== 0) return fail(`the token cannot read ${repo}: ${said(r, env)}`);
    if (String(r.stdout).trim() !== 'true') return fail(`the token cannot push to ${repo}`);
    return ok();
  });

  // As the ci ship step reads them, so a token that cannot fails here and not at that step.
  add('pull request checks', ({ env, sh }) => {
    if (!set(env, 'GH_TOKEN')) return fail('no GH_TOKEN to check');
    const repo = env.FOREMAN_REPO;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return ok();
    const list = sh('gh', ['api', `repos/${repo}/pulls?state=all&per_page=1`, '--jq', '.[0].number // empty']);
    if (list.status !== 0) return fail(`the token cannot list the pull requests of ${repo}: ${said(list, env)}`);
    const pr = String(list.stdout).trim();
    if (!/^\d+$/.test(pr)) return { ok: false, level: 'warn', detail: `${repo} has no pull request yet, so reading checks was not tried` };
    const r = readChecks(sh, pr, { repo });
    if (!r.checks) {
      const needs = r.rest ? '; this token cannot read check runs, so it needs Pull requests, Actions and Commit statuses read' : '';
      return fail(`the token cannot read the checks of pull request #${pr}: ${said({ stderr: r.error }, env)}${needs}`);
    }
    return r.rest ? ok('read through GitHub Actions and commit statuses, as this token cannot read check runs: checks that other apps post are not seen') : ok();
  });

  add('claude answers', ({ env, sh }) => {
    const r = sh('claude', ['-p', 'Reply with the word ok.', '--max-turns', '1', '--output-format', 'json'], { timeout: 120_000 });
    let result = null;
    try {
      result = JSON.parse(String(r.stdout).trim().split('\n').pop());
    } catch {
      result = null;
    }
    if (r.status === 0 && result && result.is_error !== true) return ok();
    const why = result?.result ? said({ stdout: String(result.result) }, env) : said(r, env) || `exited ${r.status}`;
    return fail(`\`claude -p\` did not answer: ${why}`);
  });

  add('plugin', ({ env, fs }) => {
    const dir = env.FOREMAN_PLUGIN_DIR;
    if (!dir) return fail('set FOREMAN_PLUGIN_DIR to the Foreman plugin folder');
    let version;
    try {
      version = JSON.parse(fs.readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version;
    } catch {
      return fail(`FOREMAN_PLUGIN_DIR (${dir}) holds no Foreman plugin`);
    }
    const mine = foremanVersion();
    return version === mine ? ok(`Foreman ${mine}`) : fail(`FOREMAN_PLUGIN_DIR holds Foreman ${version}, but this command is ${mine}`);
  });

  add('work folder', ({ env, fs }) => {
    const probe = join(workDir(env), `.foreman-doctor-${process.pid}`);
    try {
      fs.writeFileSync(probe, 'ok\n');
      fs.rmSync(probe, { force: true });
      return ok();
    } catch (err) {
      return fail(`cannot write in ${workDir(env)} (${err.code ?? err.message}); mount a volume there that the foreman user can write`);
    }
  });

  add('dashboard token', ({ env }) => {
    const host = env.FOREMAN_DASHBOARD_HOST || '127.0.0.1';
    if (isLoopback(host)) return ok();
    return set(env, 'FOREMAN_DASHBOARD_TOKEN') ? ok() : fail(`the dashboard listens on ${host}, beyond this machine; set FOREMAN_DASHBOARD_TOKEN`);
  });

  return checks;
}

export const LOCAL_SAFE = Object.freeze(['FOREMAN_REPO', 'GH_TOKEN', 'github token', 'pull request checks', 'dashboard token']);

export const localRunnerChecks = () => runnerChecks().filter((c) => LOCAL_SAFE.includes(c.name));

export function projectChecks(config, ctx) {
  const checks = [];
  const add = (name, run) => checks.push({ name, run });
  const socket = ctx.dockerSocket ?? '/var/run/docker.sock';

  if (['docker', 'supabase'].includes(config.env?.adapter)) {
    add('docker socket', ({ fs }) =>
      fs.existsSync(socket) ? ok() : fail(`the ${config.env.adapter} slot environment needs the host's Docker: mount it with -v /var/run/docker.sock:/var/run/docker.sock`));
  }

  if (config.state?.store === 'branch') {
    add('state branch', ({ env, sh, root }) => {
      const remote = config.remote ?? 'origin';
      const branch = config.state.branch ?? 'foreman-state';
      const fetch = sh('git', ['ls-remote', '--heads', remote, branch], { cwd: root });
      if (fetch.status !== 0) return fail(`cannot fetch from ${remote}: ${said(fetch, env)}`);
      const push = sh('git', ['push', '--dry-run', '--quiet', remote, `HEAD:refs/heads/foreman-doctor-${process.pid}`], { cwd: root });
      return push.status === 0 ? ok() : fail(`cannot push to ${remote}, so the state branch cannot be kept: ${said(push, env)}`);
    });
  }

  if (config.pack === 'salesforce') {
    // A runner without these is the plain image: say which one has them.
    const image = `; use the runner image ${runnerImage(config)}, or build with --build-arg SALESFORCE=1`;
    const withHint = (r) => (r.ok || r.level === 'warn' ? r : fail(`${r.detail}${image}`));
    const output = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;

    // `sf plugins --core --json` prints about 3.5 MB, past spawnSync's 1 MB default (the local
    // doctor's shell allows 64 MB).
    const roomy = (sh) => (cmd, args, opts = {}) => sh(cmd, args, { maxBuffer: SF_MAX_BUFFER, ...opts });
    add('salesforce tools', ({ sh }) => withHint(toolsCheck(config.salesforce ?? {}, roomy(sh))));

    add('python', ({ sh }) => {
      const r = sh('python3', ['--version']) ?? {};
      const m = output(r).match(/Python (\d+)\.(\d+)\.(\d+)/);
      if (r.status !== 0 || !m) return fail(`python3 is not on PATH${image}`);
      if (!atLeast(`${m[1]}.${m[2]}.${m[3]}`, '3.10.0')) return fail(`python3 ${m[1]}.${m[2]} < 3.10${image}`);
      return ok(`Python ${m[1]}.${m[2]}.${m[3]}`);
    });

    // `java -version` prints `openjdk version "17.0.13" ...` on stderr; Java 8 says "1.8.0_402".
    add('java', ({ sh }) => {
      const r = sh('java', ['-version']) ?? {};
      const m = output(r).match(/"(\d+)[^"]*"/);
      if (r.status !== 0 || !m) return fail(`java is not on PATH${image}`);
      if (!atLeast(m[1], '11')) return fail(`java ${m[1]} < 11${image}`);
      return ok(`Java ${m[0].slice(1, -1)}`);
    });
  }

  return checks;
}

export async function runChecks(checks, ctx, out) {
  let failed = false;
  for (const check of checks) {
    let r;
    try {
      r = await check.run(ctx);
    } catch (err) {
      r = fail(`the check crashed: ${err?.message ?? err}`);
    }
    if (r.ok) out.write(r.detail ? `ok    ${check.name} — ${r.detail}\n` : `ok    ${check.name}\n`);
    else if (r.level === 'warn') out.write(`warn  ${check.name} — ${r.detail}\n`);
    else {
      failed = true;
      out.write(`FAIL  ${check.name} — ${r.detail}\n`);
    }
  }
  return failed;
}
