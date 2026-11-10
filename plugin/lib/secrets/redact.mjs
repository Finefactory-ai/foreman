// Blanks secrets out of text before Foreman prints it: what a command said, or what a service
// answered when a key was tested.
//
//   SECRET_NAMES                       the variables whose values are always blanked (frozen)
//   TOKENISH                           token-shaped text blanked wherever it appears
//   redact(text, { env, names, values }) -> text
//                                      each non-empty env[name] for `names` and each non-empty
//                                      extra value becomes •••, then the token-shaped text; a
//                                      Bearer keeps its "Bearer " prefix
//   lastLine(r, env)                   the last line of r.stderr, else r.stdout, redacted and
//                                      cut to 200 characters

export const SECRET_NAMES = Object.freeze(['GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'FOREMAN_DASHBOARD_TOKEN']);
export const TOKENISH = Object.freeze([/\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bsk-ant-[A-Za-z0-9_-]{10,}/g, /(Bearer\s+)\S+/gi]);

const BLANK = '•••';

export function redact(text, { env = {}, names = SECRET_NAMES, values = [] } = {}) {
  let out = String(text ?? '');
  const secrets = [...names.map((name) => env?.[name]), ...values].filter((v) => typeof v === 'string' && v !== '');
  for (const secret of secrets) out = out.split(secret).join(BLANK);
  for (const re of TOKENISH) out = out.replace(re, (m, bearer) => (typeof bearer === 'string' && /^Bearer/i.test(m) ? `${bearer}${BLANK}` : BLANK));
  return out;
}

export function lastLine(r, env) {
  const text = String(r?.stderr || r?.stdout || '').trim().split('\n').pop() ?? '';
  return redact(text, { env }).slice(0, 200);
}
