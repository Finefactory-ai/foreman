import { describe, expect, it } from 'vitest';
import { lastLine, redact, SECRET_NAMES } from './redact.mjs';

const SENTINEL = 'ACME-SENTINEL-0001';

describe('redact', () => {
  it('blanks a value it is given', () => {
    const out = redact(`the server said ${SENTINEL} twice: ${SENTINEL}`, { values: [SENTINEL] });
    expect(out).not.toContain(SENTINEL);
    expect(out).toBe('the server said ••• twice: •••');
  });

  it('blanks a secret held in the environment', () => {
    const out = redact(`token ${SENTINEL} refused`, { env: { GH_TOKEN: SENTINEL } });
    expect(out).toBe('token ••• refused');
  });

  it('ignores empty values and names that are not secrets', () => {
    expect(redact('acme', { env: { GH_TOKEN: '', ACME_URL: 'acme' }, values: [''] })).toBe('acme');
  });

  it('keeps the Bearer prefix', () => {
    expect(redact('Authorization: Bearer abc')).toBe('Authorization: Bearer •••');
  });

  it('blanks token-shaped text', () => {
    const out = redact('a sk-ant-api03-acmeacmeacme and ghp_acmeacmeacmeacmeacmeacme b');
    expect(out).toBe('a ••• and ••• b');
  });

  it('names the same five secrets as before, frozen', () => {
    expect(SECRET_NAMES).toEqual(['GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'FOREMAN_DASHBOARD_TOKEN']);
    expect(Object.isFrozen(SECRET_NAMES)).toBe(true);
  });
});

describe('lastLine', () => {
  it('takes the last line of stderr, redacted', () => {
    expect(lastLine({ stderr: 'one\ntwo ACME-SENTINEL-0001\n', stdout: 'out' }, { GH_TOKEN: SENTINEL })).toBe('two •••');
  });

  it('falls back to stdout', () => {
    expect(lastLine({ stderr: '', stdout: 'a\nb\n' }, {})).toBe('b');
  });

  it('cuts to 200 characters', () => {
    expect(lastLine({ stderr: 'x'.repeat(300) }, {})).toHaveLength(200);
  });

  it('is empty when nothing was said', () => {
    expect(lastLine({}, {})).toBe('');
  });
});
