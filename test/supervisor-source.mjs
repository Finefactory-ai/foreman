// The supervisor's source as the source-text tests read it. The supervisor is split into parts
// (plugin/lib/engine/supervisor.mjs lists them), so a test that asserts a line of the loop reads
// all of them, in the order the code ran when it was one file.
//
//   SUPERVISOR_PARTS    the part files in plugin/lib/engine/, in that order; supervisor.mjs last
//   supervisorSource()  their text, joined with a newline
//
// The order matters to the tests that slice from one function to the next: reconcileStart comes
// before startWork, endSession before afterOwnerStop, sweepOwnerClaims before the loop marker,
// and tick last.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SUPERVISOR_PARTS = ['run-context.mjs', 'story-followups.mjs', 'session-lifecycle.mjs', 'slot-starts.mjs', 'owner-controls.mjs', 'supervisor.mjs'];

const ENGINE = new URL('../plugin/lib/engine/', import.meta.url);

export function supervisorSource() {
  return SUPERVISOR_PARTS.map((file) => readFileSync(fileURLToPath(new URL(file, ENGINE)), 'utf8')).join('\n');
}
