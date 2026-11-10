import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../main.mjs';
import { readSignIn, useSubscription } from '../../engine/claude-fallback.mjs';

const KEY = 'sk-ant-acme-fake-0000000000000000000000';

let dir;
const state = () => join(dir, '.foreman');
const signInFile = () => join(state(), 'claude-signin.json');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'foreman-cli-claude-'));
  writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(argv, extraEnv = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    cwd: dir,
    env: { FOREMAN_PROJECT_DIR: dir, ...extraEnv },
    now: () => new Date('2026-10-26T09:00:00Z'),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  });
  return { code, out, err };
}

describe('foreman claude use-key', () => {
  it('goes back to the key in .env.foreman after a switch', async () => {
    writeFileSync(join(dir, '.env.foreman'), `ANTHROPIC_API_KEY=${KEY}\n`, { mode: 0o600 });
    useSubscription(state(), new Date('2026-10-25T14:32:00Z'));
    const r = await run(['claude', 'use-key']);
    expect(r).toEqual({ code: 0, out: 'Sessions use the Console API key again from the next story.\n', err: '' });
    expect(readSignIn(state()).using).toBe('key');
    expect(readFileSync(signInFile(), 'utf8')).not.toContain(KEY);
  });

  it('takes the key from the environment too, and says when it is already on it', async () => {
    useSubscription(state(), new Date('2026-10-25T14:32:00Z'));
    expect((await run(['claude', 'use-key'], { ANTHROPIC_API_KEY: KEY })).code).toBe(0);
    expect(await run(['claude', 'use-key'], { ANTHROPIC_API_KEY: KEY })).toEqual({ code: 0, out: 'Already using the Console API key.\n', err: '' });
  });

  it('refuses with no key anywhere and changes nothing', async () => {
    useSubscription(state(), new Date('2026-10-25T14:32:00Z'));
    const before = readFileSync(signInFile(), 'utf8');
    const r = await run(['claude', 'use-key']);
    expect(r).toEqual({ code: 1, out: '', err: 'No ANTHROPIC_API_KEY in the environment or .env.foreman: add the key first.\n' });
    expect(readFileSync(signInFile(), 'utf8')).toBe(before);
  });

  it('prints the usage for anything else', async () => {
    for (const argv of [['claude'], ['claude', 'use-subscription'], ['claude', 'use-key', 'extra']]) {
      const r = await run(argv);
      expect(r, JSON.stringify(argv)).toEqual({ code: 1, out: '', err: 'usage: foreman claude use-key\n' });
    }
    expect(existsSync(signInFile())).toBe(false);
  });

  it('is refused inside a story session on the run\'s project', async () => {
    useSubscription(state(), new Date('2026-10-25T14:32:00Z'));
    const r = await run(['claude', 'use-key'], { FOREMAN_RUN: '1', ANTHROPIC_API_KEY: KEY });
    expect(r.code).toBe(1);
    expect(r.err).toContain('foreman claude use-key');
    expect(readSignIn(state()).using).toBe('subscription');
  });
});
