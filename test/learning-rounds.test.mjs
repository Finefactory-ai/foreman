// The Done-when check for recording every round's findings: a two-round story (the tester
// blocks round 1, approves round 2) goes through the pipeline, the story skill's
// findings-file rule and `foreman story end`, and its round-1 blocker reaches findings.jsonl
// marked resolved and counts in the session's run record.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWorkflow } from './workflow-harness.mjs';
import { main } from '../plugin/lib/cli/main.mjs';
import { readFindingsLines, runRecord } from '../plugin/lib/engine/run-record.mjs';

const ROLES = {
  architect: { agent: 'foreman:architect' },
  builders: { developer: { agent: 'foreman:builder', use: 'everything' } },
  tester: { agent: 'foreman:tester' },
  reviewers: [{ name: 'compliance', agent: 'foreman:compliance-reviewer' }],
};
const PLAN = { ready: true, blocker: '', needs_owner: false, builder: 'developer', resources: [], design: 'Change acme.js.', test_plan: 'acme.test.js.', done_when: 'npm test passes' };
const BUILT = { complete: true, summary: 'Built it.', files: ['acme.js'], commands: [], problem: '' };
const OK = { approved: true, findings: [], checked: 'ran it' };
const BLOCKER = { severity: 'blocker', rule: 'Every route needs a test', where: 'acme.js:3', observed: 'no test', fix: 'add one' };

const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-rounds-'));
  fs.mkdirSync(path.join(dir, 'stories'));
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' } }),
  );
  fs.writeFileSync(path.join(dir, 'stories', 'S-1.md'), '---\nid: S-1\ntitle: Add the Acme login\nstatus: todo\ndepends_on: []\n---\n\n## Progress notes\n\n_Newest first._\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

async function foreman(argv) {
  let err = '';
  const code = await main(argv, { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir }, now: () => NOW, stdout: { write: () => {} }, stderr: { write: (s) => { err += s; } } });
  return { code, err };
}

describe('learning: every round is recorded', () => {
  it("records a fixed round-1 blocker as resolved and counts it in the run record", async () => {
    const { result } = await runWorkflow(
      { story: { id: 'S-1', title: 'Add the Acme login', brief: 'stories/S-1.md' }, rounds: 3, roles: ROLES, checks: [], resources: {}, holds: [], traits: {} },
      {
        'architect:': PLAN,
        'build:': BUILT,
        'fix:': BUILT,
        'test:S-1#1': { approved: false, findings: [BLOCKER], checked: 'ran it' },
        'test:': OK,
        'compliance:': OK,
      },
    );
    expect(result).toMatchObject({ status: 'passed', rounds: 2 });

    // The findings file, the way the story skill builds it.
    const file = path.join(dir, 'findings.json');
    const list = [...result.findings, ...result.history.flatMap((h) => h.findings.map((f) => ({ ...f, round: h.round, resolved: true })))];
    fs.writeFileSync(file, JSON.stringify(list));

    expect((await foreman(['story', 'start', 'S-1'])).code).toBe(0);
    expect((await foreman(['story', 'end', 'shipped', '', 'ok', '--findings', file, '--builder', 'developer'])).code).toBe(0);

    const state = path.join(dir, '.foreman');
    const lines = fs.readFileSync(path.join(state, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const blockers = lines.filter((l) => l.severity === 'blocker');
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ story: 'S-1', result: 'shipped', builder: 'developer', stage: 'tester', rule: BLOCKER.rule, round: 1, resolved: true });

    const record = runRecord({
      story: 'S-1',
      slot: 'w1',
      result: 'shipped',
      startedAt: new Date(NOW.getTime() - 60000),
      endedAt: new Date(NOW.getTime() + 60000),
      findings: readFindingsLines(state),
    });
    expect(record.serious).toBe(1);
  });
});
