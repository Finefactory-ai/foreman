import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeKey, publishGate, stateFingerprint } from './publish-gate.mjs';

let root;
let dir;
const NOW = Date.now();
const HOUR_AGO = (NOW - 3_600_000) / 1000;
const fp = (extra = {}) => stateFingerprint(dir, { root, slots: 2, nowMs: NOW, ...extra });

// Every file and folder of the fixture is backdated, so none is racy.
function backdate() {
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const q = join(p, name);
      if (statSync(q).isDirectory()) walk(q);
      utimesSync(q, HOUR_AGO, HOUR_AGO);
    }
    utimesSync(p, HOUR_AGO, HOUR_AGO);
  };
  walk(root);
}

// After a change, every file and folder looks a few seconds old: young, but past the racy window.
function settle(p) {
  const t = (NOW - 5000) / 1000;
  for (const name of readdirSync(p)) {
    const q = join(p, name);
    if (statSync(q).isDirectory()) settle(q);
    if (statSync(q).mtimeMs > NOW - 5000) utimesSync(q, t, t);
  }
  if (statSync(p).mtimeMs > NOW - 5000) utimesSync(p, t, t);
}

const put = (rel, text = '{}') => {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
  return file;
};
// A new file lands by temp file and rename, as the factory's writers do.
const land = (rel, text = '{}') => {
  const file = join(dir, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.1.tmp`, text);
  renameSync(`${file}.1.tmp`, file);
  const now = (NOW - 5000) / 1000; // young, but not within the racy window used below
  utimesSync(file, now, now);
  utimesSync(join(file, '..'), now, now);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acme-gate-'));
  dir = join(root, '.foreman');
  mkdirSync(dir, { recursive: true });
  put('state.json');
  put('events.jsonl', '{"text":"a"}\n');
  put('control.json');
  put('decisions/d-20261109000000-aaaa.json');
  put('claims/ACME-1.json');
  put('slots/w1.json');
  put('slots/w1/agents/a1.json');
  put('stories/ACME-1.json');
  put('stories/new/x.json');
  put('jira/list.json');
  put('salesforce/list.json');
  put('check-running/t.json');
  writeFileSync(join(root, 'foreman.config.json'), '{}');
  mkdirSync(join(root, 'stories'), { recursive: true });
  writeFileSync(join(root, 'stories', 'ACME-1.md'), '# a');
  backdate();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('stateFingerprint', () => {
  it('is the same twice on an unchanged folder in the same minute', () => {
    expect(fp()).toEqual(expect.any(String));
    expect(fp()).toBe(fp());
  });

  const changes = {
    'an event is appended': () => appendFileSync(join(dir, 'events.jsonl'), '{"text":"b"}\n'),
    'state.json is rewritten': () => land('state.json', '{"a":1}'),
    'a decision is added': () => land('decisions/d-20261109000001-bbbb.json'),
    'a claim is added': () => land('claims/ACME-2.json'),
    'a claim is removed': () => rmSync(join(dir, 'claims', 'ACME-1.json')),
    'an agent file appears': () => land('slots/w1/agents/a2.json'),
    'a slot file changes': () => land('slots/w1.json', '{"state":"building"}'),
    'STOP appears': () => land('STOP', 'x'),
    'an overlay is added': () => land('stories/ACME-2.json'),
    'the Salesforce poll cache is rewritten': () => land('salesforce/list.json', '{"items":[]}'),
    'a check run is added': () => land('check-running/u.json'),
    'a file is added in a folder passed in paths': () => {
      writeFileSync(join(root, 'stories', 'ACME-2.md'), '# b');
      const t = (NOW - 5000) / 1000;
      utimesSync(join(root, 'stories'), t, t);
    },
    'foreman.config.json changes': () => {
      writeFileSync(join(root, 'foreman.config.json'), '{"slots":3}');
      const t = (NOW - 5000) / 1000;
      utimesSync(join(root, 'foreman.config.json'), t, t);
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    it(`changes when ${name}`, () => {
      const paths = [join(root, 'stories')];
      const before = fp({ paths });
      change();
      settle(root);
      const after = fp({ paths });
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
    });
  }

  it('changes when the minute changes', () => {
    expect(fp({ nowMs: NOW + 60_000 })).not.toBe(fp());
  });

  it('is null when a listed file is younger than racyMs', () => {
    writeFileSync(join(dir, 'state.json'), '{"a":2}');
    expect(fp()).toBeNull();
    expect(fp({ nowMs: NOW + 10_000 })).toEqual(expect.any(String));
  });

  it('is null when a folder passed in paths is that young', () => {
    const folder = join(root, 'stories');
    writeFileSync(join(folder, 'ACME-9.md'), '# n');
    expect(fp({ paths: [folder] })).toBeNull();
  });

  it('does not count status.json, which publishing writes', () => {
    const before = fp();
    put('status.json', '{"x":1}');
    expect(fp()).toBe(before);
  });

  it('never throws', () => {
    expect(() => stateFingerprint(join(root, 'no', 'such'), { root: join(root, 'nope') })).not.toThrow();
    expect(stateFingerprint(null, {})).toBeNull();
  });
});

describe('publishGate', () => {
  const EVERY = 300_000;
  let clock;
  let print;
  let snap;
  let build;
  let publish;
  let gate;
  beforeEach(() => {
    clock = 1_000_000;
    print = 'a';
    snap = { n: 1, updatedAt: 'x' };
    build = vi.fn(async () => ({ ...snap }));
    publish = vi.fn(async () => {});
    gate = publishGate({ fingerprint: () => print, build, publish, changeKey, everyMs: EVERY, clock: () => clock });
  });

  it('builds and publishes the first time', async () => {
    expect(await gate()).toBe('published');
    expect(build).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('skips, without building, when the fingerprint is the same inside everyMs', async () => {
    await gate();
    clock += 5000;
    expect(await gate()).toBe('skipped');
    expect(build).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('builds on a changed fingerprint and publishes nothing when the key is the same', async () => {
    await gate();
    print = 'b';
    snap = { n: 1, updatedAt: 'later' };
    expect(await gate()).toBe('unchanged');
    expect(build).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await gate()).toBe('skipped');
  });

  it('publishes a changed snapshot', async () => {
    await gate();
    print = 'b';
    snap = { n: 2 };
    expect(await gate()).toBe('published');
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('builds when the fingerprint is null, or throws', async () => {
    await gate();
    print = null;
    expect(await gate()).toBe('unchanged');
    expect(await gate()).toBe('unchanged');
    expect(build).toHaveBeenCalledTimes(3);
    const throwing = publishGate({ fingerprint: () => { throw new Error('x'); }, build, publish, changeKey, everyMs: EVERY, clock: () => clock });
    expect(await throwing()).toBe('published');
  });

  it('builds and publishes on force even when nothing changed', async () => {
    await gate();
    expect(await gate(true)).toBe('published');
    expect(build).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('builds and publishes again after everyMs with the same fingerprint', async () => {
    await gate();
    clock += EVERY;
    expect(await gate()).toBe('published');
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('builds again after a build that threw', async () => {
    build.mockRejectedValueOnce(new Error('no'));
    await expect(gate()).rejects.toThrow('no');
    expect(await gate()).toBe('published');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('builds again after a publish that threw', async () => {
    publish.mockRejectedValueOnce(new Error('no'));
    await expect(gate()).rejects.toThrow('no');
    expect(await gate()).toBe('published');
  });
});

describe('changeKey', () => {
  it('ignores updatedAt and the quiet time of agents, and sees anything else', () => {
    const a = { updatedAt: '1', slots: [{ id: 'w1', agents: [{ role: 'dev', quietFor: 1 }] }] };
    const b = { updatedAt: '2', slots: [{ id: 'w1', agents: [{ role: 'dev', quietFor: 9 }] }] };
    const c = { updatedAt: '2', slots: [{ id: 'w1', agents: [{ role: 'tester', quietFor: 9 }] }] };
    expect(changeKey(a)).toBe(changeKey(b));
    expect(changeKey(a)).not.toBe(changeKey(c));
    expect(() => changeKey({})).not.toThrow();
  });
});
