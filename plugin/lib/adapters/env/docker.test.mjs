import { describe, expect, it } from 'vitest';
import { envAdapterContract } from './contract.mjs';
import { create } from './docker.mjs';

const fakeSh = (answer = () => ({ status: 0, stdout: '' })) => {
  const calls = [];
  const sh = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, opts });
    return answer(cmd, args, opts, calls);
  };
  return { sh, calls };
};
const said = (call) => [call.cmd, ...call.args].join(' ');
const OPTS = { adapter: 'docker', projectPrefix: 'app', ports: { WEB_PORT: 8000, DB_PORT: 5432 } };
const make = (options = OPTS, sh = fakeSh().sh) => create(options, { root: '/repo', config: { slots: 3 }, sh });

envAdapterContract({ name: 'docker', make: () => make() });

describe('docker env(n)', () => {
  it('names the slot and project and shifts ports by 100 per slot', () => {
    expect(make().env(2)).toEqual({ FOREMAN_SLOT: 'w2', COMPOSE_PROJECT_NAME: 'app-w2', WEB_PORT: '8200', DB_PORT: '5632' });
  });
  it('works without ports', () => {
    expect(make({ projectPrefix: 'a' }).env(1)).toEqual({ FOREMAN_SLOT: 'w1', COMPOSE_PROJECT_NAME: 'a-w1' });
  });
});

describe('docker prepare', () => {
  const run = (answer, options = OPTS) => {
    const f = fakeSh(answer);
    return { result: make(options, f.sh).prepare(1, '/wt'), calls: f.calls };
  };
  it('is up when compose up succeeds', () => {
    const { result, calls } = run();
    expect(result).toBe('up');
    expect(calls.map(said)).toEqual(['docker compose -f compose.yaml -p app-w1 up -d --wait']);
  });
  it('resets with down then up when the first up fails', () => {
    let ups = 0;
    const { result, calls } = run((c, args) => ({ status: args.includes('up') && ++ups === 1 ? 1 : 0, stdout: '' }));
    expect(result).toBe('reset');
    expect(calls.map(said)).toEqual([
      'docker compose -f compose.yaml -p app-w1 up -d --wait',
      'docker compose -f compose.yaml -p app-w1 down',
      'docker compose -f compose.yaml -p app-w1 up -d --wait',
    ]);
  });
  it('is down when the second up fails too', () => {
    expect(run(() => ({ status: 1, stdout: '' })).result).toBe('down');
  });
  it('takes the project down again when the second up fails, so nothing is left holding ports', () => {
    const { calls } = run(() => ({ status: 1, stdout: '' }));
    expect(calls.map((c) => c.args.at(-1))).toEqual(['--wait', 'down', '--wait', 'down']);
  });
  it('uses the configured compose file, folder and slot env', () => {
    const { calls } = run(() => ({ status: 1, stdout: '' }), { ...OPTS, composeFile: 'dev/c.yml' });
    expect(calls.length).toBe(4);
    for (const c of calls) {
      expect(c.args.slice(0, 4)).toEqual(['compose', '-f', 'dev/c.yml', '-p']);
      expect(c.opts.cwd).toBe('/wt');
      expect(c.opts.env.WEB_PORT).toBe('8100');
      expect(c.opts.env.COMPOSE_PROJECT_NAME).toBe('app-w1');
      expect(c.opts.env.PATH).toBe(process.env.PATH);
    }
  });
});

describe('docker sweep at a stop', () => {
  const fakeRun = (answer) => {
    const calls = [];
    const run = async (cmd, args, opts = {}) => {
      calls.push({ cmd, args, opts });
      return { stderr: '', timedOut: false, ...answer(cmd, args) };
    };
    return { run, calls };
  };
  const makeStop = (run) => create(OPTS, { root: '/repo', config: { slots: 3 }, sh: fakeSh().sh, run });
  const STOP = { stopping: true, limitMs: 60_000 };
  const PS = 'docker ps --format {{.Label "com.docker.compose.project"}}';

  it('does nothing on the sweep while the run goes on', async () => {
    const r = fakeRun(() => ({ status: 0, stdout: '' }));
    expect(await makeStop(r.run).sweep()).toEqual({ warnings: [] });
    expect(r.calls).toEqual([]);
  });
  it("stops each slot's running compose project, keeping its containers, and nothing else", async () => {
    const r = fakeRun((cmd, args) => ({ status: 0, stdout: args[0] === 'ps' ? 'app-w1\napp-w1\napp-w3\napp\nother\n\n' : '' }));
    expect(await makeStop(r.run).sweep(STOP)).toEqual({ warnings: [] });
    const stops = r.calls.slice(1);
    expect(r.calls[0] && said(r.calls[0])).toBe(PS);
    expect(stops.map(said).sort()).toEqual(['docker compose -p app-w1 stop', 'docker compose -p app-w3 stop']);
    for (const c of stops) expect(c.opts.cwd).toBe('/repo');
  });
  it('stops nothing when Docker cannot be reached', async () => {
    const r = fakeRun(() => ({ status: 1, stdout: '' }));
    expect(await makeStop(r.run).sweep(STOP)).toEqual({ warnings: [] });
    expect(r.calls.length).toBe(1);
  });
  it('warns with the command to run by hand when a project will not stop', async () => {
    const r = fakeRun((cmd, args) => (args[0] === 'ps' ? { status: 0, stdout: 'app-w2\n' } : { status: 1, stdout: '' }));
    expect((await makeStop(r.run).sweep(STOP)).warnings).toEqual(['slot 2 containers did not stop; run `docker compose -p app-w2 stop`']);
  });
});

describe('docker options', () => {
  it('has no repair or hostedEnv', () => {
    const a = make();
    expect(a.repair).toBeUndefined();
    expect(a.hostedEnv).toBeUndefined();
  });
  it('refuses unknown options', () => {
    expect(() => make({ ...OPTS, port: {} })).toThrow(/port/);
  });
  it('requires projectPrefix', () => {
    expect(() => make({ adapter: 'docker' })).toThrow(/projectPrefix/);
  });
  it('refuses a non-integer port base', () => {
    expect(() => make({ ...OPTS, ports: { WEB_PORT: '8000' } })).toThrow(/WEB_PORT/);
  });
});
