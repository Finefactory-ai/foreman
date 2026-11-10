import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withDefaults } from '../../config/defaults.mjs';
import { main } from '../main.mjs';
import { makeNotifyCommand, validSlot } from './notify.mjs';

let dir;
const NOW = new Date('2026-10-15T12:00:00Z');
const write = (config) => fs.writeFileSync(path.join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories', idPattern: 'P\\d+-\\d+' }, ...config }));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-notify-'));
  fs.mkdirSync(path.join(dir, 'stories'));
  fs.writeFileSync(path.join(dir, 'stories', 'P4-04.md'), '---\nid: P4-04\ntitle: Add the rate limits\nstatus: todo\ndepends_on: []\n---\n\n## Progress notes\n\n_Newest first._\n');
  write({});
});

async function run(argv, { command, env = {} } = {}) {
  let out = '';
  let err = '';
  const ctx = { cwd: dir, env: { FOREMAN_PROJECT_DIR: dir, ...env }, now: () => NOW, stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } };
  const code = command ? await command.run(argv, { ...ctx, root: dir }) : await main(argv, ctx);
  return { code, out, err };
}
const outbox = () => {
  const d = path.join(dir, '.foreman', 'outbox');
  return fs.existsSync(d) ? fs.readdirSync(d).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : [];
};

describe('foreman notify', () => {
  it('writes one outbox file with the default notifier', async () => {
    const { code, out } = await run(['notify', '--kind', 'stopped', '--reason', 'test']);
    expect(code).toBe(0);
    expect(out).toMatch(/^Wrote .*\.foreman\/outbox\/20261015-120000-stopped\.json\n$/);
    const [mail] = outbox();
    expect(outbox()).toHaveLength(1);
    expect(mail.subject).toBe('Factory stopped · 0 of 0 shipped');
    expect(mail.html).toContain('ACME · BUILD FACTORY');
  });

  it("quotes the session's final message from a stream-json log, not the raw events", async () => {
    const log = path.join(dir, 'w1.log');
    fs.copyFileSync(new URL('../../../../test/fixtures/stream-json-shipped.jsonl', import.meta.url), log);
    await run(['notify', '--kind', 'blocked', '--story', 'P4-04', '--log', log]);
    const [mail] = outbox();
    expect(mail.text).toContain('**S-1 shipped.** Pull request: https://example.com/pr/1');
    expect(mail.text).not.toContain('"type"');
    expect(mail.text).not.toContain('FACTORY_RESULT');
    expect(mail.text).not.toContain('Starting S-1 through the pipeline.');
  });

  it('still quotes a plain-text log', async () => {
    const log = path.join(dir, 'w1.log');
    fs.writeFileSync(log, 'It could not reach the database.\nFACTORY_RESULT: blocked P4-04\n');
    await run(['notify', '--kind', 'blocked', '--story', 'P4-04', '--log', log]);
    expect(outbox()[0].text).toContain('It could not reach the database.');
  });

  it('refuses a missing or unknown kind with one usage line', async () => {
    const r = await run(['notify', '--kind', 'nope']);
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect((await run(['notify'])).code).toBe(1);
  });

  it('writes one stuck notification', async () => {
    const r = await run(['notify', '--kind', 'stuck', '--reason', 'the supervisor fails every loop: ENOENT']);
    expect(r.code).toBe(0);
    const files = fs.readdirSync(path.join(dir, '.foreman', 'outbox'));
    expect(files.filter((f) => f.endsWith('-stuck.json'))).toHaveLength(1);
    expect(outbox()[0].subject).toBe('Foreman is not making progress');
    const bad = await run(['notify', '--kind', 'stuckish']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^usage: foreman notify --kind <[^>]*\|stuck>/);
  });

  it('writes one standby and one owner-task notification, each with its reason in the lead', async () => {
    const standby = 'Standby: 1 owner task waits on you; finishing P4-01 starts P4-04.';
    expect((await run(['notify', '--kind', 'standby', '--story', 'P4-04', '--reason', standby])).code).toBe(0);
    const held = 'Owner task P4-01 has held P4-04 for 26 h.';
    expect((await run(['notify', '--kind', 'owner-task', '--story', 'P4-04', '--reason', held])).code).toBe(0);
    const files = fs.readdirSync(path.join(dir, '.foreman', 'outbox'));
    expect(files.filter((f) => f.endsWith('-standby.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('-owner-task.json'))).toHaveLength(1);
    const mails = outbox();
    expect(mails.find((m) => m.subject === 'Foreman is on standby: things wait on you').text).toContain(standby);
    expect(mails.find((m) => m.subject === 'An owner task still holds P4-04').text).toContain(held);
  });

  it('writes one unexpected-stop notification with the reason in its lead', async () => {
    const reason = "Stop requested by ACME-9's session at 04:01 UTC, not from your terminal or the dashboard.";
    const r = await run(['notify', '--kind', 'unexpected-stop', '--reason', reason]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const files = fs.readdirSync(path.join(dir, '.foreman', 'outbox'));
    expect(files.filter((f) => f.endsWith('-unexpected-stop.json'))).toHaveLength(1);
    expect(outbox()[0].subject).toBe('Foreman was asked to stop, not by you');
    expect(outbox()[0].text).toContain(reason);
  });

  it('writes one credits notification with the reason in its lead', async () => {
    const reason = 'Platform credits ran out at 14:32; now using your Claude subscription.';
    const r = await run(['notify', '--kind', 'credits', '--reason', reason]);
    expect(r.code).toBe(0);
    const files = fs.readdirSync(path.join(dir, '.foreman', 'outbox'));
    expect(files.filter((f) => f.endsWith('-credits.json'))).toHaveLength(1);
    expect(outbox()[0].subject).toBe('Platform credits ran out');
    expect(outbox()[0].text).toContain(`${reason} The run carries on; nothing else changes.`);
  });

  it('looks up the story title for an id the source accepts, and drops one it does not', async () => {
    await run(['notify', '--kind', 'blocked', '--story', 'P4-04']);
    expect(outbox()[0].text).toContain('P4-04 · Add the rate limits');
    fs.rmSync(path.join(dir, '.foreman'), { recursive: true });
    await run(['notify', '--kind', 'blocked', '--story', 'p4-04; rm -rf']);
    expect(outbox()[0].text).not.toContain('rm -rf');
    expect(outbox()[0].subject).toBe('undefined is blocked · the factory moved on'.replace('undefined', ''));
  });

  it('accepts w5 when slots is 8 and rejects it when slots is 3', async () => {
    expect(validSlot('w5', 8)).toBe(true);
    expect(validSlot('w5', 3)).toBe(false);
    expect(validSlot('w0', 3)).toBe(false);
    expect(validSlot('x1', 3)).toBe(false);
    write({ slots: 8 });
    await run(['notify', '--kind', 'down', '--slot', 'w5']);
    expect(outbox()[0].subject).toBe('Slot w5 is down');
    fs.rmSync(path.join(dir, '.foreman'), { recursive: true });
    write({ slots: 3 });
    await run(['notify', '--kind', 'down', '--slot', 'w5']);
    expect(outbox()[0].subject).toBe('Slot  is down');
  });

  it('reads HALT for a halt and uses the configured rollback hint', async () => {
    fs.mkdirSync(path.join(dir, '.foreman'));
    fs.writeFileSync(path.join(dir, '.foreman', 'HALT'), `2026-10-14T10:10:26Z ${JSON.stringify({ stage: 'deploy', reason: 'Deploy failed.', pr: '' })}\n`);
    write({ ship: { steps: ['pr'], deploy: { rollbackHint: 'run ./rollback.sh' } } });
    await run(['notify', '--kind', 'halted']);
    const [mail] = outbox();
    expect(mail.subject).toBe('Factory halted · deploy');
    expect(mail.text).toContain('If the live site is broken, run ./rollback.sh');
  });

  it("takes the rollback hint from the deploy-github step's options, where that step reads it", async () => {
    fs.mkdirSync(path.join(dir, '.foreman'));
    fs.writeFileSync(path.join(dir, '.foreman', 'HALT'), `2026-10-14T10:10:26Z ${JSON.stringify({ stage: 'smoke', reason: 'Down.', pr: '' })}\n`);
    write({ ship: { steps: ['deploy-github', 'smoke'], 'deploy-github': { rollbackHint: 'promote the previous deployment.' } } });
    await run(['notify', '--kind', 'halted']);
    expect(outbox()[0].text).toContain('If the live site is broken, promote the previous deployment.');
  });

  it("takes the rollback hint from any configured step's options", async () => {
    fs.mkdirSync(path.join(dir, '.foreman'));
    fs.writeFileSync(path.join(dir, '.foreman', 'HALT'), `2026-10-14T10:10:26Z ${JSON.stringify({ stage: 'deploy', reason: 'Deploy failed.', pr: '' })}\n`);
    write({ ship: { steps: ['pr', 'acme-release'], 'acme-release': { rollbackHint: 'run ./undo.sh' } } });
    await run(['notify', '--kind', 'halted']);
    expect(outbox()[0].text).toContain('If the live site is broken, run ./undo.sh');
  });

  it('takes the hint of the first configured step that has one', async () => {
    fs.mkdirSync(path.join(dir, '.foreman'));
    fs.writeFileSync(path.join(dir, '.foreman', 'HALT'), `2026-10-14T10:10:26Z ${JSON.stringify({ stage: 'deploy', reason: 'Deploy failed.', pr: '' })}\n`);
    write({ ship: { steps: ['acme-one', 'acme-two'], 'acme-one': { rollbackHint: 'undo one' }, 'acme-two': { rollbackHint: 'undo two' } } });
    await run(['notify', '--kind', 'halted']);
    const { text } = outbox()[0];
    expect(text).toContain('If the live site is broken, undo one');
    expect(text).not.toContain('undo two');
  });

  it('skips an empty rollback hint', async () => {
    fs.mkdirSync(path.join(dir, '.foreman'));
    fs.writeFileSync(path.join(dir, '.foreman', 'HALT'), `2026-10-14T10:10:26Z ${JSON.stringify({ stage: 'deploy', reason: 'Deploy failed.', pr: '' })}\n`);
    write({ ship: { steps: ['acme-one', 'acme-two'], 'acme-one': { rollbackHint: '' }, 'acme-two': { rollbackHint: 'undo two' } } });
    await run(['notify', '--kind', 'halted']);
    expect(outbox()[0].text).toContain('If the live site is broken, undo two');
  });

  it('ignores a rollback hint on a step that is not in ship.steps', async () => {
    fs.mkdirSync(path.join(dir, '.foreman'));
    fs.writeFileSync(path.join(dir, '.foreman', 'HALT'), `2026-10-14T10:10:26Z ${JSON.stringify({ stage: 'deploy', reason: 'Deploy failed.', pr: '' })}\n`);
    write({ ship: { steps: ['pr'], 'deploy-github': { rollbackHint: 'promote the previous deployment.' } } });
    await run(['notify', '--kind', 'halted']);
    const [mail] = outbox();
    expect(mail.subject).toBe('Factory halted · deploy');
    expect(mail.text).not.toContain('If the live site is broken');
    expect(mail.text).not.toContain('promote the previous deployment.');
  });

  it('a HALT written after a rollback gives the rolled-back sentence and no manual hint', async () => {
    fs.mkdirSync(path.join(dir, '.foreman'));
    const reason = 'Production was rolled back with `vercel rollback --yes`. ./check.sh reported a problem after the deploy: 4 new errors';
    fs.writeFileSync(path.join(dir, '.foreman', 'HALT'), `2026-10-14T10:10:26Z ${JSON.stringify({ stage: 'watch', reason, rolledBack: true })}\n`);
    write({ ship: { steps: ['deploy-github', 'watch'], watch: { command: './check.sh' }, rollback: { command: 'vercel rollback --yes' }, 'deploy-github': { rollbackHint: 'promote the previous deployment.' } } });
    await run(['notify', '--kind', 'halted']);
    const [mail] = outbox();
    expect(mail.subject).toBe('Factory halted · watch');
    expect(mail.text).toContain('Production was rolled back with vercel rollback --yes.');
    expect(mail.text).not.toContain('If the live site is broken');
  });

  it('adds the console links when the config carries them', async () => {
    write({ console: { adapter: 'dashboard', commandCenterUrl: 'https://pages.example/artifact/cc', decisionsUrl: 'https://pages.example/artifact/dp' } });
    await run(['notify', '--kind', 'stopped', '--reason', 'x']);
    expect(outbox()[0].text).toContain('Command center: https://pages.example/artifact/cc');
  });

  it('sends through email-resend, prints the recipient, and never prints the key', async () => {
    write({ notify: { adapter: 'email-resend' } });
    const calls = [];
    const command = makeNotifyCommand({ fetch: async (url, init) => (calls.push({ url, init }), { ok: true, status: 200 }), gitEmail: () => '' });
    const env = { RESEND_API_KEY: 're_topsecret', RESEND_FROM_EMAIL: 'f@example.com', FOREMAN_NOTIFY_EMAIL: 'me@example.com' };
    const r = await run(['notify', '--kind', 'stopped', '--reason', 'x'], { command, env });
    expect(r.code).toBe(0);
    expect(r.out).toBe('Emailed me@example.com: Factory stopped · 0 of 0 shipped\n');
    expect(JSON.parse(calls[0].init.body).subject).toMatch(/^\[Acme factory\] /);
    expect(r.out + r.err).not.toContain('re_topsecret');
  });

  it("sends with RESEND_API_KEY only in Foreman's own keys file, and never prints it", async () => {
    write({ notify: { adapter: 'email-resend' } });
    fs.writeFileSync(path.join(dir, '.env.foreman'), 'RESEND_API_KEY=re_from_foreman_file\nACME_URL=http://acme\n');
    const calls = [];
    const command = makeNotifyCommand({ fetch: async (url, init) => (calls.push({ url, init }), { ok: true, status: 200 }), gitEmail: () => '' });
    const r = await run(['notify', '--kind', 'stopped'], { command, env: { RESEND_FROM_EMAIL: 'f@example.com', FOREMAN_NOTIFY_EMAIL: 'me@example.com' } });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].init.headers)).toContain('re_from_foreman_file');
    expect(r.out + r.err).not.toContain('re_from_foreman_file');
  });

  it('says it could not read .env.foreman when that file cannot be read', async () => {
    write({ notify: { adapter: 'email-resend' } });
    fs.mkdirSync(path.join(dir, '.env.foreman'));
    const command = makeNotifyCommand({ fetch: async () => ({ ok: true, status: 200 }), gitEmail: () => '' });
    const r = await run(['notify', '--kind', 'stopped'], { command, env: {} });
    expect(r.code).toBe(1);
    expect(r.err).toBe('Not sent: could not read .env.foreman.\n');
  });

  describe('features.notifications off', () => {
    const localSettings = (values) => {
      fs.mkdirSync(path.join(dir, '.foreman'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.foreman', 'settings.json'), JSON.stringify(values));
    };
    const env = { RESEND_API_KEY: 're_topsecret', RESEND_FROM_EMAIL: 'f@example.com', FOREMAN_NOTIFY_EMAIL: 'me@example.com' };

    it('in the local layer: writes to the outbox only, and sends nothing', async () => {
      write({ notify: { adapter: 'email-resend' } });
      localSettings({ 'features.notifications': false });
      const calls = [];
      const command = makeNotifyCommand({ fetch: async (url, init) => (calls.push({ url, init }), { ok: true, status: 200 }), gitEmail: () => '' });
      const r = await run(['notify', '--kind', 'stopped', '--reason', 'x'], { command, env });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^Wrote .*\.foreman\/outbox\/20261015-120000-stopped\.json\n$/);
      expect(calls).toEqual([]);
      expect(outbox()).toHaveLength(1);
    });

    it('in the config file: the same, even with no keys for the notifier', async () => {
      write({ notify: { adapter: 'email-resend' }, features: { notifications: false } });
      const command = makeNotifyCommand({ fetch: async () => { throw new Error('must not send'); }, gitEmail: () => '' });
      const r = await run(['notify', '--kind', 'stopped'], { command, env: {} });
      expect(r.code).toBe(0);
      expect(outbox()).toHaveLength(1);
    });

    it('sends again when the local layer turns it back on', async () => {
      write({ notify: { adapter: 'email-resend' }, features: { notifications: false } });
      localSettings({ 'features.notifications': true });
      const calls = [];
      const command = makeNotifyCommand({ fetch: async (url, init) => (calls.push({ url, init }), { ok: true, status: 200 }), gitEmail: () => '' });
      const r = await run(['notify', '--kind', 'stopped'], { command, env });
      expect(r.out).toBe('Emailed me@example.com: Factory stopped · 0 of 0 shipped\n');
      expect(calls).toHaveLength(1);
    });
  });

  it('exits 1 with one line when nothing was sent', async () => {
    write({ notify: { adapter: 'email-resend' } });
    const command = makeNotifyCommand({ fetch: async () => ({ ok: true }), gitEmail: () => '' });
    const r = await run(['notify', '--kind', 'stopped'], { command, env: {} });
    expect(r.code).toBe(1);
    expect(r.err.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('Not sent: needs RESEND_API_KEY');
  });

  it('exits 1 for an unknown notifier', async () => {
    write({ notify: { adapter: 'carrier-pigeon' } });
    const r = await run(['notify', '--kind', 'stopped']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown notifier: carrier-pigeon');
  });

  describe('while the run is on the last good config', () => {
    const lastGood = () => {
      const state = path.join(dir, '.foreman');
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, 'config.last-good.json'), JSON.stringify(withDefaults({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'npm test', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories', idPattern: 'P\\d+-\\d+' } })));
      return state;
    };

    it('sends the config notification through the last good config', async () => {
      const state = lastGood();
      fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({ configProblem: { since: NOW.toISOString(), reason: 'bogusKey: unknown key' } }));
      write({ bogusKey: true });
      const r = await run(['notify', '--kind', 'config', '--reason', 'bogusKey: unknown key']);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/outbox\/20261015-120000-config\.json\n$/);
      const [mail] = outbox();
      expect(mail.subject).toBe('foreman.config.json is invalid');
      expect(mail.text).toContain('bogusKey: unknown key');
    });

    it('refuses an invalid config as before when the run is not on the last good one', async () => {
      lastGood();
      write({ bogusKey: true });
      const r = await run(['notify', '--kind', 'config', '--reason', 'x']);
      expect(r.code).toBe(1);
      expect(r.err).toContain('Not sent:');
      expect(r.err).toContain('bogusKey: unknown key');
    });
  });
});
