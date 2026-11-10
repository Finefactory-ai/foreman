// The copy-paste logout line in the Salesforce connect errors: HOME is always quoted for the
// shell, so the line runs as printed whatever the isolated home's path holds.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ERRORS } from './salesforce.mjs';

const CODES = ['production', 'not-checked'];
const HOME = "/tmp/Acme O'Neil/sf home";
// The text between the backticks: the command the owner is told to run.
const commandIn = (words) => words.match(/`([^`]*)`/)?.[1];

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-sfwords-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the logout line in ERRORS', () => {
  it('quotes HOME for the shell', () => {
    for (const code of CODES) {
      const words = ERRORS[code].words({ alias: 'acme-dev1', home: HOME, loggedOut: false });
      expect(words, code).toContain(`HOME='/tmp/Acme O'\\''Neil/sf home' sf org logout --target-org acme-dev1 --no-prompt`);
    }
  });

  it('quotes HOME even when it has no space', () => {
    for (const code of CODES) {
      const words = ERRORS[code].words({ alias: 'acme-dev1', home: '/srv/acme/sf-home', loggedOut: false });
      expect(words, code).toContain(`HOME='/srv/acme/sf-home' sf org logout --target-org acme-dev1 --no-prompt`);
    }
  });

  it('runs as printed under /bin/sh with a home holding a space and a single quote', () => {
    const dir = path.join(tmp, "Acme O'Neil");
    const fakeDir = path.join(dir, 'bin');
    const home = path.join(dir, 'sf home');
    fs.mkdirSync(fakeDir, { recursive: true });
    const sf = path.join(fakeDir, 'sf');
    fs.writeFileSync(sf, `#!/bin/sh\nprintf '%s\\n' "$HOME"\n`);
    fs.chmodSync(sf, 0o755);
    for (const code of CODES) {
      const cmd = commandIn(ERRORS[code].words({ alias: 'acme-dev1', home, loggedOut: false }));
      expect(cmd, code).toBeDefined();
      const r = spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: `${fakeDir}:/usr/bin:/bin` }, encoding: 'utf8' });
      expect(r.status, `${code}: ${r.stderr}`).toBe(0);
      expect(r.stdout.trim()).toBe(home);
    }
  });

  it('gives no logout line once the org was signed out', () => {
    for (const code of CODES) {
      const words = ERRORS[code].words({ alias: 'acme-dev1', home: HOME, loggedOut: true });
      expect(words, code).not.toContain('HOME=');
    }
  });
});
