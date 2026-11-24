import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envAdapterContract } from './contract.mjs';
import { hostedEnv } from '../ship/migrate-supabase.mjs';
import { create } from './supabase.mjs';

const fakeSh = (answer = () => ({ status: 0, stdout: '' })) => {
  const calls = [];
  const sh = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return answer(cmd, args, opts, calls);
  };
  return { sh, calls };
};
const said = (call) => [call.cmd, ...call.args].join(' ');
const ACME = { adapter: 'supabase', projectPrefix: 'acme-app', extraPorts: { UI_PORT: { base: 3210, step: 1 } } };
// The machine folder is a temporary one, so no test touches the real ~/.config/foreman.
const make = (options = ACME, sh = fakeSh().sh) => create(options, { root: '/repo', config: { slots: 3 }, sh, machineDir: mkdtempSync(join(tmpdir(), 'foreman-machine-')) });

envAdapterContract({ name: 'supabase', make: () => make(ACME, fakeSh().sh) });

describe('supabase env(n)', () => {
  // Written out literally from the old slotEnv(n) in lib/engine/slot.mjs.
  it('slot 1 gets its own project id and ports', () => {
    expect(make().env(1)).toEqual({
      SUPABASE_PROJECT_ID: 'acme-app-w1',
      SUPABASE_API_PORT: '54421',
      SUPABASE_DB_PORT: '54422',
      SUPABASE_DB_SHADOW_PORT: '54420',
      SUPABASE_DB_POOLER_PORT: '54429',
      SUPABASE_STUDIO_PORT: '54423',
      SUPABASE_INBUCKET_PORT: '54424',
      SUPABASE_LOCAL_SMTP_PORT: '54424',
      SUPABASE_ANALYTICS_PORT: '54427',
      SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT: '8084',
      UI_PORT: '3211',
      FOREMAN_SLOT: 'w1',
    });
  });
  it('slot 2 gets its own project id and ports', () => {
    expect(make().env(2)).toEqual({
      SUPABASE_PROJECT_ID: 'acme-app-w2',
      SUPABASE_API_PORT: '54521',
      SUPABASE_DB_PORT: '54522',
      SUPABASE_DB_SHADOW_PORT: '54520',
      SUPABASE_DB_POOLER_PORT: '54529',
      SUPABASE_STUDIO_PORT: '54523',
      SUPABASE_INBUCKET_PORT: '54524',
      SUPABASE_LOCAL_SMTP_PORT: '54524',
      SUPABASE_ANALYTICS_PORT: '54527',
      SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT: '8085',
      UI_PORT: '3212',
      FOREMAN_SLOT: 'w2',
    });
  });
  it('slot 3 gets its own project id and ports', () => {
    expect(make().env(3)).toEqual({
      SUPABASE_PROJECT_ID: 'acme-app-w3',
      SUPABASE_API_PORT: '54621',
      SUPABASE_DB_PORT: '54622',
      SUPABASE_DB_SHADOW_PORT: '54620',
      SUPABASE_DB_POOLER_PORT: '54629',
      SUPABASE_STUDIO_PORT: '54623',
      SUPABASE_INBUCKET_PORT: '54624',
      SUPABASE_LOCAL_SMTP_PORT: '54624',
      SUPABASE_ANALYTICS_PORT: '54627',
      SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT: '8086',
      UI_PORT: '3213',
      FOREMAN_SLOT: 'w3',
    });
  });
  it('honours portStep and has no extra ports by default', () => {
    const env = create({ projectPrefix: 'p', portStep: 10 }, { config: { slots: 2 } }).env(2);
    expect(env.SUPABASE_API_PORT).toBe('54341');
    expect(env.UI_PORT).toBeUndefined();
    expect(env.SUPABASE_PROJECT_ID).toBe('p-w2');
    expect(env.SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT).toBe('8085');
  });
  it('refuses a slot outside 1..slots', () => {
    const a = make();
    expect(() => a.env(0)).toThrow();
    expect(() => a.env(4)).toThrow();
    expect(() => a.env('2')).toThrow();
  });
});

describe('supabase prepare', () => {
  const run = (answer, options = ACME) => {
    const f = fakeSh(answer);
    return { result: make(options, f.sh).prepare(1, '/wt'), calls: f.calls };
  };
  it('is up when status succeeds', () => {
    const { result, calls } = run();
    expect(result).toBe('up');
    expect(calls.map(said)).toEqual(['supabase status']);
  });
  it('restarts when status fails and start succeeds', () => {
    const { result, calls } = run((c, args) => ({ status: args[0] === 'status' ? 1 : 0, stdout: '' }));
    expect(result).toBe('restarted');
    expect(calls.map(said)).toEqual(['supabase status', 'supabase start -x studio']);
  });
  it('resets when the first start fails and the second succeeds', () => {
    let starts = 0;
    const { result, calls } = run((c, args) => {
      if (args[0] === 'status') return { status: 1, stdout: '' };
      if (args[0] === 'start') return { status: ++starts === 1 ? 1 : 0, stdout: '' };
      return { status: 0, stdout: '' };
    });
    expect(result).toBe('reset');
    expect(calls.map(said)).toEqual(['supabase status', 'supabase start -x studio', 'supabase stop --no-backup', 'supabase start -x studio']);
  });
  it('is down when every call fails', () => {
    expect(run(() => ({ status: 1, stdout: '' })).result).toBe('down');
  });
  it('drops -x studio when excludeStudio is false', () => {
    const { calls } = run(() => ({ status: 1, stdout: '' }), { ...ACME, excludeStudio: false });
    expect(calls.map(said)).toEqual(['supabase status', 'supabase start', 'supabase stop --no-backup', 'supabase start']);
  });
  it('passes the slot env and folder to every call', () => {
    const { calls } = run(() => ({ status: 1, stdout: '' }));
    expect(calls.length).toBe(4);
    for (const c of calls) {
      expect(c.opts.cwd).toBe('/wt');
      expect(c.opts.env.SUPABASE_API_PORT).toBe('54421');
      expect(c.opts.env.SUPABASE_PROJECT_ID).toBe('acme-app-w1');
      expect(c.opts.env.PATH).toBe(process.env.PATH);
    }
  });
});

describe('supabase repair', () => {
  it('does nothing without colima', () => {
    const f = fakeSh();
    const a = make(ACME, f.sh);
    expect(a.repair).toBeUndefined();
    expect(f.calls).toEqual([]);
  });
  it('starts colima once when it is stopped', () => {
    const f = fakeSh((c, args) => ({ status: args[0] === 'status' ? 1 : 0, stdout: '' }));
    const a = make({ ...ACME, colima: true }, f.sh);
    expect(a.repair()).toBe(true);
    expect(f.calls.map(said)).toEqual(['colima status', 'colima start']);
    expect(a.repair()).toBe(false);
    expect(f.calls.length).toBe(2);
  });
  it('reports false when colima will not start', () => {
    const f = fakeSh(() => ({ status: 1, stdout: '' }));
    expect(make({ ...ACME, colima: true }, f.sh).repair()).toBe(false);
  });
  it('returns true without starting when colima already runs', () => {
    const f = fakeSh();
    expect(make({ ...ACME, colima: true }, f.sh).repair()).toBe(true);
    expect(f.calls.map(said)).toEqual(['colima status']);
  });
});

// The stop: the supervisor's stop() calls sweep({ stopping: true, limitMs }) once.
const fakeRun = (answer = () => ({ status: 0, stdout: '' })) => {
  const calls = [];
  const run = async (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return { stderr: '', timedOut: false, ...answer(cmd, args, opts, calls) };
  };
  return { run, calls };
};
const PROJECTS = 'docker ps --format {{.Label "com.supabase.cli.project"}}';
const NAMES = 'docker ps --format {{.Names}}';
// Docker answers the Supabase projects of the running containers, then their names; every other
// command succeeds unless `more` says otherwise.
const docker = ({ projects = [], names = [], more = {} } = {}) => (cmd, args) => {
  const line = [cmd, ...args].join(' ');
  if (line === PROJECTS) return { status: 0, stdout: projects.map((n) => `${n}\n`).join('') };
  if (line === NAMES) return { status: 0, stdout: names.map((n) => `${n}\n`).join('') };
  return more[line] ?? { status: 0, stdout: '' };
};
const colimaDown = () => fakeSh((c, args) => ({ status: args[0] === 'status' ? 1 : 0, stdout: '' }));
const machine = () => mkdtempSync(join(tmpdir(), 'foreman-machine-'));
const makeStop = (options, run, { sh = fakeSh().sh, machineDir = machine(), pid = 101, alive = () => false } = {}) =>
  create(options, { root: '/repo', config: { slots: 3 }, sh, run, machineDir, pid, alive });
const STOP = { stopping: true, limitMs: 60_000 };
const COLIMA = { ...ACME, colima: true };

describe('supabase sweep at a stop', () => {
  it('does nothing on the sweep while the run goes on', async () => {
    const r = fakeRun();
    expect(await makeStop(ACME, r.run).sweep()).toEqual({ warnings: [] });
    expect(r.calls).toEqual([]);
  });
  it('stops only its own slot stacks, by their exact project id, keeping their data', async () => {
    const r = fakeRun(docker({ projects: ['acme-app-w1', 'acme-app-w1', 'acme-app-w3', 'acme-app', 'other-acme-app-w2', 'x_acme-app-w2', 'acme-app-w2x', ''] }));
    expect(await makeStop(ACME, r.run).sweep(STOP)).toEqual({ warnings: [] });
    const stops = r.calls.filter((c) => c.cmd === 'supabase');
    expect(stops.map(said).sort()).toEqual(['supabase stop --project-id acme-app-w1', 'supabase stop --project-id acme-app-w3']);
    for (const c of stops) {
      expect(c.opts.cwd).toBe('/repo');
      expect(c.opts.timeoutMs).toBeGreaterThan(0);
      expect(c.opts.timeoutMs).toBeLessThanOrEqual(60_000);
    }
  });
  it('stops nothing when Docker cannot be reached, as nothing can be running', async () => {
    const r = fakeRun((cmd) => ({ status: cmd === 'docker' ? 1 : 0, stdout: '' }));
    expect(await makeStop(ACME, r.run).sweep(STOP)).toEqual({ warnings: [] });
    expect(r.calls.map(said)).toEqual([PROJECTS]);
  });
  it('warns with the command to run by hand when a stack will not stop', async () => {
    const r = fakeRun(docker({ projects: ['acme-app-w2'], more: { 'supabase stop --project-id acme-app-w2': { status: 1, stdout: '' } } }));
    const { warnings } = await makeStop(ACME, r.run).sweep(STOP);
    expect(warnings).toEqual(['slot 2 stack did not stop; run `supabase stop --project-id acme-app-w2`']);
  });
});

describe('supabase and Colima at a stop, with other Foreman runs on the machine', () => {
  it('stops Colima after the stacks when a Foreman run started it and no other run or container uses it', async () => {
    let ps = 0;
    const r = fakeRun((cmd, args) => {
      if (cmd !== 'docker') return { status: 0, stdout: '' };
      ps += 1;
      return { status: 0, stdout: ps === 1 ? 'acme-app-w1\n' : '' };
    });
    const a = makeStop(COLIMA, r.run, { sh: colimaDown().sh });
    expect(a.repair()).toBe(true);
    expect(await a.sweep(STOP)).toEqual({ warnings: [] });
    expect(r.calls.map(said)).toEqual([PROJECTS, 'supabase stop --project-id acme-app-w1', NAMES, 'colima stop']);
  });
  it('never stops a Colima that was up before any Foreman run', async () => {
    const r = fakeRun(docker());
    const a = makeStop(COLIMA, r.run);
    expect(a.repair()).toBe(true);
    await a.sweep(STOP);
    expect(r.calls.map(said)).not.toContain('colima stop');
  });
  it('leaves Colima up, without a warning, while another live Foreman run uses it', async () => {
    const dir = machine();
    makeStop(COLIMA, fakeRun().run, { machineDir: dir, pid: 202 }).prepare(1, '/wt');
    const r = fakeRun(docker());
    const a = makeStop(COLIMA, r.run, { sh: colimaDown().sh, machineDir: dir, pid: 101, alive: (pid) => pid === 202 });
    a.repair();
    expect(await a.sweep(STOP)).toEqual({ warnings: [] });
    expect(r.calls.map(said)).not.toContain('colima stop');
    expect(existsSync(join(dir, 'colima', 'started'))).toBe(true);
  });
  it('lets the last Foreman run to stop stop the Colima another run started', async () => {
    const dir = machine();
    makeStop(COLIMA, fakeRun().run, { sh: colimaDown().sh, machineDir: dir, pid: 202 }).repair();
    const b = makeStop(COLIMA, fakeRun().run, { machineDir: dir, pid: 101 });
    b.prepare(1, '/wt');
    const r = fakeRun(docker());
    // 202 has stopped (it left Colima for 101); 101 stops now and is the last.
    await makeStop(COLIMA, r.run, { machineDir: dir, pid: 101, alive: () => false }).sweep(STOP);
    expect(r.calls.map(said)).toContain('colima stop');
    expect(existsSync(join(dir, 'colima', 'started'))).toBe(false);
    expect(readdirSync(join(dir, 'colima', 'runs'))).toEqual([]);
  });
  it('forgets runs that died without stopping', async () => {
    const dir = machine();
    makeStop(COLIMA, fakeRun().run, { sh: colimaDown().sh, machineDir: dir, pid: 303 }).repair();
    const r = fakeRun(docker());
    await makeStop(COLIMA, r.run, { machineDir: dir, pid: 101, alive: () => false }).sweep(STOP);
    expect(r.calls.map(said)).toContain('colima stop');
    expect(readdirSync(join(dir, 'colima', 'runs'))).toEqual([]);
  });
  it('leaves Colima running, and says why, when containers outside Foreman still use it', async () => {
    const r = fakeRun(docker({ names: ['redis'] }));
    const a = makeStop(COLIMA, r.run, { sh: colimaDown().sh });
    a.repair();
    const { warnings } = await a.sweep(STOP);
    expect(r.calls.map(said)).not.toContain('colima stop');
    expect(warnings).toEqual(['Colima left running: other containers still use it (redis)']);
  });
  it('warns when Colima will not stop', async () => {
    const r = fakeRun(docker({ more: { 'colima stop': { status: 1, stdout: '' } } }));
    const a = makeStop(COLIMA, r.run, { sh: colimaDown().sh });
    a.repair();
    expect((await a.sweep(STOP)).warnings).toEqual(['Colima did not stop; run `colima stop`']);
  });
  it('keeps what a Foreman run started across a restart on new code (a new process)', async () => {
    const dir = machine();
    makeStop(COLIMA, fakeRun().run, { sh: colimaDown().sh, machineDir: dir, pid: 101 }).repair();
    expect(existsSync(join(dir, 'colima', 'started'))).toBe(true);
    const r = fakeRun(docker());
    await makeStop(COLIMA, r.run, { machineDir: dir, pid: 102 }).sweep(STOP);
    expect(r.calls.map(said)).toContain('colima stop');
  });
  it('writes nothing to the machine folder without the colima option', async () => {
    const dir = machine();
    const a = makeStop(ACME, fakeRun(docker()).run, { machineDir: dir });
    a.prepare(1, '/wt');
    await a.sweep(STOP);
    expect(existsSync(join(dir, 'colima'))).toBe(false);
  });
});

describe('supabase hostedEnv and options', () => {
  it('is the migrate-supabase hostedEnv', () => {
    expect(make().hostedEnv).toBe(hostedEnv);
  });
  it('refuses unknown options', () => {
    expect(() => make({ ...ACME, prefix: 'x' })).toThrow(/prefix/);
  });
  it('requires projectPrefix', () => {
    expect(() => make({ adapter: 'supabase' })).toThrow(/projectPrefix/);
  });
});
