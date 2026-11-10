import { describe, expect, it } from 'vitest';
import smoke from './smoke.mjs';
import { runShip } from '../../engine/ship.mjs';
import { fakeCtx } from '../../../../test/ship-fakes.mjs';

const A = 'https://site.example';
const B = 'https://site.example/api/health';

// answers: { url: status | 'down' }
const fakeFetch = (answers) => {
  const seen = [];
  const f = (url, init) => {
    seen.push({ url, init });
    const a = answers[url];
    return a === 'down' || a === undefined ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve({ status: a });
  };
  f.seen = seen;
  return f;
};
const ctxFor = (urls, answers, expect = undefined) => fakeCtx({ config: { ship: { steps: ['smoke'], smoke: { urls, ...(expect ? { expect } : {}) } } }, fetch: fakeFetch(answers) });

describe('smoke step', () => {
  it('needs nothing and halts on failure', () => {
    expect(smoke.name).toBe('smoke');
    expect(smoke.needs).toEqual([]);
    expect(smoke.halts).toBe(true);
  });

  it('passes when every url answers below 500, without following redirects', async () => {
    const ctx = ctxFor([A, B], { [A]: 307, [B]: 200 });
    expect(await smoke.run(ctx)).toEqual({ ok: true, live: [{ url: A, status: 307 }, { url: B, status: 200 }] });
    expect(ctx.fetch.seen.map((s) => s.url)).toEqual([A, B]);
    for (const { init } of ctx.fetch.seen) {
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('a 4xx is the site answering, not the site being down', async () => {
    expect((await smoke.run(ctxFor([A], { [A]: 404 }))).ok).toBe(true);
  });

  it.each([500, 502, 503])('fails with code 5 when any url answers %i', async (status) => {
    const r = await smoke.run(ctxFor([A, B], { [A]: 200, [B]: status }));
    expect(r).toEqual({ ok: false, code: 5, stage: 'smoke', reason: `${B} answered ${status} after the deploy.` });
  });

  it('fails with code 5 when a url does not answer at all', async () => {
    const r = await smoke.run(ctxFor([A, B], { [A]: 'down', [B]: 200 }));
    expect(r).toEqual({ ok: false, code: 5, stage: 'smoke', reason: `${A} answered nothing after the deploy.` });
  });

  it('with no urls passes without fetching', async () => {
    const ctx = ctxFor([], {});
    expect(await smoke.run(ctx)).toEqual({ ok: true, live: [] });
    expect(fakeCtx().config.ship.smoke).toBeUndefined();
    expect(await smoke.run(fakeCtx({ fetch: fakeFetch({}) }))).toEqual({ ok: true, live: [] });
    expect(ctx.fetch.seen).toEqual([]);
  });

  it('in a release, a site that is down exits 5 and writes HALT', async () => {
    const ctx = ctxFor([A], { [A]: 503 });
    const { code } = await runShip({ steps: [smoke], ctx });
    expect(code).toBe(5);
    expect(ctx.halts).toHaveLength(1);
  });
});

describe('smoke healthy', () => {
  it('passes when every url answers below 500, following redirects', async () => {
    const ctx = ctxFor([A, B], { [A]: 200, [B]: 404 });
    expect(await smoke.healthy(ctx)).toEqual({ ok: true, reason: `The live site answers (${A}, ${B}).` });
    for (const { init } of ctx.fetch.seen) expect(init.redirect).toBe('follow');
  });

  it('calls a 5xx or no answer unhealthy, naming the url', async () => {
    expect(await smoke.healthy(ctxFor([A], { [A]: 503 }))).toEqual({ ok: false, reason: `${A} answered 503.` });
    expect(await smoke.healthy(ctxFor([A, B], { [A]: 200, [B]: 'down' }))).toEqual({ ok: false, reason: `${B} did not answer.` });
  });

  it('has nothing to check without urls', async () => {
    expect(await smoke.healthy(ctxFor([], {}))).toBe(null);
  });
});

describe('smoke.expect', () => {
  it('a url with an expected status must answer exactly that', async () => {
    expect(await smoke.run(ctxFor([A, B], { [A]: 200, [B]: 200 }, { [B]: 200 }))).toEqual({ ok: true, live: [{ url: A, status: 200 }, { url: B, status: 200 }] });
    const r = await smoke.run(ctxFor([A, B], { [A]: 200, [B]: 404 }, { [B]: 200 }));
    expect(r).toEqual({ ok: false, code: 5, stage: 'smoke', reason: `${B} answered 404 after the deploy; expected 200.` });
  });

  it('an expected url with no answer fails naming expected and got', async () => {
    const r = await smoke.run(ctxFor([B], { [B]: 'down' }, { [B]: 200 }));
    expect(r).toMatchObject({ ok: false, code: 5 });
    expect(r.reason).toContain('expected 200');
  });

  it('an exact status below 500 that is not 2xx can be expected', async () => {
    expect((await smoke.run(ctxFor([A], { [A]: 307 }, { [A]: 307 }))).ok).toBe(true);
    expect((await smoke.run(ctxFor([A], { [A]: 200 }, { [A]: 307 }))).ok).toBe(false);
  });

  it('urls without an expected status keep the below-500 rule', async () => {
    expect((await smoke.run(ctxFor([A, B], { [A]: 404, [B]: 200 }, { [B]: 200 }))).ok).toBe(true);
    expect((await smoke.run(ctxFor([A, B], { [A]: 503, [B]: 200 }, { [B]: 200 }))).ok).toBe(false);
  });

  it('healthy applies the same rule', async () => {
    expect((await smoke.healthy(ctxFor([A, B], { [A]: 200, [B]: 200 }, { [B]: 200 }))).ok).toBe(true);
    expect(await smoke.healthy(ctxFor([A, B], { [A]: 200, [B]: 404 }, { [B]: 200 }))).toEqual({ ok: false, reason: `${B} answered 404; expected 200.` });
  });
});
