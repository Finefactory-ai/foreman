// The story claims, the schema token and the file reservations, called directly.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storyClaims } from './story-claims.mjs';
import { claimFile, ownerClaim, SCHEMA } from './locks.mjs';

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(stories = () => ({ list: () => [], idPattern: /^ACME-\d+$/ })) {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-story-claims-'));
  made.push(dir);
  mkdirSync(join(dir, 'claims'), { recursive: true });
  const me = process.pid;
  const events = [];
  const claims = storyClaims({
    dir,
    config: { slots: 2 },
    own: new Set([me]),
    me,
    skipped: new Set(),
    stories,
    event: (...args) => events.push(args),
    now: () => new Date('2026-01-01T10:00:00Z'),
  });
  return { dir, me, events, ...claims };
}

describe('claim and releaseClaim', () => {
  it('takes a claim for the slot and lets it go', () => {
    const { dir, me, claim, releaseClaim } = setup();
    expect(claim('w1', 'ACME-1')).toBe(true);
    const held = JSON.parse(readFileSync(claimFile(dir, 'ACME-1'), 'utf8'));
    expect(held).toMatchObject({ pid: me, slot: 'w1', story: 'ACME-1', by: 'factory' });
    releaseClaim('ACME-1');
    expect(existsSync(claimFile(dir, 'ACME-1'))).toBe(false);
  });

  it('refuses a story the owner holds and leaves the owner claim alone', () => {
    const { dir, claim } = setup();
    ownerClaim(dir, 'ACME-2');
    expect(claim('w1', 'ACME-2')).toBe(false);
    expect(JSON.parse(readFileSync(claimFile(dir, 'ACME-2'), 'utf8')).by).toBe('owner');
  });
});

describe('the schema token', () => {
  it('is taken for a slot and let go with it', () => {
    const { dir, takeTokenFor, releaseToken, schemaFree } = setup();
    expect(schemaFree()).toBe(true);
    expect(takeTokenFor('w1', 'ACME-1')).toBe(true);
    expect(existsSync(SCHEMA(dir))).toBe(true);
    expect(schemaFree()).toBe(false);
    releaseToken('w1');
    expect(existsSync(SCHEMA(dir))).toBe(false);
  });

  it('is refused to a slot while another slot holds it fresh, and the holder stays', () => {
    const { dir, takeTokenFor } = setup();
    expect(takeTokenFor('w2', 'ACME-2')).toBe(true);
    expect(takeTokenFor('w1', 'ACME-3')).toBe(false);
    expect(JSON.parse(readFileSync(SCHEMA(dir), 'utf8'))).toMatchObject({ slot: 'w2', story: 'ACME-2' });
  });
});

describe('fileWaiters', () => {
  it('is empty when the stories cannot be read', () => {
    const { fileWaiters } = setup(() => {
      throw new Error('no source');
    });
    expect(fileWaiters()).toEqual([]);
  });
});
