import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, logPath, result, start, testCoreShare } from './session.mjs';

const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Skill', 'ToolSearch', 'Workflow(foreman:pipeline)'];

// What every story session starts with when user settings are left out (the default).
const LEAN_ARGS = ['--setting-sources', 'project,local', '--strict-mcp-config'];
// The scheduling tools no story session may use (FM-368), right after --strict-mcp-config.
const DENY_ARGS = ['--disallowedTools', 'ScheduleWakeup', 'CronCreate'];
const LEAN = { claudeMdExcludes: ['/home/me/.claude/CLAUDE.md'], autoMemoryEnabled: false };
// The JSON file the path after `flag` names, as the command hands it to start().
const fileOf = (c, flag) => {
  if (!c.args.includes(flag)) return null;
  const path = c.args[c.args.indexOf(flag) + 1];
  const file = c.files.find((f) => f.path === path);
  return file ? JSON.parse(file.text) : undefined;
};
const SETTINGS_PATH = '/repo/.foreman/session-config/w2-settings.json';
const MCP_PATH = '/repo/.foreman/session-config/w2-mcp.json';

const envAdapter = { env: (n) => ({ FOREMAN_SLOT: `w${n}`, APP_PORT: String(3000 + n) }) };
const base = (console) => ({
  id: 'S-2',
  mode: '',
  config: { console },
  slot: 'w2',
  n: 2,
  root: '/repo',
  stateDir: '/repo/.foreman',
  supervisorPid: 4242,
  envAdapter,
  baseEnv: { PATH: '/bin', HOME: '/home/me' },
});

describe('session.command', () => {
  it('builds the story command with the plugin tools', () => {
    const c = command(base({ adapter: 'dashboard' }));
    expect(c.cmd).toBe('claude');
    expect(c.args).toEqual(['-p', '/foreman:story S-2', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', ...LEAN_ARGS, ...DENY_ARGS, '--settings', SETTINGS_PATH, '--allowedTools', ...TOOLS]);
    expect(fileOf(c, '--settings')).toEqual(LEAN);
  });

  it('passes config session.model as --model, right after the permission flag, and nothing without it', () => {
    const c = command({ ...base({ adapter: 'files' }), config: { console: { adapter: 'files' }, session: { model: 'sonnet' } } });
    expect(c.args).toEqual(['-p', '/foreman:story S-2', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--model', 'sonnet', ...LEAN_ARGS, ...DENY_ARGS, '--settings', SETTINGS_PATH, '--allowedTools', ...TOOLS]);
    expect(command({ ...base({ adapter: 'files' }), config: { console: { adapter: 'files' }, session: {} } }).args).not.toContain('--model');
  });

  it('loads the plugin from FOREMAN_PLUGIN_DIR when it is set', () => {
    const c = command({ ...base({ adapter: 'files' }), baseEnv: { FOREMAN_PLUGIN_DIR: '/plugins/foreman' } });
    expect(c.args).toEqual(['-p', '/foreman:story S-2', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', ...LEAN_ARGS, ...DENY_ARGS, '--plugin-dir', '/plugins/foreman', '--settings', SETTINGS_PATH, '--allowedTools', ...TOOLS]);
    expect(fileOf(c, '--settings')).toEqual({ autoMemoryEnabled: false });
    expect(command({ ...base({ adapter: 'files' }), baseEnv: { FOREMAN_PLUGIN_DIR: '' } }).args).not.toContain('--plugin-dir');
  });

  describe('pluginDir', () => {
    const files = (extra) => ({ ...base({ adapter: 'files' }), ...extra });
    const baseArgs = command(files({})).args;

    it('puts --plugin-dir right before --settings, where the environment case puts it', () => {
      const c = command(files({ pluginDir: '/plugins/foreman' }));
      expect(c.args).toEqual(command(files({ baseEnv: { PATH: '/bin', HOME: '/home/me', FOREMAN_PLUGIN_DIR: '/plugins/foreman' } })).args);
      expect(c.args.indexOf('--plugin-dir') + 2).toBe(c.args.indexOf('--settings'));
      expect(c.args.slice(c.args.indexOf('--plugin-dir'), c.args.indexOf('--plugin-dir') + 2)).toEqual(['--plugin-dir', '/plugins/foreman']);
    });

    it('decides alone: null or an empty string gives no flag, whatever FOREMAN_PLUGIN_DIR says', () => {
      const baseEnv = { PATH: '/bin', HOME: '/home/me', FOREMAN_PLUGIN_DIR: '/plugins/env' };
      expect(command(files({ pluginDir: null, baseEnv })).args).toEqual(baseArgs);
      expect(command(files({ pluginDir: '', baseEnv })).args).toEqual(baseArgs);
    });

    it('beats FOREMAN_PLUGIN_DIR when both are set', () => {
      const c = command(files({ pluginDir: '/plugins/own', baseEnv: { FOREMAN_PLUGIN_DIR: '/plugins/env' } }));
      expect(c.args).toContain('/plugins/own');
      expect(c.args).not.toContain('/plugins/env');
    });

    it('left out, falls back to FOREMAN_PLUGIN_DIR', () => {
      expect(command(files({ baseEnv: { FOREMAN_PLUGIN_DIR: '/plugins/env' } })).args).toContain('/plugins/env');
      expect(command(files({ pluginDir: undefined })).args).toEqual(baseArgs);
    });
  });

  it('keeps the session persisted in every variant, so its agents leave transcripts to count', () => {
    const variants = [
      base({ adapter: 'dashboard' }),
      base({ adapter: 'artifacts' }),
      { ...base({ adapter: 'files' }), mode: 'after-halt' },
      { ...base({ adapter: 'files' }), baseEnv: { FOREMAN_PLUGIN_DIR: '/plugins/foreman' } },
      { ...base({ adapter: 'files' }), config: { console: { adapter: 'files' }, session: { extraTools: ['mcp__acme__query'] } } },
      { ...base({ adapter: 'files' }), packSession: { env: { A: '1' }, pathPrefix: ['/srv/acme/bin'], settings: { x: 1 } } },
      { ...base({ adapter: 'files' }), fileKeys: { ANTHROPIC_API_KEY: 'k' } },
      { ...base({ adapter: 'files' }), scope: { settings: { model: 'opus' }, mcpServers: { acmeDb: { command: 'acme-db' } } } },
      { ...base({ adapter: 'files' }), config: { console: { adapter: 'files' }, session: { userSettings: true } } },
    ];
    for (const v of variants) expect(command(v).args).not.toContain('--no-session-persistence');
  });

  it('adds the mode word after the id', () => {
    const c = command({ ...base({ adapter: 'files' }), mode: 'after-halt' });
    expect(c.args[1]).toBe('/foreman:story S-2 after-halt');
  });

  it('sets the FOREMAN_* environment over the base and the slot environment', () => {
    const { env } = command(base({ adapter: 'files' }));
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/me',
      APP_PORT: '3002',
      FOREMAN_RUN: '1',
      FOREMAN_PROJECT_DIR: '/repo',
      FOREMAN_STATE_DIR: '/repo/.foreman',
      FOREMAN_SLOT: 'w2',
      FOREMAN_STORY: 'S-2',
      FOREMAN_SUPERVISOR_PID: '4242',
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
    });
  });

  it('has no entrypoint override and no ArtifactData unless the console is artifacts', () => {
    const c = command({ ...base({ adapter: 'dashboard' }), baseEnv: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
    expect(c.env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(c.args).not.toContain('ArtifactData');
    expect(command({ ...base(undefined), config: {} }).args).not.toContain('ArtifactData');
  });

  it('gives the artifacts console its tool and entrypoint', () => {
    const c = command(base({ adapter: 'artifacts' }));
    expect(c.args.slice(c.args.indexOf('--allowedTools') + 1)).toEqual([...TOOLS, 'ArtifactData']);
    expect(c.env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-vscode');
  });

  const withSession = (console, session) => ({ ...base(console), config: { console, session } });
  const allowed = (args) => args.slice(args.indexOf('--allowedTools') + 1);
  const before = (args) => args.slice(0, args.indexOf('--allowedTools') + 1);

  it('appends session.extraTools after the plugin tools', () => {
    const plain = command(base({ adapter: 'dashboard' }));
    const c = command(withSession({ adapter: 'dashboard' }, { extraTools: ['mcp__acme__query', 'mcp__acme__deploy'] }));
    expect(allowed(c.args)).toEqual([...TOOLS, 'mcp__acme__query', 'mcp__acme__deploy']);
    expect(before(c.args)).toEqual(before(plain.args));
  });

  it('builds the same command when session.extraTools is unset or empty', () => {
    const plain = command(base({ adapter: 'dashboard' }));
    for (const session of [undefined, {}, { extraTools: [] }]) {
      expect(command(withSession({ adapter: 'dashboard' }, session)).args).toEqual(plain.args);
    }
  });

  it('puts the extra tools after ArtifactData for the artifacts console', () => {
    const c = command(withSession({ adapter: 'artifacts' }, { extraTools: ['mcp__acme__query'] }));
    expect(allowed(c.args)).toEqual([...TOOLS, 'ArtifactData', 'mcp__acme__query']);
  });

  it('drops extra tool names that are not plain tool names', () => {
    const c = command(withSession({ adapter: 'dashboard' }, { extraTools: ['--dangerously-skip-permissions', '', 5, 'has space', 'mcp__acme__query'] }));
    expect(allowed(c.args)).toEqual([...TOOLS, 'mcp__acme__query']);
    expect(c.args.some((a) => a.startsWith('--dangerously'))).toBe(false);
    expect(command(withSession({ adapter: 'dashboard' }, { extraTools: 'x' })).args).toEqual(command(base({ adapter: 'dashboard' })).args);
  });
});

describe("session.command with the sign-in keys from Foreman's own keys file", () => {
  const fileKeys = { ANTHROPIC_API_KEY: 'sk-acme-file', CLAUDE_CODE_OAUTH_TOKEN: 'tok-acme-file', RESEND_API_KEY: 're_acme', JIRA_CLIENT_SECRET: 'acme-secret' };

  it('puts exactly the two Claude names in the env, never the others', () => {
    const { env } = command({ ...base({ adapter: 'dashboard' }), fileKeys });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-acme-file');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-acme-file');
    expect(env).not.toHaveProperty('RESEND_API_KEY');
    expect(env).not.toHaveProperty('JIRA_CLIENT_SECRET');
  });

  it('lets a baseEnv value win over the file', () => {
    const { env } = command({ ...base({ adapter: 'dashboard' }), baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-acme-env' }, fileKeys });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-acme-env');
  });

  it('builds the same command with no fileKeys as before', () => {
    expect(command({ ...base({ adapter: 'dashboard' }), fileKeys: {} })).toEqual(command(base({ adapter: 'dashboard' })));
    expect(command(base({ adapter: 'dashboard' })).env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
});

describe('session.command on the subscription after the credits ran out', () => {
  const KEY = 'sk-ant-acme-fake-0000000000000000000000';
  const everywhere = () => ({
    ...base({ adapter: 'dashboard' }),
    baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: KEY },
    fileKeys: { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: 'acme-oauth-fake' },
    envAdapter: { env: () => ({ ANTHROPIC_API_KEY: KEY }) },
    packSession: { env: { ANTHROPIC_API_KEY: KEY } },
  });

  it('leaves ANTHROPIC_API_KEY out wherever it came from, and keeps the token', () => {
    const { env, args } = command({ ...everywhere(), useSubscription: true });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('acme-oauth-fake');
    expect(JSON.stringify({ env, args })).not.toContain(KEY);
  });

  it('is the same command as before with the flag off', () => {
    expect(command({ ...everywhere(), useSubscription: false })).toEqual(command(everywhere()));
    expect(command(everywhere()).env.ANTHROPIC_API_KEY).toBe(KEY);
  });
});

describe('session.command with a pack session', () => {
  const SETTINGS = { ...LEAN, enabledPlugins: { 'salesforce-development@salesforce': false } };
  const packSession = {
    env: { FOREMAN_SF_HOME: '/srv/acme/sf-home', SF_DISABLE_TELEMETRY: 'true' },
    pathPrefix: ['/srv/acme/sf-home/.foreman/bin'],
    settings: { enabledPlugins: { 'salesforce-development@salesforce': false } },
  };
  const at = (args, flag) => args.indexOf(flag);

  it('builds the same command with packSession null as without it', () => {
    for (const console of [{ adapter: 'dashboard' }, { adapter: 'artifacts' }]) {
      expect(command({ ...base(console), packSession: null })).toEqual(command(base(console)));
    }
    const plugin = { ...base({ adapter: 'files' }), baseEnv: { FOREMAN_PLUGIN_DIR: '/plugins/foreman', PATH: '/bin' } };
    expect(command({ ...plugin, packSession: null })).toEqual(command(plugin));
  });

  it('adds the pack env, puts the prefix first on PATH, and passes --settings just before --allowedTools', () => {
    const c = command({ ...base({ adapter: 'dashboard' }), packSession });
    expect(c.env).toMatchObject({ FOREMAN_SF_HOME: '/srv/acme/sf-home', SF_DISABLE_TELEMETRY: 'true', HOME: '/home/me' });
    expect(c.env.PATH).toBe('/srv/acme/sf-home/.foreman/bin:/bin');
    expect(fileOf(c, '--settings')).toEqual(SETTINGS);
    expect(at(c.args, '--settings') + 2).toBe(at(c.args, '--allowedTools'));
    expect(c.args.slice(at(c.args, '--allowedTools') + 1)).toEqual(TOOLS);
  });

  it('puts --settings after --plugin-dir when the plugin folder is set', () => {
    const c = command({ ...base({ adapter: 'files' }), baseEnv: { FOREMAN_PLUGIN_DIR: '/plugins/foreman', PATH: '/bin' }, packSession });
    expect(c.args.slice(at(c.args, '--plugin-dir'))).toEqual(['--plugin-dir', '/plugins/foreman', '--settings', SETTINGS_PATH, '--allowedTools', ...TOOLS]);
    expect(fileOf(c, '--settings')).toEqual({ autoMemoryEnabled: false, enabledPlugins: { 'salesforce-development@salesforce': false } });
  });

  it('never lets the pack env override the FOREMAN_* keys', () => {
    const c = command({ ...base({ adapter: 'files' }), packSession: { ...packSession, env: { FOREMAN_RUN: '0', FOREMAN_STORY: 'X-9' } } });
    expect(c.env.FOREMAN_RUN).toBe('1');
    expect(c.env.FOREMAN_STORY).toBe('S-2');
  });

  it('passes only the lean settings for empty pack settings, and leaves PATH alone with no prefix', () => {
    const c = command({ ...base({ adapter: 'files' }), packSession: { env: {}, pathPrefix: [], settings: {} } });
    expect(fileOf(c, '--settings')).toEqual(LEAN);
    expect(c.args).toEqual(command(base({ adapter: 'files' })).args);
    expect(c.env.PATH).toBe('/bin');
  });

  it('starts PATH with the prefix when the base has no PATH', () => {
    const c = command({ ...base({ adapter: 'files' }), baseEnv: {}, packSession });
    expect(c.env.PATH).toBe('/srv/acme/sf-home/.foreman/bin');
  });
});

describe('session.command: the lean session', () => {
  const scope = {
    settings: { enabledPlugins: { 'foreman@foreman': true, 'acme-tools@acme': false }, model: 'opus' },
    mcpServers: { acmeDb: { command: 'acme-db' } },
  };
  const withConfig = (session, extra = {}) => ({ ...base({ adapter: 'dashboard' }), config: { console: { adapter: 'dashboard' }, session }, ...extra });

  it('loads project and local settings only, the named MCP servers only, and leaves out the user CLAUDE.md and memory', () => {
    const c = command({ ...base({ adapter: 'dashboard' }), scope });
    expect(c.args).toEqual([
      '-p', '/foreman:story S-2', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none',
      '--setting-sources', 'project,local',
      '--mcp-config', MCP_PATH,
      '--strict-mcp-config',
      ...DENY_ARGS,
      '--settings', SETTINGS_PATH,
      '--allowedTools', ...TOOLS,
    ]);
    expect(fileOf(c, '--mcp-config')).toEqual({ mcpServers: { acmeDb: { command: 'acme-db' } } });
    expect(fileOf(c, '--settings')).toEqual({
      claudeMdExcludes: ['/home/me/.claude/CLAUDE.md'],
      autoMemoryEnabled: false,
      enabledPlugins: { 'foreman@foreman': true, 'acme-tools@acme': false },
      model: 'opus',
    });
  });

  it('keeps the strict MCP config and the lean settings with no scope', () => {
    for (const s of [null, undefined, {}, { settings: {}, mcpServers: {} }]) {
      const c = command({ ...base({ adapter: 'dashboard' }), scope: s });
      expect(c.args).not.toContain('--mcp-config');
      expect(c.args).toContain('--strict-mcp-config');
      expect(c.args.slice(7, 9)).toEqual(['--setting-sources', 'project,local']);
      expect(fileOf(c, '--settings')).toEqual(LEAN);
    }
  });

  it('loads the user settings when session.userSettings is on, still with the strict MCP config', () => {
    const c = command(withConfig({ userSettings: true }, { scope }));
    expect(c.args).not.toContain('--setting-sources');
    expect(c.args).toContain('--strict-mcp-config');
    expect(c.args).toContain('--mcp-config');
    expect(fileOf(c, '--settings')).toEqual(scope.settings);
    const bare = command(withConfig({ userSettings: true }, { scope: { settings: {}, mcpServers: {} } }));
    expect(bare.args).toEqual(['-p', '/foreman:story S-2', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--strict-mcp-config', ...DENY_ARGS, '--allowedTools', ...TOOLS]);
    // only exactly true turns them on
    expect(command(withConfig({ userSettings: 'yes' })).args).toContain('--setting-sources');
  });

  it('excludes the CLAUDE.md in CLAUDE_CONFIG_DIR when it is set', () => {
    const c = command({ ...base({ adapter: 'dashboard' }), baseEnv: { HOME: '/home/me', CLAUDE_CONFIG_DIR: '/srv/acme/claude' } });
    expect(fileOf(c, '--settings').claudeMdExcludes).toEqual(['/srv/acme/claude/CLAUDE.md']);
    expect(fileOf(command({ ...base({ adapter: 'dashboard' }), baseEnv: {} }), '--settings')).toEqual({ autoMemoryEnabled: false });
  });

  it('merges the pack settings over the scope, keeping every rule', () => {
    const packSession = { env: {}, pathPrefix: [], settings: { enabledPlugins: { 'salesforce-development@salesforce': false }, permissions: { deny: ['Read(//k/**)'] } } };
    const carried = { settings: { permissions: { allow: ['Bash(git *)'], deny: ['WebFetch'] }, enabledPlugins: { 'foreman@foreman': true } }, mcpServers: {} };
    const c = command({ ...base({ adapter: 'files' }), baseEnv: { HOME: '/home/me', FOREMAN_PLUGIN_DIR: '/plugins/foreman' }, scope: carried, packSession });
    expect(fileOf(c, '--settings')).toEqual({
      ...LEAN,
      enabledPlugins: { 'foreman@foreman': true, 'salesforce-development@salesforce': false },
      permissions: { allow: ['Bash(git *)'], deny: ['WebFetch', 'Read(//k/**)'] },
    });
    const at = (flag) => c.args.indexOf(flag);
    expect(at('--plugin-dir') + 2).toBe(at('--settings'));
    expect(at('--settings') + 2).toBe(at('--allowedTools'));
    // the pack's value wins over the scope's for the same key, and a repeated rule is kept once
    const clash = command({ ...base({ adapter: 'files' }), scope: { settings: { enabledPlugins: { 'salesforce-development@salesforce': true }, permissions: { deny: ['Read(//k/**)'] } } }, packSession });
    expect(fileOf(clash, '--settings').enabledPlugins).toEqual({ 'salesforce-development@salesforce': false });
    expect(fileOf(clash, '--settings').permissions.deny).toEqual(['Read(//k/**)']);
  });
});

describe('session.command: the scheduling tools are denied (FM-368)', () => {
  const at = (c, flag) => c.args.indexOf(flag);

  it('denies ScheduleWakeup and CronCreate right after --strict-mcp-config, and keeps --allowedTools last and intact', () => {
    const c = command(base({ adapter: 'dashboard' }));
    const d = at(c, '--disallowedTools');
    expect(d).toBeGreaterThan(-1);
    expect(c.args.slice(d, d + 3)).toEqual(DENY_ARGS);
    expect(c.args[d - 1]).toBe('--strict-mcp-config');
    expect(at(c, '--allowedTools')).toBeGreaterThan(d + 2);
    expect(c.args.slice(at(c, '--allowedTools'))).toEqual(['--allowedTools', ...TOOLS]);
    expect(c.args[at(c, '--settings') + 2]).toBe('--allowedTools');
  });

  it('puts them in the same place in every variant', () => {
    const scope = { settings: { model: 'opus' }, mcpServers: { acmeDb: { command: 'acme-db' } } };
    const variants = {
      userSettings: { ...base({ adapter: 'dashboard' }), config: { console: { adapter: 'dashboard' }, session: { userSettings: true } } },
      mcp: { ...base({ adapter: 'dashboard' }), scope },
      artifacts: base({ adapter: 'artifacts' }),
      pluginDir: { ...base({ adapter: 'files' }), pluginDir: '/plugins/foreman' },
      subscription: { ...base({ adapter: 'dashboard' }), useSubscription: true },
    };
    for (const [name, input] of Object.entries(variants)) {
      const c = command(input);
      const s = at(c, '--strict-mcp-config');
      expect(c.args.slice(s + 1, s + 4), name).toEqual(DENY_ARGS);
      expect(c.args.slice(at(c, '--allowedTools'))[0], name).toBe('--allowedTools');
      expect(c.args.filter((a) => a === '--disallowedTools'), name).toHaveLength(1);
    }
    const m = command(variants.mcp);
    expect(m.args[at(m, '--mcp-config') + 2]).toBe('--strict-mcp-config');
    expect(at(m, '--mcp-config')).toBeLessThan(at(m, '--disallowedTools'));
    const p = command(variants.pluginDir);
    expect(at(p, '--disallowedTools')).toBeLessThan(at(p, '--plugin-dir'));
    expect(at(p, '--plugin-dir') + 2).toBe(at(p, '--settings'));
  });

  it('cannot be lifted by session.extraTools', () => {
    const c = command({ ...base({ adapter: 'dashboard' }), config: { console: { adapter: 'dashboard' }, session: { extraTools: ['ScheduleWakeup', 'mcp__acme__query'] } } });
    const s = at(c, '--strict-mcp-config');
    expect(c.args.slice(s + 1, s + 4)).toEqual(DENY_ARGS);
  });
});

describe('session.command: the settings and MCP config go in files, not on the command line', () => {
  const secrets = {
    settings: { env: { ACME_TOKEN: 'acme-fake-token' }, apiKeyHelper: '/srv/acme/key.sh' },
    mcpServers: { acmeDb: { command: 'acme-db', env: { ACME_DB_PASSWORD: 'acme-fake-pw' }, headers: { Authorization: 'Bearer acme-fake' } } },
  };

  it('puts no secret on the argv', () => {
    const c = command({ ...base({ adapter: 'dashboard' }), scope: secrets });
    const argv = JSON.stringify(c.args);
    for (const secret of ['acme-fake-token', 'acme-fake-pw', 'Bearer acme-fake', '/srv/acme/key.sh']) expect(argv).not.toContain(secret);
    expect(c.args.some((a) => a.startsWith('{'))).toBe(false);
    expect(fileOf(c, '--settings').env.ACME_TOKEN).toBe('acme-fake-token');
    expect(fileOf(c, '--settings').apiKeyHelper).toBe('/srv/acme/key.sh');
    expect(fileOf(c, '--mcp-config')).toEqual({ mcpServers: secrets.mcpServers });
  });

  it("names one pair of files per slot under the state folder, in the flags' usual places", () => {
    const c = command({ ...base({ adapter: 'dashboard' }), scope: secrets });
    const at = (flag) => c.args.indexOf(flag);
    expect(c.args[at('--settings') + 1]).toBe(SETTINGS_PATH);
    expect(c.args[at('--mcp-config') + 1]).toBe(MCP_PATH);
    expect(c.args[at('--mcp-config') + 2]).toBe('--strict-mcp-config');
    expect(at('--settings') + 2).toBe(at('--allowedTools'));
    expect(c.files.map((f) => f.path)).toEqual([SETTINGS_PATH, MCP_PATH]);
    const w3 = command({ ...base({ adapter: 'dashboard' }), slot: 'w3', n: 3, scope: secrets });
    expect(w3.args[w3.args.indexOf('--settings') + 1]).toBe('/repo/.foreman/session-config/w3-settings.json');
    expect(w3.args[w3.args.indexOf('--mcp-config') + 1]).toBe('/repo/.foreman/session-config/w3-mcp.json');
  });

  it('has a file only for a flag it passes', () => {
    const bare = command({ ...base({ adapter: 'dashboard' }), config: { console: { adapter: 'dashboard' }, session: { userSettings: true } }, scope: { settings: {}, mcpServers: {} } });
    expect(bare.files).toEqual([]);
    expect(bare.args).toEqual(['-p', '/foreman:story S-2', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--strict-mcp-config', ...DENY_ARGS, '--allowedTools', ...TOOLS]);
    const lean = command(base({ adapter: 'dashboard' }));
    expect(lean.files).toEqual([{ path: SETTINGS_PATH, text: JSON.stringify(LEAN) }]);
    expect(lean.args).not.toContain('--mcp-config');
  });
});

describe("session.command: the session's environment goes in a file for `foreman checks`", () => {
  const ENV_PATH = '/repo/.foreman/session-config/w2-env.json';

  it("returns the env file next to the slot's other files, holding the env less the Claude sign-in keys", () => {
    const c = command({ ...base({ adapter: 'files' }), baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'acme-key', CLAUDE_CODE_OAUTH_TOKEN: 'acme-token' } });
    expect(c.envFile.path).toBe(ENV_PATH);
    const { ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, ...rest } = c.env;
    expect(ANTHROPIC_API_KEY).toBe('acme-key');
    expect(CLAUDE_CODE_OAUTH_TOKEN).toBe('acme-token');
    expect(JSON.parse(c.envFile.text)).toEqual(rest);
    expect(c.files.map((f) => f.path)).not.toContain(ENV_PATH);
  });

  it('holds exactly the env when it has no sign-in keys', () => {
    const c = command(base({ adapter: 'files' }));
    expect(JSON.parse(c.envFile.text)).toEqual(c.env);
  });

  it('leaves out a key read from the keys file, which the session itself still gets', () => {
    const c = command({ ...base({ adapter: 'files' }), fileKeys: { CLAUDE_CODE_OAUTH_TOKEN: 'acme-token' } });
    expect(c.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('acme-token');
    expect(JSON.parse(c.envFile.text)).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(c.envFile.text).not.toContain('acme-token');
  });

  it('is one file per slot', () => {
    const w3 = command({ ...base({ adapter: 'files' }), slot: 'w3', n: 3 });
    expect(w3.envFile.path).toBe('/repo/.foreman/session-config/w3-env.json');
  });

  it('is taken after the subscription change, and never holds the API key', () => {
    const c = command({ ...base({ adapter: 'files' }), baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'acme-key' }, useSubscription: true });
    expect(c.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.parse(c.envFile.text)).not.toHaveProperty('ANTHROPIC_API_KEY');
    const kept = command({ ...base({ adapter: 'files' }), baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'acme-key' } });
    expect(kept.env.ANTHROPIC_API_KEY).toBe('acme-key');
    expect(JSON.parse(kept.envFile.text)).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('is taken after the entrypoint and the PATH prefix', () => {
    const c = command({ ...base({ adapter: 'artifacts' }), packSession: { env: {}, pathPrefix: ['/srv/acme/bin'], settings: {} } });
    const written = JSON.parse(c.envFile.text);
    expect(written.PATH).toBe('/srv/acme/bin:/bin');
    expect(written.CLAUDE_CODE_ENTRYPOINT).toBe('claude-vscode');
  });

  it('leaves the files the flags name exactly as they were', () => {
    const lean = command(base({ adapter: 'dashboard' }));
    expect(lean.files).toEqual([{ path: SETTINGS_PATH, text: JSON.stringify(LEAN) }]);
  });
});

describe('session.testCoreShare', () => {
  it('splits the cores between the slots, at least 2 each', () => {
    expect(testCoreShare(18, 5)).toBe(3);
    expect(testCoreShare(18, 1)).toBe(18);
    expect(testCoreShare(4, 3)).toBe(2);
    expect(testCoreShare(1, 1)).toBe(2);
  });

  it('counts cores or slots that are not a positive whole number as 1', () => {
    expect(testCoreShare(18, 0)).toBe(18);
    expect(testCoreShare(NaN, 5)).toBe(2);
    expect(testCoreShare(18, -2)).toBe(18);
    expect(testCoreShare(18, 2.5)).toBe(18);
    expect(testCoreShare(undefined, undefined)).toBe(2);
  });
});

describe("session.command with the slot's share of the cores", () => {
  const TOO_MANY = { FOREMAN_TEST_CORES: '99' };

  it('gives the session FOREMAN_TEST_CORES', () => {
    expect(command({ ...base({ adapter: 'files' }), testCores: 3 }).env.FOREMAN_TEST_CORES).toBe('3');
  });

  it('wins over the base env, the env adapter and the pack env', () => {
    const fromAdapter = { env: (n) => ({ ...envAdapter.env(n), ...TOO_MANY }) };
    const variants = [
      { ...base({ adapter: 'files' }), baseEnv: { PATH: '/bin', ...TOO_MANY } },
      { ...base({ adapter: 'files' }), envAdapter: fromAdapter },
      { ...base({ adapter: 'files' }), packSession: { env: TOO_MANY, pathPrefix: [], settings: {} } },
    ];
    for (const v of variants) expect(command({ ...v, testCores: 3 }).env.FOREMAN_TEST_CORES).toBe('3');
  });

  it('leaves the env and args as they were without a share, passing a base value through', () => {
    const plain = command(base({ adapter: 'files' }));
    expect(plain.env).not.toHaveProperty('FOREMAN_TEST_CORES');
    for (const testCores of [undefined, null, 0, -1, 2.5, NaN, '3']) {
      expect(command({ ...base({ adapter: 'files' }), testCores }), String(testCores)).toEqual(plain);
    }
    const carried = { ...base({ adapter: 'files' }), baseEnv: { PATH: '/bin', FOREMAN_TEST_CORES: '4' } };
    expect(command(carried).env.FOREMAN_TEST_CORES).toBe('4');
  });

  it('changes nothing else in the command', () => {
    const plain = command(base({ adapter: 'files' }));
    const shared = command({ ...base({ adapter: 'files' }), testCores: 3 });
    expect(shared.args).toEqual(plain.args);
    expect(shared.cmd).toBe(plain.cmd);
    const { FOREMAN_TEST_CORES, ...rest } = shared.env;
    expect(FOREMAN_TEST_CORES).toBe('3');
    expect(rest).toEqual(plain.env);
  });
});

describe('session.logPath', () => {
  it('names the log after the slot and the time', () => {
    expect(logPath({ stateDir: '/s', slot: 'w1', now: new Date('2026-10-15T09:08:07Z') })).toBe('/s/logs/w1-20261015-090807.log');
  });

  // Two sessions of one slot can start in the same second (one that ends at once, then the next
  // story). Sharing a log would mix their transcripts, and the second would be read by the first's result.
  it('never names a log that is already there: the next free -2, -3', () => {
    const now = new Date('2026-10-15T09:08:07Z');
    const there = new Set(['/s/logs/w1-20261015-090807.log']);
    expect(logPath({ stateDir: '/s', slot: 'w1', now, taken: (f) => there.has(f) })).toBe('/s/logs/w1-20261015-090807-2.log');
    there.add('/s/logs/w1-20261015-090807-2.log');
    expect(logPath({ stateDir: '/s', slot: 'w1', now, taken: (f) => there.has(f) })).toBe('/s/logs/w1-20261015-090807-3.log');
  });
});

describe('session.start', () => {
  it('spawns detached in the worktree with output to the log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-session-'));
    try {
      const calls = [];
      const fake = (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        return { pid: 1 };
      };
      const logFile = join(dir, 'w1.log');
      const child = start({ cmd: 'claude', args: ['-p', 'x'], env: { A: '1' }, cwd: '/wt', logFile, spawn: fake });
      expect(child).toEqual({ pid: 1 });
      expect(calls).toHaveLength(1);
      const { opts } = calls[0];
      expect(calls[0].cmd).toBe('claude');
      expect(opts).toMatchObject({ cwd: '/wt', env: { A: '1' }, detached: true });
      expect(opts.stdio[0]).toBe('ignore');
      expect(typeof opts.stdio[1]).toBe('number');
      expect(opts.stdio[2]).toBe(opts.stdio[1]);
      expect(readFileSync(logFile, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const inTempDir = (fn) => () => {
    const dir = mkdtempSync(join(tmpdir(), 'foreman-session-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const run = (dir, extra) => start({ cmd: 'claude', args: [], env: {}, cwd: '/wt', logFile: join(dir, 'logs', 'w1.log'), spawn: () => ({ pid: 1 }), ...extra });

  it('writes the session files with mode 600 before it spawns', inTempDir((dir) => {
    const path = join(dir, 'session-config', 'w1-settings.json');
    const seen = [];
    const spawn = () => {
      seen.push({ there: existsSync(path), text: existsSync(path) ? readFileSync(path, 'utf8') : null });
      return { pid: 1 };
    };
    run(dir, { files: [{ path, text: '{"a":1}' }], spawn });
    expect(seen).toEqual([{ there: true, text: '{"a":1}' }]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }));

  it("replaces a looser file the slot's last session left with the new text and mode 600", inTempDir((dir) => {
    const path = join(dir, 'session-config', 'w1-settings.json');
    mkdirSync(join(dir, 'session-config'));
    writeFileSync(path, '{"old":true}');
    chmodSync(path, 0o644);
    run(dir, { files: [{ path, text: '{"new":true}' }] });
    expect(readFileSync(path, 'utf8')).toBe('{"new":true}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }));

  it('replaces a symlink at the path instead of writing through it', inTempDir((dir) => {
    const path = join(dir, 'session-config', 'w1-settings.json');
    const elsewhere = join(dir, 'elsewhere.json');
    writeFileSync(elsewhere, 'untouched');
    mkdirSync(join(dir, 'session-config'));
    symlinkSync(elsewhere, path);
    run(dir, { files: [{ path, text: '{"new":true}' }] });
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{"new":true}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }));

  it('writes the env file with mode 600 after the other files and before it spawns', inTempDir((dir) => {
    const settings = join(dir, 'session-config', 'w1-settings.json');
    const envPath = join(dir, 'session-config', 'w1-env.json');
    const seen = [];
    const spawn = () => {
      seen.push({ settings: existsSync(settings), env: existsSync(envPath) ? readFileSync(envPath, 'utf8') : null });
      return { pid: 1 };
    };
    run(dir, { files: [{ path: settings, text: '{}' }], envFile: { path: envPath, text: '{"A":"1"}' }, spawn });
    expect(seen).toEqual([{ settings: true, env: '{"A":"1"}' }]);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  }));

  it('replaces a looser env file the last session left', inTempDir((dir) => {
    const envPath = join(dir, 'session-config', 'w1-env.json');
    mkdirSync(join(dir, 'session-config'));
    writeFileSync(envPath, '{"OLD":"1"}');
    chmodSync(envPath, 0o644);
    run(dir, { envFile: { path: envPath, text: '{"NEW":"1"}' } });
    expect(readFileSync(envPath, 'utf8')).toBe('{"NEW":"1"}');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  }));

  it('spawns nothing when the env file cannot be written', inTempDir((dir) => {
    writeFileSync(join(dir, 'session-config'), 'not a folder');
    const calls = [];
    const spawn = () => {
      calls.push(1);
      return { pid: 1 };
    };
    expect(() => run(dir, { envFile: { path: join(dir, 'session-config', 'w1-env.json'), text: '{}' }, spawn })).toThrow();
    expect(calls).toEqual([]);
  }));

  it('writes nothing with no files', inTempDir((dir) => {
    run(dir, {});
    run(dir, { files: [] });
    expect(existsSync(join(dir, 'session-config'))).toBe(false);
  }));

  it('refuses to spawn when a file cannot be written', inTempDir((dir) => {
    writeFileSync(join(dir, 'session-config'), 'not a folder');
    const calls = [];
    const spawn = () => {
      calls.push(1);
      return { pid: 1 };
    };
    expect(() => run(dir, { files: [{ path: join(dir, 'session-config', 'w1-settings.json'), text: '{}' }], spawn })).toThrow();
    expect(calls).toEqual([]);
  }));
});

describe('session.result', () => {
  it('reads how the session ended from its log', () => {
    expect(result('...\nFACTORY_RESULT: shipped S-2\n')).toMatchObject({ result: 'shipped', story: 'S-2' });
    expect(result('')).toMatchObject({ result: null, cause: null });
  });

  it('reads a stream-json log', () => {
    const fixture = (name) => readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8');
    expect(result(fixture('stream-json-shipped.jsonl'))).toMatchObject({ result: 'shipped', story: 'S-1', cause: null });
    expect(result(fixture('stream-json-crash.jsonl'))).toEqual({ result: null, story: null, cause: null, resetAt: null });
    expect(result(fixture('stream-json-429.jsonl'))).toMatchObject({ result: null, cause: 'rate-limit' });
  });
});
