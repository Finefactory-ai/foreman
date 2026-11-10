import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bashHoles, hasBash, heredocLayouts, LAYOUT_PARTS, mulberry32 } from './shell-holes.mjs';

const KILL = 'pkill -f acme-none';
// Runs fn with TMPDIR pointing at a folder of its own, so other test files that use the helper at
// the same time cannot add to it. fn gets that folder.
async function inOwnTmp(fn) {
  const saved = process.env.TMPDIR;
  const own = mkdtempSync(path.join(tmpdir(), 'acme-own-'));
  process.env.TMPDIR = own;
  try {
    await fn(own);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    rmSync(own, { recursive: true, force: true });
  }
}
const CROSS = LAYOUT_PARTS.head.length * LAYOUT_PARTS.ops.length * LAYOUT_PARTS.rest.length;

describe('hasBash', () => {
  it('is false when no bash can be found and true where bash exists', () => {
    expect(hasBash({ PATH: '' })).toBe(false);
    expect(hasBash()).toBe(true);
  });
});

describe('mulberry32', () => {
  it('repeats for a seed, stays in [0,1) and differs between seeds', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(xs).not.toEqual(Array.from({ length: 50 }, mulberry32(8)));
  });
});

describe.skipIf(!hasBash())('bashHoles', () => {
  it('finds a command that ran a stub and gives the stub log', async () => {
    const { holes, checked } = await bashHoles({ allow: () => true, commands: [KILL, 'echo hi'], stubs: { pkill: () => true } });
    expect(holes).toEqual([{ command: KILL, ran: [KILL] }]);
    expect(checked).toBe(2);
  });

  it('never runs a command the guard refuses', async () => {
    const { holes, checked } = await bashHoles({ allow: () => false, commands: [KILL, 'echo hi'], stubs: { pkill: () => true } });
    expect(holes).toEqual([]);
    expect(checked).toBe(0);
  });

  it('lets counts decide: a targeted run ran but is not a hole', async () => {
    const { holes, checked } = await bashHoles({
      allow: () => true,
      commands: ['npm test --silent', 'npm test -- plugin/x.test.mjs'],
      stubs: { npm: (args) => /^test(?: -\S+)*$/.test(args) },
    });
    expect(holes.map((h) => h.command)).toEqual(['npm test --silent']);
    expect(checked).toBe(2);
  });

  it('leaves nothing in the caller folder or the temp folder', async () => {
    await inOwnTmp(async (own) => {
      const { holes } = await bashHoles({ allow: () => true, commands: ['echo x > acme-holes-probe', 'cd sub && echo y > z'], stubs: { pkill: () => true } });
      expect(holes).toEqual([]);
      expect(existsSync(`${process.cwd()}/acme-holes-probe`)).toBe(false);
      expect(readdirSync(own)).toEqual([]);
    });
  });

  it('cuts off a command that never ends and does not call it a hole', async () => {
    const t0 = Date.now();
    const { holes, checked } = await bashHoles({ allow: () => true, commands: ['sleep 5'], stubs: { pkill: () => true }, timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(holes).toEqual([]);
    expect(checked).toBe(1);
  });

  it('removes its temp folder when the guard throws', async () => {
    await inOwnTmp(async (own) => {
      await expect(bashHoles({ allow: () => { throw new Error('boom'); }, commands: ['echo hi'], stubs: {} })).rejects.toThrow('boom');
      expect(readdirSync(own)).toEqual([]);
    });
  });
});

describe('heredocLayouts', () => {
  const danger = [KILL, 'killall acme-none'];
  const opts = { seed: 403, size: 300, danger };

  it('is repeatable for a seed and differs for another', () => {
    expect(heredocLayouts(opts)).toEqual(heredocLayouts({ ...opts }));
    expect(heredocLayouts({ ...opts, seed: 404 })).not.toEqual(heredocLayouts(opts));
  });

  it('has no duplicates', () => {
    const all = heredocLayouts(opts);
    expect(new Set(all).size).toBe(all.length);
  });

  it('puts a danger line, or its quote-closing variant, in every layout', () => {
    const lines = danger.flatMap((d) => [d, `' ; ${d}`, `" ; ${d}`]);
    for (const layout of heredocLayouts(opts)) expect(lines.some((l) => layout.includes(l)), layout).toBe(true);
  });

  it('always holds the FM-386 cross entry, whatever the seed', () => {
    const want = `cat > ' <<EOF '\n${KILL}\nEOF`;
    expect(heredocLayouts(opts)).toContain(want);
    expect(heredocLayouts({ ...opts, seed: 1, size: 0 })).toContain(want);
  });

  it('holds at least the whole cross for seed 403 and size 1500', () => {
    expect(heredocLayouts({ seed: 403, size: 1500, danger }).length).toBeGreaterThanOrEqual(CROSS);
  });

  it('keeps its lists frozen', () => {
    expect(Object.isFrozen(LAYOUT_PARTS)).toBe(true);
  });
});

describe.skipIf(!hasBash())('the method against a weak guard', () => {
  // A guard that cuts every `<<WORD ... WORD` body out with a regex and refuses only when a
  // kill line is left. It trusts a heredoc that a quote can hide.
  const weak = (command) => {
    const rest = command.replace(/<<-?\s*['"\\]?(\w+)['"]?[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*(?:\n|$)/g, '');
    return !/pkill/.test(rest);
  };

  it('finds the FM-386 shape as a hole', async () => {
    // Only the layouts that open a quote in the head: the whole sample is the guard tests' job, and
    // running it here as well made this test slow on a busy machine.
    const commands = heredocLayouts({ seed: 403, size: 200, danger: [KILL] }).filter((c) => c.startsWith("cat > '"));
    const { holes, checked } = await bashHoles({ allow: weak, commands, stubs: { pkill: () => true, git: () => false } });
    expect(checked).toBeGreaterThan(0);
    expect(holes.map((h) => h.command)).toContain(`cat > ' <<EOF '\n${KILL}\nEOF`);
  });
});
