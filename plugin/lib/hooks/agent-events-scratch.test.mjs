// The agent-events hook fails closed when one of its steps throws, will not load or hangs, in a
// scratch copy of the plugin, and when the hook itself is stopped. The fixture is
// test/agent-events-fixture.mjs.

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bash, cleanEnv, CONFIG, dir, HOST_DENY, START, withHookDir } from '../../../test/agent-events-fixture.mjs';
import { stretchByLoad } from '../../../test/slow-tests.mjs';
import { startChild, useSupervisors } from '../../../test/supervisors.mjs';

withHookDir();
useSupervisors();

describe('the agent-events hook', () => {
  describe('production guard', () => {
    describe('fails closed inside a Foreman run', () => {
      describe('fails closed when a step breaks, in a scratch copy of the plugin', () => {
        const PLUGIN = fileURLToPath(new URL('../..', import.meta.url));
        const GUARD_DENY = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'The Foreman Bash guard failed, so Foreman denies this command.',
          },
        };
        let copy;
        beforeEach(() => {
          copy = mkdtempSync(join(tmpdir(), 'foreman-plugin-'));
          cpSync(PLUGIN, join(copy, 'plugin'), { recursive: true, filter: (src) => !src.endsWith('.test.mjs') });
        });
        afterEach(() => rmSync(copy, { recursive: true, force: true }));

        const inCopy = (rel) => join(copy, 'plugin', rel);
        const copyHook = (env, input) => {
          writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(CONFIG));
          return spawnSync('node', [inCopy('lib/hooks/agent-events.mjs')], {
            input,
            encoding: 'utf8',
            timeout: 20_000,
            cwd: dir,
            env: cleanEnv({ FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: join(dir, 'state'), ...env }),
          });
        };
        const guardDenied = (r) => {
          expect(r.status).toBe(0);
          expect(JSON.parse(r.stdout)).toEqual(GUARD_DENY);
        };
        const silent = (r) => {
          expect(r.status).toBe(0);
          expect(r.stdout).toBe('');
        };
        const dropSettings = () => rmSync(inCopy('lib/settings'), { recursive: true });

        it('denies when the guard throws', () => {
          writeFileSync(inCopy('lib/engine/bash-guard.mjs'), "export function bashDecision() { throw new Error('boom'); }\n");
          guardDenied(copyHook({ FOREMAN_RUN: '1' }, bash('foreman:builder', 'npm test')));
        });

        it('denies when the guard module will not load', () => {
          writeFileSync(inCopy('lib/engine/bash-guard.mjs'), 'export function bashDecision( {\n');
          guardDenied(copyHook({ FOREMAN_RUN: '1' }, bash(null, 'ls')));
        });

        it('denies when a module needed before the decision is missing', () => {
          dropSettings();
          guardDenied(copyHook({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl http://localhost:3000')));
        });

        it('denies when stageMap throws', () => {
          writeFileSync(inCopy('lib/engine/state.mjs'), "export function stageMap() { throw new Error('boom'); }\nexport function applyHookEvent() {}\n");
          guardDenied(copyHook({ FOREMAN_RUN: '1' }, bash('foreman:builder', 'npm test')));
        });

        it('with a module missing, does not deny other tools or events', () => {
          dropSettings();
          const read = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, agent_id: 'x1', agent_type: 'foreman:tester' });
          silent(copyHook({ FOREMAN_RUN: '1' }, read));
          silent(copyHook({ FOREMAN_RUN: '1' }, START));
        });

        it('with a module missing, prints nothing outside a Foreman run', () => {
          dropSettings();
          silent(copyHook({}, bash('foreman:builder', 'npm test')));
        });

        it('with a module missing, prints nothing for input that is not JSON', () => {
          dropSettings();
          silent(copyHook({ FOREMAN_RUN: '1' }, 'not json'));
        });

        // The watchdog thread throws after it has started: its 'error' event must not become an
        // uncaught exception in the --decide child, which would deny an allowed command.
        it('a watchdog that fails after it starts does not deny an allowed command', () => {
          const hook = inCopy('lib/hooks/agent-events.mjs');
          const src = readFileSync(hook, 'utf8');
          expect(src).toContain('const started = Date.now();');
          writeFileSync(
            hook,
            src.replace(
              'const started = Date.now();',
              "require('node:fs').writeFileSync(require('node:path').join(process.env.FOREMAN_PROJECT_DIR, 'watchdog.thrown'), ''); throw new Error('watchdog broke');",
            ),
          );
          // Holds the decision back until the worker has thrown, and its error has reached the main thread.
          writeFileSync(
            inCopy('lib/engine/bash-guard.mjs'),
            "import { existsSync } from 'node:fs';\nimport { join } from 'node:path';\n" +
              "const flag = join(process.env.FOREMAN_PROJECT_DIR, 'watchdog.thrown');\n" +
              'for (let i = 0; i < 250 && !existsSync(flag); i++) await new Promise((r) => setTimeout(r, 20));\n' +
              'await new Promise((r) => setTimeout(r, 200));\n' +
              'export function bashDecision() { return null; }\n',
          );
          silent(copyHook({ FOREMAN_RUN: '1' }, bash('foreman:builder', 'ls')));
          expect(existsSync(join(dir, 'watchdog.thrown'))).toBe(true);

          rmSync(join(dir, 'watchdog.thrown'));
          const child = spawnSync('node', [hook, '--decide'], {
            input: bash('foreman:builder', 'ls'),
            encoding: 'utf8',
            timeout: 20_000,
            cwd: dir,
            env: cleanEnv({ FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: join(dir, 'state'), FOREMAN_RUN: '1' }),
          });
          expect(child.status).toBe(0);
          expect(child.stdout).toBe('{"reason":null}\n');
          expect(existsSync(join(dir, 'watchdog.thrown'))).toBe(true);
        }, 20_000);

        describe('when a step hangs instead of throwing', () => {
          const HANG = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);';
          // Makes the copy's exported function block forever, synchronously. The original is
          // renamed so the module still parses, and its other exports stay real.
          const hangIn = (rel, name, { before = '', header = '' } = {}) => {
            const file = inCopy(rel);
            const text = readFileSync(file, 'utf8');
            const line = `export function ${name}(`;
            expect(text).toContain(line);
            writeFileSync(file, header + text.replace(line, `export function ${name}() { ${before}${HANG} }\nfunction __original_${name}(`));
          };
          const timed = (env, input) => {
            const start = Date.now();
            const r = copyHook(env, input);
            return { r, elapsed: Date.now() - start };
          };
          const FAST = { FOREMAN_RUN: '1', FOREMAN_GUARD_TIMEOUT_MS: '1000' };
          const hangStateWrite = () =>
            hangIn('lib/engine/state.mjs', 'applyHookEvent', {
              header: "import { writeFileSync as __w } from 'node:fs';\nimport { join as __j } from 'node:path';\n",
              before: "__w(__j(process.env.FOREMAN_PROJECT_DIR, 'child.pid'), String(process.pid));",
            });
          const gone = (pid) => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (e) {
              return e.code === 'ESRCH';
            }
          };

          const alive = (pid) => pid > 0 && !gone(pid);
          const waitFor = async (check, ms) => {
            const until = Date.now() + ms;
            while (!check() && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
            return check();
          };

          // At the default 8 s limit: a decision already made comes back after a short grace
          // for the recording, not after the full limit.
          it('enforces a deny already made when the state write hangs, and kills the child', async () => {
            hangStateWrite();
            const { r, elapsed } = timed({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl https://app.example.com/api'));
            expect(r.status).toBe(0);
            expect(JSON.parse(r.stdout)).toEqual(HOST_DENY);
            expect(elapsed).toBeLessThan(stretchByLoad(4000));
            const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
            expect(pid).toBeGreaterThan(0);
            const until = Date.now() + 2000;
            while (!gone(pid) && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
            expect(gone(pid)).toBe(true);
          }, 20_000);

          it('lets an allowed command through when the state write hangs', () => {
            hangStateWrite();
            const { r, elapsed } = timed({ FOREMAN_RUN: '1' }, bash('foreman:tester', 'curl http://localhost:3000'));
            expect(r.status).toBe(0);
            expect(r.stdout).toBe('');
            expect(elapsed).toBeLessThan(stretchByLoad(4000));
          }, 20_000);

          it('denies when the guard hangs', () => {
            writeFileSync(inCopy('lib/engine/bash-guard.mjs'), `export function bashDecision() { ${HANG} }\n`);
            const { r, elapsed } = timed(FAST, bash('foreman:builder', 'npm test'));
            guardDenied(r);
            expect(elapsed).toBeLessThan(5000);
          });

          it('denies when the config load hangs', () => {
            hangIn('lib/settings/load.mjs', 'loadResolved');
            const { r, elapsed } = timed(FAST, bash('foreman:builder', 'npm test'));
            guardDenied(r);
            expect(elapsed).toBeLessThan(5000);
          });

          it('denies when a module import never settles', () => {
            writeFileSync(inCopy('lib/engine/bash-guard.mjs'), 'await new Promise(() => {});\nexport function bashDecision() { return null; }\n');
            const { r, elapsed } = timed(FAST, bash('foreman:builder', 'npm test'));
            guardDenied(r);
            expect(elapsed).toBeLessThan(5000);
          });

          it('by default denies under the 10 s hook timeout, and clamps a longer limit to it', () => {
            writeFileSync(inCopy('lib/engine/bash-guard.mjs'), `export function bashDecision() { ${HANG} }\n`);
            // The copy's hook says the limit it settled on, so the clamp is checked exactly and
            // only the time around the 8 s wait (two node starts) depends on the machine's load.
            const hook = inCopy('lib/hooks/agent-events.mjs');
            const line = 'const LIMIT_MS = guardLimit(process.env.FOREMAN_GUARD_TIMEOUT_MS);\n';
            expect(readFileSync(hook, 'utf8')).toContain(line);
            writeFileSync(hook, readFileSync(hook, 'utf8').replace(line, `${line}if (!DECIDE) process.stderr.write('acme-limit ' + LIMIT_MS + '\\n');\n`));
            const { r, elapsed } = timed({ FOREMAN_RUN: '1', FOREMAN_GUARD_TIMEOUT_MS: '99999' }, bash('foreman:builder', 'npm test'));
            guardDenied(r);
            expect(r.stderr).toContain('acme-limit 8000\n');
            expect(elapsed).toBeGreaterThan(7000);
            expect(elapsed).toBeLessThan(8000 + stretchByLoad(1500));
          }, 20_000);

          // A synchronously hung step stops the child's own timers, so a watchdog thread in it
          // ends it: at the guard limit plus 2 s, or once the hook that started it is gone.
          it('a --decide run whose stdin closes ends itself within seconds when its step hangs', async () => {
            writeFileSync(inCopy('lib/engine/bash-guard.mjs'), `export function bashDecision() { ${HANG} }\n`);
            writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(CONFIG));
            const started = Date.now();
            const child = startChild('node', [inCopy('lib/hooks/agent-events.mjs'), '--decide'], {
              cwd: dir,
              env: cleanEnv({ FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: join(dir, 'state'), FOREMAN_RUN: '1', FOREMAN_GUARD_TIMEOUT_MS: '1000' }),
              stdio: ['pipe', 'ignore', 'ignore'],
            });
            child.stdin.end(bash('foreman:builder', 'npm test'));
            await child.exited;
            const elapsed = Date.now() - started;
            expect(child.signalCode).toBe('SIGKILL');
            // The cap (1 s + 2 s), not an instant exit.
            expect(elapsed).toBeGreaterThanOrEqual(2500);
            expect(elapsed).toBeLessThan(3000 + stretchByLoad(2000));
          }, 20_000);

          it('a --decide child ends within seconds once the hook that started it is killed', async () => {
            writeFileSync(
              inCopy('lib/engine/bash-guard.mjs'),
              "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" +
                `export function bashDecision() { writeFileSync(join(process.env.FOREMAN_PROJECT_DIR, 'child.pid'), String(process.pid)); ${HANG} }\n`,
            );
            writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(CONFIG));
            const pidFile = join(dir, 'child.pid');
            const hook = startChild('node', [inCopy('lib/hooks/agent-events.mjs')], {
              cwd: dir,
              env: cleanEnv({ FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: join(dir, 'state'), FOREMAN_RUN: '1' }),
              stdio: ['pipe', 'ignore', 'ignore'],
            });
            hook.stdin.end(bash('foreman:builder', 'npm test'));
            let childPid = 0;
            try {
              expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 5000)).toBe(true);
              childPid = Number(readFileSync(pidFile, 'utf8'));
              expect(childPid).toBeGreaterThan(0);
              const killedAt = Date.now();
              process.kill(hook.pid, 'SIGKILL');
              expect(await waitFor(() => gone(childPid), stretchByLoad(2000))).toBe(true);
              expect(Date.now() - killedAt).toBeLessThan(6000);
            } finally {
              if (alive(childPid)) process.kill(childPid, 'SIGKILL');
            }
          }, 20_000);

          describe('when the hook itself is stopped', () => {
            it.each(['SIGTERM', 'SIGINT', 'SIGHUP'])('on %s, kills the hung child and denies before it exits', async (sig) => {
              writeFileSync(
                inCopy('lib/engine/bash-guard.mjs'),
                "import { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" +
                  `export function bashDecision() { writeFileSync(join(process.env.FOREMAN_PROJECT_DIR, 'child.pid'), String(process.pid)); ${HANG} }\n`,
              );
              writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(CONFIG));
              const pidFile = join(dir, 'child.pid');
              const parent = startChild('node', [inCopy('lib/hooks/agent-events.mjs')], {
                cwd: dir,
                env: cleanEnv({ FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: join(dir, 'state'), FOREMAN_RUN: '1' }),
                stdio: ['pipe', 'pipe', 'ignore'],
              });
              let stdout = '';
              parent.stdout.setEncoding('utf8');
              parent.stdout.on('data', (chunk) => (stdout += chunk));
              const closed = new Promise((res) => parent.on('close', (code, signal) => res({ code, signal, at: Date.now() })));
              parent.stdin.end(bash('foreman:builder', 'npm test'));
              let childPid = 0;
              try {
                expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 5000)).toBe(true);
                childPid = Number(readFileSync(pidFile, 'utf8'));
                expect(childPid).toBeGreaterThan(0);
                const sentAt = Date.now();
                parent.kill(sig);
                const { code, signal, at } = await closed;
                expect(code).toBe(0);
                expect(signal).toBe(null);
                expect(at - sentAt).toBeLessThan(3000);
                expect(JSON.parse(stdout)).toEqual(GUARD_DENY);
                expect(await waitFor(() => gone(childPid), 2000)).toBe(true);
              } finally {
                if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
                if (alive(childPid)) process.kill(childPid, 'SIGKILL');
              }
            }, 20_000);

            // The child prints its decision before it records, so the pause before the pid file
            // lets the parent read the decision and open its 0.5 s grace before the signal lands.
            it('on SIGTERM during the grace after a deny, keeps the deny and kills the hung child', async () => {
              hangIn('lib/engine/state.mjs', 'applyHookEvent', {
                header: "import { writeFileSync as __w } from 'node:fs';\nimport { join as __j } from 'node:path';\n",
                before:
                  'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); ' +
                  "__w(__j(process.env.FOREMAN_PROJECT_DIR, 'child.pid'), String(process.pid));",
              });
              writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify(CONFIG));
              const pidFile = join(dir, 'child.pid');
              const parent = startChild('node', [inCopy('lib/hooks/agent-events.mjs')], {
                cwd: dir,
                env: cleanEnv({ FOREMAN_PROJECT_DIR: dir, FOREMAN_STATE_DIR: join(dir, 'state'), FOREMAN_RUN: '1' }),
                stdio: ['pipe', 'pipe', 'ignore'],
              });
              let stdout = '';
              parent.stdout.setEncoding('utf8');
              parent.stdout.on('data', (chunk) => (stdout += chunk));
              const closed = new Promise((res) => parent.on('close', (code, signal) => res({ code, signal, at: Date.now() })));
              parent.stdin.end(bash('foreman:tester', 'curl https://app.example.com/api'));
              let childPid = 0;
              try {
                expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 5000)).toBe(true);
                childPid = Number(readFileSync(pidFile, 'utf8'));
                expect(childPid).toBeGreaterThan(0);
                expect(parent.exitCode === null && parent.signalCode === null).toBe(true);
                const sentAt = Date.now();
                parent.kill('SIGTERM');
                const { code, signal, at } = await closed;
                expect(code).toBe(0);
                expect(signal).toBe(null);
                expect(at - sentAt).toBeLessThan(3000);
                expect(JSON.parse(stdout)).toEqual(HOST_DENY);
                expect(await waitFor(() => gone(childPid), 2000)).toBe(true);
              } finally {
                if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
                if (alive(childPid)) process.kill(childPid, 'SIGKILL');
              }
            }, 20_000);
          });
        });
      });
    });
  });
});
