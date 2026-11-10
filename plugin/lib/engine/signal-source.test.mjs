import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTERRUPTED, LAST_INTERRUPT, SIGNAL_WINDOW_MS, interruptReason, readInterrupt, signalSource, writeInterrupt } from './signal-source.mjs';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const PKILL = 'pkill -f "foreman.*run --foreground"';
const agent = (raw, ms, over = {}) => ({ slot: 'w1', story: 'ACME-1', raw, lastAt: ago(ms), ...over });
const find = (agents) => signalSource({ agents, now: NOW, windowMs: SIGNAL_WINDOW_MS });

describe('signalSource', () => {
  it('names the session whose agent had just run a kill command', () => {
    expect(find([agent(PKILL, 2000)])).toEqual({ story: 'ACME-1', slot: 'w1', command: PKILL, at: ago(2000) });
  });

  it('ignores a kill command from over a minute ago, and one that is not a kill', () => {
    expect(find([agent(PKILL, 120_000)])).toBeNull();
    expect(find([agent('npm test', 1000)])).toBeNull();
    expect(find([agent(null, 1000), agent(undefined, 1000)])).toBeNull();
    expect(find([])).toBeNull();
  });

  it('recognises each way to send a signal', () => {
    for (const raw of ['kill -9 123', 'killall node', 'sleep 1; kill 4', 'npm test && /bin/kill 4', 'echo $(pkill x)', 'node -e "process.kill(4)"', 'python -c "os.kill(4, 9)"', 'x |\n kill 7']) {
      expect(find([agent(raw, 1000)]), raw).not.toBeNull();
    }
    for (const raw of ['echo skill', 'git commit -m killer', 'npm run kill-port', 'ls killed']) {
      expect(find([agent(raw, 1000)]), raw).toBeNull();
    }
  });

  it('picks the newer of two matches', () => {
    const a = agent('kill 1', 5000, { slot: 'w1', story: 'ACME-1' });
    const b = agent('kill 2', 1000, { slot: 'w2', story: 'ACME-2' });
    expect(find([a, b]).story).toBe('ACME-2');
    expect(find([b, a]).story).toBe('ACME-2');
  });

  it('cuts the command at 200', () => {
    expect(find([agent(`kill 1 ${'x'.repeat(400)}`, 1000)]).command).toHaveLength(200);
  });

  it('ignores a time in the far future', () => {
    expect(find([agent(PKILL, -60_000)])).toBeNull();
  });
});

describe('interruptReason', () => {
  it('keeps the plain text for no source', () => {
    expect(INTERRUPTED).toBe('Interrupted (Ctrl-C, kill or a closed terminal).');
    expect(interruptReason(null)).toBe(INTERRUPTED);
  });

  it('names the story, the slot and the command', () => {
    const r = interruptReason({ story: 'ACME-1', slot: 'w1', command: PKILL, at: ago(0) });
    expect(r).toBe(`Interrupted by a signal from ACME-1's session in w1, which had just run \`${PKILL}\`.`);
    expect(r).not.toContain('Ctrl-C');
  });
});

describe('the interrupt record', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-interrupt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips', () => {
    writeInterrupt(dir, { at: ago(0), story: 'ACME-1', slot: 'w1', command: PKILL });
    expect(readInterrupt(dir)).toEqual({ at: ago(0), story: 'ACME-1', slot: 'w1', command: PKILL });
    writeInterrupt(dir, { at: ago(0) });
    expect(readInterrupt(dir)).toEqual({ at: ago(0) });
  });

  it('drops bad fields, cuts long ones, and gives null for a missing or broken file', () => {
    expect(readInterrupt(dir)).toBeNull();
    writeFileSync(join(dir, LAST_INTERRUPT), JSON.stringify({ at: ago(0), story: 5, slot: 'w1'.repeat(30), command: 'x'.repeat(400) }));
    const r = readInterrupt(dir);
    expect(r.story).toBeUndefined();
    expect(r.slot).toHaveLength(20);
    expect(r.command).toHaveLength(200);
    writeFileSync(join(dir, LAST_INTERRUPT), JSON.stringify({ at: 'yesterday', story: 'ACME-1' }));
    expect(readInterrupt(dir)).toBeNull();
    writeFileSync(join(dir, LAST_INTERRUPT), 'not json');
    expect(readInterrupt(dir)).toBeNull();
  });
});
