// The notifications set-up step behind the dashboard's /api/setup/notify/ routes: choosing email
// or none, and sending a test email. Every word the owner sees is in
// lib/setup/notify-screen.mjs NOTIFY_SCREEN.
//
//   const notify = notifySetup({ root, env, now, fetch, gitEmail, timeoutMs, setupFirst });
//   notify.current()      { adapter, from, to, notifications } from the resolved config (the
//                         local layer included): adapter is notify.adapter ('none' when unset),
//                         from and to the notify block's or null, notifications whether
//                         features.notifications is on. null with no valid config.
//   notify.save(body)     { adapter }, exactly that key, 'none' or 'email-resend': writes the
//                         whole notify block to foreman.config.json through the team layer
//                         (lib/settings/team.mjs) as { adapter } alone, because the none adapter
//                         refuses any other option, and a switch to email comes from another
//                         adapter, whose options are not email's. Answers { ok, lines, notify };
//                         lines end with the commit reminder, or are [nothingChanged] when the
//                         file already has that adapter, and then nothing is written.
//                         Synchronous.
//   notify.test({ stateDir, values })
//                         sends a test email through openNotifier (lib/engine/notifier.mjs),
//                         so features.notifications off means the outbox only, as for every
//                         other email. `values` is the notifier's env: the Resend key and the
//                         addresses, as the server reads them. Answers testResult's shape.
//   testResult(r, config, secrets)
//                         a notifier's answer as { sent, outbox, to?, detail }: detail in
//                         NOTIFY_SCREEN.results' words, with each of `secrets` blanked out
//
// The project is read afresh on each call. A failure is an Error with .status, the HTTP code to
// answer with, and never repeats what was sent. This file does not import steps.mjs: the server
// passes the set-up-first words in.

import { openNotifier } from '../engine/notifier.mjs';
import { buildEmail } from '../notify/email.mjs';
import { redact } from '../secrets/redact.mjs';
import { COMMIT_REMINDER } from '../settings/change.mjs';
import { loadResolved } from '../settings/load.mjs';
import { readTeam, teamSet } from '../settings/team.mjs';
import { NOTIFY_SCREEN } from './notify-screen.mjs';

export const ADAPTERS = Object.freeze(['none', 'email-resend']);

const W = NOTIFY_SCREEN.results;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
const fail = (status, message) => Object.assign(new Error(message), { status });
// The words with each {name} filled in.
const fill = (words, values) => Object.entries(values).reduce((out, [k, v]) => out.split(`{${k}}`).join(String(v)), words);

// The words for what Resend, or the notifier, answered.
function words(r, config) {
  if (r?.file) return config?.features?.notifications === false ? W.outboxOff : W.outboxNone;
  if (r?.sent && r.to) return fill(W.sent, { to: r.to });
  if (Array.isArray(r?.missing) && r.missing.length) return fill(W.missing, { missing: r.missing.join(' and ') });
  const reason = String(r?.reason ?? '');
  if (r?.status === undefined || r?.status === null) return W.unreachable;
  if (r.status === 401) return W.badKey;
  if (r.status === 403 && r.code === 'restricted_api_key') return W.inactiveKey;
  if (r.status === 403 && /not verified/i.test(reason)) return W.unverified;
  if (r.status === 403 && /testing emails|own email/i.test(reason)) return W.testingOnly;
  if (r.status === 429) return W.tooMany;
  return fill(W.other, { reason });
}

export function testResult(r, config, secrets = []) {
  const detail = redact(words(r, config), { values: secrets });
  if (r?.file) return { sent: false, outbox: true, detail };
  if (r?.sent && r.to) return { sent: true, outbox: false, to: r.to, detail };
  return { sent: false, outbox: false, detail };
}

export function notifySetup({ root, env = process.env, now = () => new Date(), fetch, gitEmail, timeoutMs, setupFirst = NOTIFY_SCREEN.setupFirst }) {
  const resolved = () => loadResolved(root, { env }).config;

  function current() {
    const config = resolved();
    if (!config) return null;
    const block = isPlain(config.notify) ? config.notify : {};
    return {
      adapter: text(block.adapter) ?? 'none',
      from: text(block.from),
      to: text(block.to),
      notifications: config.features?.notifications !== false,
    };
  }

  function save(body) {
    if (!isPlain(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'adapter')) throw fail(400, NOTIFY_SCREEN.badChoice);
    const wanted = body.adapter;
    if (typeof wanted !== 'string' || !ADAPTERS.includes(wanted)) throw fail(400, NOTIFY_SCREEN.badChoice);
    const team = readTeam(root);
    if (team.errors) throw fail(409, setupFirst);
    const block = isPlain(team.raw.notify) ? team.raw.notify : {};
    if ((block.adapter ?? 'none') === wanted) return { ok: true, lines: [NOTIFY_SCREEN.nothingChanged], notify: current() };
    let errors;
    try {
      ({ errors } = teamSet(root, 'notify', { adapter: wanted }));
    } catch (err) {
      errors = [err.message];
    }
    if (errors.length) throw fail(400, errors.join('; '));
    return { ok: true, lines: [`set notify.adapter to ${wanted}`, COMMIT_REMINDER], notify: current() };
  }

  async function test({ stateDir, values = {} }) {
    const config = resolved();
    if (!config) throw fail(409, setupFirst);
    const secrets = [values.RESEND_API_KEY];
    const mail = buildEmail({ kind: 'test', project: config.project, now: now() });
    let notifier;
    try {
      notifier = openNotifier({ config, ctx: { stateDir, env: values, now, fetch, gitEmail, timeoutMs } });
    } catch (err) {
      return { sent: false, outbox: false, detail: redact(fill(W.badBlock, { reason: err.message }), { values: secrets }) };
    }
    const r = await notifier.send({ kind: 'test', subject: mail.subject, text: mail.text, html: mail.html });
    return testResult(r, config, secrets);
  }

  return { current, save, test };
}
