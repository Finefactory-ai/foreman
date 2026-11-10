// Every test that starts Foreman's supervisor goes through test/supervisors.mjs, so its afterEach
// ends the run even when the test fails. This test reads every test file and fails when one
// starts a supervisor (or a Foreman CLI command next to one) another way. A line inside a fake
// script that runs the CLI but never starts a supervisor ends with the marker below.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'test/supervisor-guard.test.mjs';
const MARKER = '// supervisor-guard: not a supervisor';

// What starts a supervisor: `run --foreground`, `BIN, 'run'`, a bin path then 'run', `cloud run|tick`,
// the background runner itself, or the helper's own calls (so a file using them needs the hook).
const STARTS = [
  /['"]run['"]\s*,\s*['"]--foreground['"]/,
  /\bBIN\s*,\s*['"]run['"]/,
  /['"]foreman['"]\)\s*,\s*['"]run['"]/,
  /['"]cloud['"]\s*,\s*['"](?:run|tick)['"]/,
  /run-in-background\.mjs/,
  /\b(?:startForeman|runForeman|startChild)\s*\(/,
  /\btrackedRun\b/,
];
const CHILD_CALL = /\b(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\s*\(/;
const FOREMAN_BIN = [/\bBIN\b/, /['"]bin['"]\s*,\s*['"]foreman['"]/, /bin\/foreman/];

// The hook started by hand (spawnSync is fine: it returns only after the hook has exited), and
// `ownerCommands(` outside a string with no `run` of its own (the fake or trackedRun). Each call is
// read from its `(` to its matching `)`, across lines, so a `run` or a HOOK beside the call, not in
// it, does not count.
const HOOK_SPAWN = /\bspawn\s*\(/g;
const HOOK_NAME = /agent-events\.mjs|\bHOOK\b/;
const OWNER_CALL = /^[^'"`]*\bownerCommands\(/;
const OWN_RUN = /\brun\b\s*[:,}]/;

// The text from the `(` at `open` up to and including its matching `)`, or to the end when it has
// none. Parentheses inside '...', "..." and `...` do not count; a backslash skips the next character.
function callSpan(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

const startsOne = (line) => STARTS.some((p) => p.test(line));

// What is wrong with a test file's source, as plain lines; [] when it starts nothing or starts
// it only through the helper.
function problems(text) {
  const lines = text.split('\n').filter((l) => !l.trimEnd().endsWith(MARKER));
  const body = lines.join('\n');
  const starts = [];
  lines.reduce((at, line) => (starts.push(at), at + line.length + 1), 0);
  const direct = [];
  lines.forEach((line, i) => {
    const hit = [...line.matchAll(HOOK_SPAWN)].some((m) => HOOK_NAME.test(callSpan(body, starts[i] + m.index + m[0].length - 1)));
    if (hit) direct.push(`starts the hook directly on line ${i + 1}: use startChild`);
    if (OWNER_CALL.test(line)) {
      const open = body.indexOf('(', starts[i] + line.indexOf('ownerCommands'));
      if (!OWN_RUN.test(callSpan(body, open))) direct.push(`starts owner commands without trackedRun on line ${i + 1}: pass run: trackedRun`);
    }
  });
  if (!lines.some(startsOne)) return direct;
  const out = [];
  if (!lines.some((l) => /^import\b.*from\s+['"][^'"]*supervisors\.mjs['"]/.test(l))) out.push('does not import from test/supervisors.mjs');
  if (!lines.some((l) => /^useSupervisors\(\);/.test(l))) out.push('has no `useSupervisors();` line at the top level');
  // vitest runs afterEach hooks last first, so the helper's hook must come after the file's own.
  const hook = lines.findIndex((l) => /^useSupervisors\(\);/.test(l));
  lines.forEach((line, i) => {
    if (hook >= 0 && i > hook && /^afterEach\(/.test(line)) {
      out.push(`useSupervisors() comes before its own afterEach on line ${i + 1}: move it below, so it runs first`);
    }
  });
  lines.forEach((line, i) => {
    if (CHILD_CALL.test(line) && (FOREMAN_BIN.some((p) => p.test(line)) || startsOne(line))) {
      out.push(`starts Foreman directly on line ${i + 1}: use startForeman or runForeman`);
    }
  });
  return [...out, ...direct];
}

const GOOD = `import { startForeman, useSupervisors } from '../../../test/supervisors.mjs';

useSupervisors();

const child = startForeman(['run', '--foreground'], { cwd });
`;

describe('the supervisor guard', () => {
  it('reports a direct start', () => {
    const text = GOOD.replace("startForeman(['run', '--foreground'], { cwd })", "spawn(process.execPath, [BIN, 'run', '--foreground'])");
    expect(problems(text)).toEqual(['starts Foreman directly on line 5: use startForeman or runForeman']);
  });

  it('reports a direct start through a copied plugin, or with spawnSync', () => {
    expect(problems(`${GOOD}spawn(process.execPath, [join(plug, 'bin', 'foreman'), 'run', '--foreground']);\n`)).toHaveLength(1);
    expect(problems(`${GOOD}const r = spawnSync(process.execPath, [BIN, 'status']);\n`)).toHaveLength(1);
  });

  it('reports a direct start of the hook, and passes spawnSync', () => {
    const hook = `import { startChild, useSupervisors } from '../../../test/supervisors.mjs';\n\nuseSupervisors();\n\n`;
    expect(problems(`${hook}const p = spawn('node', [HOOK], { cwd });\n`)).toEqual(['starts the hook directly on line 5: use startChild']);
    expect(problems(`${hook}const p = spawn('node', [inCopy('lib/hooks/agent-events.mjs')], { cwd });\n`)).toEqual(['starts the hook directly on line 5: use startChild']);
    expect(problems(`${hook}const r = spawnSync('node', [HOOK], { input });\n`)).toEqual([]);
    expect(problems(`const r = spawn('node', [HOOK], { input });\n`)).toEqual(['starts the hook directly on line 1: use startChild']);
  });

  it('reports owner commands started without trackedRun', () => {
    const owner = `import { trackedRun, useSupervisors } from '../../../test/supervisors.mjs';\n\nuseSupervisors();\n\n`;
    expect(problems(`${owner}const o = ownerCommands({ bin, root, event });\n`)).toEqual([
      'starts owner commands without trackedRun on line 5: pass run: trackedRun',
    ]);
    expect(problems(`const o = ownerCommands({ bin, root, event });\n`)).toEqual([
      'starts owner commands without trackedRun on line 1: pass run: trackedRun',
    ]);
    expect(problems(`${owner}const o = ownerCommands({ bin, root, run: trackedRun, event });\n`)).toEqual([]);
    expect(problems(`${owner}const o = ownerCommands({ bin, root, event, run });\n`)).toEqual([]);
    expect(problems(`${owner}expect(text).toContain('ownerCommands({ bin, root })');\n`)).toEqual([]);
  });

  describe('reads a whole call, across lines', () => {
    const owner = `import { trackedRun, useSupervisors } from '../../../test/supervisors.mjs';\n\nuseSupervisors();\n\n`;
    const hook = `import { startChild, useSupervisors } from '../../../test/supervisors.mjs';\n\nuseSupervisors();\n\n`;
    const NO_RUN = ['starts owner commands without trackedRun on line 5: pass run: trackedRun'];
    const DIRECT = ['starts the hook directly on line 5: use startChild'];

    it('passes a multi-line ownerCommands that has run', () => {
      expect(problems(`${owner}const o = ownerCommands({\n  bin,\n  root,\n  run: trackedRun,\n  event,\n});\n`)).toEqual([]);
    });

    it('reports a multi-line ownerCommands with no run', () => {
      expect(problems(`${owner}const o = ownerCommands({\n  bin,\n  root,\n  event,\n});\n`)).toEqual(NO_RUN);
    });

    it('reports an ownerCommands with no run when another run shares its line', () => {
      expect(problems(`${owner}const o = ownerCommands({ bin, root, event }); const r = { run: 1 };\n`)).toEqual(NO_RUN);
    });

    it('reads nested parentheses inside the call', () => {
      expect(problems(`${owner}const o = ownerCommands({ bin, root, event: (t, k) => log.push([t, k]), run: trackedRun });\n`)).toEqual([]);
    });

    it('stops the call at its own closing parenthesis', () => {
      expect(problems(`${owner}await ownerCommands({ bin, root, event }).notify('down', { run: 1 });\n`)).toEqual(NO_RUN);
    });

    it('reports a multi-line spawn of the hook', () => {
      expect(problems(`${hook}const p = spawn(\n  'node',\n  [HOOK],\n  { cwd },\n);\n`)).toEqual(DIRECT);
      expect(problems(`${hook}const p = spawn(\n  'node',\n  [inCopy('lib/hooks/agent-events.mjs')],\n  { cwd },\n);\n`)).toEqual(DIRECT);
    });

    it('passes a multi-line spawnSync of the hook', () => {
      expect(problems(`${hook}const r = spawnSync(\n  'node',\n  [HOOK],\n  { input },\n);\n`)).toEqual([]);
    });

    it('does not take HOOK after the spawn call for part of it', () => {
      expect(problems(`${hook}const p = spawn('git', ['status']); const h = HOOK;\n`)).toEqual([]);
    });

    it('is not fooled by a parenthesis inside a string', () => {
      expect(problems(`${hook}const p = spawn('node', ['(', HOOK]);\n`)).toEqual(DIRECT);
      expect(problems(`${hook}const p = spawn('node', [")", \`)\`, 'a\\'(', HOOK]);\n`)).toEqual(DIRECT);
    });
  });

  it('reports a file that uses startChild or trackedRun without its hook', () => {
    expect(problems("import { startChild } from './supervisors.mjs';\nconst c = startChild('node', []);\n")).toEqual(['has no `useSupervisors();` line at the top level']);
    expect(problems("import { trackedRun } from '../supervisors.mjs';\nconst r = trackedRun('node', []);\n")).toEqual(['has no `useSupervisors();` line at the top level']);
  });

  it('reports a file that uses the helper without its hook', () => {
    expect(problems(GOOD.replace('useSupervisors();\n', ''))).toEqual(['has no `useSupervisors();` line at the top level']);
    expect(problems(GOOD.replace('useSupervisors();', '  useSupervisors();'))).toEqual(['has no `useSupervisors();` line at the top level']);
  });

  it("reports a useSupervisors() registered before the file's own afterEach", () => {
    const after = problems(GOOD.replace('useSupervisors();\n', 'useSupervisors();\nafterEach(() => repos.cleanup());\n'));
    expect(after).toHaveLength(1);
    expect(after[0]).toContain('before its own afterEach on line 4');
    expect(problems(GOOD.replace('useSupervisors();\n', 'afterEach(() => repos.cleanup());\nuseSupervisors();\n'))).toEqual([]);
    expect(problems(GOOD.replace('useSupervisors();\n', 'useSupervisors();\n  afterEach(() => repos.cleanup());\n'))).toEqual([]);
  });

  it('reports a file that does not import the helper', () => {
    expect(problems(GOOD.replace(/^import .*\n/, ''))).toEqual(['does not import from test/supervisors.mjs']);
  });

  it('passes a file that uses the helper, and one that starts nothing', () => {
    expect(problems(GOOD)).toEqual([]);
    expect(problems("const r = spawnSync('git', ['status']);\n")).toEqual([]);
  });

  it('skips a line with the marker', () => {
    expect(problems(`${GOOD}const foreman = () => spawnSync(process.execPath, [BIN, 'story', 'block']); ${MARKER}\n`)).toEqual([]);
    expect(problems(`const go = () => spawnSync(process.execPath, [BIN, 'cloud', 'tick']); ${MARKER}\n`)).toEqual([]);
  });

  it('does not take FAKE_FOREMAN_BIN for BIN', () => {
    expect(problems(`${GOOD}spawnSync(process.execPath, [process.env.FAKE_FOREMAN_BIN, 'story', 'block', id]);\n`)).toEqual([]);
  });

  it('every test file that starts a supervisor does it through test/supervisors.mjs', () => {
    const files = [];
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.test.mjs')) files.push(relative(ROOT, path));
      }
    };
    for (const top of ['plugin', 'test', 'workshop']) walk(join(ROOT, top));
    const starting = files.filter((f) => f !== SELF && readFileSync(join(ROOT, f), 'utf8').split('\n').some(startsOne));
    const found = files.filter((f) => f !== SELF).flatMap((f) => problems(readFileSync(join(ROOT, f), 'utf8')).map((p) => `${f}: ${p}`));
    expect(found).toEqual([]);
    // The patterns still find the files that start supervisors, so the scan cannot pass by finding none.
    const engine = 'tokens session-keys config release sf-isolation learning learned-skills outlive answers stuck credits credit-resume usage-limit standby busy-answers leash';
    const known = ['plugin/lib/cli/commands/run-real.test.mjs', ...engine.split(' ').map((n) => `plugin/lib/engine/supervisor-${n}.test.mjs`), 'test/cloud-run.test.mjs', 'test/supervisors.test.mjs', 'plugin/lib/hooks/agent-events-scratch.test.mjs', 'plugin/lib/engine/owner-commands.test.mjs', 'plugin/lib/engine/node-path.test.mjs'];
    expect(starting.length).toBeGreaterThanOrEqual(22);
    for (const f of known) expect(starting).toContain(f);
  });

  // The restart, slow, watchdog, build-limit and cloud tick tests start their supervisors in a
  // shared fixture, whose withX() hook registers useSupervisors.
  it('the fixtures that start supervisors do it through test/supervisors.mjs, and register its hook', () => {
    for (const f of [
      'test/supervisor-restart-fixture.mjs',
      'test/supervisor-slow-fixture.mjs',
      'test/watchdog-shipped-fixture.mjs',
      'test/build-limit-fixture.mjs',
      'test/cloud-tick-fixture.mjs',
    ]) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n').filter((l) => !l.trimEnd().endsWith(MARKER));
      expect(lines.some(startsOne), f).toBe(true);
      expect(lines.some((l) => /^import\b.*from\s+['"]\.\/supervisors\.mjs['"]/.test(l)), f).toBe(true);
      expect(lines.some((l) => /^ {2}useSupervisors\(\);/.test(l)), f).toBe(true);
      expect(lines.filter((l) => CHILD_CALL.test(l) && (FOREMAN_BIN.some((p) => p.test(l)) || startsOne(l))), f).toEqual([]);
    }
  });
});
