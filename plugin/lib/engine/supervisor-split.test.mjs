// The supervisor is split into parts (see supervisor.mjs): this file checks the split itself,
// reading files only. Each part says what it owns, run-context.mjs is the root nothing in the
// split sits above, no part imports supervisor.mjs (which ends in `await main()`), and every
// module that imports a part, directly or through another part, is in test/supervisor-source.mjs,
// so the source-text tests that read the supervisor cover it.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPERVISOR_PARTS, supervisorSource } from '../../../test/supervisor-source.mjs';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const read = (file) => readFileSync(`${DIR}${file}`, 'utf8');
const lines = (text) => text.split('\n').length - 1;
const NEW_PARTS = SUPERVISOR_PARTS.filter((file) => file !== 'supervisor.mjs');
const SOURCES = readdirSync(DIR).filter((file) => file.endsWith('.mjs') && !file.endsWith('.test.mjs'));
// The `//` lines a file opens with.
const headerLines = (text) => text.split('\n').slice(0, text.split('\n').findIndex((l) => !l.startsWith('//')));
// The header as one line of text, so a phrase may wrap across comment lines.
const header = (text) => headerLines(text).map((l) => l.replace(/^\/\/ ?/, '')).join(' ');
// The module a file imports from './x.mjs'.
const importsOf = (text) => [...text.matchAll(/^(?:import|export)\s(?:[^;]*?\sfrom\s+)?'\.\/([^']+)';/gm)].map((m) => m[1]);
// The parts: run-context.mjs, the root, and every module that imports a part, directly or through
// another part. Importing a part's setter means importing that part's file, so setters count too.
const partsFrom = (importsByFile) => {
  const parts = new Set(['run-context.mjs']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, imports] of Object.entries(importsByFile)) {
      if (!parts.has(file) && imports.some((i) => parts.has(i))) {
        parts.add(file);
        grew = true;
      }
    }
  }
  return [...parts].sort();
};

describe('the supervisor parts', () => {
  it('exist, and none is over 1,200 lines; supervisor.mjs is under 1,000', () => {
    for (const file of SUPERVISOR_PARTS) {
      expect(SOURCES, file).toContain(file);
      expect(lines(read(file)), file).toBeLessThanOrEqual(1200);
    }
    expect(lines(read('supervisor.mjs'))).toBeLessThan(1000);
  });

  it('no source module in the engine folder is over 1,200 lines', () => {
    const big = SOURCES.filter((file) => lines(read(file)) > 1200);
    expect(big).toEqual([]);
  });

  it('each new part opens with a header of 3 lines or more that names supervisor.mjs', () => {
    for (const file of NEW_PARTS) {
      const head = headerLines(read(file));
      expect(head.length, file).toBeGreaterThanOrEqual(3);
      expect(head.join('\n'), file).toContain('supervisor.mjs');
    }
  });

  it('each new part says what it owns', () => {
    const owns = {
      'run-context.mjs': /what the run reads once at start/i,
      'story-followups.mjs': /what an ending leaves on the story/i,
      'session-lifecycle.mjs': /a session's ending, the watchdog/i,
      'slot-starts.mjs': /picking and starting/i,
      'owner-controls.mjs': /the owner's control\.json commands/i,
    };
    for (const file of NEW_PARTS) expect(header(read(file)), file).toMatch(owns[file]);
  });

  it("supervisor.mjs's header names every part", () => {
    const head = header(read('supervisor.mjs'));
    for (const file of SUPERVISOR_PARTS) expect(head, file).toContain(file);
    for (const file of ['standby.mjs', 'session-records.mjs', 'background-jobs.mjs', 'account-checks.mjs', 'story-claims.mjs', 'owner-commands.mjs', 'dry-run.mjs']) expect(head, file).toContain(file);
  });

  it('run-context.mjs imports none of the other parts', () => {
    const imports = importsOf(read('run-context.mjs'));
    for (const file of SUPERVISOR_PARTS) expect(imports, file).not.toContain(file);
  });

  it('no module in the engine folder imports supervisor.mjs', () => {
    for (const file of SOURCES) expect(importsOf(read(file)), file).not.toContain('supervisor.mjs');
  });

  it('partsFrom counts a module that reaches run-context.mjs only through another part', () => {
    const map = {
      'run-context.mjs': ['pick.mjs'],
      'a.mjs': ['run-context.mjs'],
      'b.mjs': ['a.mjs'],
      'c.mjs': ['b.mjs', 'state.mjs'],
      'd.mjs': ['pick.mjs'],
      'pick.mjs': [],
    };
    expect(partsFrom(map)).toEqual(['a.mjs', 'b.mjs', 'c.mjs', 'run-context.mjs']);
  });

  it('the list in test/supervisor-source.mjs is run-context.mjs and every engine module that imports a part, directly or through another part', () => {
    const importsByFile = Object.fromEntries(SOURCES.map((file) => [file, importsOf(read(file))]));
    expect([...SUPERVISOR_PARTS].sort()).toEqual(partsFrom(importsByFile));
  });

  it('supervisor.mjs imports run-context.mjs before the other parts, and its header says why it follows the other imports', () => {
    const text = read('supervisor.mjs');
    expect(importsOf(text).filter((file) => SUPERVISOR_PARTS.includes(file))[0]).toBe('run-context.mjs');
    expect(header(text)).toMatch(/run-context\.mjs import comes after the other imports/i);
  });

  it("only supervisor.mjs holds the loop's marker comment", () => {
    for (const file of NEW_PARTS) expect(read(file), file).not.toContain('// ── the loop');
    expect(read('supervisor.mjs')).toContain('// ── the loop');
  });

  it('the joined source reads the parts in order, supervisor.mjs last', () => {
    const src = supervisorSource();
    const at = (text) => src.indexOf(text);
    expect(at('function reconcileStart(')).toBeLessThan(at('function startWork('));
    expect(at('function endSession(')).toBeLessThan(at('const afterOwnerStop = guarded('));
    expect(at('const sweepOwnerClaims = guarded(')).toBeLessThan(at('// ── the loop'));
    expect(at('// ── the loop')).toBeLessThan(at('async function tick('));
    expect(at('async function tick(')).toBeLessThan(at('async function main('));
  });
});
