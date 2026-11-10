import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeDoctorCommand } from './doctor.mjs';
import { addItem, undoItem } from '../../engine/learning-store.mjs';

const SECRET = 'sk-top-secret-456';
let dir;
let source;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doctor-cmd-'));
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-doctor-src-'));
  fs.mkdirSync(path.join(source, '.claude-plugin'));
  fs.writeFileSync(path.join(source, '.claude-plugin', 'plugin.json'), '{"version":"0.1.0"}');
});

const LIST = 'Installed plugins:\n\n  ❯ foreman@foreman\n    Version: 0.1.0\n    Scope: project\n    Status: ✔ enabled\n';

function sh(overrides = {}) {
  return (cmd, args = []) => {
    const line = [cmd, ...args].join(' ');
    if (line === 'claude plugin list') return { status: 0, stdout: LIST, stderr: '' };
    const key = Object.keys(overrides).find((k) => line.startsWith(k));
    return { status: 0, stdout: '', stderr: '', ...(key ? overrides[key] : {}) };
  };
}

async function run(shOverrides, config = {}) {
  fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'P' }, checks: [{ run: 'npm test', when: 'always' }], notify: { adapter: 'email-resend' }, ...config }));
  let out = '';
  let err = '';
  const command = makeDoctorCommand({ sh: () => sh(shOverrides), sourceRoot: source });
  const code = await command.run([], { cwd: dir, root: dir, env: { RESEND_FROM_EMAIL: 'a@b.c' }, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out: out + err };
}

describe('foreman doctor', () => {
  it('exits 0 with warnings only, and prints one line per check', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `RESEND_API_KEY=${SECRET}\n`);
    const { code, out } = await run({ 'gh api': { status: 1, stderr: 'HTTP 404' } });
    expect(code).toBe(0);
    expect(out).toMatch(/^warn {2}branch protection — branch protection is off$/m);
    expect(out).toMatch(/^warn {2}workflows — /m);
    expect(out).toMatch(/^ok {4}config$/m);
    expect(out).toMatch(/^(ok|warn) {2,4}background service/m);
    expect(out).not.toMatch(/^FAIL/m);
    expect(out).not.toContain(SECRET);
  });

  it('exits 1 on any error, runs every check anyway, and never prints values', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `OTHER=${SECRET}\n`);
    const { code, out } = await run({ 'gh auth status': { status: 1 }, 'git remote get-url': { status: 2 } });
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL {2}git remote — /m);
    expect(out).toMatch(/^FAIL {2}gh signed in — /m);
    expect(out).toMatch(/^FAIL {2}env variables — .*RESEND_API_KEY/m);
    expect(out).toMatch(/^ok {4}claude on PATH$/m);
    expect(out).not.toContain(SECRET);
  });

  it("prints the keys file lines, names only, wherever Foreman's keys are", async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `RESEND_API_KEY=${SECRET}\n`);
    const before = await run({});
    expect(before.out).toMatch(/^ok {4}foreman keys file$/m);
    expect(before.out).toMatch(/^warn {2}foreman keys placement — move RESEND_API_KEY to \.env\.foreman: agents can read \.env\.local; run `foreman keys migrate`$/m);
    expect(before.out).not.toContain(SECRET);

    fs.writeFileSync(path.join(dir, '.env.local'), 'ACME_URL=x\n');
    fs.writeFileSync(path.join(dir, '.env.foreman'), `RESEND_API_KEY=${SECRET}\n`, { mode: 0o600 });
    const after = await run({});
    expect(after.out).toMatch(/^ok {4}foreman keys placement$/m);
    expect(after.out).toMatch(/^ok {4}env variables$/m);
    expect(after.out).not.toContain(SECRET);
  });

  it('says which Claude sign-in is in use, in each case, without printing a value', async () => {
    const runWith = async (env, auth = { loggedIn: true, authMethod: 'claude.ai' }) => {
      fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'P' } }));
      let out = '';
      const shell = sh({ 'claude auth status': { stdout: JSON.stringify(auth) } });
      const command = makeDoctorCommand({ sh: () => shell, sourceRoot: source });
      await command.run([], { cwd: dir, root: dir, env, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
      return out;
    };
    const key = await runWith({ ANTHROPIC_API_KEY: SECRET });
    expect(key).toMatch(/^ok {4}claude sign-in — Console API key: per-token billing$/m);
    const token = await runWith({ CLAUDE_CODE_OAUTH_TOKEN: SECRET });
    expect(token).toMatch(/^warn {2}claude sign-in — Claude subscription token: counts against your plan's limits\. .*needs a Console API key/m);
    const login = await runWith({});
    expect(login).toMatch(/^warn {2}claude sign-in — claude\.ai login on this machine: counts against your plan's limits\. .*needs a Console API key/m);
    const none = await runWith({}, { loggedIn: false });
    expect(none).toMatch(/^FAIL {2}claude sign-in — /m);
    for (const out of [key, token, login, none]) expect(out).not.toContain(SECRET);
  });

  it('prints a fix line under each warn and FAIL, naming the set-up step, and none under ok', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `OTHER=${SECRET}\n`);
    const { code, out } = await run({ 'gh auth status': { status: 1 }, 'gh api': { status: 1, stderr: 'HTTP 404' } });
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL {2}env variables — missing: RESEND_API_KEY \(set in \.env\.foreman or the environment\)\n {6}fix: .*RESEND_API_KEY.* \(dashboard: Set up › Notifications\)$/m);
    expect(out).toMatch(/^FAIL {2}gh signed in — run `gh auth login`\n {6}fix: sign in with `gh auth login` \(dashboard: Set up › GitHub\)$/m);
    expect(out).toMatch(/^warn {2}branch protection — branch protection is off\n {6}fix: turn branch protection on for main \(dashboard: Set up › GitHub\)$/m);
    const lines = out.trimEnd().split('\n');
    lines.forEach((line, i) => {
      if (/^(warn|FAIL) {2}/.test(line)) expect(lines[i + 1], line).toMatch(/^ {6}fix: \S/);
      if (/^ok {4}/.test(line)) expect(lines[i + 1] ?? '', line).not.toMatch(/^ {6}fix: /);
    });
    expect(lines.every((l) => /^(ok {4}|warn {2}|FAIL {2}| {6}fix: )/.test(l))).toBe(true);
    expect(out).not.toContain(SECRET);
  });

  it('prints no value in a fix line, with the key in the environment or a Claude token set', async () => {
    fs.writeFileSync(path.join(dir, '.env.local'), `OTHER=${SECRET}\n`);
    const outputs = [];
    for (const env of [{ RESEND_API_KEY: SECRET }, { CLAUDE_CODE_OAUTH_TOKEN: SECRET }, { ANTHROPIC_API_KEY: SECRET, RESEND_API_KEY: SECRET }]) {
      let out = '';
      const command = makeDoctorCommand({ sh: () => sh({ 'gh auth status': { status: 1 } }), sourceRoot: source });
      await command.run([], { cwd: dir, root: dir, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { out += s; } } });
      outputs.push(out);
    }
    for (const out of outputs) {
      expect(out).toMatch(/^ {6}fix: /m);
      expect(out).not.toContain(SECRET);
    }
  });

  it('fails on a broken config', async () => {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), '{ nope');
    let out = '';
    const command = makeDoctorCommand({ sh: () => sh(), sourceRoot: source });
    const code = await command.run([], { cwd: dir, root: dir, env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL {2}config — /m);
    expect(out).toMatch(/^FAIL {2}config — .*\n {6}fix: .+ \(dashboard: Set up › This project\)$/m);
  });
});

describe('foreman doctor --end-strays', () => {
  const STRAYS = [
    { pid: 222, rssKb: 1024, ageMs: 20 * 60_000, cwd: '/tmp/acme', where: 'temp' },
    { pid: 333, rssKb: 1024, ageMs: 11 * 60_000, cwd: '/srv/acme/.foreman/worktrees/w1', where: 'project' },
  ];
  async function endStrays({ args = ['--end-strays'], env = {}, found = { listed: true, strays: STRAYS, mb: 2 }, ended = { ended: [222, 333], left: [] } } = {}) {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' } }));
    const calls = { find: [], end: [] };
    const strays = {
      find: (opts) => {
        calls.find.push(opts);
        return found;
      },
      end: async (list) => {
        calls.end.push(list);
        return ended;
      },
    };
    let out = '';
    let err = '';
    const command = makeDoctorCommand({ sh: () => sh(), sourceRoot: source, strays });
    const code = await command.run(args, { cwd: dir, root: dir, env, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
    return { code, out, err, calls };
  }

  it('ends the strays it finds, says how many, and runs no check', async () => {
    const r = await endStrays();
    expect(r.code).toBe(0);
    expect(r.out).toContain('Ending 2 supervisors');
    expect(r.out).toContain('pid 222, 333.');
    expect(r.out).toContain('Ended 2.');
    expect(r.out).not.toMatch(/^(ok|warn|FAIL) /m);
    expect(r.calls.end).toEqual([STRAYS]);
    expect(r.calls.find[0]).toMatchObject({ root: dir, dir: path.join(dir, '.foreman') });
  });

  it('exits 1 and names any still running', async () => {
    const r = await endStrays({ ended: { ended: [222], left: [333] } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Ended 1.');
    expect(r.out).toContain('Still running: pid 333');
  });

  it('says so when there are none, and ends nothing', async () => {
    const r = await endStrays({ found: { listed: true, strays: [], mb: 0 } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('No stray processes.');
    expect(r.calls.end).toEqual([]);
  });

  it('exits 1 when it cannot list the processes, and ends nothing', async () => {
    const r = await endStrays({ found: { listed: false, strays: [], mb: 0 } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('Could not list the running processes.');
    expect(r.calls.end).toEqual([]);
  });

  it('refuses inside a story session, before it looks or ends anything', async () => {
    const r = await endStrays({ env: { FOREMAN_RUN: '1' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('does not run inside a Foreman story session');
    expect(r.err).toContain('foreman doctor --end-strays');
    expect(r.calls.find).toEqual([]);
    expect(r.calls.end).toEqual([]);
  });

  it('a plain doctor never ends anything', async () => {
    const r = await endStrays({ args: [] });
    expect(r.out).toMatch(/^ok {4}stray processes$/m);
    expect(r.out).not.toContain('Ending');
    expect(r.calls.end).toEqual([]);
  });
});

describe('foreman doctor: learning', () => {
  const A = 'a'.repeat(40);
  const NOW = new Date('2026-10-25T12:00:00Z');
  const DAY = 24 * 3600 * 1000;
  const ago = (days) => ({ now: new Date(NOW.getTime() - days * DAY) });
  const SKILL_TEXT = 'Acme private steps for the flow builder';
  const state = () => path.join(dir, '.foreman');
  const skill = (slug, name) => `---\nname: foreman-learned-${slug}\ndescription: "Use when Acme work runs ${name}."\n---\n\n## Steps\n\n1. ${SKILL_TEXT}: ${name}.\n`;
  const addSkill = (slug, name, packs, at = ago(1)) =>
    addItem(state(), { kind: 'skill', roles: ['developer'], slug, text: skill(slug, name), source: { key: 'f-000000000001', stories: ['S-1'] }, reason: 'Acme', metrics: packs ? { packs } : null }, at);
  const lock = (skills) => fs.writeFileSync(path.join(dir, 'skills-lock.json'), JSON.stringify({ version: 1, skills }));

  async function doctor(config = {}) {
    fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'npm test', when: 'always' }], notify: { adapter: 'email-resend' }, ...config }));
    let out = '';
    const command = makeDoctorCommand({ sh: () => sh({}), sourceRoot: source });
    const code = await command.run([], { cwd: dir, root: dir, env: { FOREMAN_STATE_DIR: state(), RESEND_FROM_EMAIL: 'a@b.c', RESEND_API_KEY: 'x' }, now: () => NOW, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { out += s; } } });
    return { code, out };
  }

  it('says learning is on, with its counts and no cap reached', async () => {
    const base = await doctor({ learning: { auto: false, apply: false } });
    const { code, out } = await doctor();
    expect(out).toMatch(/^ok {4}learning — on; 0 active, 0 evaluating; last 7 days: 0 rolled back, 0 refused$/m);
    expect(out).toMatch(/^ok {4}learning caps$/m);
    expect(code).toBe(base.code);
    expect(out.indexOf('learning — ')).toBeGreaterThan(out.indexOf('background service'));
    expect(out.indexOf('learning — ')).toBeLessThan(out.indexOf('workflows'));
  });

  it('says learning is off, without the caps line', async () => {
    const { out } = await doctor({ learning: { auto: false } });
    expect(out).toMatch(/^ok {4}learning — off \(learning\.auto is false\);/m);
    expect(out).not.toMatch(/learning caps/);
    const both = await doctor({ learning: { auto: false, apply: false } });
    expect(both.out).toMatch(/^ok {4}learning — off \(learning\.auto and learning\.apply are false\);/m);
  });

  it('says when the agents use none of it', async () => {
    const { out } = await doctor({ learning: { apply: false } });
    expect(out).toMatch(/^ok {4}learning — on, but the agents use none of it \(learning\.apply is false\); 0 active/m);
  });

  it('warns at a cap reached, with a fix line, and still exits as before', async () => {
    const base = await doctor();
    addItem(state(), { kind: 'trait', roles: ['developer'], text: 'Acme: test every route' }, ago(2));
    const { code, out } = await doctor({ learning: { maxEvaluating: 1 } });
    expect(out).toMatch(/^warn {2}learning caps — reached: on trial 1 of 1\n {6}fix: raise the limit with `foreman settings` \(learning group\), or undo an item with `foreman learning undo <id>`/m);
    expect(code).toBe(base.code);
    const spent = await doctor({ learning: { maxUsdPerDay: 0 } });
    expect(spent.out).toMatch(/^warn {2}learning caps — reached: learner spend today \$0\.00 of \$0\.00$/m);
  });

  it('warns when learning.jsonl cannot be read, and runs the other checks', async () => {
    fs.mkdirSync(path.join(state(), 'learning.jsonl'), { recursive: true });
    const { out } = await doctor();
    expect(out).toMatch(/^warn {2}learning — could not read learning\.jsonl\n {6}fix: /m);
    expect(out).toMatch(/^warn {2}workflows — /m);
    expect(out).toMatch(/^ok {4}config$/m);
  });

  it('warns on the caps line when learner.jsonl cannot be read, and still counts the ledger', async () => {
    fs.mkdirSync(path.join(state(), 'learner.jsonl'), { recursive: true });
    const { out } = await doctor();
    expect(out).toMatch(/^ok {4}learning — on; 0 active/m);
    expect(out).toMatch(/^warn {2}learning caps — could not read learner\.jsonl, so the spend cap is unknown\n {6}fix: /m);
  });

  it('has no pack-tag line without skills-lock.json, or without a learned skill in force', async () => {
    addSkill('acme-flow', 'sf-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    expect((await doctor()).out).not.toMatch(/learned skills and pack tags/);
    fs.rmSync(path.join(state(), 'learning.jsonl'));
    fs.rmSync(path.join(state(), 'learned'), { recursive: true });
    lock({ 'sf-flow': { ref: 'v1.1.0', commit: A } });
    expect((await doctor()).out).not.toMatch(/learned skills and pack tags/);
    addSkill('acme-flow', 'sf-flow', { 'sf-flow': { ref: 'v1.1.0', commit: A } });
    expect((await doctor()).out).toMatch(/^ok {4}learned skills and pack tags$/m);
  });

  it('DONE WHEN: names the learned skill in force whose pack tag moved, never the rolled-back one', async () => {
    addSkill('acme-apex', 'sf-apex', { 'sf-apex': { ref: 'v1.0.0', commit: A } }, ago(3));
    undoItem(state(), 'L-1', { ...ago(2), action: 'rollback', by: 'foreman' });
    addSkill('acme-flow', 'sf-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } }, ago(1));
    lock({ 'sf-apex': { ref: 'v1.1.0', commit: 'b'.repeat(40) }, 'sf-flow': { ref: 'v1.1.0', commit: 'c'.repeat(40) } });
    const { code, out } = await doctor();
    expect(out).toMatch(/^ok {4}learning — on; 1 active, 1 evaluating; last 7 days: 1 rolled back, 0 refused$/m);
    expect(out).toMatch(/^warn {2}learned skills and pack tags — L-2 names sf-flow, learned at v1\.0\.0, now v1\.1\.0$/m);
    expect(out).toMatch(/^warn {2}learned skills and pack tags — .*\n {6}fix: read it with `foreman learning show <id>` and undo it with `foreman learning undo <id>` if it no longer fits/m);
    expect(out).not.toContain('L-1 names');
    expect(code).toBe(0);
    expect(out).not.toContain(SKILL_TEXT);
  });

  it('says when the same tag now points at another commit, or the lock dropped the skill', async () => {
    addSkill('acme-flow', 'sf-flow', { 'sf-flow': { ref: 'v1.0.0', commit: A } });
    addSkill('acme-apex', 'sf-apex', { 'sf-apex': { ref: 'v1.0.0', commit: A } });
    lock({ 'sf-flow': { ref: 'v1.0.0', commit: 'b'.repeat(40) }, 'sf-lwc': { ref: 'v1.0.0', commit: A } });
    const { out } = await doctor();
    expect(out).toMatch(/^warn {2}learned skills and pack tags — L-1 names sf-flow, learned at v1\.0\.0 \(aaaaaaa\), the tag now points at bbbbbbb; L-2 names sf-apex, learned at v1\.0\.0, no longer in skills-lock\.json$/m);
    expect(out).not.toContain(SKILL_TEXT);
    expect(out).not.toContain(A);
  });
});
