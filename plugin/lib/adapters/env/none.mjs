// The default slot environment: nothing to start. Each slot gets FOREMAN_SLOT=wN, plus any
// `ports: { NAME: base }` option moved up by the slot number (base + n).

export function create(options = {}, ctx = {}) {
  const { adapter, ports = {}, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`env adapter none: unknown option ${unknown.join(', ')}`);
  for (const [name, base] of Object.entries(ports)) {
    if (!Number.isInteger(base)) throw new Error(`env adapter none: port ${name} must be an integer, got ${JSON.stringify(base)}`);
  }
  return {
    env(n) {
      const env = { FOREMAN_SLOT: `w${n}` };
      for (const [name, base] of Object.entries(ports)) env[name] = String(base + n);
      return env;
    },
    prepare() {
      return 'up';
    },
  };
}
