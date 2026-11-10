import { describe, expect, it } from 'vitest';
import { JIRA_SCREEN, jqlFor, suggestTransitions } from './jira-screen.mjs';
import { stepById } from './steps.mjs';
import { PROJECT_FORM } from './project.mjs';
import { DEFAULT_PORT } from '../jira/login.mjs';
import { TRANSITION_EVENTS } from '../settings/registry.mjs';
import { checkOptions } from '../adapters/stories/jira.mjs';

const guideText = (step) => step.guide.map((g) => `${g.text} ${(g.click ?? []).join(' ')}`).join('\n');
const NONE = { started: null, blocked: null, review: null, failed: null, shipped: null };

describe('JIRA_SCREEN', () => {
  it('is plain data, deep-frozen, in three parts', () => {
    const walk = (v, at) => {
      expect(typeof v, at).not.toBe('function');
      if (v && typeof v === 'object') {
        expect(Object.isFrozen(v), at).toBe(true);
        for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
      }
    };
    walk(JIRA_SCREEN, 'JIRA_SCREEN');
    expect(JSON.parse(JSON.stringify(JIRA_SCREEN))).toEqual(JIRA_SCREEN);
    expect(Object.keys(JIRA_SCREEN)).toEqual(['app', 'signin', 'filter']);
    for (const [name, part] of Object.entries(JIRA_SCREEN)) expect(part.part).toBe(name);
  });

  it("lists the registry's transition events, in order", () => {
    expect(JIRA_SCREEN.filter.events.map((e) => e.id)).toEqual(TRANSITION_EVENTS);
    for (const e of JIRA_SCREEN.filter.events) expect(typeof e.label === 'string' && e.label.length > 0, e.id).toBe(true);
  });

  it("gives the app's callback, the one the jira-app guide names", () => {
    expect(JIRA_SCREEN.app.callback).toBe(`http://localhost:${DEFAULT_PORT}/callback`);
    expect(guideText(stepById('jira-app'))).toContain(JIRA_SCREEN.app.callback);
  });

  it('holds the sign-in words the page fills in', () => {
    expect(JIRA_SCREEN.signin.signedIn).toContain('{site}');
    expect(JIRA_SCREEN.signin.signedIn).toContain('{account}');
    expect(JIRA_SCREEN.signin.localOnly).toBe(
      'Jira sign-in works only on a dashboard that listens on this computer alone (127.0.0.1). To use it from another machine, open it through an SSH tunnel.',
    );
    expect(JIRA_SCREEN.filter.leave).toBe('Leave where it is');
    expect(JIRA_SCREEN.filter.count).toContain('{count}');
  });
});

describe('jqlFor', () => {
  it("fills in the project's key, as the project form's placeholder has it", () => {
    expect(jqlFor('KEY')).toBe(PROJECT_FORM.fields.find((f) => f.id === 'jql').placeholder);
    expect(jqlFor('ACME').startsWith('project = ACME AND labels = foreman')).toBe(true);
  });
});

describe('suggestTransitions', () => {
  it("suggests from an Acme project's three statuses", () => {
    const statuses = [
      { name: 'To Do', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' },
      { name: 'Done', category: 'done' },
    ];
    expect(suggestTransitions(statuses)).toEqual({ ...NONE, started: 'In Progress', shipped: 'Done' });
  });

  it('picks review, blocked and Done from a richer set, and never failed', () => {
    const statuses = [
      { name: 'Doing', category: 'indeterminate' },
      { name: 'In Review', category: 'indeterminate' },
      { name: 'Blocked', category: 'indeterminate' },
      { name: 'Closed', category: 'done' },
      { name: 'Done', category: 'done' },
    ];
    expect(suggestTransitions(statuses)).toEqual({ started: 'Doing', blocked: 'Blocked', review: 'In Review', failed: null, shipped: 'Done' });
  });

  it('takes the first done status when none is named Done', () => {
    expect(suggestTransitions([{ name: 'Closed', category: 'done' }])).toEqual({ ...NONE, shipped: 'Closed' });
  });

  it('suggests nothing for no statuses', () => {
    expect(suggestTransitions([])).toEqual(NONE);
    expect(suggestTransitions(undefined)).toEqual(NONE);
  });

  it('makes a stories block, with the suggestions that are set, that the adapter takes', () => {
    const suggested = suggestTransitions([
      { name: 'To Do', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' },
      { name: 'Done', category: 'done' },
    ]);
    const transitions = Object.fromEntries(Object.entries(suggested).filter(([, v]) => v !== null));
    expect(() => checkOptions({ site: 'acme.atlassian.net', jql: jqlFor('ACME'), ownerLabel: 'foreman-owner', transitions })).not.toThrow();
  });
});
