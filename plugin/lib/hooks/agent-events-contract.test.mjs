// The contract of the agent-events hook: the exact bytes it prints for Claude Code, run as a real
// process from the command in hooks.json. Goldens live in test/fixtures/agent-events/ (see its README).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanEnv, dir, withHookDir } from '../../../test/agent-events-fixture.mjs';

const read = (path) => readFileSync(path, 'utf8');
const PLUGIN = fileURLToPath(new URL('../..', import.meta.url));
const HOOKS = JSON.parse(read(join(PLUGIN, 'hooks', 'hooks.json'))).hooks;
const FIX = fileURLToPath(new URL('../../../test/fixtures/agent-events/', import.meta.url));
const CASES = JSON.parse(read(FIX + 'cases.json'));
const NOT_CASE_FILES = ['README.md', 'cases.json', 'foreman.config.json'];

const commandFor = (event) => HOOKS[event][0].hooks[0].command;

// Stands in the canonical project path, JSON-escaped, for the <PROJECT> token.
const fill = (text) => text.replaceAll('<PROJECT>', JSON.stringify(realpathSync(dir)).slice(1, -1));

// Runs a case the way Claude Code does: the hooks.json command through a shell, the event on stdin.
function runCase(c) {
  copyFileSync(FIX + 'foreman.config.json', join(dir, 'foreman.config.json'));
  const env = cleanEnv({
    CLAUDE_PLUGIN_ROOT: PLUGIN,
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    FOREMAN_PROJECT_DIR: dir,
    FOREMAN_STATE_DIR: join(dir, 'state'),
    ...(c.run ? { FOREMAN_RUN: '1' } : {}),
  });
  return spawnSync(commandFor(c.event), { shell: true, cwd: dir, input: fill(read(`${FIX}${c.name}.stdin`)), encoding: 'utf8', timeout: 20_000, env });
}

// Nothing, or exactly one compact JSON object and nothing else.
function oneReply(stdout) {
  if (stdout === '') return true;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && JSON.stringify(parsed) === stdout;
}

const eventsWithoutCase = (events, cases) => events.filter((e) => !cases.some((c) => c.event === e));

describe('agent-events hook replies', () => {
  withHookDir();

  it.each(CASES)('$name: $why', (c) => {
    const r = runCase(c);
    expect(r.error).toBeUndefined();
    expect(r.signal).toBeNull();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(fill(read(`${FIX}${c.name}.stdout`)));
    expect(oneReply(r.stdout)).toBe(true);
  });
});

describe('oneReply', () => {
  it('accepts nothing or one compact object, and refuses anything else', () => {
    expect(oneReply('')).toBe(true);
    expect(oneReply('{"a":1}')).toBe(true);
    for (const bad of ['{"a":1}\n', '{"a": 1}', '[]', 'null', '1', '{"a":1}{"b":2}', 'x', '\n']) expect(oneReply(bad), bad).toBe(false);
  });
});

describe('the cases cover every hook event', () => {
  it('has a case for every event in hooks.json', () => {
    expect(eventsWithoutCase(Object.keys(HOOKS), CASES)).toEqual([]);
  });

  it('names the event when a case is removed', () => {
    expect(eventsWithoutCase(Object.keys(HOOKS), CASES.filter((c) => c.event !== 'SubagentStart'))).toEqual(['SubagentStart']);
  });

  it('only names events that hooks.json has', () => {
    for (const c of CASES) expect(Object.keys(HOOKS), c.name).toContain(c.event);
  });

  it('has a stdin and a stdout file for every case, and no other file', () => {
    const named = CASES.flatMap((c) => [`${c.name}.stdin`, `${c.name}.stdout`]);
    for (const f of named) expect(existsSync(FIX + f), f).toBe(true);
    const stray = readdirSync(FIX).filter((f) => !NOT_CASE_FILES.includes(f) && !named.includes(f));
    expect(stray).toEqual([]);
  });

  it('has unique case names', () => {
    const names = CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
