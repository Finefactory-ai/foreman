import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyWarning, initPluginWarning, installedCopies, ownCopy, samePlace, sessionPlugin } from './plugin-copy.mjs';

let base;
let pluginsDir;
let root;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'foreman-plugin-copy-')));
  pluginsDir = join(base, 'plugins');
  root = join(base, 'acme-market');
  mkdirSync(pluginsDir, { recursive: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const installed = (plugins) => writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));

describe('installedCopies', () => {
  it('reads the user-scope copies and the project copies of the root and its slot worktrees', () => {
    installed({
      'foreman@acme-market': [
        { scope: 'user', installPath: '/opt/acme/user', version: '0.0.1' },
        { scope: 'project', projectPath: root, installPath: '/opt/acme/project', version: '0.0.2' },
        { scope: 'local', projectPath: join(root, '.foreman', 'worktrees', 'w1'), installPath: '/opt/acme/local', version: '0.0.3' },
      ],
    });
    expect(installedCopies({ pluginsDir, root })).toEqual([
      { id: 'foreman@acme-market', scope: 'user', path: '/opt/acme/user', version: '0.0.1' },
      { id: 'foreman@acme-market', scope: 'project', path: '/opt/acme/project', version: '0.0.2' },
      { id: 'foreman@acme-market', scope: 'local', path: '/opt/acme/local', version: '0.0.3' },
    ]);
  });

  it('drops a project entry for another folder, one with no installPath, and other plugins', () => {
    installed({
      'foreman@acme-market': [
        { scope: 'project', projectPath: join(base, 'elsewhere'), installPath: '/opt/acme/other', version: '1' },
        { scope: 'project', projectPath: `${root}-two`, installPath: '/opt/acme/sibling', version: '1' },
        { scope: 'user', version: '1' },
        { scope: 'user', installPath: 7, version: '1' },
      ],
      'acme-tools@acme-market': [{ scope: 'user', installPath: '/opt/acme/tools', version: '1' }],
    });
    expect(installedCopies({ pluginsDir, root })).toEqual([]);
  });

  it('is [] for a missing file, a file that is not JSON and a file with no plugins', () => {
    expect(installedCopies({ pluginsDir, root })).toEqual([]);
    writeFileSync(join(pluginsDir, 'installed_plugins.json'), '{ not json');
    expect(installedCopies({ pluginsDir, root })).toEqual([]);
    writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2 }));
    expect(installedCopies({ pluginsDir, root })).toEqual([]);
    writeFileSync(join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ plugins: { 'foreman@acme-market': 'x' } }));
    expect(installedCopies({ pluginsDir, root })).toEqual([]);
  });

  it('never throws when the file system does', () => {
    const fs = { readFileSync: () => { throw new Error('denied'); } };
    expect(installedCopies({ pluginsDir, root, fs })).toEqual([]);
  });
});

describe('samePlace', () => {
  it('ignores a trailing slash', () => {
    expect(samePlace(join(base, 'x', 'plugin') + '/', join(base, 'x', 'plugin'))).toBe(true);
  });

  it('sees a symlinked folder and its target as one place', () => {
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    expect(samePlace(join(base, 'link'), join(base, 'real'))).toBe(true);
  });

  it('expands a leading ~/ with home', () => {
    mkdirSync(join(base, 'p'));
    expect(samePlace('~/p', join(base, 'p'), { home: base })).toBe(true);
  });

  it('is false for two different folders', () => {
    mkdirSync(join(base, 'a'));
    mkdirSync(join(base, 'b'));
    expect(samePlace(join(base, 'a'), join(base, 'b'))).toBe(false);
  });
});

describe('ownCopy', () => {
  it('reads the version from .claude-plugin/plugin.json, and is null when it cannot', () => {
    mkdirSync(join(base, 'plugin', '.claude-plugin'), { recursive: true });
    writeFileSync(join(base, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'foreman', version: '0.0.9' }));
    expect(ownCopy({ pluginDir: join(base, 'plugin') + '/' })).toEqual({ path: join(base, 'plugin'), version: '0.0.9' });
    expect(ownCopy({ pluginDir: join(base, 'nowhere') })).toEqual({ path: join(base, 'nowhere'), version: null });
  });
});

describe('sessionPlugin', () => {
  const copy = (path, version = '0.0.1') => ({ id: 'foreman@acme-market', scope: 'user', path, version });
  const outside = () => join(base, 'checkout', 'plugin');

  it('loads the supervisor\'s folder when the project is Foreman\'s own repo, even with a copy at the same place', () => {
    const pluginDir = join(root, 'plugin');
    mkdirSync(pluginDir);
    const r = sessionPlugin({ pluginDir: pluginDir + '/', root, copies: [copy(pluginDir)] });
    expect(r).toEqual({ dir: pluginDir, why: 'own-repo', copy: null });
  });

  it('loads it when nothing is installed', () => {
    expect(sessionPlugin({ pluginDir: outside(), root, copies: [] })).toEqual({ dir: outside(), why: 'not-installed', copy: null });
  });

  it('loads it when an installed copy is elsewhere, and names that copy', () => {
    const c = copy(join(base, 'cache', 'foreman', '0.0.1'));
    expect(sessionPlugin({ pluginDir: outside(), root, copies: [c] })).toEqual({ dir: outside(), why: 'differs', copy: c });
  });

  it('adds nothing when every installed copy is the supervisor\'s own folder', () => {
    mkdirSync(outside(), { recursive: true });
    expect(sessionPlugin({ pluginDir: outside() + '/', root, copies: [copy(outside()), copy(outside() + '/')] })).toEqual({ dir: null, why: null, copy: null });
  });

  it('is not changed by FOREMAN_PLUGIN_DIR in the environment', () => {
    const before = process.env.FOREMAN_PLUGIN_DIR;
    process.env.FOREMAN_PLUGIN_DIR = join(base, 'somewhere-else');
    try {
      mkdirSync(outside(), { recursive: true });
      expect(sessionPlugin({ pluginDir: outside(), root, copies: [copy(outside())] })).toEqual({ dir: null, why: null, copy: null });
      expect(sessionPlugin({ pluginDir: outside(), root, copies: [] }).dir).toBe(outside());
    } finally {
      if (before === undefined) delete process.env.FOREMAN_PLUGIN_DIR;
      else process.env.FOREMAN_PLUGIN_DIR = before;
    }
  });

  it('resolves a relative plugin folder', () => {
    expect(sessionPlugin({ pluginDir: 'plugin/', root, copies: [] }).dir).toBe(resolve('plugin'));
  });
});

describe('copyWarning', () => {
  const copy = { id: 'foreman@acme-market', scope: 'user', path: '/opt/acme/cache/0.0.1', version: '0.0.1' };

  it('names both versions, both paths and the label', () => {
    expect(copyWarning({ copy, own: { path: '/opt/acme/checkout/plugin', version: '0.0.2', label: 'a1b2c3d' } })).toBe(
      'The installed Foreman plugin is 0.0.1 (/opt/acme/cache/0.0.1), but this Foreman is 0.0.2 (a1b2c3d) (/opt/acme/checkout/plugin); story sessions load this one with --plugin-dir.',
    );
  });

  it('leaves the label out when it is v<version> or missing, and shows ? for an unknown version', () => {
    const own = { path: '/opt/acme/checkout/plugin', version: '0.0.2' };
    const plain = 'but this Foreman is 0.0.2 (/opt/acme/checkout/plugin);';
    expect(copyWarning({ copy, own: { ...own, label: 'v0.0.2' } })).toContain(plain);
    expect(copyWarning({ copy, own })).toContain(plain);
    expect(copyWarning({ copy: { ...copy, version: null }, own: { ...own, version: null } })).toContain('plugin is ? (/opt/acme/cache/0.0.1), but this Foreman is ? (/opt/acme/checkout/plugin)');
  });
});

describe('initPluginWarning', () => {
  const init = (plugins) => ({ type: 'system', subtype: 'init', plugins });

  it('is null for no init and for an init without a plugins list', () => {
    expect(initPluginWarning({ id: 'ACME-1', init: null, expected: '/opt/acme/plugin' })).toBeNull();
    expect(initPluginWarning({ id: 'ACME-1', init: { type: 'system', subtype: 'init' }, expected: '/opt/acme/plugin' })).toBeNull();
  });

  it('is null when foreman was loaded from the expected folder, trailing slash or not', () => {
    mkdirSync(join(base, 'plugin'));
    const i = init([{ name: 'foreman', path: join(base, 'plugin'), source: 'foreman@inline' }]);
    expect(initPluginWarning({ id: 'ACME-1', init: i, expected: join(base, 'plugin') + '/' })).toBeNull();
  });

  it('says where Foreman came from when that is not the expected folder', () => {
    const i = init([{ name: 'acme-tools', path: '/opt/acme/tools' }, { name: 'foreman', path: '/opt/acme/old', version: '0.0.1' }]);
    expect(initPluginWarning({ id: 'ACME-1', init: i, expected: '/opt/acme/plugin/' })).toBe(
      "ACME-1: its session loaded Foreman 0.0.1 from /opt/acme/old, not this run's code at /opt/acme/plugin.",
    );
  });

  it('leaves the version out when the init has none', () => {
    const i = init([{ name: 'foreman', path: '/opt/acme/old' }]);
    expect(initPluginWarning({ id: 'ACME-1', init: i, expected: '/opt/acme/plugin' })).toContain('loaded Foreman from /opt/acme/old,');
  });

  it('says no Foreman plugin loaded when the list has none', () => {
    expect(initPluginWarning({ id: 'ACME-1', init: init([{ name: 'acme-tools', path: '/opt/acme/tools' }]), expected: '/opt/acme/plugin' })).toBe('ACME-1: its session loaded no Foreman plugin.');
    expect(initPluginWarning({ id: 'ACME-1', init: init([]), expected: '/opt/acme/plugin' })).toBe('ACME-1: its session loaded no Foreman plugin.');
  });
});

describe('samePlace with no path', () => {
  it('is false for an empty or missing path, never the current folder', () => {
    expect(samePlace('', process.cwd())).toBe(false);
    expect(samePlace(undefined, process.cwd())).toBe(false);
  });
});

describe('given a missing or wrong input', () => {
  const copy = (path, version = '0.0.1') => ({ id: 'foreman@acme-market', scope: 'user', path, version });
  const outside = () => join(base, 'checkout', 'plugin');
  const bare = 'The installed Foreman plugin is ? (?), but this Foreman is ? (?); story sessions load this one with --plugin-dir.';

  it('installedCopies is [] with no argument, and keeps only the user entries when root is not a string', () => {
    expect(installedCopies()).toEqual([]);
    installed({
      'foreman@acme-market': [
        { scope: 'user', installPath: '/opt/acme/user', version: '0.0.1' },
        { scope: 'project', projectPath: root, installPath: '/opt/acme/project', version: '0.0.2' },
      ],
    });
    expect(installedCopies({ pluginsDir, root: undefined })).toEqual([
      { id: 'foreman@acme-market', scope: 'user', path: '/opt/acme/user', version: '0.0.1' },
    ]);
  });

  it('ownCopy is null with no argument and when pluginDir is not a string', () => {
    expect(ownCopy()).toBeNull();
    expect(ownCopy({ pluginDir: undefined })).toBeNull();
    expect(ownCopy({ pluginDir: 7 })).toBeNull();
    expect(ownCopy({ pluginDir: '' })).toBeNull();
  });

  it('sessionPlugin gives all-null fields with no pluginDir', () => {
    const none = { dir: null, why: null, copy: null };
    expect(sessionPlugin({ pluginDir: undefined, root, copies: [copy(outside())] })).toEqual(none);
    expect(sessionPlugin()).toEqual(none);
  });

  it('sessionPlugin loads the folder as not-installed when root or the copies list is missing', () => {
    expect(sessionPlugin({ pluginDir: outside(), root: undefined, copies: [] })).toEqual({ dir: outside(), why: 'not-installed', copy: null });
    expect(sessionPlugin({ pluginDir: outside(), root, copies: null })).toEqual({ dir: outside(), why: 'not-installed', copy: null });
    expect(() => sessionPlugin({ pluginDir: outside(), root, copies: [null] })).not.toThrow();
  });

  it('initPluginWarning is null without an expected folder, and with no argument', () => {
    const i = { type: 'system', subtype: 'init', plugins: [{ name: 'foreman', path: '/opt/acme/old' }] };
    expect(initPluginWarning({ id: 'ACME-1', init: i, expected: undefined })).toBeNull();
    expect(initPluginWarning()).toBeNull();
  });

  it('copyWarning gives question marks for a missing copy or own', () => {
    expect(copyWarning()).toBe(bare);
    expect(copyWarning({ copy: null, own: null })).toBe(bare);
  });
});
