// Opens the project's slot environment adapter, named by config.env.adapter. When the config
// names a pack (plugin/packs/index.mjs), that pack's env adapters join the core ones; a pack
// adapter may not take a core adapter's name. `packs` stands in for the real registry in tests.

import * as none from '../adapters/env/none.mjs';
import * as docker from '../adapters/env/docker.mjs';
import * as supabase from '../adapters/env/supabase.mjs';
import { PACKS, packFor } from '../../packs/index.mjs';

const ADAPTERS = { none, supabase, docker };

// The core env adapters plus those of the pack the config names. Throws on an unknown pack or
// a pack adapter that reuses a core name; the doctor reports the same throw.
export function envAdaptersFor(config, packs) {
  const pack = packFor(config, packs);
  if (!pack?.envAdapters) return ADAPTERS;
  for (const name of Object.keys(pack.envAdapters)) {
    if (Object.hasOwn(ADAPTERS, name)) throw new Error(`pack ${pack.name} env adapter ${name} clashes with a core env adapter`);
  }
  return { ...ADAPTERS, ...pack.envAdapters };
}

export function openEnvAdapter({ config, ctx, packs = PACKS }) {
  const options = config.env ?? { adapter: 'none' };
  const table = envAdaptersFor(config, packs);
  const adapter = Object.hasOwn(table, options.adapter) ? table[options.adapter] : null;
  if (!adapter) throw new Error(`unknown slot environment: ${options.adapter}`);
  return adapter.create(options, ctx);
}
