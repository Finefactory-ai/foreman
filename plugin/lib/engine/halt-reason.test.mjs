import { describe, expect, it } from 'vitest';
import { haltReason, reasonOf, shipLineBody } from './halt-reason.mjs';

const R = 'qa (acme-qa) was rolled back with `foreman sf rollback "$FOREMAN_STORY"`. ./watch.sh reported a problem after the deploy: 3 new errors';
const STAMP = '2026-11-10T11:27:00.000Z';
const STATE = {
  sfDelta: { dir: '/tmp/acme-delta', from: 'a'.repeat(40), to: 'b'.repeat(40), components: Array.from({ length: 12 }, (_, i) => `classes/AcmeService${i}.cls`) },
  stage: 'watch',
  reason: R,
  rolledBack: true,
  pr: 'https://github.com/acme/acme/pull/5',
};

describe('haltReason', () => {
  it('keeps a plain-text HALT, trimmed', () => {
    expect(haltReason('A release failed.\n')).toBe('A release failed.');
  });

  it('gives the reason of a ship JSON line with an ISO stamp and facts first, with no brace', () => {
    const raw = `${STAMP} ${JSON.stringify(STATE)}\n`;
    expect(raw.length).toBeGreaterThan(300);
    const got = haltReason(raw);
    expect(got).toBe(R);
    expect(got).not.toContain('{');
  });

  it('reads a JSON line without a stamp', () => {
    expect(haltReason(JSON.stringify(STATE))).toBe(R);
  });

  it('reduces an object reason to its reason field', () => {
    expect(haltReason(JSON.stringify({ stage: 'watch', reason: { reason: 'inner' } }))).toBe('inner');
  });

  it('falls back to the stage when the reason is not text', () => {
    expect(haltReason(JSON.stringify({ stage: 'watch', reason: 42 }))).toBe('The release failed at watch.');
    expect(haltReason(JSON.stringify({ stage: 'watch', reason: {} }))).toBe('The release failed at watch.');
    expect(haltReason(JSON.stringify({ step: 'deploy' }))).toBe('The release failed at deploy.');
    expect(haltReason(JSON.stringify({ reason: 42 }))).toBe('A release failed.');
  });

  it('takes the reason out of a cut JSON line', () => {
    const cut = `${STAMP} {"sfDelta":{"dir":"/tmp/acme-delta"},"stage":"watch","reason":"x \\"y\\"","rolledBack":tr`;
    expect(haltReason(cut)).toBe('x "y"');
  });

  it('says a release failed for a cut line with no reason, and never shows the object', () => {
    const got = haltReason(`${STAMP} {"sfDelta":{"dir":"/tmp/acme-delta","from":"aaaa`);
    expect(got).toBe('A release failed.');
    expect(got).not.toContain('{');
  });

  it('says a release failed for nothing', () => {
    expect(haltReason('')).toBe('A release failed.');
    expect(haltReason(undefined)).toBe('A release failed.');
    expect(haltReason(null)).toBe('A release failed.');
    expect(haltReason(`${STAMP} \n`)).toBe('A release failed.');
  });

  it('never throws', () => {
    expect(() => haltReason({ toString: () => { throw new Error('no'); } })).not.toThrow();
  });
});

describe('reasonOf', () => {
  it('trims text', () => {
    expect(reasonOf('  it broke \n', 'watch')).toBe('it broke');
  });

  it('reduces an object to its reason', () => {
    expect(reasonOf({ reason: ' inner ' }, 'watch')).toBe('inner');
  });

  it('falls back to the stage', () => {
    expect(reasonOf(42, 'watch')).toBe('The release failed at watch.');
    expect(reasonOf({}, 'watch')).toBe('The release failed at watch.');
    expect(reasonOf({ reason: '' }, 'watch')).toBe('The release failed at watch.');
    expect(reasonOf(['x'], 'watch')).toBe('The release failed at watch.');
    expect(reasonOf('   ', 'watch')).toBe('The release failed at watch.');
  });

  it('says a release failed when there is no stage', () => {
    expect(reasonOf(42)).toBe('A release failed.');
    expect(reasonOf({}, '')).toBe('A release failed.');
  });
});

describe('shipLineBody', () => {
  it('gives the reason and the pull request for a ship JSON line', () => {
    expect(shipLineBody(JSON.stringify({ ok: false, code: 5, ...STATE }))).toBe(`${R}\n\nPull request: https://github.com/acme/acme/pull/5`);
  });

  it('gives only the reason when there is no pull request', () => {
    const { pr, ...rest } = STATE;
    expect(shipLineBody(JSON.stringify(rest))).toBe(R);
  });

  it('leaves anything else as given', () => {
    expect(shipLineBody('Plain words about the stop.')).toBeNull();
    expect(shipLineBody('[1]')).toBeNull();
    expect(shipLineBody('{"a":1}')).toBeNull();
    expect(shipLineBody('')).toBeNull();
    expect(shipLineBody('{"stage":')).toBeNull();
  });
});
