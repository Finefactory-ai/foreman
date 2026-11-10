// Production hosts, and the Bash guard that keeps the tester and reviewers away from them
// (roadmap 2.2). Pure: the hook in lib/hooks/agent-events.mjs does the I/O.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

// The hosts the tester and reviewers must not touch: ship.productionHosts when set, else the
// smoke urls' hosts plus the Supabase project's API and database hosts.
export function productionHosts(config) {
  const ship = config?.ship ?? {};
  const out = [];
  const add = (host) => {
    const h = String(host).trim().toLowerCase();
    if (h && !LOOPBACK.has(h) && !out.includes(h)) out.push(h);
  };
  if (Array.isArray(ship.productionHosts)) {
    ship.productionHosts.forEach(add);
    return out;
  }
  for (const url of ship.smoke?.urls ?? []) {
    try {
      add(new URL(url).hostname);
    } catch {
      // not a url; nothing to guard
    }
  }
  const ref = ship['migrate-supabase']?.projectRef;
  if (typeof ref === 'string' && ref) {
    add(`${ref}.supabase.co`);
    add(`db.${ref}.supabase.co`);
  }
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Null to allow, or the reason to deny. A host matches on its boundaries: not glued to a
// longer name on the left (`my-api.example.com`), not followed by more name on the right
// (`api.example.community`, `api.example.com.evil.org`). A subdomain of the host matches.
export function guardBash({ command, stage, hosts }) {
  if (stage !== 'test' && stage !== 'review') return null;
  if (typeof command !== 'string' || !command || !Array.isArray(hosts)) return null;
  for (const host of hosts) {
    if (typeof host !== 'string' || !host) continue;
    const re = new RegExp(`(?<![A-Za-z0-9-])${escape(host)}(?![A-Za-z0-9-]|\\.[A-Za-z0-9])`, 'i');
    if (re.test(command)) {
      return `Foreman keeps the tester and reviewers off production (${host}). Test against the local or slot environment instead.`;
    }
  }
  return null;
}
