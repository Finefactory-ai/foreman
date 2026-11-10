// The files console, and the base of the dashboard: everything lives in the state folder.
//
//   publish(snapshot)   writes <stateDir>/status.json
//   controls()          reads <stateDir>/control.json, which `foreman pause` and friends write
//   decisions           <stateDir>/decisions/<id>.json, through lib/console/decisions.mjs
//
// The owner reads status.json with `foreman status` and answers with `foreman decide`.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readControl } from '../../console/control.mjs';
import * as decisions from '../../console/decisions.mjs';

export function create(options = {}, ctx = {}) {
  const unknown = Object.keys(options).filter((key) => key !== 'adapter');
  if (unknown.length) throw new Error(`console files: unknown option ${unknown.join(', ')}`);
  const dir = ctx.stateDir;
  if (!dir) throw new Error('console files: ctx.stateDir is required');
  const now = ctx.now ?? (() => new Date());

  return {
    async publish(snapshot) {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'status.json');
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`);
      renameSync(tmp, file);
    },
    async controls() {
      return readControl(dir);
    },
    decisions: {
      async add(item) {
        return decisions.add(dir, item, now());
      },
      async pending() {
        return decisions.pending(dir);
      },
      async applied(id) {
        decisions.applied(dir, id, now());
      },
      // Beyond the contract, for `foreman decide`: every item, and the owner's answer.
      async list() {
        return decisions.list(dir);
      },
      async answer(id, given) {
        return decisions.answer(dir, id, given, now());
      },
    },
  };
}
