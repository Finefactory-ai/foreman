// The Docker Compose slot environment: one compose project per slot (<prefix>-wN), each
// port moved up by 100·n. Options: composeFile ('compose.yaml'), projectPrefix (required),
// ports ({ NAME: base }). At a stop (sweep({ stopping: true, limitMs })) every slot project that
// runs is stopped, not taken down, so a held story's containers start again as they were.

import { runAsync } from '../../engine/run-async.mjs';
import { defaultSh } from '../../engine/worktree.mjs';

export const requires = { env: [], tools: ['docker'] };

const NAME = 'env adapter docker';
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function create(options = {}, ctx = {}) {
  const { adapter, composeFile = 'compose.yaml', projectPrefix, ports = {}, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${NAME}: unknown option ${unknown.join(', ')}`);
  if (typeof projectPrefix !== 'string' || !projectPrefix) throw new Error(`${NAME}: projectPrefix is required`);
  for (const [name, base] of Object.entries(ports)) {
    if (!Number.isInteger(base)) throw new Error(`${NAME}: port ${name} must be an integer, got ${JSON.stringify(base)}`);
  }
  const sh = ctx.sh ?? defaultSh;
  const run = ctx.run ?? runAsync;

  const env = (n) => {
    const out = { FOREMAN_SLOT: `w${n}`, COMPOSE_PROJECT_NAME: `${projectPrefix}-w${n}` };
    for (const [name, base] of Object.entries(ports)) out[name] = String(base + 100 * n);
    return out;
  };

  const prepare = (n, path) => {
    const opts = { cwd: path, env: { ...process.env, ...env(n) } };
    const compose = (...args) => sh('docker', ['compose', '-f', composeFile, '-p', `${projectPrefix}-w${n}`, ...args], opts).status === 0;
    if (compose('up', '-d', '--wait')) return 'up';
    compose('down');
    if (compose('up', '-d', '--wait')) return 'reset';
    compose('down'); // a failed up can leave unhealthy containers holding the slot's ports
    return 'down';
  };

  const slotOf = new RegExp(`^${escapeRe(projectPrefix)}-w(\\d+)$`);
  const sweep = async ({ stopping = false, limitMs = 60_000 } = {}) => {
    if (!stopping) return { warnings: [] };
    const deadline = Date.now() + limitMs;
    const timeoutMs = () => Math.max(1000, deadline - Date.now());
    const ps = await run('docker', ['ps', '--format', '{{.Label "com.docker.compose.project"}}'], { cwd: ctx.root, timeoutMs: timeoutMs() });
    if (ps.status !== 0) return { warnings: [] }; // no Docker, so nothing of ours runs
    const projects = [...new Set(ps.stdout.split('\n').map((l) => l.trim()))].filter((p) => slotOf.test(p));
    const warnings = [];
    await Promise.all(
      projects.map(async (p) => {
        const r = await run('docker', ['compose', '-p', p, 'stop'], { cwd: ctx.root, timeoutMs: timeoutMs() });
        if (r.status !== 0) warnings.push(`slot ${slotOf.exec(p)[1]} containers did not stop; run \`docker compose -p ${p} stop\``);
      }),
    );
    return { warnings };
  };

  return { env, prepare, sweep };
}
