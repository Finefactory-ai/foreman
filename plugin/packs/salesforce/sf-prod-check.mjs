// The sf wrapper's production check (prod-block.mjs). Run as `node sf-prod-check.mjs
// <production JSON> <sf args...>` after the wrapper has set HOME to the isolated sf home. It
// exits 0 to let sf run, or 1 with the reason on stderr. If the check itself fails, it fails
// closed: only a command on the production allow-list (and not a Dev Hub only one, one that
// names a deploy endpoint, or a record change through the Tooling API or with --flags-dir) runs,
// and every other is refused.

import fs from 'node:fs';
import { plainlyAllowed, prodReason } from './prod-block.mjs';

const [productionArg, ...args] = process.argv.slice(2);

let reason;
try {
  reason = prodReason({ args, env: process.env, cwd: process.cwd(), home: process.env.HOME, production: JSON.parse(productionArg ?? '[]'), fs });
} catch (err) {
  reason = plainlyAllowed(args)
    ? null
    : `foreman: sf refused: the production check failed (${err?.message ?? err}), so only a command Foreman allows against production runs.`;
}
if (reason) {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
}
