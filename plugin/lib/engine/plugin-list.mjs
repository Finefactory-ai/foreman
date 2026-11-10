// parsePluginList, on its own with no imports, so both the core doctor (doctor-checks.mjs) and a
// pack's doctor checks can read `claude plugin list` without importing each other.

// Reads the output of `claude plugin list`: blocks that start with `❯ name@market`, then
// `Version:`, `Read from:` and `Status:` lines.
export function parsePluginList(text) {
  const plugins = [];
  let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const head = line.match(/^❯\s+([^\s@]+)@(\S+)$/);
    if (head) {
      current = { id: `${head[1]}@${head[2]}`, name: head[1], market: head[2], version: null, readFrom: null, enabled: false };
      plugins.push(current);
      continue;
    }
    if (!current) continue;
    const field = line.match(/^(Version|Read from|Status):\s*(.*)$/);
    if (!field) continue;
    if (field[1] === 'Version') current.version = field[2];
    else if (field[1] === 'Read from') current.readFrom = field[2];
    else current.enabled = /enabled/.test(field[2]) && !/disabled/.test(field[2]);
  }
  return plugins;
}
