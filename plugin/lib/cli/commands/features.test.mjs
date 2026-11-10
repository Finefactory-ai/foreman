import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';

let dir;
const configFile = () => join(dir, 'foreman.config.json');
const localFile = () => join(dir, '.foreman', 'settings.json');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-features-'));
  writeFileSync(configFile(), `${JSON.stringify({ version: 1, project: { name: 'T' } }, null, 2)}\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir },
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

describe('foreman features', () => {
  it('does not take jiraCommentDetail as a switch', async () => {
    const { code, err } = await run(['features', 'on', 'jiraCommentDetail']);
    expect(code).toBe(1);
    expect(err).toContain('unknown feature: jiraCommentDetail');
    expect(err).not.toContain('jiraCommentDetail,');
  });

  it('off turns a switch off locally, and settings list shows it', async () => {
    const { code, out } = await run(['features', 'off', 'followUps']);
    expect(code).toBe(0);
    expect(out).toBe('features.followUps = false (local; applies next-story)\n');
    expect(JSON.parse(readFileSync(localFile(), 'utf8'))).toEqual({ 'features.followUps': false });
    const list = (await run(['settings', 'list', '--group', 'features'])).out;
    expect(list).toMatch(/^features\.followUps\s+false\s+\(local\)\s+next-story$/m);
  });

  it('on turns it back on', async () => {
    await run(['features', 'off', 'learnTraits']);
    await run(['features', 'on', 'learnTraits']);
    expect((await run(['settings', 'get', 'features.learnTraits'])).out).toBe('true\n');
  });

  it('--team writes the config file and prints the commit reminder', async () => {
    const { code, out } = await run(['features', 'on', 'followUpsOfFollowUps', '--team']);
    expect(code).toBe(0);
    expect(out).toContain('foreman.config.json changed; commit it so the team gets it');
    expect(JSON.parse(readFileSync(configFile(), 'utf8')).features).toEqual({ followUpsOfFollowUps: true });
    expect(existsSync(localFile())).toBe(false);
    expect((await run(['config', 'check'])).out).toBe('ok\n');
  });

  it('accepts the full name too', async () => {
    expect((await run(['features', 'off', 'features.costMetrics'])).code).toBe(0);
    expect((await run(['settings', 'get', 'features.costMetrics'])).out).toBe('false\n');
  });

  it('refuses an unknown switch', async () => {
    const { code, err } = await run(['features', 'off', 'nope']);
    expect(code).toBe(1);
    expect(err).toContain('unknown feature: nope');
  });

  it('with no arguments lists the switches', async () => {
    const { code, out } = await run(['features']);
    expect(code).toBe(0);
    expect(out).toMatch(/^features\.followUps\s+true\s+\(default\)/m);
  });

  it('prints usage for anything else', async () => {
    expect((await run(['features', 'maybe', 'followUps'])).code).toBe(64);
    expect((await run(['features', 'on'])).code).toBe(64);
  });
});
