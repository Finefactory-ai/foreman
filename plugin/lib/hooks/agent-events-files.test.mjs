// The agent-events hook's production guard: the project's own files, which no agent may change,
// and failing closed inside a Foreman run when the config or the state folder is broken. The
// fixture is test/agent-events-fixture.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bash, dir, HOST_DENY, hook, run, withHookDir } from '../../../test/agent-events-fixture.mjs';

withHookDir();

describe('the agent-events hook', () => {
  describe('production guard', () => {
    describe("the project's own files", () => {
      it('denies a builder appending to the project .env.local', () => {
        const r = run({ FOREMAN_RUN: '1' }, bash('foreman:builder', `echo X >> ${join(dir, '.env.local')}`));
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout).hookSpecificOutput;
        expect(out.permissionDecision).toBe('deny');
        expect(out.permissionDecisionReason).toMatch(/^Foreman denies this command: it would change .*\.env\.local, which belongs to the project this run builds\./);
      });

      it('denies tee into the local settings in the state folder, for the foreman too', () => {
        const r = run({ FOREMAN_RUN: '1' }, bash(null, `echo '{}' | tee ${join(dir, 'state', 'settings.json')}`));
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/settings\.json, which belongs to the project this run builds/);
      });

      it('lets a read of the project .env.local through', () => {
        const r = run({ FOREMAN_RUN: '1' }, bash('foreman:builder', `cat ${join(dir, '.env.local')}`));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      });

      const tool = (tool_name, tool_input, extra = {}) =>
        JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input, agent_id: 'x1', agent_type: 'foreman:builder', ...extra });
      const denied = (r) => {
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout).hookSpecificOutput;
        expect(out.permissionDecision).toBe('deny');
        return out.permissionDecisionReason;
      };
      const slot = () => {
        const w1 = join(dir, '.foreman', 'worktrees', 'w1');
        mkdirSync(join(w1, 'src'), { recursive: true });
        writeFileSync(join(dir, '.env.local'), 'KEY=1\n');
        symlinkSync(join(dir, '.env.local'), join(w1, '.env.local'));
        return w1;
      };

      it('denies Write to the project .env.local', () => {
        const reason = denied(run({ FOREMAN_RUN: '1' }, tool('Write', { file_path: join(dir, '.env.local'), content: 'X=1' })));
        expect(reason).toMatch(/^Foreman denies this edit: it would change .*\.env\.local, which belongs to the project this run builds\./);
      });

      it('denies Edit through the slot symlink to the project .env.local', () => {
        const w1 = slot();
        const r = run({ FOREMAN_RUN: '1' }, tool('Edit', { file_path: join(w1, '.env.local'), old_string: 'KEY=1', new_string: 'KEY=2' }, { cwd: w1 }));
        expect(denied(r)).toMatch(/it would change .*\.env\.local, which belongs to the project this run builds/);
        expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe('KEY=1\n');
      });

      it('denies MultiEdit of the config and NotebookEdit of the local settings', () => {
        expect(denied(run({ FOREMAN_RUN: '1' }, tool('MultiEdit', { file_path: join(dir, 'foreman.config.json'), edits: [] })))).toMatch(/foreman\.config\.json, which belongs/);
        expect(denied(run({ FOREMAN_RUN: '1' }, tool('NotebookEdit', { notebook_path: join(dir, 'state', 'settings.json'), new_source: '' })))).toMatch(/settings\.json, which belongs/);
      });

      it("denies a subagent's Bash write and Write to the check records in the state folder", () => {
        const file = join(dir, 'state', 'check-runs.jsonl');
        const r = run({ FOREMAN_RUN: '1' }, bash('foreman:compliance-reviewer', `echo '{}' >> ${file}`));
        expect(denied(r)).toMatch(/check-runs\.jsonl, which belongs to the project this run builds/);
        expect(denied(run({ FOREMAN_RUN: '1' }, tool('Write', { file_path: file, content: '{}' }, { agent_type: 'foreman:tester' })))).toMatch(/check-runs\.jsonl, which belongs/);
      });

      it("denies a Write or a redirect to a slot's session environment file", () => {
        const file = join(dir, 'state', 'session-config', 'w1-env.json');
        expect(denied(run({ FOREMAN_RUN: '1' }, tool('Write', { file_path: file, content: '{}' }, { agent_type: 'foreman:tester' })))).toMatch(/w1-env\.json, which belongs to the project this run builds/);
        expect(denied(run({ FOREMAN_RUN: '1' }, bash('foreman:compliance-reviewer', `echo '{}' > ${file}`)))).toMatch(/w1-env\.json, which belongs/);
      });

      it('allows Write to a file in the slot worktree', () => {
        const w1 = slot();
        const r = run({ FOREMAN_RUN: '1' }, tool('Write', { file_path: join(w1, 'src', 'app.js'), content: '' }, { cwd: w1 }));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      });

      it('denies Write when the config cannot be loaded, and stays silent outside a run', () => {
        writeFileSync(join(dir, 'foreman.config.json'), '{ nope');
        const r = hook({ FOREMAN_RUN: '1' }, tool('Write', { file_path: join(dir, 'src.js'), content: '' }));
        expect(denied(r)).toBe('Foreman could not load foreman.config.json, so it denies file edits in this run until the config loads.');
        expect(hook({}, tool('Write', { file_path: join(dir, '.env.local'), content: '' })).stdout).toBe('');
      });

      it('denies a settings write from the slot with the run variables unset', () => {
        const w1 = slot();
        const input = JSON.stringify({ ...JSON.parse(bash('foreman:tester', '(unset FOREMAN_RUN FOREMAN_PROJECT_DIR FOREMAN_STATE_DIR; foreman settings set workers 1)')), cwd: w1 });
        expect(denied(run({ FOREMAN_RUN: '1' }, input))).toBe(
          `foreman settings set would change ${dir}, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.`,
        );
      });

      it.each([
        ['cd {scratch} && (unset FOREMAN_RUN; foreman settings set learning.auto true)'],
        ['cd {notgit} && FOREMAN_RUN= foreman settings set workers 1'],
      ])('denies %s from the slot: the run variables changed, whatever the folder', (template) => {
        const w1 = slot();
        const scratch = mkdtempSync(join(tmpdir(), 'foreman-hook-scratch-'));
        const notgit = mkdtempSync(join(tmpdir(), 'foreman-hook-notgit-'));
        try {
          spawnSync('git', ['init', '-q'], { cwd: scratch });
          const command = template.replace('{scratch}', scratch).replace('{notgit}', notgit);
          const input = JSON.stringify({ ...JSON.parse(bash('foreman:tester', command)), cwd: w1 });
          expect(denied(run({ FOREMAN_RUN: '1' }, input))).toBe(
            `Foreman denies this command: it runs foreman settings set with the Foreman run variables changed, so it could change ${dir}, the project this run builds, whatever folder it runs in. Keep the FOREMAN_* variables set and run it in a scratch git repo: inside a run it then acts on that repo.`,
          );
        } finally {
          rmSync(scratch, { recursive: true, force: true });
          rmSync(notgit, { recursive: true, force: true });
        }
      });

      it('lets the same settings write through from a scratch folder', () => {
        const scratch = mkdtempSync(join(tmpdir(), 'foreman-hook-scratch-'));
        try {
          const r = run({ FOREMAN_RUN: '1' }, bash('foreman:tester', `cd ${scratch} && foreman settings set workers 1`));
          expect(r.status).toBe(0);
          expect(r.stdout).toBe('');
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      });

      it('prints nothing outside a factory run', () => {
        const r = run({}, bash('foreman:builder', `echo X >> ${join(dir, '.env.local')}`));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      });
    });

    describe('fails closed inside a Foreman run', () => {
      const CONFIG_DENY = 'Foreman could not load foreman.config.json, so it denies Bash commands in this run until the config loads.';
      const configDenied = (r) => {
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: CONFIG_DENY } });
      };
      const brokenConfig = () => writeFileSync(join(dir, 'foreman.config.json'), '{ not json');
      // A plain file where the state dir should be, so the state write throws ENOTDIR.
      const brokenStateDir = () => writeFileSync(join(dir, 'state'), 'not a directory');

      it('denies Bash when the config is not JSON', () => {
        brokenConfig();
        configDenied(hook({ FOREMAN_RUN: '1' }, bash('foreman:builder', 'npm test')));
      });

      it('denies Bash when there is no config, even for the foreman', () => {
        configDenied(hook({ FOREMAN_RUN: '1' }, bash(null, 'ls')));
      });

      it('denies Bash when the config fails validation', () => {
        writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1 }));
        configDenied(hook({ FOREMAN_RUN: '1' }, bash('foreman:builder', 'npm test')));
      });

      it('with a broken config, does not deny other tools or events, and still records the agent', () => {
        brokenConfig();
        const read = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, agent_id: 'x1', agent_type: 'foreman:tester' });
        const r1 = hook({ FOREMAN_RUN: '1' }, read);
        expect(r1.status).toBe(0);
        expect(r1.stdout).toBe('');
        const r2 = hook({ FOREMAN_RUN: '1', FOREMAN_SLOT: 'w2' });
        expect(r2.status).toBe(0);
        expect(r2.stdout).toBe('');
        expect(existsSync(join(dir, 'state', 'slots', 'w2', 'agents', 'a1.json'))).toBe(true);
      });

      it('still reaches the guard when the state write throws', () => {
        brokenStateDir();
        const r = run({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl https://app.example.com/api'));
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual(HOST_DENY);
      });

      it('lets an allowed command through when the state write throws', () => {
        brokenStateDir();
        const r = run({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl http://localhost:3000'));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      });

      it('outside a Foreman run, a broken config prints nothing', () => {
        brokenConfig();
        const r = hook({}, bash('foreman:builder', 'npm test'));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      });

      it('outside a Foreman run, a broken state dir prints nothing', () => {
        brokenStateDir();
        const r = run({}, bash('foreman:tester', 'curl https://app.example.com/api'));
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
      });
    });
  });
});
