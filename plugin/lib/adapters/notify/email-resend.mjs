// Emails the owner through Resend. The key comes from RESEND_API_KEY in the environment and
// is never printed. Options: { adapter, to?, from?, subjectPrefix? }.
//   from  the option, else RESEND_FROM_EMAIL
//   to    the option, else FOREMAN_NOTIFY_EMAIL, else FACTORY_NOTIFY_EMAIL, else git user.email
// FACTORY_NOTIFY_EMAIL is the older name, still read so existing env files keep working.
//
// send() answers { sent: true, to }, or { sent: false, reason } with:
//   missing   the names it needs and does not have, when it asked Resend nothing
//   status    Resend's HTTP status, when Resend answered (none when it could not be reached
//             or did not answer within ctx.timeoutMs, 15 s by default)
//   code      the `name` in Resend's error body, such as validation_error
// The reason is 'Resend answered <status>', with Resend's message after it when it gave one.

import { execFileSync } from 'node:child_process';

const realGitEmail = () => {
  try {
    return execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const TIMEOUT_MS = 15_000;

// { name, message } from Resend's error body, each a string or undefined.
async function errorBody(response) {
  if (typeof response.json !== 'function') return {};
  try {
    const body = await response.json();
    const text = (v) => (typeof v === 'string' && v !== '' ? v : undefined);
    return { name: text(body?.name), message: text(body?.message) };
  } catch {
    return {};
  }
}

// What `foreman doctor` checks for: names of variables and tools, never values. The from address
// may come from the config instead of RESEND_FROM_EMAIL.
export const requires = { env: ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'], tools: [] };
export const requiresFor = (options = {}) => ({ ...requires, env: requires.env.filter((n) => n !== 'RESEND_FROM_EMAIL' || !options.from) });

export function create(options = {}, ctx = {}) {
  const { adapter, to: toOption, from: fromOption, subjectPrefix, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new Error(`notifier email-resend: unknown option ${unknown.join(', ')}`);
  const env = ctx.env ?? process.env;
  const doFetch = ctx.fetch ?? globalThis.fetch;
  const gitEmail = ctx.gitEmail ?? realGitEmail;
  const prefix = subjectPrefix ?? `[${ctx.project?.name ?? 'Foreman'} factory]`;

  return {
    async send({ subject, text, html }) {
      const key = env.RESEND_API_KEY?.trim();
      const from = (fromOption || env.RESEND_FROM_EMAIL)?.trim();
      const to = (toOption || env.FOREMAN_NOTIFY_EMAIL || env.FACTORY_NOTIFY_EMAIL)?.trim() || gitEmail();
      const missing = [!key && 'RESEND_API_KEY', !from && 'RESEND_FROM_EMAIL', !to && 'a recipient'].filter(Boolean);
      if (missing.length) return { sent: false, reason: `needs RESEND_API_KEY, RESEND_FROM_EMAIL and a recipient (missing: ${missing.join(', ')})`, missing };

      let response = null;
      try {
        response = await doFetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject: `${prefix} ${subject}`, html, text }),
          signal: AbortSignal.timeout(ctx.timeoutMs ?? TIMEOUT_MS),
        });
      } catch {
        response = null;
      }
      if (!response) return { sent: false, reason: 'Resend answered nothing' };
      if (!response.ok) {
        const { name, message } = await errorBody(response);
        return { sent: false, reason: `Resend answered ${response.status}${message ? `: ${message}` : ''}`, status: response.status, code: name };
      }
      return { sent: true, to };
    },
  };
}
