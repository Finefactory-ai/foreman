import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CREDENTIALS_REASON, SKILL_NAME, gitUrl, hasCredentials, hashSkillDir, installSkills, movedFromLock, namedSkills, readLock, sourceType } from './skills.mjs';
import { gitIn, gitSh, makeSkillsSource, writeInstalled } from '../../../test/fake-skills.mjs';

let dir;
let root;
let tmpDir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-skills-test-'));
  root = path.join(dir, 'acme');
  tmpDir = path.join(dir, 'tmp');
  fs.mkdirSync(root);
  fs.mkdirSync(tmpDir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const APEX = { 'SKILL.md': '# Apex for Acme\n', 'references/a.md': 'Acme apex notes\n' };
const LWC = { 'SKILL.md': '# LWC for Acme\n', 'assets/b.txt': 'Acme lwc\n', 'link.md': { link: 'SKILL.md' } };
const VERSIONS = {
  '1.66.0': { 'platform-apex-generate': APEX, 'platform-lwc-build': LWC },
  '1.67.0': {
    'platform-apex-generate': { ...APEX, 'SKILL.md': '# Apex for Acme, revised\n' },
    'platform-soql-query': { 'SKILL.md': '# SOQL for Acme\n' },
  },
  '2.0.0': null,
  '3.0.0': { '-bad': { 'SKILL.md': '# bad\n' } },
};

// The source repo is built once; each test gets its own copy, so a test that moves a tag
// changes only its copy. verbatimSymlinks keeps link.md -> SKILL.md relative in the work tree.
let templateDir;
let template;
beforeAll(() => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-skills-src-'));
  template = makeSkillsSource(path.join(templateDir, 'source'), VERSIONS);
});
afterAll(() => fs.rmSync(templateDir, { recursive: true, force: true }));

const source = () => {
  const to = path.join(dir, 'source');
  fs.cpSync(template, to, { recursive: true, verbatimSymlinks: true });
  return to;
};
const install = (opts) => installSkills({ root, source: opts.source, tag: opts.tag, sh: opts.sh ?? gitSh, fs, tmpDir });

// Every path under `base` with its file content or link target, for before/after comparisons.
function snapshot(base) {
  const out = {};
  const walk = (rel) => {
    const abs = path.join(base, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) out[rel] = `-> ${fs.readlinkSync(abs)}`;
    else if (st.isDirectory()) {
      out[`${rel}/`] = '';
      for (const name of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name);
    } else out[rel] = fs.readFileSync(abs, 'utf8');
  };
  walk('');
  return out;
}

function allPaths(base) {
  const out = [];
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      out.push(path.join(abs, e.name));
      if (e.isDirectory()) walk(path.join(abs, e.name));
    }
  };
  walk(base);
  return out;
}

describe('hashSkillDir', () => {
  function expected(files, compare) {
    const hash = crypto.createHash('sha256');
    for (const rel of Object.keys(files).sort(compare)) {
      hash.update(rel);
      hash.update(Buffer.from(files[rel]));
    }
    return hash.digest('hex');
  }

  it('hashes path then content for each regular file, in localeCompare order, skipping .git, node_modules and symlinks', () => {
    const skill = path.join(dir, 'skill');
    const files = { 'SKILL.md': '# Acme\n', 'B.md': 'bee\n', 'a.md': 'ay\n', 'references/x.md': 'ex\n' };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(skill, rel)), { recursive: true });
      fs.writeFileSync(path.join(skill, rel), text);
    }
    fs.mkdirSync(path.join(skill, '.git'));
    fs.writeFileSync(path.join(skill, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(skill, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(skill, 'node_modules', 'x', 'i.js'), '1');
    fs.symlinkSync('SKILL.md', path.join(skill, 'link.md'));

    const locale = expected(files, (a, b) => a.localeCompare(b));
    const codeUnit = expected(files, undefined);
    expect(locale).not.toBe(codeUnit);
    expect(hashSkillDir(skill, fs)).toBe(locale);
  });
});

describe('namedSkills', () => {
  it('reads the inline, flow-list and block-list forms, and strips quotes', () => {
    expect(namedSkills('---\nname: sf-developer\nskills: sf-apex, "platform-soql-query"\n---\nBody\n')).toEqual(['sf-apex', 'platform-soql-query']);
    expect(namedSkills("---\nskills: [sf-apex, 'sf-lwc', \"sf-apex\"]\nmodel: opus\n---\n")).toEqual(['sf-apex', 'sf-lwc']);
    expect(namedSkills('---\nname: x\nskills:\n  - sf-apex\n  - "sf-lwc"\ntools: Bash\n---\n')).toEqual(['sf-apex', 'sf-lwc']);
  });
  it('returns [] with no frontmatter, no skills key, or skills only in the body', () => {
    expect(namedSkills('# An agent\nskills: sf-apex\n')).toEqual([]);
    expect(namedSkills('---\nname: x\n---\nBody\n')).toEqual([]);
    expect(namedSkills('---\nname: x\n---\nskills: sf-apex\n')).toEqual([]);
    expect(namedSkills('')).toEqual([]);
  });
});

describe('gitUrl and sourceType', () => {
  it('maps owner/repo to GitHub and passes URLs and absolute paths through', () => {
    expect(gitUrl('acme/skills')).toBe('https://github.com/acme/skills.git');
    expect(sourceType('acme/skills')).toBe('github');
    for (const s of ['/srv/acme/skills', 'file:///srv/acme/skills', 'https://git.acme.example/skills.git']) {
      expect(gitUrl(s)).toBe(s);
      expect(sourceType(s)).toBe('git');
    }
  });
  it('refuses anything else', () => {
    for (const s of ['-x', 'a b', '', 'acme', 'ssh://x', undefined, 7]) expect(gitUrl(s), String(s)).toBeNull();
  });
  it('refuses an https URL that holds a user name or token, but not an @ after the host', () => {
    for (const s of [
      'https://acme:t0ken@git.acme.example/skills.git',
      'https://t0ken@git.acme.example/skills.git',
      'HTTPS://t0ken@git.acme.example/skills.git',
      'https://git.acme.example/skills.git?access_token=t0ken',
      'https://git.acme.example/skills.git?x=1',
    ]) {
      expect(hasCredentials(s), s).toBe(true);
      expect(gitUrl(s), s).toBeNull();
    }
    for (const s of ['https://git.acme.example/skills.git', 'https://git.acme.example/a@b.git']) {
      expect(hasCredentials(s), s).toBe(false);
      expect(gitUrl(s)).toBe(s);
    }
    for (const s of [undefined, 7, 'acme/skills', '/srv/acme/skills']) expect(hasCredentials(s), String(s)).toBe(false);
  });
  it('names skills safely', () => {
    expect(SKILL_NAME.test('platform-apex-generate')).toBe(true);
    for (const s of ['-bad', '../x', 'a/b', '.hidden', '']) expect(SKILL_NAME.test(s), s).toBe(false);
  });
});

describe('readLock', () => {
  it('says missing, unreadable, not JSON, not version 1, or gives the lock', () => {
    expect(readLock(root, fs)).toEqual({ missing: true });
    fs.writeFileSync(path.join(root, 'skills-lock.json'), '{ nope');
    expect(readLock(root, fs)).toEqual({ error: 'skills-lock.json is not valid JSON' });
    fs.writeFileSync(path.join(root, 'skills-lock.json'), '{"version":2}');
    expect(readLock(root, fs)).toEqual({ error: 'skills-lock.json is not a version 1 skills lock' });
    fs.writeFileSync(path.join(root, 'skills-lock.json'), '{"version":1,"skills":{}}');
    expect(readLock(root, fs)).toEqual({ lock: { version: 1, skills: {} } });
    fs.rmSync(path.join(root, 'skills-lock.json'));
    fs.mkdirSync(path.join(root, 'skills-lock.json'));
    expect(readLock(root, fs)).toEqual({ error: 'could not read skills-lock.json' });
  });
});

describe('movedFromLock', () => {
  const SRC = '/srv/acme/skills';
  const now = 'd'.repeat(40);
  const entry = (commit, extra = {}) => ({ source: SRC, sourceType: 'git', ref: '1.66.0', ...(commit === undefined ? {} : { commit }), ...extra });
  const lock = (...entries) => ({ version: 1, skills: Object.fromEntries(entries.map((e, i) => [`skill-${i}`, e])) });
  const moved = (l) => movedFromLock(l, { source: SRC, tag: '1.66.0', commit: now });

  const bad = ['\u001b]0;acme\u0007', 'abc1234', 'g'.repeat(40), 'A'.repeat(40), 'a'.repeat(39), `\u001b[31m${'a'.repeat(40)}`, 7];
  it.each(bad.map((c) => [JSON.stringify(c), c]))('never counts a lock commit that is not a commit id: %s', (_, commit) => {
    expect(moved(lock(entry(commit)))).toBeUndefined();
  });

  it('gives the old commit, SHA-1 or SHA-256, when the tag moved', () => {
    expect(moved(lock(entry('a'.repeat(40))))).toBe('a'.repeat(40));
    expect(moved(lock(entry('c'.repeat(64))))).toBe('c'.repeat(64));
  });

  it('is undefined when the tag has not moved', () => {
    expect(moved(lock(entry(now)))).toBeUndefined();
  });

  it('never counts another source or another tag', () => {
    expect(moved(lock(entry('a'.repeat(40), { source: '/srv/acme/other-skills' })))).toBeUndefined();
    expect(moved(lock(entry('a'.repeat(40), { ref: '1.67.0' })))).toBeUndefined();
  });

  it('finds a later entry when the first has no commit, and the first match wins', () => {
    expect(moved(lock(entry(undefined), entry('b'.repeat(40))))).toBe('b'.repeat(40));
    expect(moved(lock(entry('e'.repeat(40)), entry('b'.repeat(40))))).toBe('e'.repeat(40));
  });

  it('is undefined for skills that are not an object, or an entry that is not one', () => {
    for (const skills of [null, [], 'x', 7]) expect(moved({ version: 1, skills })).toBeUndefined();
    expect(moved(lock(null, 'a'.repeat(40), [entry('a'.repeat(40))]))).toBeUndefined();
    expect(moved(null)).toBeUndefined();
  });
});

describe('installSkills', () => {
  it('installs a tag into .agents/skills, links .claude/skills and writes the lock', () => {
    const src = source();
    const r = install({ source: src, tag: '1.66.0' });
    expect(r).toEqual({ ok: true, commit: gitIn(src, 'rev-parse', '1.66.0^{commit}'), installed: ['platform-apex-generate', 'platform-lwc-build'], removed: [] });

    for (const [name, files] of Object.entries(VERSIONS['1.66.0'])) {
      const real = path.join(root, '.agents', 'skills', name);
      for (const [rel, text] of Object.entries(files)) {
        if (typeof text === 'string') expect(fs.readFileSync(path.join(real, rel), 'utf8')).toBe(text);
        else expect(fs.existsSync(path.join(real, rel)), `${rel} is a symlink and is not copied`).toBe(false);
      }
      expect(fs.readlinkSync(path.join(root, '.claude', 'skills', name))).toBe(`../../.agents/skills/${name}`);
    }
    expect(allPaths(path.join(root, '.agents')).some((p) => p.split(path.sep).includes('.git'))).toBe(false);

    const text = fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8');
    const entry = (name) => ({
      source: src,
      sourceType: 'git',
      ref: '1.66.0',
      commit: gitIn(src, 'rev-parse', '1.66.0^{commit}'),
      skillPath: `skills/${name}/SKILL.md`,
      computedHash: hashSkillDir(path.join(root, '.agents', 'skills', name), fs),
    });
    const lock = { version: 1, skills: { 'platform-apex-generate': entry('platform-apex-generate'), 'platform-lwc-build': entry('platform-lwc-build') } };
    expect(text).toBe(`${JSON.stringify(lock, null, 2)}\n`);
  });

  it('moves to a new tag: removes the dropped skill, updates the changed one, adds the new one', () => {
    const src = source();
    install({ source: src, tag: '1.66.0' });
    const before = JSON.parse(fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8'));
    const r = install({ source: src, tag: '1.67.0' });
    expect(r).toMatchObject({ ok: true, installed: ['platform-apex-generate', 'platform-soql-query'], removed: ['platform-lwc-build'] });
    expect(r).not.toHaveProperty('movedFrom');

    expect(fs.existsSync(path.join(root, '.agents', 'skills', 'platform-lwc-build'))).toBe(false);
    expect(() => fs.lstatSync(path.join(root, '.claude', 'skills', 'platform-lwc-build'))).toThrow();
    expect(fs.readFileSync(path.join(root, '.claude', 'skills', 'platform-apex-generate', 'SKILL.md'), 'utf8')).toBe('# Apex for Acme, revised\n');
    const after = JSON.parse(fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8'));
    expect(Object.keys(after.skills)).toEqual(['platform-apex-generate', 'platform-soql-query']);
    expect(after.skills['platform-apex-generate'].computedHash).not.toBe(before.skills['platform-apex-generate'].computedHash);
    expect(after.skills['platform-apex-generate'].ref).toBe('1.67.0');
  });

  it('leaves .git and node_modules inside a cloned skill folder out of the copy and the hash', () => {
    // git will not commit a .git folder in a subfolder, so the clone gets its junk afterwards.
    const junkSh = (cmd, args, opts) => {
      const r = gitSh(cmd, args, opts);
      if (args[0] === 'clone' && r.status === 0) {
        const skill = path.join(args.at(-1), 'skills', 'platform-apex-generate');
        fs.mkdirSync(path.join(skill, '.git'), { recursive: true });
        fs.writeFileSync(path.join(skill, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.mkdirSync(path.join(skill, 'node_modules', 'x'), { recursive: true });
        fs.writeFileSync(path.join(skill, 'node_modules', 'x', 'i.js'), '1');
      }
      return r;
    };
    const r = install({ source: source(), tag: '1.66.0', sh: junkSh });
    expect(r.ok).toBe(true);
    const real = path.join(root, '.agents', 'skills', 'platform-apex-generate');
    expect(fs.existsSync(path.join(real, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(real, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(real, 'node_modules'))).toBe(false);

    const plain = path.join(dir, 'plain-apex');
    for (const [rel, text] of Object.entries(APEX)) {
      fs.mkdirSync(path.dirname(path.join(plain, rel)), { recursive: true });
      fs.writeFileSync(path.join(plain, rel), text);
    }
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8'));
    expect(lock.skills['platform-apex-generate'].computedHash).toBe(hashSkillDir(plain, fs));
  });

  describe('a tag that moved upstream', () => {
    // The source's work tree is at its last version, so the move starts from 1.66.0.
    const moveTag = (src) => {
      gitIn(src, 'checkout', '-q', '1.66.0');
      fs.writeFileSync(path.join(src, 'skills', 'platform-apex-generate', 'SKILL.md'), '# Apex for Acme, moved\n');
      gitIn(src, 'commit', '-qam', 'moved');
      gitIn(src, 'tag', '-f', '1.66.0');
    };

    it('records the new commit and says which commit the lock had', () => {
      const src = source();
      const old = install({ source: src, tag: '1.66.0' }).commit;
      moveTag(src);
      const now = gitIn(src, 'rev-parse', '1.66.0^{commit}');
      expect(now).not.toBe(old);
      const r = install({ source: src, tag: '1.66.0' });
      expect(r).toMatchObject({ ok: true, commit: now, movedFrom: old });
      const lock = JSON.parse(fs.readFileSync(path.join(root, 'skills-lock.json'), 'utf8'));
      expect(lock.skills['platform-apex-generate'].commit).toBe(now);
      expect(fs.readFileSync(path.join(root, '.agents', 'skills', 'platform-apex-generate', 'SKILL.md'), 'utf8')).toBe('# Apex for Acme, moved\n');
    });

    // A commit starts `git maintenance run --auto --detach`, which can still be writing into
    // the source's .git when afterEach removes the temp dir (ENOTEMPTY under load).
    it('commits with no background maintenance that outlives the test', () => {
      const src = source();
      expect(gitIn(src, 'config', '--get', 'maintenance.auto')).toBe('false');
      expect(gitIn(src, 'config', '--get', 'gc.auto')).toBe('0');
    });

    it('moves the tag only in this test\'s copy of the source', () => {
      const src = source();
      expect(src).not.toBe(template);
      moveTag(src);
      expect(gitIn(template, 'show', '1.66.0:skills/platform-apex-generate/SKILL.md')).toBe('# Apex for Acme');
    });

    it('says nothing of a move when the tag has not moved', () => {
      const src = source();
      install({ source: src, tag: '1.66.0' });
      const r = install({ source: src, tag: '1.66.0' });
      expect(r).toEqual({ ok: true, commit: gitIn(src, 'rev-parse', '1.66.0^{commit}'), installed: ['platform-apex-generate', 'platform-lwc-build'], removed: [] });
    });

    it('never counts a lock entry from another source, even at the same tag', () => {
      const src = source();
      install({ source: src, tag: '1.66.0' });
      const lockPath = path.join(root, 'skills-lock.json');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      for (const entry of Object.values(lock.skills)) {
        entry.source = '/srv/acme/other-skills';
        entry.commit = 'a'.repeat(40);
      }
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      const r = install({ source: src, tag: '1.66.0' });
      expect(r.ok).toBe(true);
      expect(r).not.toHaveProperty('movedFrom');
    });

    it('never counts a lock entry with no commit, such as one the skills CLI wrote', () => {
      const src = source();
      const { 'link.md': _link, ...lwc } = LWC;
      writeInstalled(root, { 'platform-apex-generate': APEX, 'platform-lwc-build': lwc }, src);
      const r = install({ source: src, tag: '1.66.0' });
      expect(r.ok).toBe(true);
      expect(r).not.toHaveProperty('movedFrom');
    });

    // Rewrites each lock entry with `change`, keeping its source and ref.
    const editLock = (change) => {
      const lockPath = path.join(root, 'skills-lock.json');
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      for (const [name, entry] of Object.entries(lock.skills)) change(name, entry);
      fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    };

    it('finds a moved tag in a later entry when the first has no commit', () => {
      const src = source();
      install({ source: src, tag: '1.66.0' });
      editLock((name, entry) => {
        if (name === 'platform-apex-generate') delete entry.commit;
        else entry.commit = 'b'.repeat(40);
      });
      const r = install({ source: src, tag: '1.66.0' });
      expect(r).toMatchObject({ ok: true, commit: gitIn(src, 'rev-parse', '1.66.0^{commit}'), movedFrom: 'b'.repeat(40) });
    });

    // Each bad value is tested without git in movedFromLock above; this one keeps the wiring covered.
    it('never counts a lock commit that is not a commit id', () => {
      const src = source();
      install({ source: src, tag: '1.66.0' });
      editLock((name, entry) => { entry.commit = 'abc1234'; });
      const r = install({ source: src, tag: '1.66.0' });
      expect(r.ok).toBe(true);
      expect(r).not.toHaveProperty('movedFrom');
    });

    it('counts a 64-character lock commit as a commit id', () => {
      const src = source();
      install({ source: src, tag: '1.66.0' });
      editLock((name, entry) => { entry.commit = 'c'.repeat(64); });
      expect(install({ source: src, tag: '1.66.0' })).toMatchObject({ ok: true, movedFrom: 'c'.repeat(64) });
    });
  });

  describe('refuses, writing nothing into the project', () => {
    const refused = (opts, reason) => {
      const before = snapshot(root);
      const r = install(opts);
      expect(r.ok).toBe(false);
      if (reason instanceof RegExp) expect(r.reason).toMatch(reason);
      else expect(r.reason).toBe(reason);
      expect(snapshot(root)).toEqual(before);
      expect(fs.readdirSync(tmpDir)).toEqual([]);
      return r;
    };

    it('an unknown tag', () => {
      const src = source();
      refused({ source: src, tag: '9.9.9' }, `${src} has no tag 9.9.9`);
    });
    it('an unreachable source', () => {
      const missing = path.join(dir, 'nowhere');
      refused({ source: missing, tag: '1.66.0' }, `could not reach ${missing}`);
    });
    it('a tag with no skills/', () => {
      refused({ source: source(), tag: '2.0.0' }, 'no skills under skills/ at tag 2.0.0');
    });
    it('a skill folder with a bad name', () => {
      const r = refused({ source: source(), tag: '3.0.0' }, /-bad/);
      expect(r.reason).toContain('-bad');
    });
    it('an old lock that is not JSON', () => {
      fs.writeFileSync(path.join(root, 'skills-lock.json'), '{ nope');
      refused({ source: source(), tag: '1.66.0' }, 'skills-lock.json is not valid JSON; fix or delete it');
    });
    it('an old lock naming ../x', () => {
      fs.writeFileSync(path.join(root, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { '../x': { source: 'acme/skills' } } }));
      refused({ source: source(), tag: '1.66.0' }, /\.\.\/x/);
    });
    it('a folder of the user\'s own in .claude/skills, which it leaves alone', () => {
      const own = path.join(root, '.claude', 'skills', 'platform-apex-generate');
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(path.join(own, 'SKILL.md'), '# mine\n');
      const src = source();
      refused({ source: src, tag: '1.66.0' }, `.claude/skills/platform-apex-generate is not from ${src}; move it or remove it`);
      expect(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8')).toBe('# mine\n');
    });
    it('a folder of the user\'s own in .agents/skills with no lock, which it leaves alone', () => {
      const own = path.join(root, '.agents', 'skills', 'platform-apex-generate');
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(path.join(own, 'SKILL.md'), '# mine\n');
      const src = source();
      refused({ source: src, tag: '1.66.0' }, `.agents/skills/platform-apex-generate is not from ${src}; move it or remove it`);
      expect(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8')).toBe('# mine\n');
    });
    it('several folders of the user\'s own, naming them all', () => {
      const apex = path.join(root, '.claude', 'skills', 'platform-apex-generate');
      const lwc = path.join(root, '.agents', 'skills', 'platform-lwc-build');
      for (const own of [apex, lwc]) {
        fs.mkdirSync(own, { recursive: true });
        fs.writeFileSync(path.join(own, 'SKILL.md'), '# mine\n');
      }
      const src = source();
      refused(
        { source: src, tag: '1.66.0' },
        `.claude/skills/platform-apex-generate, .agents/skills/platform-lwc-build are not from ${src}; move them or remove them`,
      );
      for (const own of [apex, lwc]) expect(fs.readFileSync(path.join(own, 'SKILL.md'), 'utf8')).toBe('# mine\n');
    });
    describe('when git fails after the tag is found', () => {
      const SOURCE = '/srv/acme/skills';
      // The git subcommand of each call, past any `-C <dir>`.
      const subcommand = (args) => (args[0] === '-C' ? args[2] : args[0]);
      const subcommands = (calls) => calls.map(([, ...args]) => subcommand(args));
      const recording = (calls, { clone, revParse }) => (cmd, args) => {
        calls.push([cmd, ...args]);
        if (subcommand(args) === 'ls-remote') return { status: 0, stdout: `${'a'.repeat(40)}\trefs/tags/1.66.0\n`, stderr: '' };
        if (subcommand(args) === 'clone') return clone(args);
        if (subcommand(args) === 'rev-parse') return revParse;
        return { status: 1, stdout: '', stderr: '' };
      };

      it('a clone that fails', () => {
        const calls = [];
        const sh = recording(calls, { clone: () => ({ status: 128, stdout: '', stderr: 'fatal' }) });
        refused({ source: SOURCE, tag: '1.66.0', sh }, 'could not clone /srv/acme/skills at tag 1.66.0');
        expect(subcommands(calls)).toEqual(['ls-remote', 'clone']);
      });

      for (const [what, revParse] of [
        ['a commit that is not a hash', { status: 0, stdout: 'not-a-commit\n', stderr: '' }],
        ['a rev-parse that fails', { status: 1, stdout: '', stderr: '' }],
      ]) {
        it(`a commit it cannot read: ${what}, removing the clone`, () => {
          const calls = [];
          const clone = (args) => {
            fs.mkdirSync(args.at(-1), { recursive: true });
            fs.writeFileSync(path.join(args.at(-1), 'README.md'), 'Acme skills\n');
            return { status: 0, stdout: '', stderr: '' };
          };
          const sh = recording(calls, { clone, revParse });
          refused({ source: SOURCE, tag: '1.66.0', sh }, 'could not read the commit of /srv/acme/skills at tag 1.66.0');
          expect(subcommands(calls)).toEqual(['ls-remote', 'clone', 'rev-parse']);
        });
      }
    });
    it('a source URL that holds a user name or token, before any git call and without echoing it', () => {
      const calls = [];
      const sh = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
      const r = refused(
        { source: 'https://acme:t0ken@git.acme.example/skills.git', tag: '1.66.0', sh },
        'salesforce.skills.source must not hold a user name or token; use a git credential helper instead',
      );
      expect(r.reason).not.toContain('t0ken');
      expect(calls).toEqual([]);
    });
    it('a source URL with a token in its query string, before any git call and without echoing it', () => {
      const calls = [];
      const sh = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
      const r = refused({ source: 'https://git.acme.example/skills.git?access_token=t0ken', tag: '1.66.0', sh }, CREDENTIALS_REASON);
      expect(r.reason).not.toContain('t0ken');
      expect(calls).toEqual([]);
    });
    it('a tag or a source that could be read as an option, before any git call', () => {
      const calls = [];
      const sh = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: '', stderr: '' }; };
      refused({ source: source(), tag: '--upload-pack=x', sh }, 'salesforce.skills.tag is not a tag name');
      refused({ source: '-x', tag: '1.66.0', sh }, 'salesforce.skills.source must be owner/repo, an https:// or file:// URL, or an absolute path');
      expect(calls).toEqual([]);
    });
  });

  it('removes its temp clone on success and on failure', () => {
    const src = source();
    expect(install({ source: src, tag: '1.66.0' }).ok).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
    expect(install({ source: src, tag: '2.0.0' }).ok).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('never throws, even when the shell does', () => {
    const sh = () => { throw new Error('boom'); };
    expect(install({ source: '/srv/acme/skills', tag: '1.66.0', sh })).toMatchObject({ ok: false });
  });
});
