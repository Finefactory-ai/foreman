// A stand-in for vitest's bin (test/run-suite.test.mjs). It prints its args, and with
// --project it marks its start in FAKE_DIR and waits for the other project to start too, so
// the two only finish when they run at the same time. FAKE_FAIL names a project that exits 1,
// FAKE_KILL one that kills itself, FAKE_HANG one that waits until it is signalled. With no
// --project it writes its args to FAKE_DIR/single.args and exits FAKE_CODE.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const at = args.indexOf('--project');
const name = at === -1 ? null : args[at + 1];
const dir = process.env.FAKE_DIR;
process.stdout.write(`args: ${args.join(' ')}\n`);
process.stderr.write(`stderr of ${name ?? 'single'}\n`);

if (name) {
  fs.writeFileSync(path.join(dir, `${name}.started`), '');
  const other = name === 'waits' ? 'unit' : 'waits';
  const until = Date.now() + 10_000;
  while (!fs.existsSync(path.join(dir, `${other}.started`))) {
    if (Date.now() > until) {
      process.stdout.write(`${other} never started\n`);
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  if (process.env.FAKE_HANG === name || process.env.FAKE_HANG === 'both') {
    process.on('SIGTERM', () => {
      fs.writeFileSync(path.join(dir, `${name}.signalled`), '');
      process.exit(143);
    });
    setInterval(() => {}, 1000);
  } else {
    if (process.env.FAKE_KILL === name) process.kill(process.pid, 'SIGKILL');
    process.exit(process.env.FAKE_FAIL === name ? 1 : 0);
  }
} else {
  fs.writeFileSync(path.join(dir, 'single.args'), args.join(' '));
  process.exit(Number(process.env.FAKE_CODE ?? 0));
}
