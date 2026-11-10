import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../main.mjs';
import { adoptLegacySchemaLock, RESOURCE } from '../../engine/locks.mjs';
import { FILE_LOCK, RESERVE, WAIT } from '../../engine/file-locks.mjs';

let dir;
const DEAD = 999999;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-lock-'));
  fs.writeFileSync(
    path.join(dir, 'foreman.config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'T' },
      checks: [{ run: 'npm test', when: 'always' }],
      resources: { schema: { paths: ['db/**'], describe: 'database schema' } },
    }),
  );
});

async function run(argv, env = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir, FOREMAN_SUPERVISOR_PID: String(process.pid), ...env },
    now: () => new Date(2026, 9, 15, 12, 0, 0),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}
const file = () => RESOURCE(path.join(dir, '.foreman'), 'schema');

describe('RESOURCE and adoptLegacySchemaLock', () => {
  it('RESOURCE is a pure path, and the schema token keeps the old factory\'s locks/schema.json', () => {
    expect(RESOURCE('/s', 'db')).toBe(path.join('/s', 'locks', 'resource-db.json'));
    // So the old scripts read a token Foreman took, and the other way round (rollback).
    expect(RESOURCE('/s', 'schema')).toBe(path.join('/s', 'locks', 'schema.json'));
  });

  it('moves an earlier Foreman run\'s resource-schema.json back to schema.json, once, never overwriting', () => {
    const s = path.join(dir, 'state');
    fs.mkdirSync(path.join(s, 'locks'), { recursive: true });
    const earlier = path.join(s, 'locks', 'resource-schema.json');
    fs.writeFileSync(earlier, '{"pid":1}');
    expect(adoptLegacySchemaLock(s)).toBe(true);
    expect(fs.existsSync(earlier)).toBe(false);
    expect(JSON.parse(fs.readFileSync(RESOURCE(s, 'schema'), 'utf8')).pid).toBe(1);
    expect(adoptLegacySchemaLock(s)).toBe(false);
    fs.writeFileSync(earlier, '{"pid":2}');
    expect(adoptLegacySchemaLock(s)).toBe(false);
    expect(JSON.parse(fs.readFileSync(RESOURCE(s, 'schema'), 'utf8')).pid).toBe(1);
  });
});

describe('foreman lock', () => {
  it('take then held for the same slot', async () => {
    expect(await run(['lock', 'take', 'schema', 'S-1'], { FOREMAN_SLOT: 'w1' })).toMatchObject({ code: 0 });
    expect(await run(['lock', 'take', 'schema', 'S-1'], { FOREMAN_SLOT: 'w1' })).toMatchObject({ code: 0 });
    expect(await run(['lock', 'held', 'schema'], { FOREMAN_SLOT: 'w1' })).toMatchObject({ code: 0, out: '', err: '' });
  });

  it('held is 0 only for the holding slot', async () => {
    await run(['lock', 'take', 'schema', 'S-1'], { FOREMAN_SLOT: 'w2' });
    expect((await run(['lock', 'held', 'schema'], { FOREMAN_SLOT: 'w2' })).code).toBe(0);
    const other = await run(['lock', 'held', 'schema'], { FOREMAN_SLOT: 'w1' });
    expect(other.code).toBe(1);
    expect(other.err.trim().split('\n')).toHaveLength(1);
    expect((await run(['lock', 'held', 'schema'])).code).toBe(1); // default slot w1
  });

  it('two slots cannot both take one resource', async () => {
    await run(['lock', 'take', 'schema', 'S-1'], { FOREMAN_SLOT: 'w1' });
    const r = await run(['lock', 'take', 'schema', 'S-2'], { FOREMAN_SLOT: 'w2' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('w1');
    expect(r.err).toContain('S-1');
  });

  it('takes over a stale holder', async () => {
    await run(['lock', 'take', 'schema', 'S-1'], { FOREMAN_SLOT: 'w1', FOREMAN_SUPERVISOR_PID: String(DEAD) });
    expect((await run(['lock', 'take', 'schema', 'S-2'], { FOREMAN_SLOT: 'w2' })).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toMatchObject({ slot: 'w2', story: 'S-2' });
  });

  it('sees an existing locks/schema.json as the holder of resource schema', async () => {
    fs.mkdirSync(path.join(dir, '.foreman', 'locks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.foreman', 'locks', 'schema.json'), JSON.stringify({ pid: process.pid, slot: 'w3', story: 'P1-01', by: 'factory', at: 'x' }));
    expect((await run(['lock', 'held', 'schema'], { FOREMAN_SLOT: 'w3' })).code).toBe(0);
    expect((await run(['lock', 'held', 'schema'], { FOREMAN_SLOT: 'w1' })).code).toBe(1);
  });

  it('release frees a resource this slot holds', async () => {
    await run(['lock', 'take', 'schema', 'S-1'], { FOREMAN_SLOT: 'w2' });
    expect(await run(['lock', 'release', 'schema'], { FOREMAN_SLOT: 'w2' })).toMatchObject({ code: 0 });
    expect(fs.existsSync(file())).toBe(false);
    expect((await run(['lock', 'take', 'schema', 'S-2'], { FOREMAN_SLOT: 'w1' })).code).toBe(0);
  });

  it('release never frees another slot\'s lock, and exits 0 when this slot holds nothing', async () => {
    await run(['lock', 'take', 'schema', 'S-1'], { FOREMAN_SLOT: 'w1' });
    const r = await run(['lock', 'release', 'schema'], { FOREMAN_SLOT: 'w2' });
    expect(r.code).toBe(0);
    expect(r.err).toContain('w1');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toMatchObject({ slot: 'w1', story: 'S-1' });
    fs.rmSync(file());
    expect((await run(['lock', 'release', 'schema'], { FOREMAN_SLOT: 'w2' })).code).toBe(0);
  });

  it('release needs a name', async () => {
    expect((await run(['lock', 'release'])).code).toBe(1);
  });

  it('rejects a resource that is not in the config', async () => {
    for (const sub of [['held', 'x'], ['take', 'x', 'S-1'], ['release', 'x']]) {
      const r = await run(['lock', ...sub]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('no resource named x');
    }
  });

  it('owner-claim writes an owner claim', async () => {
    expect((await run(['lock', 'owner-claim', 'S-1'])).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.foreman', 'claims', 'S-1.json'), 'utf8'))).toMatchObject({ by: 'owner', pid: null, story: 'S-1' });
  });

  it('exits 1 with errors on an invalid config', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{}');
    const r = await run(['lock', 'held', 'schema']);
    expect(r.code).toBe(1);
    expect(r.err).not.toBe('');
  });
});

describe('foreman lock files', () => {
  const state = () => path.join(dir, '.foreman');
  const plan = (files, name = 'plan.json') => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ ready: true, builder: 'developer', files }));
    return name;
  };
  const lastJson = (out) => JSON.parse(out.trim().split('\n').pop());

  it('claims the plan\'s files, leaving out the ignored ones, and prints them as JSON', async () => {
    const r = await run(['lock', 'files', 'ACME-1', '--plan', plan(['src/a.mjs', 'CHANGELOG.md', `${dir}/src/a.mjs`, '../x'])], { FOREMAN_SLOT: 'w1' });
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toHaveLength(1);
    expect(lastJson(r.out)).toEqual({ ok: true, files: ['src/a.mjs'], ignored: ['CHANGELOG.md'], dropped: ['../x'] });
    expect(JSON.parse(fs.readFileSync(FILE_LOCK(state(), 'src/a.mjs'), 'utf8'))).toMatchObject({ pid: process.pid, slot: 'w1', story: 'ACME-1', by: 'factory', path: 'src/a.mjs' });
  });

  it('exits 7 with the holder named when another slot holds a file, writes a wait, and clears it once the file is free', async () => {
    expect((await run(['lock', 'files', 'ACME-1', '--plan', plan(['src/a.mjs'])], { FOREMAN_SLOT: 'w1' })).code).toBe(0);
    const p = plan(['src/a.mjs', 'src/b.mjs'], 'plan-2.json');
    const r = await run(['lock', 'files', 'ACME-2', '--plan', p], { FOREMAN_SLOT: 'w2' });
    expect(r.code).toBe(7);
    const answer = lastJson(r.out);
    expect(answer.ok).toBe(false);
    expect(answer.heldBy).toEqual([{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }]);
    expect(answer.reason).toContain('ACME-1');
    expect(answer.reason).toContain('src/a.mjs');
    expect(fs.existsSync(WAIT(state(), 'ACME-2'))).toBe(true);
    // The second slot took nothing.
    expect(fs.existsSync(FILE_LOCK(state(), 'src/b.mjs'))).toBe(false);

    fs.rmSync(FILE_LOCK(state(), 'src/a.mjs'));
    const again = await run(['lock', 'files', 'ACME-2', '--plan', p], { FOREMAN_SLOT: 'w2' });
    expect(again.code).toBe(0);
    expect(lastJson(again.out)).toMatchObject({ ok: true, files: ['src/a.mjs', 'src/b.mjs'] });
    expect(fs.existsSync(WAIT(state(), 'ACME-2'))).toBe(false);
  });

  it('exits 7 and writes every claimable file the plan asks for under needs, with the held ones under files', async () => {
    expect((await run(['lock', 'files', 'ACME-1', '--plan', plan(['src/a.mjs'])], { FOREMAN_SLOT: 'w1' })).code).toBe(0);
    const r = await run(['lock', 'files', 'ACME-2', '--plan', plan(['src/a.mjs', 'src/b.mjs', 'CHANGELOG.md'], 'plan-2.json')], { FOREMAN_SLOT: 'w2' });
    expect(r.code).toBe(7);
    const answer = lastJson(r.out);
    expect(Object.keys(answer)).toEqual(['ok', 'heldBy', 'reason']);
    expect(answer.heldBy).toEqual([{ story: 'ACME-1', slot: 'w1', files: ['src/a.mjs'] }]);
    const record = JSON.parse(fs.readFileSync(WAIT(state(), 'ACME-2'), 'utf8'));
    expect(record).toMatchObject({ story: 'ACME-2', on: ['ACME-1'], files: ['src/a.mjs'], needs: ['src/a.mjs', 'src/b.mjs'] });
  });

  it('exits 7 for a file kept for another story, takes nothing, and lets the story it is kept for claim it and drop the reservation', async () => {
    const reserve = RESERVE(state(), 'src/a.mjs');
    fs.mkdirSync(path.dirname(reserve), { recursive: true });
    // The command's clock is 2026-10-15 12:00 local.
    fs.writeFileSync(reserve, JSON.stringify({ path: 'src/a.mjs', story: 'ACME-2', from: 'ACME-1', at: new Date(2026, 9, 15, 11).toISOString(), until: new Date(2026, 9, 16).toISOString() }));
    const r = await run(['lock', 'files', 'ACME-9', '--plan', plan(['src/a.mjs'])], { FOREMAN_SLOT: 'w2' });
    expect(r.code).toBe(7);
    const answer = lastJson(r.out);
    expect(answer.heldBy).toEqual([{ story: 'ACME-2', slot: null, files: ['src/a.mjs'], reserved: true }]);
    expect(answer.reason).toContain('kept for it');
    expect(fs.existsSync(WAIT(state(), 'ACME-9'))).toBe(true);
    expect(fs.existsSync(FILE_LOCK(state(), 'src/a.mjs'))).toBe(false);
    expect(fs.existsSync(reserve)).toBe(true);

    const mine = await run(['lock', 'files', 'ACME-2', '--plan', plan(['src/a.mjs'])], { FOREMAN_SLOT: 'w1' });
    expect(mine.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(FILE_LOCK(state(), 'src/a.mjs'), 'utf8'))).toMatchObject({ slot: 'w1', story: 'ACME-2' });
    expect(fs.existsSync(reserve)).toBe(false);
  });

  it('drops the story\'s own reservations when it is refused, too: it has made its claim', async () => {
    expect((await run(['lock', 'files', 'ACME-1', '--plan', plan(['src/a.mjs'])], { FOREMAN_SLOT: 'w1' })).code).toBe(0);
    const reserve = RESERVE(state(), 'src/b.mjs');
    fs.writeFileSync(reserve, JSON.stringify({ path: 'src/b.mjs', story: 'ACME-2', from: null, at: new Date(2026, 9, 15, 11).toISOString(), until: new Date(2026, 9, 16).toISOString() }));
    const r = await run(['lock', 'files', 'ACME-2', '--plan', plan(['src/a.mjs', 'src/b.mjs'])], { FOREMAN_SLOT: 'w2' });
    expect(r.code).toBe(7);
    expect(fs.existsSync(reserve)).toBe(false);
  });

  it('claims nothing for a plan with no files', async () => {
    fs.writeFileSync(path.join(dir, 'plan.json'), '{"ready":true}');
    const r = await run(['lock', 'files', 'ACME-1', '--plan', 'plan.json']);
    expect(r.code).toBe(0);
    expect(lastJson(r.out)).toEqual({ ok: true, files: [], ignored: [], dropped: [] });
  });

  it('drops a folder entry and claims no lock for it', async () => {
    const r = await run(['lock', 'files', 'ACME-1', '--plan', plan(['src/', 'src/a.mjs'])]);
    expect(r.code, r.err).toBe(0);
    expect(lastJson(r.out)).toEqual({ ok: true, files: ['src/a.mjs'], ignored: [], dropped: ['src/'] });
    expect(fs.existsSync(FILE_LOCK(state(), 'src'))).toBe(false);
  });

  describe('keeps local paths out of the first stderr line', () => {
    const first = (err) => err.split('\n')[0];

    it('names a plan it cannot read by its file name only', async () => {
      const r = await run(['lock', 'files', 'ACME-1', '--plan', `${dir}/missing/ACME-1.json`]);
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(first(r.err)).toBe('could not read the plan ACME-1.json');
      expect(r.err).not.toContain(path.basename(dir));
    });

    it('says a plan is not valid JSON without the parser message', async () => {
      fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
      const r = await run(['lock', 'files', 'ACME-1', '--plan', 'bad.json']);
      expect(r.code).toBe(1);
      expect(first(r.err)).toBe('the plan bad.json is not valid JSON');
    });

    it('starts a config error with one plain line', async () => {
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{}');
      const r = await run(['lock', 'files', 'ACME-1', '--plan', plan(['a'])]);
      expect(r.code).toBe(1);
      expect(first(r.err)).toBe('lock: foreman.config.json has errors');
    });

    it('gives only an error code when the claim itself fails', async () => {
      const notADir = path.join(dir, 'state-file');
      fs.writeFileSync(notADir, 'x');
      const r = await run(['lock', 'files', 'ACME-1', '--plan', plan(['src/a.mjs'])], { FOREMAN_STATE_DIR: notADir });
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(first(r.err)).toMatch(/^lock: could not claim the files( \([A-Z][A-Z0-9_]*\))?$/);
      expect(r.err).not.toContain(path.basename(dir));
    });
  });

  it('exits 1 with a message for a missing --plan, an unreadable plan, a bad id or an invalid config', async () => {
    for (const argv of [['lock', 'files', 'ACME-1'], ['lock', 'files', '--plan', plan(['a'])], ['lock', 'files', 'ACME-1', '--plan', 'nope.json'], ['lock', 'files', '../x', '--plan', plan(['a'])], ['lock', 'files', 'ACME-1', '--plan', plan(['a']), '--bogus']]) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err, argv.join(' ')).not.toBe('');
      expect(r.out).toBe('');
    }
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    const bad = await run(['lock', 'files', 'ACME-1', '--plan', 'bad.json']);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('bad.json');
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{}');
    const r = await run(['lock', 'files', 'ACME-1', '--plan', plan(['a'])]);
    expect(r.code).toBe(1);
    expect(r.err).not.toBe('');
  });
});
