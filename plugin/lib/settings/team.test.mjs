import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teamApply, teamReset, teamSet } from './team.mjs';
import { validate } from '../config/validate.mjs';

let root;
const file = () => join(root, 'foreman.config.json');
const read = () => JSON.parse(readFileSync(file(), 'utf8'));
const write = (raw) => writeFileSync(file(), `${JSON.stringify(raw, null, 2)}\n`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'foreman-team-'));
  write({ version: 1, project: { name: 'x' }, slots: 2, checks: [{ run: 'npm test', when: 'always' }] });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('teamSet', () => {
  it('sets one path and keeps the other keys, their order and 2-space formatting', () => {
    expect(teamSet(root, 'rounds', 5)).toEqual({ errors: [] });
    expect(readFileSync(file(), 'utf8')).toBe(`${JSON.stringify({ version: 1, project: { name: 'x' }, slots: 2, checks: [{ run: 'npm test', when: 'always' }], rounds: 5 }, null, 2)}\n`);
  });

  it('makes the objects on the way to a nested path', () => {
    teamSet(root, 'features.followUps', false);
    teamSet(root, 'watchdog.quietMinutes', 10);
    expect(read()).toMatchObject({ features: { followUps: false }, watchdog: { quietMinutes: 10 } });
  });

  it('starts a block the config replaces as a whole from its defaults, so nothing else changes', () => {
    expect(teamSet(root, 'ship.ci.timeoutMinutes', 45)).toEqual({ errors: [] });
    expect(read().ship).toEqual({ steps: ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'], ci: { required: [], timeoutMinutes: 45 } });
    expect(teamSet(root, 'console.port', 5000)).toEqual({ errors: [] });
    expect(read().console).toEqual({ adapter: 'dashboard', host: '127.0.0.1', port: 5000 });
  });

  it('refuses a change that makes the config invalid, and leaves the file byte for byte', () => {
    const before = readFileSync(file(), 'utf8');
    expect(teamSet(root, 'workers', 3).errors).toEqual(['workers: must not be more than slots (2)']);
    expect(teamSet(root, 'slots', 9).errors).toEqual(['slots: must be an integer from 1 to 8']);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('sets ship.pr.into, keeping the default ship steps, and the file validates', () => {
    expect(teamSet(root, 'ship.pr.into', 'qa')).toEqual({ errors: [] });
    expect(read().ship).toEqual({ steps: ['merge-main', 'resources', 'push', 'pr', 'ci', 'mergeable-recheck', 'merge'], ci: { required: [] }, pr: { into: 'qa' } });
    expect(validate(read())).toEqual([]);
  });

  it('refuses a ship.pr.into that is not a branch name, and leaves the file byte for byte', () => {
    const before = readFileSync(file(), 'utf8');
    expect(teamSet(root, 'ship.pr.into', 'a..b').errors).toEqual(['ship.pr.into: expected a branch name']);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('writes atomically, leaving no temp file behind', () => {
    teamSet(root, 'rounds', 5);
    expect(readdirSync(root)).toEqual(['foreman.config.json']);
  });

  it('says why when there is no config file or it is not JSON', () => {
    rmSync(file());
    expect(teamSet(root, 'rounds', 5).errors).toEqual([expect.stringContaining('no foreman.config.json')]);
    writeFileSync(file(), '{ nope');
    expect(teamSet(root, 'rounds', 5).errors).toEqual([expect.stringContaining('not valid JSON')]);
  });
});

describe('the deprecated top-level keepAwake', () => {
  it('moves to features.keepAwake on any team write', () => {
    write({ version: 1, project: { name: 'x' }, keepAwake: false });
    expect(teamSet(root, 'rounds', 4)).toEqual({ errors: [] });
    expect(read()).toEqual({ version: 1, project: { name: 'x' }, features: { keepAwake: false }, rounds: 4 });
  });

  it('gives way to the value being set', () => {
    write({ version: 1, project: { name: 'x' }, keepAwake: false });
    teamSet(root, 'features.keepAwake', true);
    expect(read()).toEqual({ version: 1, project: { name: 'x' }, features: { keepAwake: true } });
  });

  it('is dropped when features.keepAwake is set already', () => {
    write({ version: 1, project: { name: 'x' }, keepAwake: false, features: { keepAwake: true } });
    teamSet(root, 'rounds', 4);
    expect(read()).toEqual({ version: 1, project: { name: 'x' }, features: { keepAwake: true }, rounds: 4 });
  });

  it('is what a team reset of features.keepAwake removes', () => {
    write({ version: 1, project: { name: 'x' }, keepAwake: false });
    expect(teamReset(root, 'features.keepAwake')).toEqual({ removed: true, errors: [] });
    expect(read()).toEqual({ version: 1, project: { name: 'x' } });
  });
});

describe('teamReset', () => {
  it('removes the path, and any object it leaves empty', () => {
    teamSet(root, 'features.followUps', false);
    expect(teamReset(root, 'features.followUps')).toEqual({ removed: true, errors: [] });
    expect(read()).toEqual({ version: 1, project: { name: 'x' }, slots: 2, checks: [{ run: 'npm test', when: 'always' }] });
  });

  it('keeps the parent when it still holds other keys', () => {
    teamSet(root, 'ship.ci.timeoutMinutes', 45);
    teamReset(root, 'ship.ci.timeoutMinutes');
    expect(read().ship.ci).toEqual({ required: [] });
  });

  it('says so, and writes nothing, when the file does not set it', () => {
    const before = readFileSync(file(), 'utf8');
    expect(teamReset(root, 'rounds')).toEqual({ removed: false, errors: [] });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('refuses when removing it makes the config invalid', () => {
    write({ version: 1, project: { name: 'x' }, workers: 2, slots: 2 });
    expect(teamReset(root, 'slots').errors).toEqual(['workers: must not be more than slots (1)']);
    expect(read().slots).toBe(2);
  });
});

describe('teamApply', () => {
  it('sets two paths and removes one in one write, keeping the key order', () => {
    write({ version: 1, project: { name: 'x' }, slots: 2, rounds: 4, checks: [{ run: 'npm test', when: 'always' }] });
    expect(teamApply(root, [{ name: 'slots', value: 3 }, { name: 'rounds', remove: true }, { name: 'watchdog.quietMinutes', value: 10 }])).toEqual({ errors: [] });
    expect(readFileSync(file(), 'utf8')).toBe(
      `${JSON.stringify({ version: 1, project: { name: 'x' }, slots: 3, checks: [{ run: 'npm test', when: 'always' }], watchdog: { quietMinutes: 10 } }, null, 2)}\n`,
    );
    expect(readdirSync(root)).toEqual(['foreman.config.json']);
  });

  it('writes nothing and returns the errors when the edits make the config invalid', () => {
    const before = readFileSync(file(), 'utf8');
    const r = teamApply(root, [{ name: 'rounds', value: 5 }, { name: 'workers', value: 3 }]);
    expect(r.errors).toEqual(['workers: must not be more than slots (2)']);
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('writes nothing for an empty list', () => {
    writeFileSync(file(), '{"version":1,"project":{"name":"x"}}');
    expect(teamApply(root, [])).toEqual({ errors: [] });
    expect(readFileSync(file(), 'utf8')).toBe('{"version":1,"project":{"name":"x"}}');
  });
});
