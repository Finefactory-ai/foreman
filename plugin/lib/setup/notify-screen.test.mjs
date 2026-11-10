import { describe, expect, it } from 'vitest';
import { NOTIFY_SCREEN } from './notify-screen.mjs';

describe('NOTIFY_SCREEN', () => {
  it('is plain data, deep-frozen, with part notify', () => {
    const walk = (v, at) => {
      expect(typeof v, at).not.toBe('function');
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v), at).toBe(true);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    walk(NOTIFY_SCREEN, 'NOTIFY_SCREEN');
    expect(JSON.parse(JSON.stringify(NOTIFY_SCREEN))).toEqual(NOTIFY_SCREEN);
    expect(NOTIFY_SCREEN.part).toBe('notify');
  });

  it('offers exactly two choices, email through Resend and none', () => {
    expect(NOTIFY_SCREEN.choices.map((c) => c.value)).toEqual(['email-resend', 'none']);
    for (const c of NOTIFY_SCREEN.choices) expect(typeof c.label === 'string' && c.label.length > 0, c.value).toBe(true);
  });

  it('has words for every result, and the placeholders the page and server fill in', () => {
    const names = ['sent', 'outboxOff', 'outboxNone', 'missing', 'badKey', 'inactiveKey', 'unverified', 'testingOnly', 'tooMany', 'unreachable', 'other', 'badBlock'];
    expect(Object.keys(NOTIFY_SCREEN.results).sort()).toEqual([...names].sort());
    for (const [name, text] of Object.entries(NOTIFY_SCREEN.results)) expect(typeof text === 'string' && text.length > 0, name).toBe(true);
    expect(NOTIFY_SCREEN.results.sent).toContain('{to}');
    expect(NOTIFY_SCREEN.results.missing).toContain('{missing}');
    expect(NOTIFY_SCREEN.results.other).toContain('{reason}');
    expect(NOTIFY_SCREEN.results.badBlock).toContain('{reason}');
    expect(NOTIFY_SCREEN.fromConfig).toContain('{from}');
    expect(NOTIFY_SCREEN.toConfig).toContain('{to}');
    for (const name of ['heading', 'fromTitle', 'fromNote', 'toTitle', 'toNote', 'send', 'sending', 'localOnly', 'badChoice', 'nothingChanged', 'setupFirst']) {
      expect(typeof NOTIFY_SCREEN[name] === 'string' && NOTIFY_SCREEN[name].length > 0, name).toBe(true);
    }
    expect(NOTIFY_SCREEN.send).toBe('Send a test email');
  });
});
