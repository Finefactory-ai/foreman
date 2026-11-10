// The agent-events hook: what it records, and the production guard on Bash calls, with its
// setting. The guard on the project's own files and failing closed are in agent-events-files.test.mjs,
// and failing closed in a scratch copy of the plugin in agent-events-scratch.test.mjs; the fixture
// they share is test/agent-events-fixture.mjs.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bash, CONFIG, dir, hook, run, withHookDir } from '../../../test/agent-events-fixture.mjs';
import { readSlot, startStory } from '../engine/state.mjs';

withHookDir();

describe('the agent-events hook', () => {
  it('does nothing and exits 0 outside a factory run', () => {
    const r = hook({});
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, 'state'))).toBe(false);
  });

  it('records the agent inside a factory run, in its slot', () => {
    const r = hook({ FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2' });
    expect(r.status).toBe(0);
    expect(readdirSync(join(dir, 'state', 'slots', 'w2', 'agents'))).toEqual(['a1.json']);
  });

  it('refreshes the slot heartbeat the watchdog reads, on every event', () => {
    const slotFile = join(dir, 'state', 'slots', 'w2.json');
    const stop = JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'foreman:architect' });
    const before = Date.now();
    expect(hook({ FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2' }, stop).status).toBe(0);
    expect(Date.parse(JSON.parse(readFileSync(slotFile, 'utf8')).lastBeat)).toBeGreaterThanOrEqual(before - 1000);
  });

  it("a SubagentStart in a session marks progress on the slot's story", () => {
    const state = join(dir, 'state');
    startStory(state, { id: 'ACME-1', title: 'Acme' }, new Date(Date.now() - 60_000), 'w2');
    expect(readSlot(state, 'w2').story.progressAt ?? null).toBeNull();
    const before = Date.now();
    const r = hook({ FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2' });
    expect(r.status).toBe(0);
    const at = readSlot(state, 'w2').story.progressAt;
    expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('exits 0 on input it cannot read, and with a broken config', () => {
    writeFileSync(join(dir, 'foreman.config.json'), '{ not json');
    expect(hook({ FOREMAN_RUN: '1' }, 'not json').status).toBe(0);
    expect(hook({ FOREMAN_RUN: '1' }).status).toBe(0);
  });

  describe('what the command centre shows', () => {
    const U = '4947378a-6485-4e40-9357-671b81c4acf3';
    const agentFile = () => join(dir, 'state', 'slots', 'w2', 'agents', 'x1.json');
    const read = (extra = '') => ({ hook_event_name: 'PreToolUse', session_id: U, agent_id: 'x1', agent_type: 'foreman:tester', tool_name: 'Read', tool_input: { file_path: join(dir, 'src', 'a.js') }, ...JSON.parse(extra || '{}') });

    it('records the plain words and the model read from the agent\'s transcript under CLAUDE_CONFIG_DIR', () => {
      const claude = join(dir, 'claude');
      const file = join(claude, 'projects', '-tmp-acme', U, 'subagents', 'agent-x1.jsonl');
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'task' } })}\n${JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [] } })}\n`);
      const r = run({ FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2', CLAUDE_CONFIG_DIR: claude }, JSON.stringify(read()));
      expect(r.status).toBe(0);
      expect(JSON.parse(readFileSync(agentFile(), 'utf8'))).toMatchObject({ model: 'claude-haiku-4-5-20251001', says: 'Reading src/a.js', tools: 1 });
    });

    it('records the words without a model when there is no transcript', () => {
      const r = run({ FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2', CLAUDE_CONFIG_DIR: join(dir, 'nowhere') }, JSON.stringify(read()));
      expect(r.status).toBe(0);
      const a = JSON.parse(readFileSync(agentFile(), 'utf8'));
      expect(a.says).toBe('Reading src/a.js');
      expect('model' in a).toBe(false);
    });
  });

  describe('production guard', () => {
    it('denies a tester Bash command that names a production host', () => {
      const r = run({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl https://app.example.com/api'));
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Foreman keeps the tester and reviewers off production (app.example.com). Test against the local or slot environment instead.',
        },
      });
    });

    it('denies a reviewer too', () => {
      const r = run({ FOREMAN_RUN: '1' }, bash('security-reviewer', 'psql -h app.example.com'));
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('lets a tester run a local command', () => {
      const r = run({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl http://localhost:3000'));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('still records the agent and the slot heartbeat on a Bash call, allowed or denied', () => {
      const agentFile = join(dir, 'state', 'slots', 'w2', 'agents', 'x1.json');
      const slotFile = join(dir, 'state', 'slots', 'w2.json');
      const cases = [
        ['curl http://localhost:3000', (r) => expect(r.stdout).toBe('')],
        ['curl https://app.example.com/api', (r) => expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')],
      ];
      for (const [command, answered] of cases) {
        for (let i = 0; i < 5; i++) {
          rmSync(join(dir, 'state'), { recursive: true, force: true });
          const before = Date.now();
          const r = run({ FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2' }, bash('foreman:tester', command));
          expect(r.status).toBe(0);
          answered(r);
          expect(existsSync(agentFile)).toBe(true);
          expect(JSON.parse(readFileSync(agentFile, 'utf8')).tools).toBe(1);
          expect(Date.parse(JSON.parse(readFileSync(slotFile, 'utf8')).lastBeat)).toBeGreaterThanOrEqual(before - 1000);
        }
      }
    }, 60_000);

    it('never blocks a builder or the foreman', () => {
      for (const who of ['foreman:builder', null]) {
        const r = run({ FOREMAN_RUN: '1' }, bash(who, 'curl https://app.example.com/api'));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      }
    });

    it('prints nothing outside a factory run', () => {
      const r = run({}, bash('foreman:tester', 'curl https://app.example.com/api'));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    describe('features.productionGuard', () => {
      const deny = (r) => r.stdout && JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny';
      const localSettings = (values) => {
        mkdirSync(join(dir, 'state'), { recursive: true });
        writeFileSync(join(dir, 'state', 'settings.json'), JSON.stringify(values));
      };

      it('off in the local layer: lets the command through', () => {
        localSettings({ 'features.productionGuard': false });
        const r = run({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl https://app.example.com/api'));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      });

      it('off in the config file: lets the command through, and a local on turns it back on', () => {
        const off = { ...CONFIG, features: { productionGuard: false } };
        writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(off));
        expect(hook({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl https://app.example.com/api')).stdout).toBe('');
        localSettings({ 'features.productionGuard': true });
        expect(deny(hook({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl https://app.example.com/api')))).toBe(true);
      });

      it('still guards when the settings file is broken', () => {
        mkdirSync(join(dir, 'state'), { recursive: true });
        writeFileSync(join(dir, 'state', 'settings.json'), '{ nope');
        expect(deny(run({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl https://app.example.com/api')))).toBe(true);
      });
    });

    it('with the host guard off and no pack, lets a builder Bash call through', () => {
      writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ ...CONFIG, features: { productionGuard: false } }));
      const r = hook({ FOREMAN_RUN: '1' }, bash('foreman:builder', 'npm test'));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('with the host guard off, the salesforce pack guard still denies', () => {
      const SF_CONFIG = {
        version: 1,
        project: { name: 'Acme' },
        pack: 'salesforce',
        baseBranch: 'main',
        features: { productionGuard: false },
        salesforce: {
          productionBranch: 'main',
          orgs: { 'acme-dev1': { orgId: '00D000000000001AAA' }, 'acme-qa': { orgId: '00D000000000002AAA' } },
          build: ['acme-dev1'],
          stages: [{ name: 'qa', org: 'acme-qa', branch: 'qa' }],
        },
      };
      writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(SF_CONFIG));
      for (const who of ['foreman:sf-developer', null]) {
        const r = hook({ FOREMAN_RUN: '1' }, bash(who, 'sf org login web'));
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout).hookSpecificOutput;
        expect(out.permissionDecision).toBe('deny');
        expect(out.permissionDecisionReason).toMatch(/^Foreman's Salesforce guard denies/);
        expect(out.permissionDecisionReason).toMatch(/org login/);
      }
      const allowed = hook({ FOREMAN_RUN: '1' }, bash('foreman:sf-developer', 'npm test'));
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toBe('');
    });

    it('does not guard other tools', () => {
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'https://app.example.com' }, agent_id: 'x1', agent_type: 'foreman:tester' });
      expect(run({ FOREMAN_RUN: '1' }, input).stdout).toBe('');
    });
  });
});
