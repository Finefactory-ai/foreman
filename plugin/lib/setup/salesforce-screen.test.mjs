import { describe, expect, it } from 'vitest';
import { SF_SCREEN } from './salesforce-screen.mjs';
import { DEFAULT_INSTANCE_URL } from '../../packs/salesforce/setup.mjs';
import { WORDS } from './salesforce.mjs';

const NAMES = [
  'heading', 'none', 'ready', 'generate', 'upload', 'keyFile', 'certificateFile', 'download', 'downloadName', 'replace', 'replaceWarn', 'confirm', 'cancel',
  'rowUntested', 'rowConnected', 'rowBroken', 'roles', 'notUsed',
  'username', 'clientId', 'instanceUrl', 'instanceUrlNote', 'defaultInstanceUrl', 'connect', 'connecting', 'connected', 'testNext', 'seeStep', 'openStep', 'saveOrgId', 'localOnly', 'keyFirst',
  'followUntested', 'followDone', 'followNot',
];

describe('SF_SCREEN', () => {
  it('is plain data, deep-frozen, with part salesforce', () => {
    const walk = (v, at) => {
      expect(typeof v, at).not.toBe('function');
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v), at).toBe(true);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    walk(SF_SCREEN, 'SF_SCREEN');
    expect(JSON.parse(JSON.stringify(SF_SCREEN))).toEqual(SF_SCREEN);
    expect(SF_SCREEN.part).toBe('salesforce');
  });

  it('has every word the screen draws, each a non-empty string', () => {
    for (const name of NAMES) expect(typeof SF_SCREEN[name] === 'string' && SF_SCREEN[name].length > 0, name).toBe(true);
    expect(SF_SCREEN.downloadName).toBe('foreman.crt');
  });

  it('has the placeholders the page fills in', () => {
    expect(SF_SCREEN.ready).toContain('{fingerprint}');
    expect(SF_SCREEN.ready).toContain('{expires}');
    expect(SF_SCREEN.connected).toContain('{orgId}');
    expect(SF_SCREEN.seeStep).toContain('{n}');
    expect(SF_SCREEN.roles).toContain('{roles}');
    for (const name of ['rowConnected', 'rowBroken', 'followNot']) expect(SF_SCREEN[name], name).toContain('{detail}');
  });

  it('agrees with the set-up code on the login URL and the loopback rule', () => {
    expect(SF_SCREEN.defaultInstanceUrl).toBe(DEFAULT_INSTANCE_URL);
    expect(SF_SCREEN.localOnly).toBe(WORDS.localOnly);
    expect(SF_SCREEN.keyFirst).toBe(WORDS.keyFirst);
  });

  it('holds no guide: no click path and no Setup words, which stay in the model', () => {
    const walk = (v, at) => {
      if (typeof v === 'string') {
        for (const bad of ['External Client App', 'Setup', '›']) expect(v, `${at} ${bad}`).not.toContain(bad);
      }
      if (v && typeof v === 'object') {
        expect(Object.hasOwn(v, 'click'), at).toBe(false);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    walk(SF_SCREEN, 'SF_SCREEN');
  });
});
