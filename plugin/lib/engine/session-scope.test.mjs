import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carryUserSettings, configDir, MCP_NAME, projectMcpServers, readSettingsFile, sessionScope, userMcpServer } from './session-scope.mjs';
import fs from 'node:fs';

let home;
let root;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'foreman-scope-home-'));
  root = mkdtempSync(join(tmpdir(), 'foreman-scope-root-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const writeJson = (file, value) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};
const userSettings = (value, dir = join(home, '.claude')) => writeJson(join(dir, 'settings.json'), value);
const projectSettings = (value) => writeJson(join(root, '.claude', 'settings.json'), value);
const localSettings = (value) => writeJson(join(root, '.claude', 'settings.local.json'), value);
const mcpJson = (value) => writeJson(join(root, '.mcp.json'), value);

const scope = (config = {}, extra = {}) => sessionScope({ config, root, env: {}, homedir: home, packs: {}, ...extra });

describe('carryUserSettings', () => {
  const user = {
    model: 'opus',
    effortLevel: 'high',
    attribution: { commit: '', pr: '' },
    permissions: { allow: ['Bash(git *)'], defaultMode: 'bypassPermissions' },
    sandbox: { enabled: true, excludedCommands: ['docker'] },
    hooks: { Stop: [] },
    enabledPlugins: { 'other@acme': true },
    extraKnownMarketplaces: { acme: {} },
    statusLine: { type: 'command', command: 'acme-status' },
    outputStyle: 'Explanatory',
    autoMemoryEnabled: true,
    claudeMdExcludes: ['/x'],
  };

  it('keeps how the session runs and drops what adds context', () => {
    expect(carryUserSettings({ user })).toEqual({
      model: 'opus',
      effortLevel: 'high',
      attribution: { commit: '', pr: '' },
      permissions: { allow: ['Bash(git *)'], defaultMode: 'bypassPermissions' },
      sandbox: { enabled: true, excludedCommands: ['docker'] },
    });
  });

  it('lets the project and local settings win key by key', () => {
    expect(carryUserSettings({ user: { model: 'opus' }, project: { model: 'sonnet' } })).toEqual({});
    expect(carryUserSettings({ user: { model: 'opus' }, local: { model: 'sonnet' } })).toEqual({});
    expect(carryUserSettings({ user: { env: { A: 'user', B: 'user' } }, project: { env: { A: 'project' } } })).toEqual({ env: { B: 'user' } });
    expect(carryUserSettings({ user: { env: { A: 'user' } }, local: { env: { A: 'local' } } })).toEqual({});
    expect(carryUserSettings({
      user: { permissions: { allow: ['Bash(git *)'], defaultMode: 'bypassPermissions' } },
      project: { permissions: { defaultMode: 'acceptEdits', allow: ['Read'] } },
    })).toEqual({ permissions: { allow: ['Bash(git *)'] } });
    expect(carryUserSettings({
      user: { sandbox: { enabled: true, excludedCommands: ['docker'] } },
      project: { sandbox: { enabled: false } },
    })).toEqual({ sandbox: { excludedCommands: ['docker'] } });
  });

  it('carries nothing from empty or missing layers', () => {
    expect(carryUserSettings({})).toEqual({});
    expect(carryUserSettings({ user: { env: {} } })).toEqual({});
  });
});

describe('configDir and readSettingsFile', () => {
  it('prefers CLAUDE_CONFIG_DIR', () => {
    expect(configDir({ CLAUDE_CONFIG_DIR: '/acme/claude' }, '/home/acme')).toBe('/acme/claude');
    expect(configDir({}, '/home/acme')).toBe('/home/acme/.claude');
    expect(configDir({ CLAUDE_CONFIG_DIR: '' }, '/home/acme')).toBe('/home/acme/.claude');
  });

  it('reads a plain object, else {}', () => {
    const file = join(root, 's.json');
    expect(readSettingsFile(fs, file)).toEqual({});
    writeFileSync(file, '{"model":"opus"}');
    expect(readSettingsFile(fs, file)).toEqual({ model: 'opus' });
    for (const bad of ['not json', '[1]', '"x"', 'null']) {
      writeFileSync(file, bad);
      expect(readSettingsFile(fs, file)).toEqual({});
    }
    expect(readSettingsFile(fs, root)).toEqual({});
  });
});

describe('projectMcpServers and userMcpServer', () => {
  it('reads .mcp.json, missing as none and broken as an error', () => {
    expect(projectMcpServers({ root, fs })).toEqual({ servers: {} });
    mcpJson({ mcpServers: { acmeDb: { command: 'acme-db' } } });
    expect(projectMcpServers({ root, fs })).toEqual({ servers: { acmeDb: { command: 'acme-db' } } });
    mcpJson('{ nope');
    expect(projectMcpServers({ root, fs }).error).toBeTruthy();
  });

  it('finds a server defined at user level, globally or for the project', () => {
    expect(userMcpServer({ name: 'ghost', root, env: {}, homedir: home, fs })).toBe(false);
    writeJson(join(home, '.claude.json'), { mcpServers: { ghost: { command: 'g' } } });
    expect(userMcpServer({ name: 'ghost', root, env: {}, homedir: home, fs })).toBe(true);
    writeJson(join(home, '.claude.json'), { projects: { [root]: { mcpServers: { ghost: { command: 'g' } } } } });
    expect(userMcpServer({ name: 'ghost', root, env: {}, homedir: home, fs })).toBe(true);
    expect(userMcpServer({ name: 'other', root, env: {}, homedir: home, fs })).toBe(false);
    const dir = join(home, 'cfg');
    writeJson(join(dir, '.claude.json'), { mcpServers: { inDir: {} } });
    expect(userMcpServer({ name: 'inDir', root, env: { CLAUDE_CONFIG_DIR: dir }, homedir: home, fs })).toBe(true);
    expect(userMcpServer({ name: 'ghost', root, env: { CLAUDE_CONFIG_DIR: dir }, homedir: home, fs })).toBe(false);
  });

  it('accepts plain server names only', () => {
    for (const good of ['acmeDb', 'acme-db', 'a.b_c', '0x']) expect(MCP_NAME.test(good)).toBe(true);
    for (const bad of ['-x', 'has space', '', '_x', 'a/b']) expect(MCP_NAME.test(bad)).toBe(false);
  });
});

describe('sessionScope', () => {
  it('gives empty settings and no servers with no config and no files', () => {
    expect(scope()).toEqual({ ok: true, scope: { settings: {}, mcpServers: {} } });
    expect(sessionScope({ config: undefined, root, env: {}, homedir: home })).toEqual({ ok: true, scope: { settings: {}, mcpServers: {} } });
  });

  it('enables Foreman, turns the project\'s other plugins off and carries the user model, without hooks', () => {
    userSettings({ model: 'opus', hooks: { Stop: [] }, enabledPlugins: { 'other@acme': true, 'foreman@foreman': true } });
    projectSettings({ enabledPlugins: { 'foreman@foreman': true, 'acme-tools@acme': true } });
    const r = scope();
    expect(r.ok).toBe(true);
    expect(r.scope.settings).toEqual({ model: 'opus', enabledPlugins: { 'foreman@foreman': true, 'acme-tools@acme': false } });
    expect(JSON.stringify(r.scope)).not.toContain('other@acme');
  });

  it('turns local plugins off too, and ignores ids set to false', () => {
    localSettings({ enabledPlugins: { 'acme-local@acme': true, 'acme-off@acme': false } });
    expect(scope().scope.settings).toEqual({ enabledPlugins: { 'acme-local@acme': false } });
  });

  it('keeps a Foreman enabled only at user level', () => {
    userSettings({ enabledPlugins: { 'foreman@mine': true } });
    expect(scope().scope.settings).toEqual({ enabledPlugins: { 'foreman@mine': true } });
  });

  it('carries nothing with userSettings on, and turns the user\'s other plugins off', () => {
    userSettings({ model: 'opus', enabledPlugins: { 'other@acme': true, 'foreman@foreman': true } });
    const r = scope({ session: { userSettings: true } });
    expect(r.scope.settings).toEqual({ enabledPlugins: { 'other@acme': false, 'foreman@foreman': true } });
  });

  it("carries the user's sandbox, unless the session reads the user settings itself", () => {
    userSettings({ sandbox: { enabled: true } });
    expect(scope().scope.settings.sandbox).toEqual({ enabled: true });
    expect(scope({ session: { userSettings: true } }).scope.settings).not.toHaveProperty('sandbox');
  });

  it('reads CLAUDE_CONFIG_DIR instead of the home folder', () => {
    userSettings({ model: 'sonnet' });
    const dir = join(home, 'acme-config');
    userSettings({ model: 'opus' }, dir);
    expect(scope({}, { env: { CLAUDE_CONFIG_DIR: dir } }).scope.settings).toEqual({ model: 'opus' });
    expect(scope().scope.settings).toEqual({ model: 'sonnet' });
  });

  it('adds what the pack needs', () => {
    const packs = { acme: { name: 'acme', sessionNeeds: { plugins: ['acme-sf@acme'], mcpServers: { acmeDocs: { command: 'acme-docs' } } } } };
    projectSettings({ enabledPlugins: { 'acme-sf@acme': true, 'acme-tools@acme': true } });
    const r = scope({ pack: 'acme' }, { packs });
    expect(r.ok).toBe(true);
    expect(r.scope.settings.enabledPlugins).toEqual({ 'acme-sf@acme': true, 'acme-tools@acme': false });
    expect(r.scope.mcpServers).toEqual({ acmeDocs: { command: 'acme-docs' } });
    expect(scope({ pack: 'acme' }, { packs: { acme: { name: 'acme', sessionNeeds: { plugins: ['acme-sf@acme'] } } } }).scope).toEqual({ settings: { enabledPlugins: { 'acme-sf@acme': true, 'acme-tools@acme': false } }, mcpServers: {} });
    rmSync(join(root, '.claude'), { recursive: true });
    expect(scope({ pack: 'acme' }, { packs }).scope.settings).toEqual({ enabledPlugins: { 'acme-sf@acme': true } });
  });

  it('refuses a pack it cannot use, naming it', () => {
    for (const sessionNeeds of [{ plugins: 'x' }, { plugins: [5] }, { mcpServers: { acmeDocs: 'acme-docs' } }, { mcpServers: [] }, 'x']) {
      const r = scope({ pack: 'acme' }, { packs: { acme: { name: 'acme', sessionNeeds } } });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/^pack acme: sessionNeeds/);
    }
    const unknown = scope({ pack: 'ghost' }, { packs: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe('pack ghost: unknown pack: ghost');
    const pack = { name: 'acme' };
    Object.defineProperty(pack, 'sessionNeeds', { get: () => { throw new Error('acme broke'); } });
    expect(scope({ pack: 'acme' }, { packs: { acme: pack } })).toEqual({ ok: false, reason: 'pack acme: acme broke' });
  });

  it('loads only the servers session.mcpServers names', () => {
    mcpJson({ mcpServers: { acmeDb: { command: 'acme-db' }, acmeOther: { command: 'acme-other' } } });
    expect(scope({ session: { mcpServers: ['acmeDb'] } }).scope.mcpServers).toEqual({ acmeDb: { command: 'acme-db' } });
    expect(scope({ session: { mcpServers: [] } }).scope.mcpServers).toEqual({});
  });

  it('lets the project\'s server win over the pack\'s of the same name', () => {
    mcpJson({ mcpServers: { acmeDocs: { command: 'mine' } } });
    const packs = { acme: { name: 'acme', sessionNeeds: { mcpServers: { acmeDocs: { command: 'pack' }, acmeMore: { command: 'more' } } } } };
    expect(scope({ pack: 'acme', session: { mcpServers: ['acmeDocs'] } }, { packs }).scope.mcpServers).toEqual({ acmeDocs: { command: 'mine' }, acmeMore: { command: 'more' } });
  });

  it('refuses names .mcp.json does not define, or a .mcp.json it cannot read', () => {
    mcpJson({ mcpServers: { acmeDb: { command: 'acme-db' } } });
    const r = scope({ session: { mcpServers: ['acmeDb', 'ghost'] } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('session.mcpServers names ghost, which .mcp.json does not define');
    rmSync(join(root, '.mcp.json'));
    const missing = scope({ session: { mcpServers: ['acmeDb', 'ghost'] } });
    expect(missing).toEqual({ ok: false, reason: 'session.mcpServers names acmeDb, ghost, which .mcp.json does not define' });
    mcpJson('{ nope');
    const broken = scope({ session: { mcpServers: ['acmeDb'] } });
    expect(broken.ok).toBe(false);
    expect(broken.reason).toMatch(/^could not read \.mcp\.json: /);
  });

  it('ignores names that are not server names, and reads no .mcp.json for none', () => {
    mcpJson('{ nope');
    expect(scope({ session: { mcpServers: ['-x', 'has space', 5, ''] } })).toEqual({ ok: true, scope: { settings: {}, mcpServers: {} } });
    expect(scope({ session: { mcpServers: 'acmeDb' } })).toEqual({ ok: true, scope: { settings: {}, mcpServers: {} } });
  });

  it('never throws', () => {
    const broken = { readFileSync: () => { throw new Error('disk gone'); }, existsSync: () => true };
    const r = sessionScope({ config: { session: { mcpServers: ['acmeDb'] } }, root, env: {}, homedir: home, fs: broken, packs: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('disk gone');
    const config = {};
    Object.defineProperty(config, 'session', { get: () => { throw new Error('acme config broke'); } });
    expect(sessionScope({ config, root, env: {}, homedir: home, packs: {} })).toEqual({ ok: false, reason: 'acme config broke' });
  });
});
