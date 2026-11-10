// Runs the docker env adapter against real Docker. Opt in: FOREMAN_DOCKER_IT=1 npm test
// Needs docker + compose, the nginx:alpine image (pulled if missing), and free ports 8100-8300.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { create } from './docker.mjs';

const GOOD = `services:
  web:
    image: nginx:alpine
    ports:
      - "\${WEB_PORT}:80"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1/"]
      interval: 1s
      timeout: 2s
      retries: 30
`;
const BAD = GOOD.replace('"wget", "-qO-", "http://127.0.0.1/"', '"false"').replace('retries: 30', 'retries: 2');
const PREFIX = 'fmtest';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const get = async (port) => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/`)).status;
  } catch {
    return 0;
  }
};

describe.skipIf(process.env.FOREMAN_DOCKER_IT !== '1')('docker env against real Docker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foreman-docker-it-'));
  const good = join(dir, 'good');
  const bad = join(dir, 'bad');
  const slots = [1, 2, 3];
  const adapter = create({ projectPrefix: PREFIX, ports: { WEB_PORT: 8000 } });

  afterAll(() => {
    for (const n of slots) docker('compose', '-p', `${PREFIX}-w${n}`, 'down', '--remove-orphans');
    rmSync(dir, { recursive: true, force: true });
  });

  it('brings two slots up on their own ports, then takes them down', async () => {
    for (const d of [good, bad]) mkdirSync(d);
    writeFileSync(join(good, 'compose.yaml'), GOOD);
    writeFileSync(join(bad, 'compose.yaml'), BAD);

    expect(adapter.prepare(1, good)).toBe('up');
    expect(adapter.prepare(2, good)).toBe('up');
    expect(await get(8100)).toBe(200);
    expect(await get(8200)).toBe(200);

    const projects = JSON.parse(docker('compose', 'ls', '--format', 'json').stdout).map((p) => p.Name);
    expect(projects).toContain(`${PREFIX}-w1`);
    expect(projects).toContain(`${PREFIX}-w2`);

    expect(adapter.prepare(1, good)).toBe('up'); // idempotent

    for (const n of [1, 2]) expect(docker('compose', '-p', `${PREFIX}-w${n}`, 'down').status).toBe(0);
    expect(await get(8100)).toBe(0);
    expect(docker('ps', '-aq', '--filter', `name=${PREFIX}-w`).stdout.trim()).toBe('');
  }, 180_000);

  it('reports down and leaves no containers when a service never gets healthy', () => {
    expect(adapter.prepare(3, bad)).toBe('down');
    expect(docker('ps', '-aq', '--filter', `name=${PREFIX}-w3`).stdout.trim()).toBe('');
  }, 180_000);
});
