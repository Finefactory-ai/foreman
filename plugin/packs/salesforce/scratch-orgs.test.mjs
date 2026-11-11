import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALIAS } from './config.mjs';
import { claimedStories, readScratchOrgs, removeScratchOrg, scratchAlias, scratchFile, storiesInSlots, writeScratchOrg } from './scratch-orgs.mjs';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-scratch-orgs-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const record = (over = {}) => ({
  story: 'ACME-1',
  slot: 'w1',
  alias: 'foreman-acme-1',
  devHub: 'acme-hub',
  state: 'ready',
  jobId: '2SR000000000001AAA',
  username: 'test-abc@example.com',
  orgId: '00D000000000101AAA',
  createdAt: '2026-10-25T10:00:00.000Z',
  readyAt: '2026-10-25T10:05:00.000Z',
  ...over,
});

describe('scratchAlias', () => {
  it('is foreman-<story id, lower case>, and a valid alias', () => {
    expect(scratchAlias('ACME-1')).toBe('foreman-acme-1');
    expect(ALIAS.test(scratchAlias('ACME-1'))).toBe(true);
    expect(scratchAlias('ACME/../9')).toBe('foreman-acme_.._9');
    expect(ALIAS.test(scratchAlias('ACME/../9'))).toBe(true);
  });
});

describe('scratchFile', () => {
  it('is under salesforce/scratch, named by the safe story id', () => {
    expect(scratchFile('/state', 'ACME-1')).toBe(path.join('/state', 'salesforce', 'scratch', 'ACME-1.json'));
    expect(scratchFile('/state', 'A/B')).toBe(path.join('/state', 'salesforce', 'scratch', 'A_B.json'));
  });
});

describe('readScratchOrgs', () => {
  it('is empty for no state folder or a missing one', () => {
    expect(readScratchOrgs(undefined)).toEqual([]);
    expect(readScratchOrgs('')).toEqual([]);
    expect(readScratchOrgs(path.join(dir, 'nothing'))).toEqual([]);
  });
  it('skips a file it cannot parse, and one that is not a record', () => {
    writeScratchOrg(dir, record());
    const folder = path.join(dir, 'salesforce', 'scratch');
    fs.writeFileSync(path.join(folder, 'BAD.json'), '{ not json');
    fs.writeFileSync(path.join(folder, 'ARRAY.json'), '[1]');
    fs.writeFileSync(path.join(folder, 'NOSTORY.json'), JSON.stringify({ alias: 'foreman-x' }));
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
    expect(readScratchOrgs(dir)).toEqual([record()]);
  });
});

describe('writeScratchOrg and removeScratchOrg', () => {
  it('round-trip', () => {
    writeScratchOrg(dir, record());
    writeScratchOrg(dir, record({ story: 'ACME-2', alias: 'foreman-acme-2', state: 'creating', orgId: null, username: null }));
    expect(JSON.parse(fs.readFileSync(scratchFile(dir, 'ACME-1'), 'utf8'))).toEqual(record());
    expect(readScratchOrgs(dir).map((r) => r.story).sort()).toEqual(['ACME-1', 'ACME-2']);
    removeScratchOrg(dir, 'ACME-1');
    expect(readScratchOrgs(dir).map((r) => r.story)).toEqual(['ACME-2']);
    removeScratchOrg(dir, 'ACME-1');
    expect(fs.readdirSync(path.join(dir, 'salesforce', 'scratch')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('storiesInSlots', () => {
  it('reads story.id and heldStory from every slot file', () => {
    const slots = path.join(dir, 'slots');
    fs.mkdirSync(slots, { recursive: true });
    fs.writeFileSync(path.join(slots, 'w1.json'), JSON.stringify({ state: 'building', story: { id: 'ACME-1' } }));
    fs.writeFileSync(path.join(slots, 'w2.json'), JSON.stringify({ state: 'held', heldStory: 'ACME-2', story: { id: 'ACME-3' } }));
    fs.writeFileSync(path.join(slots, 'w3.json'), JSON.stringify({ state: 'idle', story: null }));
    fs.writeFileSync(path.join(slots, 'w4.json'), '{ broken');
    fs.writeFileSync(path.join(slots, 'other.json'), JSON.stringify({ story: { id: 'ACME-9' } }));
    expect([...storiesInSlots(dir)].sort()).toEqual(['ACME-1', 'ACME-2', 'ACME-3']);
  });
  it('is empty with no slots folder', () => {
    expect(storiesInSlots(dir).size).toBe(0);
    expect(storiesInSlots(undefined).size).toBe(0);
  });
});

describe('claimedStories', () => {
  it('lists every claims/*.json name, whoever holds it and whether or not it parses', () => {
    const claims = path.join(dir, 'claims');
    fs.mkdirSync(claims, { recursive: true });
    fs.writeFileSync(path.join(claims, 'ACME-1.json'), JSON.stringify({ holder: 'factory', pid: 1 }));
    fs.writeFileSync(path.join(claims, 'ACME-2.json'), JSON.stringify({ holder: 'owner' }));
    fs.writeFileSync(path.join(claims, 'ACME-3.json'), '{ broken');
    fs.writeFileSync(path.join(claims, 'ACME-4.txt'), 'not a claim');
    fs.writeFileSync(path.join(claims, 'ACME-5.json.tmp'), 'not a claim');
    expect([...claimedStories(dir)].sort()).toEqual(['ACME-1', 'ACME-2', 'ACME-3']);
  });
  it('is empty with no claims folder, or when the state folder is not text', () => {
    expect(claimedStories(dir).size).toBe(0);
    expect(claimedStories(undefined).size).toBe(0);
    expect(claimedStories(42).size).toBe(0);
    expect(claimedStories('').size).toBe(0);
  });
  it('is empty when claims is a file, not a folder', () => {
    fs.writeFileSync(path.join(dir, 'claims'), 'x');
    expect(claimedStories(dir).size).toBe(0);
  });
});
