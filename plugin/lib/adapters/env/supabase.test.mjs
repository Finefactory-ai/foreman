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
const make = (options = ACME, sh = fakeSh().sh) => create(options, { root: '/repo', config: { slots: 3 }, sh });

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
