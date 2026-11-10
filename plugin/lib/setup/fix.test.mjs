import { describe, expect, it } from 'vitest';
import { withFix } from './fix.mjs';

const OK = { ok: true, level: 'error', detail: '' };
const FAIL = { ok: false, level: 'error', detail: 'broken' };
const WARN = { ok: false, level: 'warn', detail: 'odd' };

describe('withFix', () => {
  it('adds the check step to warn and error results, and leaves ok results untouched', () => {
    const check = (result) => withFix({ name: 'acme', step: 'github', run: () => result });
    expect(check(FAIL).run({})).toEqual({ ...FAIL, fix: { step: 'github' } });
    expect(check(WARN).run({})).toEqual({ ...WARN, fix: { step: 'github' } });
    expect(check(OK).run({})).toBe(OK);
  });

  it("keeps a result's own fix.step, action and hint", () => {
    const own = { ...FAIL, fix: { step: 'notifications', action: 'jira-login', hint: 'add RESEND_API_KEY' } };
    const check = withFix({ name: 'env variables', step: 'project-keys', run: () => own });
    expect(check.run({})).toEqual({ ...FAIL, fix: { step: 'notifications', action: 'jira-login', hint: 'add RESEND_API_KEY' } });
    const hintOnly = withFix({ name: 'x', step: 'tools', run: () => ({ ...FAIL, fix: { hint: 'install acme' } }) });
    expect(hintOnly.run({})).toEqual({ ...FAIL, fix: { step: 'tools', hint: 'install acme' } });
  });

  it('stays synchronous for a sync run, and works for an async one', async () => {
    const sync = withFix({ name: 'a', step: 'tools', run: () => FAIL });
    const r = sync.run({});
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.fix.step).toBe('tools');
    const later = withFix({ name: 'b', step: 'jira-site', run: async () => WARN });
    const p = later.run({});
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toEqual({ ...WARN, fix: { step: 'jira-site' } });
  });

  it("gives a check without a step 'project', and passes ctx through", () => {
    let seen;
    const check = withFix({ name: 'acme org', run: (ctx) => { seen = ctx; return FAIL; } });
    expect(check.step).toBe('project');
    expect(check.name).toBe('acme org');
    expect(check.run({ root: '/acme' }).fix.step).toBe('project');
    expect(seen).toEqual({ root: '/acme' });
  });
});
