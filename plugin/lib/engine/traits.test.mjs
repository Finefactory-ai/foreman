import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LEARNED_HEADING, resolveTraits, roleNames } from './traits.mjs';
import { fakePack } from '../../../test/fake-pack.mjs';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-traits-'));
});
const put = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const config = (over = {}) => ({
  roles: {
    architect: { agent: 'a' },
    builders: { developer: { agent: 'b', use: 'x', ...(over.developer ?? {}) } },
    tester: { agent: 't', ...(over.tester ?? {}) },
    reviewers: [{ name: 'security', agent: 's', ...(over.security ?? {}) }],
  },
});

describe('roleNames', () => {
  it('lists architect, tester, builders and reviewers', () => {
    expect(roleNames(config())).toEqual(['architect', 'tester', 'developer', 'security']);
  });
});

describe('resolveTraits', () => {
  it('all.md reaches every role, <role>.md only that role', () => {
    put('.claude/foreman/traits/all.md', 'ALL');
    put('.claude/foreman/traits/tester.md', 'TESTER');
    const { traits, errors } = resolveTraits({ root, config: config() });
    expect(errors).toEqual([]);
    expect(traits).toEqual({
      architect: 'ALL',
      tester: 'ALL\n\nTESTER',
      developer: 'ALL',
      security: 'ALL',
    });
  });

  it('omits roles with no traits', () => {
    expect(resolveTraits({ root, config: config() }).traits).toEqual({});
  });

  it('orders all, role file, then config entries', () => {
    put('.claude/foreman/traits/all.md', 'ALL');
    put('.claude/foreman/traits/tester.md', 'FILE');
    put('docs/api.md', 'PATH');
    const { traits } = resolveTraits({ root, config: config({ tester: { traits: ['inline one', 'docs/api.md'] } }) });
    expect(traits.tester).toBe('ALL\n\nFILE\n\ninline one\n\nPATH');
  });

  it('reads inline and path traits for builders and reviewers too', () => {
    put('r.txt', 'from file');
    const { traits } = resolveTraits({ root, config: config({ developer: { traits: ['small funcs'] }, security: { traits: ['r.txt'] } }) });
    expect(traits.developer).toBe('small funcs');
    expect(traits.security).toBe('from file');
  });

  it('errors, naming the entry, for a missing .md or .txt path', () => {
    const { errors } = resolveTraits({ root, config: config({ tester: { traits: ['docs/missing.md'] } }) });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('docs/missing.md');
  });

  it('warns when a role is over 8 KB', () => {
    put('.claude/foreman/traits/tester.md', 'x'.repeat(9 * 1024));
    const { warnings } = resolveTraits({ root, config: config() });
    expect(warnings).toEqual(['traits for tester are 9 KB; keep them under 8 KB']);
  });
});

describe('resolveTraits with a pack', () => {
  let packDir;
  beforeEach(() => {
    packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pack-traits-'));
  });
  const packPut = (name, text) => fs.writeFileSync(path.join(packDir, name), text);
  const packs = (over = {}) => ({ acme: fakePack({ traitsDir: packDir, ...over }) });
  const acme = (over = {}) => ({ pack: 'acme', ...config(over) });

  it('puts pack all.md and <role>.md first, then the project files, then config entries', () => {
    packPut('all.md', 'PACK ALL');
    packPut('tester.md', 'PACK TESTER');
    put('.claude/foreman/traits/all.md', 'ALL');
    put('.claude/foreman/traits/tester.md', 'FILE');
    const { traits, errors } = resolveTraits({ root, config: acme({ tester: { traits: ['inline one'] } }), packs: packs() });
    expect(errors).toEqual([]);
    expect(traits.tester).toBe('PACK ALL\n\nPACK TESTER\n\nALL\n\nFILE\n\ninline one');
    expect(traits.developer).toBe('PACK ALL\n\nALL');
  });

  it('reads no pack traits when the config names no pack', () => {
    packPut('all.md', 'PACK ALL');
    expect(resolveTraits({ root, config: config(), packs: packs() }).traits).toEqual({});
    put('.claude/foreman/traits/all.md', 'ALL');
    expect(resolveTraits({ root, config: config(), packs: packs() }).traits.tester).toBe('ALL');
  });

  it('skips a pack with no traitsDir, and a pack file that is missing, without an error', () => {
    put('.claude/foreman/traits/all.md', 'ALL');
    const none = resolveTraits({ root, config: acme(), packs: { acme: fakePack() } });
    expect(none.errors).toEqual([]);
    expect(none.traits.tester).toBe('ALL');
    packPut('tester.md', 'PACK TESTER');
    const some = resolveTraits({ root, config: acme(), packs: packs() });
    expect(some.errors).toEqual([]);
    expect(some.traits.tester).toBe('PACK TESTER\n\nALL');
    expect(some.traits.security).toBe('ALL');
  });

  it('reads pack files through the injected readFile and exists', () => {
    packPut('all.md', 'PACK ALL');
    const underPack = (file) => file.startsWith(packDir + path.sep);
    const hidden = resolveTraits({
      root,
      config: acme(),
      packs: packs(),
      exists: (file) => (underPack(file) ? false : fs.existsSync(file)),
      readFile: (file, enc) => {
        if (underPack(file)) throw new Error(`hidden: ${file}`);
        return fs.readFileSync(file, enc);
      },
    });
    expect(hidden.traits).toEqual({});
    expect(hidden.errors).toEqual([]);

    const fakeTester = path.join(packDir, 'tester.md');
    const served = resolveTraits({
      root,
      config: acme(),
      packs: packs(),
      exists: (file) => file === fakeTester,
      readFile: (file) => {
        if (file === fakeTester) return 'FAKE PACK TESTER';
        throw new Error(`unexpected read: ${file}`);
      },
    });
    expect(served.traits.tester).toBe('FAKE PACK TESTER');
    expect(served.traits.developer).toBeUndefined();
  });

  it('takes traits from the project only for an unknown pack, and does not throw', () => {
    put('.claude/foreman/traits/all.md', 'ALL');
    packPut('all.md', 'PACK ALL');
    const { traits, errors } = resolveTraits({ root, config: { ...acme(), pack: 'nope' }, packs: packs() });
    expect(errors).toEqual([]);
    expect(traits.tester).toBe('ALL');
    expect(traits.architect).toBe('ALL');
  });

  it('counts pack text toward the 8 KB warning', () => {
    packPut('all.md', 'x'.repeat(9 * 1024));
    const { warnings } = resolveTraits({ root, config: acme(), packs: packs() });
    expect(warnings).toEqual(['architect', 'tester', 'developer', 'security'].map((r) => `traits for ${r} are 9 KB; keep them under 8 KB`));
  });
});

describe('resolveTraits with learned traits', () => {
  let stateDir;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-learned-traits-'));
  });
  const learn = (role, text) => {
    const file = path.join(stateDir, 'learned', 'traits', `${role}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const HEADING = '### Learned by Foreman (CLAUDE.md and the traits above win)';
  // An entry of about `bytes` bytes, tagged with its id.
  const entry = (id, bytes) => `[${id}] ${'a'.repeat(bytes - id.length - 3)}`;

  it('exports the heading the store and the pipeline share', () => {
    expect(LEARNED_HEADING).toBe('Learned by Foreman (CLAUDE.md and the traits above win)');
  });

  it('puts learned all.md then learned <role>.md after the owner text, under the heading', () => {
    put('.claude/foreman/traits/tester.md', 'FILE');
    learn('all', '[L-2] ALL RULE');
    learn('tester', '[L-1] T ONE\n\n[L-3] T TWO\n');
    const { traits, errors, learned } = resolveTraits({ root, config: config({ tester: { traits: ['inline'] } }), stateDir });
    expect(errors).toEqual([]);
    expect(traits.tester).toBe(`FILE\n\ninline\n\n${HEADING}\n\n[L-2] ALL RULE\n\n[L-1] T ONE\n\n[L-3] T TWO`);
    expect(learned.tester).toEqual(['L-1', 'L-2', 'L-3']);
    expect(traits.developer).toBe(`${HEADING}\n\n[L-2] ALL RULE`);
    expect(learned.developer).toEqual(['L-2']);
  });

  it('starts a role with only learned traits at the heading, and leaves a role with none out', () => {
    learn('developer', '[L-4] Acme: check every input.');
    const { traits, learned } = resolveTraits({ root, config: config(), stateDir });
    expect(traits).toEqual({ developer: `${HEADING}\n\n[L-4] Acme: check every input.` });
    expect(learned).toEqual({ developer: ['L-4'] });
  });

  it('keeps an untagged entry, without an id', () => {
    learn('developer', 'no tag here\n\n[L-5] tagged');
    const { traits, learned } = resolveTraits({ root, config: config(), stateDir });
    expect(traits.developer).toBe(`${HEADING}\n\nno tag here\n\n[L-5] tagged`);
    expect(learned).toEqual({ developer: ['L-5'] });
  });

  it('leaves learned text out when learning.apply is false, as with no stateDir', () => {
    put('.claude/foreman/traits/tester.md', 'FILE');
    learn('all', '[L-2] ALL RULE');
    learn('tester', '[L-1] T ONE');
    const owner = resolveTraits({ root, config: config() });
    const off = resolveTraits({ root, config: { ...config(), learning: { apply: false } }, stateDir });
    expect(off).toEqual(owner);
    expect(off).toEqual({ traits: { tester: 'FILE' }, errors: [], warnings: [], learned: {} });
    expect(JSON.stringify(off.traits)).not.toContain('Learned by Foreman');
  });

  it('drops the highest learned ids until a role fits in 3 KB, and warns', () => {
    learn('developer', [entry('L-1', 1200), entry('L-2', 1200), entry('L-3', 1200)].join('\n\n'));
    const { traits, warnings, learned } = resolveTraits({ root, config: config(), stateDir });
    expect(traits.developer).toContain('[L-1] ');
    expect(traits.developer).toContain('[L-2] ');
    expect(traits.developer).not.toContain('[L-3]');
    expect(warnings).toEqual(['learned traits for developer are over 3 KB; left out L-3']);
    expect(learned.developer).toEqual(['L-1', 'L-2']);
  });

  it('names every dropped id, in the order dropped', () => {
    learn('all', entry('L-7', 2200));
    learn('developer', [entry('L-1', 1000), entry('L-9', 1500)].join('\n\n'));
    const { warnings, learned } = resolveTraits({ root, config: config(), stateDir });
    expect(warnings).toContain('learned traits for developer are over 3 KB; left out L-9, L-7');
    expect(learned.developer).toEqual(['L-1']);
  });

  it('keeps an untagged learned text over 3 KB whole, and warns that it is still over', () => {
    const big = 'x'.repeat(5 * 1024);
    learn('developer', big);
    const { traits, warnings, learned } = resolveTraits({ root, config: config(), stateDir });
    expect(warnings).toEqual(['learned traits for developer are still over 3 KB; untagged entries are never left out']);
    expect(traits.developer).toBe(`${HEADING}\n\n${big}`);
    expect(learned).toEqual({});
  });

  it('warns about the dropped ids first, then that the untagged text left is still over 3 KB', () => {
    learn('developer', ['y'.repeat(4 * 1024), entry('L-1', 200)].join('\n\n'));
    const { warnings, learned } = resolveTraits({ root, config: config(), stateDir });
    expect(warnings).toEqual([
      'learned traits for developer are over 3 KB; left out L-1',
      'learned traits for developer are still over 3 KB; untagged entries are never left out',
    ]);
    expect(learned).toEqual({});
  });

  it('counts learned text toward the 8 KB warning', () => {
    put('.claude/foreman/traits/developer.md', 'x'.repeat(6 * 1024));
    learn('developer', [entry('L-1', 1250), entry('L-2', 1250)].join('\n\n'));
    const { warnings } = resolveTraits({ root, config: config(), stateDir });
    expect(warnings).toEqual(['traits for developer are 9 KB; keep them under 8 KB']);
  });

  it('reads nothing and reports nothing when the learned folder is missing', () => {
    put('.claude/foreman/traits/all.md', 'ALL');
    const today = resolveTraits({ root, config: config() });
    const withState = resolveTraits({ root, config: config(), stateDir: path.join(stateDir, 'nope') });
    expect(withState).toEqual(today);
    expect(withState.errors).toEqual([]);
    expect(withState.learned).toEqual({});
  });
});
