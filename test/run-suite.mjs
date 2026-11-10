// `npm test`: runs vitest's 'waits' and 'unit' projects (vitest.config.mjs) at the same time,
// as two `vitest run --project <name>` processes, each with its own worker cap. Each one's
// output is held and printed whole when it ends, under a one-line header with the project and
// how it ended. SIGINT and SIGTERM are passed on to both. Exits 1 when either fails or is
// killed, else 0. With args (`npm test -- <file>`), it runs one plain `vitest run <args>` with
// its output as it comes, and exits with its code.
// Both get suiteEnv's PATH (test/real-git.mjs): on macOS, the real git ahead of /usr/bin's launcher.

import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { suiteEnv } from './real-git.mjs';

export const PROJECTS = ['waits', 'unit'];

export function vitestBin() {
  return path.join(path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
}

const ended = (code, signal) => (signal ? `killed by ${signal}` : `exit ${code}`);

export function runSuite({
  bin = vitestBin(),
  args = [],
  env = suiteEnv(),
  spawn = nodeSpawn,
  write = (s) => process.stdout.write(s),
  signals = process,
} = {}) {
  if (args.length) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, 'run', ...args], { stdio: 'inherit', env });
      const forward = (sig) => child.kill(sig);
      for (const sig of ['SIGINT', 'SIGTERM']) signals.on(sig, forward);
      child.on('close', (code, signal) => {
        for (const sig of ['SIGINT', 'SIGTERM']) signals.off(sig, forward);
        resolve(signal ? 1 : code);
      });
    });
  }
  const children = PROJECTS.map((name) => {
    const child = spawn(process.execPath, [bin, 'run', '--project', name], { stdio: ['ignore', 'pipe', 'pipe'], env });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const done = new Promise((resolve) => {
      child.on('close', (code, signal) => {
        write(`\n===== vitest run --project ${name}: ${ended(code, signal)} =====\n`);
        write(Buffer.concat(out).toString());
        write(Buffer.concat(err).toString());
        resolve(code === 0 && !signal);
      });
    });
    return { child, done };
  });
  const forward = (sig) => {
    for (const { child } of children) child.kill(sig);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) signals.on(sig, forward);
  return Promise.all(children.map((c) => c.done)).then((ok) => {
    for (const sig of ['SIGINT', 'SIGTERM']) signals.off(sig, forward);
    return ok.every(Boolean) ? 0 : 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runSuite({ args: process.argv.slice(2) });
}
