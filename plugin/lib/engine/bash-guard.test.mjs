import { describe, expect, it, vi } from 'vitest';
import { bashDecision } from './bash-guard.mjs';
import { ownerFilesWrite } from './run-guard.mjs';
import { stageMap } from './state.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

const stages = stageMap(null);
const config = { pack: 'acme', acme: { region: 'eu' }, ship: { smoke: { urls: ['https://app.acme.test/health'] } } };
const HOST_DENY = 'Foreman keeps the tester and reviewers off production (app.acme.test). Test against the local or slot environment instead.';
const spyGuard = () => vi.fn(({ command }) => (command.includes('deploy quick') ? 'no quick deploys' : null));

describe('bashDecision', () => {
  it('denies a builder command the pack guard denies, with its reason', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    const reason = bashDecision({ command: 'sf project deploy quick', agentType: 'foreman:builder', config, stages, slot: 'w2', packs });
    expect(reason).toBe('no quick deploys');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ command: 'sf project deploy quick', stage: 'build', slot: 'w2', config });
  });

  it('allows a builder command the pack guard allows', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    expect(bashDecision({ command: 'npm test', agentType: 'foreman:builder', config, stages, slot: 'w1', packs })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('asks the pack guard in every stage, and for the foreman with a null stage', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    for (const agentType of ['foreman:architect', 'foreman:builder', 'foreman:tester', 'foreman:security-reviewer', undefined]) {
      expect(bashDecision({ command: 'npm test', agentType, config, stages, slot: 'w1', packs })).toBeNull();
    }
    expect(spy.mock.calls.map(([arg]) => arg.stage)).toEqual(['architect', 'build', 'test', 'review', null]);
  });

  it('runs the host guard first, unchanged, and skips the pack guard when it denies', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    expect(bashDecision({ command: 'curl https://app.acme.test/x', agentType: 'foreman:tester', config, stages, slot: 'w1', packs })).toBe(HOST_DENY);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still gives the builder no host guard', () => {
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    expect(bashDecision({ command: 'curl https://app.acme.test/x', agentType: 'foreman:builder', config, stages, slot: 'w1', packs })).toBeNull();
  });

  it('features.productionGuard off switches off only the host guard', () => {
    const off = { ...config, features: { productionGuard: false } };
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    expect(bashDecision({ command: 'curl https://app.acme.test/x', agentType: 'foreman:tester', config: off, stages, slot: 'w1', packs })).toBeNull();
    expect(bashDecision({ command: 'sf project deploy quick', agentType: 'foreman:builder', config: off, stages, slot: 'w1', packs })).toBe('no quick deploys');
  });

  it('fails closed when the pack guard throws or gives no reason', () => {
    const decide = (guard) => bashDecision({ command: 'npm test', agentType: 'foreman:builder', config, stages, slot: 'w1', packs: { acme: fakePack({ guard }) } });
    expect(
      decide(() => {
        throw new Error('boom');
      }),
    ).toBe('The acme pack guard failed (boom), so Foreman denies this command.');
    expect(decide(() => ({}))).toBe('The acme pack guard gave no reason, so Foreman denies this command.');
    for (const value of [undefined, false, '']) expect(decide(() => value)).toBeNull();
  });

  it('fails closed, and never throws, when the thrown value breaks the message', () => {
    const decide = (guard) => bashDecision({ command: 'npm test', agentType: 'foreman:builder', config, stages, slot: 'w1', packs: { acme: fakePack({ guard }) } });
    const failed = (detail) => `The acme pack guard failed (${detail}), so Foreman denies this command.`;
    const badMessage = {
      get message() {
        throw new Error('no');
      },
    };
    const badString = {
      toString() {
        throw new Error('no');
      },
    };
    const cases = [
      [Symbol('x'), failed('Symbol(x)')],
      [badMessage, failed('unknown error')],
      [badString, failed('unknown error')],
      [Object.create(null), failed('unknown error')],
    ];
    for (const [thrown, expected] of cases) {
      const g = () => {
        throw thrown;
      };
      expect(() => decide(g)).not.toThrow();
      expect(decide(g)).toBe(expected);
    }
  });

  it('gives the pack guard a null stage for an agent type named like an Object.prototype member', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    for (const agentType of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(bashDecision({ command: 'npm test', agentType, config, stages, slot: 'w1', packs })).toBeNull();
    }
    expect(spy.mock.calls.map(([a]) => a.stage)).toEqual([null, null, null, null]);
  });

  it('keeps the host guard the same for prototype-named agent types', () => {
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    expect(bashDecision({ command: 'curl https://app.acme.test/x', agentType: 'foreman:tester', config, stages, slot: 'w1', packs })).toBe(HOST_DENY);
    expect(bashDecision({ command: 'curl https://app.acme.test/x', agentType: 'constructor', config, stages, slot: 'w1', packs })).toBeNull();
  });

  it('with no pack guard to call, applies only the host guard and never throws', () => {
    const cases = [
      { config: { ship: config.ship }, packs: { acme: fakePack({ guard: spyGuard() }) } },
      { config, packs: { acme: fakePack({ guard: undefined }) } },
      { config: null, packs: { acme: fakePack({ guard: spyGuard() }) } },
      { config: { ...config, pack: 'other' }, packs: { acme: fakePack({ guard: spyGuard() }) } },
    ];
    for (const c of cases) {
      expect(bashDecision({ command: 'sf project deploy quick', agentType: 'foreman:builder', stages, slot: 'w1', ...c })).toBeNull();
      const host = bashDecision({ command: 'curl https://app.acme.test/x', agentType: 'foreman:tester', stages, slot: 'w1', ...c });
      expect(host).toBe(c.config ? HOST_DENY : null);
      if (c.packs.acme.guard) expect(c.packs.acme.guard).not.toHaveBeenCalled();
    }
  });

  it('does not ask the pack guard when there is no command', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    for (const command of [undefined, '']) {
      expect(bashDecision({ command, agentType: 'foreman:builder', config, stages, slot: 'w1', packs })).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('bashDecision: the project-files guard', () => {
  const protect = ['/a/foreman.config.json', '/a/.foreman/settings.json', '/a/.env.local', '/a/.env.foreman'];
  const vars = { FOREMAN_PROJECT_DIR: '/a', HOME: '/h' };
  const cwd = '/a/.foreman/worktrees/w1';
  const ANCHOR_DENY =
    "Foreman denies this command: it would change /a/.env.local, which belongs to the project this run builds. Story sessions never write the real project's config, settings or keys; check Foreman commands in a scratch git repo, with the FOREMAN_* variables left set.";

  it('denies a write to a project file for every agent type, the foreman included', () => {
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    for (const agentType of ['foreman:builder', 'foreman:tester', 'security-reviewer', null]) {
      expect(bashDecision({ command: 'echo x > /a/.env.local', agentType, config, stages, slot: 'w1', packs, cwd, protect, vars }), String(agentType)).toBe(ANCHOR_DENY);
    }
  });

  it('still denies with features.productionGuard off', () => {
    const off = { ...config, features: { productionGuard: false } };
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    expect(bashDecision({ command: 'echo x > /a/.env.local', agentType: 'foreman:builder', config: off, stages, slot: 'w1', packs, cwd, protect, vars })).toBe(ANCHOR_DENY);
  });

  it('does not ask the pack guard when it denies', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    expect(bashDecision({ command: 'echo x > /a/.env.local', agentType: 'foreman:builder', config, stages, slot: 'w1', packs, cwd, protect, vars })).toBe(ANCHOR_DENY);
    expect(spy).not.toHaveBeenCalled();
  });

  it('lets a read through to the pack guard', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    expect(bashDecision({ command: 'cat /a/.env.local', agentType: 'foreman:builder', config, stages, slot: 'w1', packs, cwd, protect, vars })).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a protect list', () => {
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    expect(bashDecision({ command: 'echo x > /a/.env.local', agentType: 'foreman:builder', config, stages, slot: 'w1', packs, cwd, vars })).toBeNull();
    expect(bashDecision({ command: 'echo x > /a/.env.local', agentType: 'foreman:builder', config, stages, slot: 'w1', packs, cwd, protect: [], vars })).toBeNull();
  });

  it('passes the foreman option on: a guarded Foreman command from the project is denied before the pack guard', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    const foreman = { anchor: '/a', guarded: (name, args) => (name === 'settings' && args[0] === 'set' ? 'foreman settings set' : null), isAnchorDir: (d) => d.startsWith('/a') };
    const decide = (command) => bashDecision({ command, agentType: 'foreman:tester', config, stages, slot: 'w1', packs, cwd, protect, vars, foreman });
    expect(decide('(unset FOREMAN_RUN; foreman settings set workers 1)')).toBe(
      'foreman settings set would change /a, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.',
    );
    expect(spy).not.toHaveBeenCalled();
    expect(decide('foreman settings get workers')).toBeNull();
  });

  it('denies foreman sf deletes from the project with the real guarded list, whatever it does to FOREMAN_RUN', () => {
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    const foreman = { anchor: '/a', guarded: ownerFilesWrite, isAnchorDir: (d) => d.startsWith('/a') };
    const decide = (command) => bashDecision({ command, agentType: 'foreman:builder', config, stages, slot: 'w1', packs, cwd: '/a', protect, vars, foreman });
    expect(decide('(unset FOREMAN_RUN; foreman sf deletes allow S-1)')).toBe(
      'foreman sf deletes would change /a, the project this Foreman run builds, so it does not run inside a story session (FOREMAN_RUN=1); run it in a scratch git repo instead.',
    );
    expect(decide('foreman sf baseline')).toBeNull();
  });

  it('fails closed, and never throws, when resolving a path throws', () => {
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    const resolve = () => {
      throw new Error('boom');
    };
    const decide = () => bashDecision({ command: 'echo x > /tmp/y', agentType: 'foreman:builder', config, stages, slot: 'w1', packs, cwd, protect, vars, resolve });
    expect(decide).not.toThrow();
    expect(decide()).toBe('The Foreman project-files guard failed, so Foreman denies this command.');
  });
});

describe('bashDecision: the check guard', () => {
  const RUN = 'SLOW_TEST_GUARD=report npm test';
  const withChecks = { ...config, checks: [{ run: RUN, when: 'always' }] };
  const protect = ['/a/.env.local'];
  const cwd = '/a/.foreman/worktrees/w1';
  const REASON = (run) => `Foreman denies this command: it runs the project's check \`${run}\` by hand, which leaves no record. Run the checks through Foreman: \`foreman checks --changed\`, or for a long suite \`foreman checks --changed --start\` and then \`foreman checks --wait <id>\` (add --reuse where your instructions say so). Targeted runs of single tests stay free.`;
  const hand = `${RUN} 2>&1 | tail -40`;

  it('denies a hand run for every agent type, the foreman included, and does not ask the pack guard', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    for (const agentType of ['foreman:builder', 'foreman:tester', 'foreman:architect', 'foreman:security-reviewer', undefined]) {
      expect(bashDecision({ command: hand, agentType, config: withChecks, stages, slot: 'w1', packs }), String(agentType)).toBe(REASON(RUN));
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('still denies with features.productionGuard off', () => {
    const off = { ...withChecks, features: { productionGuard: false } };
    expect(bashDecision({ command: hand, agentType: 'foreman:builder', config: off, stages, slot: 'w1', packs: { acme: fakePack({ guard: spyGuard() }) } })).toBe(REASON(RUN));
  });

  it('allows foreman checks and a targeted test run, and still asks the pack guard', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    for (const command of ['foreman checks --changed', 'npx vitest run plugin/lib/engine/state.test.mjs']) {
      expect(bashDecision({ command, agentType: 'foreman:builder', config: withChecks, stages, slot: 'w1', packs }), command).toBeNull();
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('allows npm test when the config has no checks', () => {
    expect(bashDecision({ command: 'npm test', agentType: 'foreman:builder', config, stages, slot: 'w1', packs: { acme: fakePack({ guard: spyGuard() }) } })).toBeNull();
  });

  it('runs after the host guard and the project-files guard', () => {
    const packs = { acme: fakePack({ guard: spyGuard() }) };
    const both = { ...withChecks, ...config, checks: withChecks.checks };
    const host = `curl https://app.acme.test/x; ${RUN}`;
    expect(bashDecision({ command: host, agentType: 'foreman:tester', config: both, stages, slot: 'w1', packs })).toBe(HOST_DENY);
    const files = `echo x > /a/.env.local; ${RUN}`;
    const reason = bashDecision({ command: files, agentType: 'foreman:builder', config: both, stages, slot: 'w1', packs, cwd, protect, vars: {} });
    expect(reason).toMatch(/^Foreman denies this command: it would change \/a\/\.env\.local, which belongs/);
  });

  it('fails closed with the exact message, and never throws, when the checks cannot be read', () => {
    const broken = {
      ...config,
      get checks() {
        throw new Error('boom');
      },
    };
    const decide = () => bashDecision({ command: 'npm test', agentType: 'foreman:builder', config: broken, stages, slot: 'w1', packs: { acme: fakePack({ guard: spyGuard() }) } });
    expect(decide).not.toThrow();
    expect(decide()).toBe('The Foreman check guard failed, so Foreman denies this command.');
  });

  it('does not run on an empty command', () => {
    expect(bashDecision({ command: '', agentType: 'foreman:builder', config: withChecks, stages, slot: 'w1', packs: {} })).toBeNull();
  });
});

describe('bashDecision: the scan guard', () => {
  const roots = ['/acme', '/tmp'];
  const decide = (over) => bashDecision({ command: 'find / -name x', config, stages, slot: 'w1', cwd: '/acme', vars: {}, roots, ...over });
  const SCAN = /^Foreman denies this command: `find` would search \/, outside the folders a story session may search\./;

  it('denies a scan outside the roots for every agent and the foreman, before the pack guard', () => {
    const spy = spyGuard();
    const packs = { acme: fakePack({ guard: spy }) };
    for (const agentType of ['foreman:architect', 'foreman:builder', 'foreman:tester', 'foreman:compliance-reviewer', 'foreman:security-reviewer', undefined]) {
      expect(decide({ agentType, packs })).toMatch(SCAN);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('is off without roots', () => {
    expect(decide({ agentType: 'foreman:builder', roots: undefined })).toBeNull();
    expect(decide({ agentType: 'foreman:builder', roots: [] })).toBeNull();
  });

  it('is not switched off by features.productionGuard', () => {
    expect(decide({ config: { ...config, features: { productionGuard: false } } })).toMatch(SCAN);
  });

  it('allows a scan inside the roots', () => {
    expect(decide({ command: 'rg x /acme/src' })).toBeNull();
  });

  it('lets the check guard win for a hand-run check', () => {
    const checks = [{ run: 'npm test', when: 'always' }];
    const reason = decide({ command: 'npm test', config: { ...config, checks } });
    expect(reason).toContain('foreman checks');
    expect(reason).not.toMatch(SCAN);
  });

  it('keeps the host guard first', () => {
    expect(decide({ command: 'curl https://app.acme.test/x', agentType: 'foreman:tester' })).toBe(HOST_DENY);
  });

  it('fails closed when resolving a start throws', () => {
    const resolve = () => {
      throw new Error('boom');
    };
    expect(decide({ command: 'find /acme/src', resolve })).toBe('The Foreman scan guard failed, so Foreman denies this command.');
  });
});

describe('bashDecision: the kill guard', () => {
  const INCIDENT = `pkill -f "vitest run plugin/lib/engine/supervisor-file-locks" ; pkill -f "foreman.*run --foreground"; cp /tmp/sup.bak plugin/lib/engine/supervisor.mjs`;
  const decide = (extra) => bashDecision({ command: 'npm test', agentType: 'foreman:builder', config, stages, slot: 'w1', packs: { acme: fakePack() }, ...extra });

  it('denies the incident command for a builder and for no agent type, with the production guard off', () => {
    for (const agentType of ['foreman:builder', undefined]) {
      const reason = decide({ command: INCIDENT, agentType, config: { ...config, features: { productionGuard: false } } });
      expect(reason).toMatch(/^Foreman denies this command: `pkill` stops processes by name or pattern/);
      expect(reason).toContain('the PID you recorded');
    }
  });

  it('does not ask the pack guard when it denies', () => {
    const spy = vi.fn(() => null);
    expect(decide({ command: 'killall node', packs: { acme: fakePack({ guard: spy }) } })).toContain('`killall`');
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks signals.verdict for a pid', () => {
    expect(decide({ command: 'kill 123', signals: { verdict: () => 'not yours' } })).toBe('not yours');
    expect(decide({ command: 'kill 123', signals: { verdict: () => null } })).toBeNull();
    expect(decide({ command: 'kill 123' })).toBeNull();
  });

  it('fails closed when the verdict throws', () => {
    const signals = {
      verdict: () => {
        throw new Error('boom');
      },
    };
    expect(decide({ command: 'kill 123', signals })).toBe('The Foreman kill guard failed, so Foreman denies this command.');
  });

  it('leaves an ordinary command to the pack guard', () => {
    const spy = vi.fn(() => 'no');
    expect(decide({ command: 'npm test', packs: { acme: fakePack({ guard: spy }) } })).toBe('no');
  });

  it('denies a kill that is not an allowed form, without asking the pack guard', () => {
    const spy = vi.fn(() => null);
    const reason = decide({ command: 'kill -s 0 -TERM 123', agentType: undefined, config: { ...config, features: { productionGuard: false } }, packs: { acme: fakePack({ guard: spy }) } });
    expect(reason).toContain('Foreman allows only');
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads a commit message that mentions kill as text, and leaves it to the pack guard', () => {
    const spy = vi.fn(() => 'no');
    expect(decide({ command: 'git commit -m "kill the old process"', packs: { acme: fakePack({ guard: spy }) } })).toBe('no');
    expect(spy).toHaveBeenCalled();
  });
});
