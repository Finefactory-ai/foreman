import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consoleContract } from './contract.mjs';
import { create } from './files.mjs';
import { pause } from '../../console/control.mjs';
import { answer } from '../../console/decisions.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-console-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const now = () => new Date('2026-10-15T09:08:07Z');
const make = () => create({ adapter: 'files' }, { stateDir: dir, now });

consoleContract({ name: 'files', make });

describe('files console', () => {
  it('publish writes status.json, atomically', async () => {
    await make().publish({ loop: { state: 'paused' }, slots: [] });
    expect(JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8'))).toEqual({ loop: { state: 'paused' }, slots: [] });
    expect(readdirSync(dir)).toEqual(['status.json']);
  });

  it('controls read control.json, as the CLI wrote it', async () => {
    pause(dir, now());
    expect(await make().controls()).toEqual({ paused: true });
  });

  it('decisions live in the decisions folder, answered through the one module', async () => {
    const con = make();
    const id = await con.decisions.add({ story: 'S-1', kind: 'decision', title: 'Pick one', options: ['A', 'B'] });
    expect(readdirSync(join(dir, 'decisions'))).toEqual([`${id}.json`]);
    answer(dir, id, { option: 'B' }, now());
    expect((await con.decisions.pending())[0].answer).toMatchObject({ option: 'B' });
  });

  it('refuses unknown options and a missing state folder', () => {
    expect(() => create({ adapter: 'files', port: 1 }, { stateDir: dir })).toThrow(/port/);
    expect(() => create({ adapter: 'files' }, {})).toThrow(/stateDir/);
  });
});
