import { describe, expect, it } from 'vitest';
import { preparePackSessions } from './pack-session.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

const SESSION = { env: { ACME_HOME: '/srv/acme' }, pathPrefix: ['/srv/acme/bin'], settings: { enabledPlugins: { 'acme@acme': false } } };

const hook = (answer) => {
  const fn = (arg) => {
    fn.calls.push(arg);
    return typeof answer === 'function' ? answer(arg) : answer;
  };
  fn.calls = [];
  return fn;
};

const fakeFs = { fake: 'fs' };
const fakeSh = () => ({ status: 0, stdout: '', stderr: '' });

describe('preparePackSessions', () => {
  it('gives no session without a pack, and calls no hook', () => {
    const prepareSessions = hook({ ok: true, session: SESSION });
    const packs = { acme: fakePack({ prepareSessions }) };
    expect(preparePackSessions({ config: { version: 1 }, env: {}, packs })).toEqual({ ok: true, session: null });
    expect(prepareSessions.calls).toEqual([]);
  });
  it('gives no session for a pack without the hook', () => {
    expect(preparePackSessions({ config: { pack: 'acme' }, env: {}, packs: { acme: fakePack() } })).toEqual({ ok: true, session: null });
  });
  it("passes the hook its arguments and returns the hook's session", () => {
    const prepareSessions = hook({ ok: true, session: SESSION });
    const config = { pack: 'acme', acme: { region: 'eu' } };
    const env = { PATH: '/bin' };
    const r = preparePackSessions({ config, env, packs: { acme: fakePack({ prepareSessions }) }, fs: fakeFs, sh: fakeSh, homedir: '/home/acme' });
    expect(r).toEqual({ ok: true, session: SESSION });
    expect(prepareSessions.calls).toEqual([{ config, env, fs: fakeFs, sh: fakeSh, homedir: '/home/acme' }]);
  });
  it('passes a null session through', () => {
    const packs = { acme: fakePack({ prepareSessions: hook({ ok: true, session: null }) }) };
    expect(preparePackSessions({ config: { pack: 'acme' }, env: {}, packs })).toEqual({ ok: true, session: null });
  });
  it('turns a throw into a refusal naming the pack', () => {
    const packs = { acme: fakePack({ prepareSessions: hook(() => { throw new Error('no sf here'); }) }) };
    expect(preparePackSessions({ config: { pack: 'acme' }, env: {}, packs })).toEqual({ ok: false, reason: 'pack acme: no sf here' });
  });
  it("passes a hook's refusal through", () => {
    const packs = { acme: fakePack({ prepareSessions: hook({ ok: false, reason: 'the home holds acme-prod' }) }) };
    expect(preparePackSessions({ config: { pack: 'acme' }, env: {}, packs })).toEqual({ ok: false, reason: 'the home holds acme-prod' });
  });
  it('refuses an unknown pack, and a hook that gives no verdict', () => {
    const r = preparePackSessions({ config: { pack: 'nope' }, env: {}, packs: { acme: fakePack() } });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^pack nope: /);
    for (const answer of [undefined, 'yes', Promise.resolve({ ok: true, session: null })]) {
      const packs = { acme: fakePack({ prepareSessions: hook(answer) }) };
      expect(preparePackSessions({ config: { pack: 'acme' }, env: {}, packs }).ok).toBe(false);
    }
  });
  it('refuses, rather than weakens, a session with a non-string env value, a relative path entry or settings that are not a plain object', () => {
    const bad = [
      [{ ...SESSION, env: { ACME_HOME: '/srv/acme', N: 3 } }, 'env.N is not a string'],
      [{ ...SESSION, env: { U: undefined } }, 'env.U is not a string'],
      [{ ...SESSION, pathPrefix: ['/srv/acme/bin', '~/acme/bin'] }, 'pathPrefix entry ~/acme/bin is not an absolute path'],
      [{ ...SESSION, pathPrefix: [7] }, 'pathPrefix entry 7 is not an absolute path'],
      [{ ...SESSION, pathPrefix: '/srv/acme/bin' }, 'pathPrefix is not a list'],
      [{ ...SESSION, env: ['x'] }, 'env is not an object'],
      [{ ...SESSION, settings: ['x'] }, 'settings is not a plain object'],
      ['yes', 'the session is not an object'],
    ];
    for (const [session, why] of bad) {
      const packs = { acme: fakePack({ prepareSessions: hook({ ok: true, session }) }) };
      expect(preparePackSessions({ config: { pack: 'acme' }, env: {}, packs }), why).toEqual({ ok: false, reason: `pack acme: prepareSessions gave a session Foreman cannot use: ${why}` });
    }
  });
  it('fills in the parts a session leaves out', () => {
    const packs = { acme: fakePack({ prepareSessions: hook({ ok: true, session: { env: { ACME_HOME: '/srv/acme' } } }) }) };
    expect(preparePackSessions({ config: { pack: 'acme' }, env: {}, packs })).toEqual({
      ok: true,
      session: { env: { ACME_HOME: '/srv/acme' }, pathPrefix: [], settings: {} },
    });
  });
});
