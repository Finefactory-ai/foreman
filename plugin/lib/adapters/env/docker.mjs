// The Docker Compose slot environment: one compose project per slot (<prefix>-wN), each
// port moved up by 100·n. Options: composeFile ('compose.yaml'), projectPrefix (required),
// ports ({ NAME: base }).

import { defaultSh } from '../../engine/worktree.mjs';

export const requires = { env: [], tools: ['docker'] };

const NAME = 'env adapter docker';

export function create(options = {}, ctx = {}) {
  const { adapter, composeFile = 'compose.yaml', projectPrefix, ports = {}, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`${NAME}: unknown option ${unknown.join(', ')}`);
  if (typeof projectPrefix !== 'string' || !projectPrefix) throw new Error(`${NAME}: projectPrefix is required`);
  for (const [name, base] of Object.entries(ports)) {
    if (!Number.isInteger(base)) throw new Error(`${NAME}: port ${name} must be an integer, got ${JSON.stringify(base)}`);
  }
  const sh = ctx.sh ?? defaultSh;

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

  return { env, prepare };
}
