import { describe, expect, it } from 'vitest';
import { holdsSecret, scrub, scrubDeep } from './scrub.mjs';

// Token-shaped fixtures are built at run time, so no file holds one whole.
const GHP = `ghp_${'a1B2'.repeat(9)}`;
const ANT = `sk-ant-${'x9Y8'.repeat(5)}`;
const AKIA = `AKIA${'ABCDEFGH23456789'}`;
const ROOT = '/home/acme/proj';
const HOME = '/home/acme';
const opts = { root: ROOT, home: HOME };

describe('scrub', () => {
  it.each([[GHP], [ANT], [AKIA]])('blanks the token %s', (token) => {
    const out = scrub(`before ${token} after`, opts);
    expect(out).toBe('before ••• after');
  });

  it('blanks an env secret value and a file secret value', () => {
    const out = scrub('key AcmeEnvValue42 and AcmeFileValue123 here', { ...opts, env: { ANTHROPIC_API_KEY: 'AcmeEnvValue42' }, values: ['AcmeFileValue123'] });
    expect(out).toBe('key ••• and ••• here');
  });

  it('blanks a literal learning.redact entry and a /regex/ entry', () => {
    const out = scrub('the AcmeInternal host acme-1234 replied', { ...opts, redact: ['AcmeInternal', '/acme-\\d+/'] });
    expect(out).toBe('the ••• host ••• replied');
  });

  it('treats a learning.redact entry that does not compile as literal text', () => {
    let out;
    expect(() => {
      out = scrub('look at /acme[/ and acme[ there', { ...opts, redact: ['/acme[/'] });
    }).not.toThrow();
    expect(out).toBe('look at ••• and acme[ there');
  });

  it('makes an email <email>', () => {
    expect(scrub('ask dev.ops+x@acme-corp.example.com now', opts)).toBe('ask <email> now');
  });

  it('makes a path inside the project relative', () => {
    expect(scrub(`see ${ROOT}/src/a.mjs:12`, opts)).toBe('see src/a.mjs:12');
    expect(scrub(`cd ${ROOT} first`, opts)).toBe('cd . first');
  });

  it('makes the home folder ~, and any other home path too', () => {
    expect(scrub(`${HOME}/.config/acme.json`, opts)).toBe('~/.config/acme.json');
    expect(scrub('/home/other/notes.txt', opts)).toBe('~/notes.txt');
  });

  it('gives the same text when run twice', () => {
    const text = `${GHP} ops@acme.example ${ROOT}/a.mjs ${HOME}/x KEY=abc /home/zed/y AcmeInternal`;
    const o = { ...opts, redact: ['AcmeInternal'] };
    const once = scrub(text, o);
    expect(scrub(once, o)).toBe(once);
  });

  it('scrubDeep scrubs every string in objects and arrays', () => {
    const out = scrubDeep({ a: [`${ROOT}/src/a.mjs`, 3, { b: 'ops@acme.example' }], n: null }, opts);
    expect(out).toEqual({ a: ['src/a.mjs', 3, { b: '<email>' }], n: null });
  });
});

describe('holdsSecret', () => {
  it('finds a token nested in an array', () => {
    expect(holdsSecret({ a: [{ b: ['fine', `x ${GHP}`] }] })).toBe(true);
  });

  it('finds a token in an object key', () => {
    expect(holdsSecret({ nested: { [GHP]: 'value' } })).toBe(true);
  });

  it('is false for plain text', () => {
    expect(holdsSecret({ a: ['Acme routes have tests'], b: 2 })).toBe(false);
  });
});
