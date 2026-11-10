import { describe, expect, it } from 'vitest';
import { CLOUD_SCREEN } from './cloud-screen.mjs';
import { KEY_CARD, checkShape } from './keys.mjs';

describe('CLOUD_SCREEN', () => {
  it('is plain data, deep-frozen, with no functions and part cloud', () => {
    const walk = (v, at) => {
      expect(typeof v, at).not.toBe('function');
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v), at).toBe(true);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    walk(CLOUD_SCREEN, 'CLOUD_SCREEN');
    expect(JSON.parse(JSON.stringify(CLOUD_SCREEN))).toEqual(CLOUD_SCREEN);
    expect(CLOUD_SCREEN.part).toBe('cloud');
  });

  it('offers Actions and a container, each with its guide ids', () => {
    expect(CLOUD_SCREEN.modes.map((m) => m.value)).toEqual(['actions', 'container']);
    for (const m of CLOUD_SCREEN.modes) expect(typeof m.label === 'string' && m.label.length > 0, m.value).toBe(true);
    expect(CLOUD_SCREEN.guides).toEqual({ actions: ['state-branch', 'workflow', 'token', 'secrets'], container: ['runner-file', 'docker-run'] });
  });

  it('has the placeholders the page and the server fill in', () => {
    expect(CLOUD_SCREEN.missing).toBe('Not set yet: {names}');
    expect(CLOUD_SCREEN.saveFirst).toBe('Save {name} on its step first.');
    expect(CLOUD_SCREEN.errors.ghFailed).toBe('{name}: {detail}');
    expect(CLOUD_SCREEN.errors.notIgnored).toContain('{file}');
    expect(CLOUD_SCREEN.errors.runnerTracked).toContain('{file}');
    expect(CLOUD_SCREEN.errors.runnerLink).toContain('{file}');
    expect(CLOUD_SCREEN.runner.notIgnored).toContain('{file}');
  });

  it("uses the key card's words for the ignore fix, and checkShape's words for a bad token", () => {
    expect(CLOUD_SCREEN.runner.ignore).toBe(KEY_CARD.ignore);
    expect(CLOUD_SCREEN.runner.notIgnored).toBe(KEY_CARD.notIgnored.replace('this key', 'its keys'));
    expect(CLOUD_SCREEN.errors.badToken).toBe(checkShape('GH_TOKEN', 'acme-not-a-token'));
  });

  it('says what the GitHub token needs, as `foreman cloud actions init` does', () => {
    for (const text of ['classic token', 'repo', 'workflow', 'fine-grained', 'Contents and Pull requests read and write', 'Actions and Commit statuses read']) {
      expect(CLOUD_SCREEN.token.note, text).toContain(text);
    }
  });

  it('has words for every error the set-up answers with', () => {
    const names = ['setupFirst', 'badBody', 'noRepo', 'needsBranch', 'workflowExists', 'badToken', 'tokenRefused', 'ghFailed', 'notIgnored', 'nothingChanged', 'runnerTracked', 'runnerLink', 'workflowLink'];
    expect(Object.keys(CLOUD_SCREEN.errors).sort()).toEqual([...names].sort());
    for (const [name, text] of Object.entries(CLOUD_SCREEN.errors)) expect(typeof text === 'string' && text.length > 0, name).toBe(true);
    expect(CLOUD_SCREEN.secrets.set).toBe('Set the secrets');
    expect(CLOUD_SCREEN.runner.write).toBe('Write the runner file');
    expect(CLOUD_SCREEN.check).toBe('Check the runner');
    for (const k of ['name', 'github', 'stored']) expect(typeof CLOUD_SCREEN.secrets.table[k], k).toBe('string');
    for (const k of ['none', 'current', 'old', 'write', 'rewrite', 'commit']) expect(typeof CLOUD_SCREEN.workflow[k], k).toBe('string');
  });
});
