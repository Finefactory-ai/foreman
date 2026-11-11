import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { add, EXPLAIN_LABELS, explainProblems, pending } from '../console/decisions.mjs';
import { buildWaiting } from '../console/waiting.mjs';
import { ACTION_HELP } from './help.mjs';
import { REGISTRY, TYPES } from '../settings/registry.mjs';
import { limitsOf } from '../settings/change.mjs';
import { AREAS, DOCS_URL, OFF_WORDS, RUN_SETUP, SETUP_FIRST, STEPS, stepById } from '../setup/steps.mjs';
import { PROJECT_FORM, WORDS as PROJECT_WORDS } from '../setup/project.mjs';
import { KEY_CARD } from '../setup/keys.mjs';
import { SIGNIN } from '../setup/claude.mjs';
import { JIRA_SCREEN } from '../setup/jira-screen.mjs';
import { NOTIFY_SCREEN } from '../setup/notify-screen.mjs';
import { SF_SCREEN } from '../setup/salesforce-screen.mjs';
import { GEARSET_SCREEN } from '../setup/gearset-screen.mjs';
import { CLOUD_SCREEN } from '../setup/cloud-screen.mjs';
import { ERRORS as SF_ERRORS } from '../setup/salesforce.mjs';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>'), PAGE.lastIndexOf('</script>'));

describe('page.html', () => {
  it('loads nothing from elsewhere', () => {
    expect(PAGE).not.toMatch(/\b(src|href)\s*=\s*["']?\s*(https?:)?\/\//i);
    expect(PAGE).not.toMatch(/@import|url\(\s*["']?(https?:)?\/\//i);
    expect(PAGE).not.toMatch(/<link\b/i);
    expect(PAGE).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  it('shows standby as a live, steady loop state', () => {
    expect(SCRIPT).toMatch(/const LOOP = \{[^}]*standby: 'Standby'/);
    expect(PAGE).toMatch(/\.s-standby \.lamp\{[^}]*\}/);
    expect(PAGE).not.toMatch(/\.s-standby \.lamp\{[^}]*animation/);
    expect(PAGE).toMatch(/\.s-standby b\{color:var\(--/);
    expect(SCRIPT.match(/const silent = [^\n]*/)[0]).toContain("'standby'");
    expect(SCRIPT.match(/const runGoing = [^\n]*/)[0]).toContain("'standby'");
  });

  it('gives text links a 44 px tap area on touch screens', () => {
    expect(PAGE).toMatch(/@media \(pointer:coarse\)\{a\{position:relative\}a::after\{content:"";position:absolute;inset:-14px -6px\}\}/);
  });

  it('carries no project of its own, and nothing from the claude.ai runtime', () => {
    expect(PAGE).not.toContain('window.claude');
    expect(PAGE).not.toContain('claude.ai');
    expect(PAGE).not.toMatch(/\bP\d+-\d+\b/);
  });

  describe('renders the Taken by you list', () => {
    // The real renderQueue and SENT from the page, run against a fake document and stubs for
    // what the function closes over.
    const NODE = `
      const node = (tag, cls, text) => ({
        tag, cls: cls || null, text: text == null ? null : String(text), children: [], dataset: {}, attrs: {}, hidden: false, disabled: false, type: null, on: {},
        get textContent() { return this.text; }, set textContent(v) { this.text = String(v); },
        setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
        addEventListener(t, f) { this.on[t] = f; }, append(...xs) { this.children.push(...xs); },
        replaceChildren(...xs) { this.children = xs; },
      });
      const el = node;`;
    const render = (input) => new Function('input', `
      ${NODE}
      const nodes = {};
      const $ = (id) => (nodes[id] ??= node('div'));
      let status = input.status;
      const queuedRows = () => [];
      const keepFocus = (box, fn) => fn();
      const requested = () => status?.requested || {};
      const waitingFor = () => input.waiting === true;
      const canAct = () => input.canAct !== false;
      const busy = new Set();
      const help = null;
      const helpFor = () => null;
      const withHelp = (b) => b;
      const sent = [];
      const command = (...a) => sent.push(a);
      const when = (iso) => 'at ' + iso;
      const hhmm = () => '';
      const linkTo = (h, t) => t;
      const dollars = () => '';
      const duration = () => '';
      ${SCRIPT.match(/const SENT = [^\n]+/)[0]}
      ${SCRIPT.match(/function renderQueue\(\) \{[\s\S]*?\n {2}\}\n/)[0]}
      renderQueue();
      return { nodes, sent, SENT };
    `)(input);

    const FIRST = { id: 'ACME-3', title: 'Fix the login page', at: '2026-10-24T09:00:00Z' };

    it('shows the id, the title, when it was taken and a Hand back button that sends the hand back', () => {
      const { nodes, sent } = render({ status: { ownerClaims: [FIRST, { id: 'ACME-4' }] } });
      expect(nodes.claims.hidden).toBe(false);
      expect(nodes['claim-list'].children).toHaveLength(2);
      const [qid, qt, button] = nodes['claim-list'].children[0].children;
      expect(qid).toMatchObject({ tag: 'span', cls: 'qid', text: 'ACME-3' });
      expect(qt).toMatchObject({ tag: 'div', cls: 'qt', text: 'Fix the login page' });
      expect(qt.children).toHaveLength(1);
      expect(qt.children[0]).toMatchObject({ tag: 'span', cls: 'num', text: 'Taken at 2026-10-24T09:00:00Z' });
      expect(button).toMatchObject({ tag: 'button', cls: 'btn ghost', text: 'Hand back', type: 'button', disabled: false });
      expect(button.dataset.key).toBe('handback:ACME-3');
      expect(button.attrs['aria-label']).toBe('Hand ACME-3 back to the run');
      expect(sent).toEqual([]);
      button.on.click();
      expect(sent).toEqual([[{ action: 'handback', id: 'ACME-3' }, 'handback:ACME-3']]);
    });

    it('says Taken by you, with no date, for a story with no title and no time', () => {
      const { nodes } = render({ status: { ownerClaims: [FIRST, { id: 'ACME-4' }] } });
      const [qid, qt, button] = nodes['claim-list'].children[1].children;
      expect(qid.text).toBe('ACME-4');
      expect(qt.text).toBe('Taken by you');
      expect(qt.children.find((c) => c.cls === 'num')).toBeUndefined();
      expect(button.dataset.key).toBe('handback:ACME-4');
    });

    it('shows the sent note after the Taken span while a hand back is waiting', () => {
      const status = { ownerClaims: [FIRST], requested: { handBack: { id: 'ACME-3', at: '2026-10-24T09:05:00Z' } } };
      const { nodes, SENT } = render({ status, waiting: true });
      const qt = nodes['claim-list'].children[0].children[1];
      expect(qt.children.map((c) => [c.cls, c.text])).toEqual([['num', 'Taken at 2026-10-24T09:00:00Z'], ['cnote on', SENT]]);
    });

    it('shows no sent note once the run has acted, or for another story', () => {
      const back = { id: 'ACME-3', at: '2026-10-24T09:05:00Z' };
      const done = render({ status: { ownerClaims: [FIRST], requested: { handBack: back } }, waiting: false });
      expect(done.nodes['claim-list'].children[0].children[1].children.map((c) => c.cls)).toEqual(['num']);
      const other = render({ status: { ownerClaims: [FIRST], requested: { handBack: { ...back, id: 'ACME-9' } } }, waiting: true });
      expect(other.nodes['claim-list'].children[0].children[1].children.map((c) => c.cls)).toEqual(['num']);
    });

    it('disables Hand back when the page cannot act', () => {
      const { nodes } = render({ status: { ownerClaims: [FIRST] }, canAct: false });
      expect(nodes['claim-list'].children[0].children[2].disabled).toBe(true);
    });

    it('hides the box and empties the list with no owner claims', () => {
      const { nodes } = render({ status: {} });
      expect(nodes.claims.hidden).toBe(true);
      expect(nodes['claim-list'].children).toHaveLength(0);
    });
  });

  it('talks to the dashboard API', () => {
    for (const path of ['/api/status', '/api/events', '/api/control', '/api/decisions', '/api/waiting', '/api/settings', '/api/help', '/api/setup', '/api/tokens', '/api/learned']) expect(SCRIPT).toContain(`'${path}`);
    expect(SCRIPT).not.toContain(['/api/help', 'guide'].join('/'));
    expect(SCRIPT).toContain('new EventSource(');
  });

  it('lays the Command centre out as the waiting strip, the slot rows, then a tabbed details card beside the controls', () => {
    const at = (needle) => { const i = PAGE.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    expect(at('class="panel a-dec"')).toBeLessThan(at('<section class="a-now"'));
    expect(at('<section class="a-now"')).toBeLessThan(at('<section class="panel tabcard"'));
    expect(at('<section class="panel tabcard"')).toBeLessThan(at('<div class="cc-side">'));
    expect(at('<div class="cc-side">')).toBeLessThan(at('class="panel a-ctl"'));
    expect(at('class="panel a-ctl"')).toBeLessThan(at('class="panel a-gauge"'));
    // One tab per pane, in order, each pane labelled by its tab, only the first shown.
    const keys = ['feed', 'next', 'done', 'prog', 'tok'];
    keys.forEach((k, i) => {
      expect(PAGE).toMatch(new RegExp(`<button type="button" role="tab" id="sub-${k}" aria-controls="pane-${k}" aria-selected="${i === 0}"`));
      expect(PAGE).toMatch(new RegExp(`<section class="tabpane a-${k}" id="pane-${k}" role="tabpanel" aria-labelledby="sub-${k}"${i === 0 ? '>' : ' hidden>'}`));
      if (i) expect(at(`id="sub-${k}"`)).toBeGreaterThan(at(`id="sub-${keys[i - 1]}"`));
    });
    expect(PAGE).toContain('<h2 class="ph" id="h-tok">Tokens <span class="tag num" id="tok-tag"></span></h2><div id="tokens">');
    expect(PAGE).not.toMatch(/grid-template-areas:"now/);
    expect(SCRIPT).toContain("setupSubtabs(document.querySelector('.subtabs'));");
  });

  it('switches the details tabs by click and by the arrow keys, Home and End', () => {
    const fn = new Function('$', 'document', `${SCRIPT.match(/function setupSubtabs\(bar\) \{[\s\S]*?\n {2}\}\n/)[0]}; return setupSubtabs;`);
    const panes = new Map();
    const node = (attrs = {}) => { const n = { attrs: new Map(Object.entries(attrs)), hidden: false, tabIndex: 0, on: {}, setAttribute: (k, v) => n.attrs.set(k, String(v)), getAttribute: (k) => n.attrs.get(k), addEventListener: (t, f) => { n.on[t] = f; }, focus: () => { doc.activeElement = n; } }; return n; };
    const tabs = ['feed', 'next', 'done'].map((k) => { panes.set('pane-' + k, node()); return node({ 'aria-controls': 'pane-' + k }); });
    const bar = node(); bar.querySelectorAll = () => tabs;
    const doc = { activeElement: null };
    fn((id) => panes.get(id), doc)(bar);
    tabs[1].on.click();
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect([...panes.values()].map((p) => p.hidden)).toEqual([true, false, true]);
    doc.activeElement = tabs[1];
    const key = (k) => bar.on.keydown({ key: k, preventDefault() {} });
    key('ArrowRight'); expect(doc.activeElement).toBe(tabs[2]);
    key('ArrowRight'); expect(doc.activeElement).toBe(tabs[0]);
    key('End'); expect(doc.activeElement).toBe(tabs[2]);
    key('Home'); expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('loads the tokens at start and when a story ends, and shows no money in them', () => {
    expect(SCRIPT).toContain("api('/api/tokens')");
    expect(SCRIPT).toMatch(/\n {2}loadTokens\(\);\n/);
    const set = SCRIPT.slice(SCRIPT.indexOf('function setStatus(snap) {'), SCRIPT.indexOf('\n  }\n', SCRIPT.indexOf('function setStatus(snap) {')));
    expect(set).toContain('loadTokens()');
    expect(set).toContain('recent');
    expect(set).toContain('totals');
    const start = SCRIPT.indexOf('function renderTokens() {');
    expect(start).toBeGreaterThan(-1);
    const body = SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
    expect(body).not.toContain('dollars(');
    expect(body).not.toContain('costUsd');
    expect(body).not.toMatch(/\$\d|'\$'/);
    for (const field of ['todayText', 'weekText', 'runText', 'sparkText', 'weekLine', 'totalText', 'hints', 'unknown', 'empty']) expect(body, field).toContain(field);
    expect(body).toContain("'last 14 days'");
    expect(body).not.toMatch(/toFixed|toLocaleString/);
  });

  it("shows each role's and each story agent's recorded models", () => {
    const start = SCRIPT.indexOf('function renderTokens() {');
    const body = SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
    expect(body).toContain("el('span', 'tmodel', ' ' + ");
    expect(body.match(/modelsText/g).length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("' (' + ");
  });

  it('takes the token only from its own address and never shows or logs it', () => {
    expect(SCRIPT).toContain("const TOKEN = new URLSearchParams(location.search).get('token') || '';");
    expect(SCRIPT.match(/location\.search/g)).toHaveLength(1);
    // Authorization is set in one place, from TOKEN.
    const auth = SCRIPT.match(/Authorization[^\n]*/g);
    expect(auth).toHaveLength(1);
    expect(auth[0]).toContain("'Bearer ' + TOKEN");
    // The token goes nowhere but the header and the event stream's address.
    const uses = SCRIPT.match(/\bTOKEN\b/g).length;
    expect(uses).toBe(5); // the declaration, the header (twice), the stream address (twice)
    expect(SCRIPT).not.toMatch(/console\.|sessionStorage|document\.cookie/);
    // Storage is opened in one place, for the theme, and changed only by the theme picker.
    expect(SCRIPT.match(/localStorage/g)).toHaveLength(1);
    expect(SCRIPT.match(/setItem\(/g)).toHaveLength(1);
    expect(SCRIPT.match(/removeItem\(/g)).toHaveLength(1);
    expect(SCRIPT).toContain('store.setItem(KEY, mode)');
  });

  it('asks before stop and discard without window.confirm, and polls when the stream fails', () => {
    expect(SCRIPT).not.toMatch(/\bconfirm\(|\balert\(|\bprompt\(/);
    expect(SCRIPT).toContain('confirmRow(');
    expect(SCRIPT).toContain('const POLL_MS = 10000;');
  });

  it('shows each finished story\'s cost and minutes, and the run\'s totals by the heading', () => {
    expect(PAGE).toContain('<span class="tag num" id="done-tag"></span>');
    expect(SCRIPT).toContain("$('done-tag').textContent");
    expect(SCRIPT).toContain('status?.totals');
    expect(SCRIPT).toContain("typeof s.costUsd === 'number'");
    expect(SCRIPT).toContain("typeof s.minutes === 'number'");
    // the two formatters, run as the page runs them
    const dollars = new Function(`${SCRIPT.match(/const dollars = [^\n]+/)[0]}; return dollars;`)();
    const duration = new Function(`${SCRIPT.match(/const duration = [^\n]+/)[0]}; return duration;`)();
    expect([dollars(2.456), dollars(null)]).toEqual(['$2.46', '$0.00']);
    expect([duration(0.4), duration(41.5), duration(125)]).toEqual(['<1 min', '42 min', '2 h 5 min']);
  });

  it('lists the stories ready to promote in the Finished panel', () => {
    expect(PAGE).toContain('id="ready-list"');
    expect(PAGE).toContain('>Ready to promote</h3>');
    expect(PAGE.indexOf('id="ready-list"')).toBeGreaterThan(PAGE.indexOf('class="panel a-done"'));
    expect(PAGE.indexOf('id="ready-list"')).toBeLessThan(PAGE.indexOf('<ol class="list" id="recent">'));
    expect(SCRIPT).toContain('status?.parked');
  });

  it('never shows a bare Running while the run is stuck', () => {
    expect(SCRIPT).toContain("'Running, but stuck: ' + status.stuck.reason");
  });

  it('names no address but the user guide, not even in text', () => {
    // The one address is the Help link's, set from the script (the Help link tests).
    const rest = PAGE.split(DOCS_URL).join('');
    expect(PAGE.split(DOCS_URL).length - 1).toBe(1);
    expect(rest).not.toMatch(/https?:\/\/[A-Za-z0-9[]/);
    expect(rest).not.toMatch(/\bwww\./);
  });
});

describe('the theme', () => {
  const block = (selector) => {
    const start = PAGE.indexOf(selector + '{');
    if (start < 0) return null;
    const from = start + selector.length + 1;
    return PAGE.slice(from, PAGE.indexOf('}', from));
  };
  const tokens = (text) => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const THEMES = { light: ':root', dark: ':root[data-mode="dark"]' };
  const SYSTEM_DARK = '@media (prefers-color-scheme:dark){:root:not([data-mode="light"]){';
  const themeTokens = (name) => tokens(block(THEMES[name]) ?? '');

  const parse = (value) => {
    const v = value.trim().toLowerCase();
    let m = v.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
    if (m) return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
    m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    throw new Error(`cannot read the colour ${value}`);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const ratio = (fg, bg) => {
    const a = luminance(fg); const b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const hue = ({ r, g, b }) => {
    const [R, G, B] = [r / 255, g / 255, b / 255];
    const max = Math.max(R, G, B); const min = Math.min(R, G, B); const d = max - min;
    if (d === 0) return 0;
    let h;
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

  const backgrounds = (t) => {
    const voidC = parse(t.void);
    return { void: voidC, deep: over(parse(t.deep), voidC), panel: over(parse(t.panel), voidC) };
  };
  // Every pair below `min`, named with its theme and ratio, so a failure says what to fix.
  const failures = (theme, pairs, min) => pairs
    .map(([name, fg, bg]) => [name, ratio(over(fg, bg), bg)])
    .filter(([, r]) => r < min)
    .map(([name, r]) => `${theme}: ${name} is ${r.toFixed(2)}:1, needs ${min}:1`);

  it('is light by default and dark when the computer is, unless this browser chose', () => {
    const t = themeTokens('light');
    expect(t.void.toLowerCase()).toBe('#eef1f6');
    expect(block(THEMES.light)).toContain('color-scheme:light');
    expect(block(THEMES.dark)).toContain('color-scheme:dark');
    // The computer's dark setting uses the dark set, word for word, unless Light was picked.
    const at = PAGE.indexOf(SYSTEM_DARK);
    expect(at).toBeGreaterThan(-1);
    const system = PAGE.slice(at + SYSTEM_DARK.length, PAGE.indexOf('}', at + SYSTEM_DARK.length));
    expect(system).toBe(block(THEMES.dark));
    expect(PAGE).not.toContain('data-theme');
    expect(PAGE).not.toContain('--cyan');
  });

  it('has a dark set that sets every colour the light set sets', () => {
    expect(block(THEMES.dark)).not.toBeNull();
    const dark = themeTokens('dark');
    const missing = Object.keys(themeTokens('light')).filter((k) => !['display', 'mono', 'code'].includes(k) && !(k in dark));
    expect(missing).toEqual([]);
  });

  it('keeps every colour a token', () => {
    let css = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
    const cut = (open) => {
      const start = css.indexOf(open);
      expect(start).toBeGreaterThanOrEqual(0);
      css = css.slice(0, start) + css.slice(css.indexOf('}', start + open.length) + 1);
    };
    for (const selector of Object.values(THEMES)) cut(selector + '{');
    cut(SYSTEM_DARK);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it.each(Object.keys(THEMES))('meets WCAG AA for text in the %s theme', (theme) => {
    const t = themeTokens(theme);
    const c = (k) => parse(t[k]);
    const pairs = [];
    for (const [bgName, bg] of Object.entries(backgrounds(t))) {
      for (const fg of ['text', 'dim', 'accent', 'mint', 'amber', 'red']) pairs.push([`${fg} on ${bgName}`, c(fg), bg]);
    }
    for (const fill of ['accent', 'amber', 'red', 'mint']) pairs.push([`on-accent on ${fill}`, c('on-accent'), c(fill)]);
    const panel = backgrounds(t).panel;
    for (const [wash, own] of [['red-wash', 'red'], ['amber-wash', 'amber'], ['mint-wash', 'mint'], ['accent-wash', 'accent']]) {
      const bg = over(c(wash), panel);
      for (const fg of ['text', 'dim', own]) pairs.push([`${fg} on ${wash}`, c(fg), bg]);
    }
    expect(failures(theme, pairs, 4.5)).toEqual([]);
  });

  it.each(Object.keys(THEMES))('meets 3:1 for control borders and focus in the %s theme', (theme) => {
    const t = themeTokens(theme);
    const pairs = [];
    for (const [bgName, bg] of Object.entries(backgrounds(t))) {
      for (const fg of ['edge-hot', 'accent', 'faint']) pairs.push([`${fg} on ${bgName}`, parse(t[fg]), bg]);
    }
    expect(failures(theme, pairs, 3)).toEqual([]);
  });

  it.each(Object.keys(THEMES))('keeps good, warn and bad apart from the accent and each other in the %s theme', (theme) => {
    const t = themeTokens(theme);
    const names = ['accent', 'mint', 'amber', 'red'];
    const close = [];
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const gap = hueGap(hue(parse(t[names[i]])), hue(parse(t[names[j]])));
        if (gap < 20) close.push(`${theme}: ${names[i]} and ${names[j]} are ${gap.toFixed(1)} degrees apart`);
      }
    }
    expect(close).toEqual([]);
  });

  it('can fail: the old light border on the old light background is under 3:1', () => {
    expect(ratio(parse('#7ea8bb'), parse('#eef3f6'))).toBeLessThan(3);
  });

  it('has a theme picker in the header with a 44 px tap area', () => {
    const markup = '<label class="themepick"><span>Theme</span><select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>';
    expect(PAGE).toContain(markup);
    const at = PAGE.indexOf(markup);
    expect(at).toBeGreaterThan(PAGE.indexOf('<header>'));
    expect(at).toBeLessThan(PAGE.indexOf('</header>'));
    expect(PAGE).toMatch(/\.themepick\{[^}]*min-height:44px/);
  });

  const setupTheme = () => new Function(`${SCRIPT.match(/function setupTheme\(root, select, store\) \{[\s\S]*?\n {2}\}\n/)[0]}; return setupTheme;`)();
  const fakeRoot = () => {
    const attrs = new Map();
    return { attrs, setAttribute: (k, v) => attrs.set(k, String(v)), removeAttribute: (k) => attrs.delete(k), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null) };
  };
  const fakeSelect = () => {
    const node = { value: '', change: null, addEventListener: (type, fn) => { if (type === 'change') node.change = fn; } };
    node.pick = (v) => { node.value = v; node.change(); };
    return node;
  };
  const fakeStore = (entries = []) => {
    const map = new Map(entries);
    return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
  };

  it('follows the computer until a mode is picked, and remembers only a picked mode', () => {
    const setup = setupTheme();
    const store = fakeStore();
    let root = fakeRoot(); let select = fakeSelect();
    setup(root, select, store);
    expect(root.getAttribute('data-mode')).toBeNull();
    expect(select.value).toBe('system');

    select.pick('dark');
    expect(root.getAttribute('data-mode')).toBe('dark');
    expect(store.map.get('foreman.mode')).toBe('dark');

    root = fakeRoot(); select = fakeSelect();
    setup(root, select, store);
    expect(root.getAttribute('data-mode')).toBe('dark');
    expect(select.value).toBe('dark');

    select.pick('light');
    expect(root.getAttribute('data-mode')).toBe('light');
    expect(store.map.get('foreman.mode')).toBe('light');

    select.pick('system');
    expect(root.getAttribute('data-mode')).toBeNull();
    expect(store.map.has('foreman.mode')).toBe(false);

    for (const odd of ['purple', 'yellow']) {
      const r = fakeRoot(); const s = fakeSelect();
      setup(r, s, fakeStore([['foreman.mode', odd]]));
      expect(r.getAttribute('data-mode')).toBeNull();
      expect(s.value).toBe('system');
    }
  });

  it('still renders and switches when storage is blocked', () => {
    const setup = setupTheme();
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    for (const store of [blocked, null]) {
      const root = fakeRoot(); const select = fakeSelect();
      expect(() => setup(root, select, store)).not.toThrow();
      expect(root.getAttribute('data-mode')).toBeNull();
      expect(() => select.pick('dark')).not.toThrow();
      expect(root.getAttribute('data-mode')).toBe('dark');
      expect(() => select.pick('system')).not.toThrow();
      expect(root.getAttribute('data-mode')).toBeNull();
    }
  });

  it('wires the picker to the page', () => {
    expect(SCRIPT).toContain("setupTheme(document.documentElement, $('theme'), ");
    expect(SCRIPT).toContain('try { return window.localStorage; } catch');
  });
});

describe('the Insights tab', () => {
  // With the page's own money and time formatters, as it runs.
  const insightTiles = (week) => new Function(`${SCRIPT.match(/const dollars = [^\n]+/)[0]}\n${SCRIPT.match(/const duration = [^\n]+/)[0]}\n${SCRIPT.match(/function insightTiles\(week\) \{[\s\S]*?\n {2}\}\n/)[0]}; return insightTiles;`)()(week);
  const usageByAgent = lifted(/function usageByAgent\(roles, n\) \{[\s\S]*?\n {2}\}\n/, 'usageByAgent');
  const dayLabel = lifted(/function dayLabel\(day\) \{[\s\S]*?\n {2}\}\n/, 'dayLabel');
  const storyTokenSeries = lifted(/function storyTokenSeries\(tps\) \{[\s\S]*?\n {2}\}\n/, 'storyTokenSeries');

  it('is a tab after the Command centre, with its own view and address', () => {
    expect(PAGE).toMatch(/<button type="button" role="tab" id="tab-insights" aria-controls="view-insights" aria-selected="false" tabindex="-1"><svg class="ticon" [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>Insights<\/button>/);
    expect(PAGE.indexOf('id="tab-insights"')).toBeGreaterThan(PAGE.indexOf('id="tab-run"'));
    expect(PAGE.indexOf('id="tab-insights"')).toBeLessThan(PAGE.indexOf('id="tab-waiting"'));
    expect(PAGE).toContain('<section class="sview" id="view-insights" role="tabpanel" aria-labelledby="tab-insights" tabindex="-1" hidden><div id="insights">');
    expect(SCRIPT).toContain("['insights', $('tab-insights'), $('view-insights')]");
    expect(SCRIPT).toContain("h === '#insights' ? 'insights'");
    expect(SCRIPT).toContain("['setup', 'run', 'insights', 'waiting', 'settings'] : ['run', 'insights', 'waiting', 'settings', 'setup']");
    expect(SCRIPT).toContain("if (name === 'insights') loadInsights();");
    expect(SCRIPT).toContain("api('/api/history')");
  });

  it('leads with four numbers for the last 7 days', () => {
    expect(insightTiles({ finished: 4, shipped: 3, costUsd: 9.5, medianMinutes: 30, firstTry: 2, stages: {} })).toEqual([
      { label: 'Stories shipped', value: '3', note: '0.4 a day on average' },
      { label: 'Ship rate', value: '75%', note: '1 of 4 did not ship' },
      { label: 'Typical time to ship', value: '30 min', note: '67% shipped on the first try' },
      { label: 'Spend', value: '$9.50', note: '$3.17 per shipped story' },
    ]);
    expect(insightTiles({ finished: 0, shipped: 0, costUsd: 0, medianMinutes: null, firstTry: 0, stages: {} })).toEqual([
      { label: 'Stories shipped', value: '0', note: '0.0 a day on average' },
      { label: 'Ship rate', value: '–', note: 'Nothing finished in the last 7 days' },
      { label: 'Typical time to ship', value: '–', note: 'Nothing shipped yet' },
      { label: 'Spend', value: '$0.00', note: '' },
    ]);
    // From $100 up, whole dollars with a thousands mark.
    expect(insightTiles({ finished: 200, shipped: 192, costUsd: 1357.53, medianMinutes: 30, firstTry: 160, stages: {} })[3]).toEqual({ label: 'Spend', value: '$1,358', note: '$7.07 per shipped story' });
  });

  it('folds the token roles into four groups, day by day, for the days on show', () => {
    const spark = (n) => Array.from({ length: 14 }, (_, i) => (i === 13 ? n : 0));
    const roles = [
      { who: 'builder', spark: spark(10) }, { who: 'architect', spark: spark(5) }, { who: 'orchestration', spark: spark(3) },
      { who: 'tester', spark: spark(2) }, { who: 'reviewer:security', spark: spark(1) }, { who: 'learner', spark: spark(1) },
    ];
    const series = usageByAgent(roles, 2);
    expect(series.map((x) => [x.label, x.values])).toEqual([
      ['Builder', [0, 10]], ['Architect', [0, 5]], ['Story session', [0, 3]], ['Tester, reviewers, learner', [0, 4]],
    ]);
    expect(series.map((x) => x.color)).toEqual(['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)']);
    expect(usageByAgent(null, 3).every((x) => x.values.join() === '0,0,0')).toBe(true);
  });

  it('draws tokens per shipped story by agent, each agent keeping its colour from the usage chart', () => {
    const tps = {
      agents: [{ who: 'builder', label: 'Builder' }, { who: 'reviewer:security', label: 'Security reviewer' }, { who: 'architect', label: 'Architect' },
        { who: 'tester', label: 'Tester' }, { who: 'orchestration', label: 'Story session' }, { who: 'rest', label: 'Other agents' }],
      overall: { shipped: 3, average: 600, agents: { builder: 300, 'reviewer:security': 100, architect: 80, tester: 60, orchestration: 40, rest: 20 } },
      days: [{ day: '2026-10-14', shipped: 0, average: null, agents: {} }, { day: '2026-10-15', shipped: 2, average: 500, agents: { builder: 400, tester: 100 } }],
    };
    expect(storyTokenSeries(tps).map((x) => [x.label, x.color, x.values, x.overall])).toEqual([
      ['Builder', 'var(--s1)', [0, 400], 300], ['Security reviewer', 'var(--s5)', [0, 0], 100], ['Architect', 'var(--s2)', [0, 0], 80],
      ['Tester', 'var(--s4)', [0, 100], 60], ['Story session', 'var(--s3)', [0, 0], 40], ['Other agents', 'var(--s6)', [0, 0], 20],
    ]);
    expect(storyTokenSeries(null)).toEqual([]);
    expect(storyTokenSeries({ agents: [{ who: 'learner', label: 'Learner' }], days: [{ day: '2026-10-15', agents: { learner: 5 } }] })[0].color).toBe('var(--s5)');
  });

  it('names a day by its weekday and date, in UTC like the history', () => {
    expect(dayLabel('2026-10-15')).toBe('Thu 15');
  });

  it('gives the chart series their own colours in both modes', () => {
    for (const set of [':root{', ':root[data-mode="dark"]{']) {
      const at = PAGE.indexOf(set);
      const block = PAGE.slice(at, PAGE.indexOf('}', at));
      for (const k of ['s1', 's2', 's3', 's4', 's5', 's6']) expect(block, `${set} --${k}`).toMatch(new RegExp(`--${k}:#[0-9a-f]{6};`));
    }
  });

  it('draws charts from the page itself: no SVG built in script, no markup strings', () => {
    const start = SCRIPT.indexOf('// ── insights ──');
    expect(start).toBeGreaterThan(-1);
    const body = SCRIPT.slice(start, SCRIPT.indexOf('// ── end of insights ──'));
    expect(body).not.toMatch(/innerHTML|createElementNS|insertAdjacentHTML/);
    expect(body).toContain("'Show as table'");
    expect(body).toContain("setAttribute('aria-label'");
  });
});

describe('the Settings tab', () => {
  it('sits beside the command centre as a keyboard-reachable tab', () => {
    expect(PAGE).toMatch(/<nav class="tabs" role="tablist"[^>]*>/);
    expect(PAGE).toMatch(/<button[^>]*role="tab"[^>]*id="tab-run"[^>]*aria-controls="view-run"[^>]*aria-selected="true"/);
    expect(PAGE).toMatch(/<button[^>]*role="tab"[^>]*id="tab-settings"[^>]*aria-controls="view-settings"[^>]*aria-selected="false"/);
    expect(PAGE).toMatch(/id="view-run" role="tabpanel"/);
    expect(PAGE).toMatch(/id="view-settings" role="tabpanel"[^>]*hidden/);
    // arrow keys move between the tabs
    expect(SCRIPT).toContain("'ArrowRight'");
    expect(SCRIPT).toContain("'ArrowLeft'");
  });

  it('reads and changes settings through /api/settings, on either layer', () => {
    expect(SCRIPT).toContain("api('/api/settings')");
    expect(SCRIPT).toContain("api('/api/settings', ");
    expect(SCRIPT).toContain("layer: 'local'");
    expect(SCRIPT).toContain("'Save for me'");
    expect(SCRIPT).toContain("'Save for the team'");
    expect(SCRIPT).toMatch(/reset: true/);
  });

  it('shows the source, when it applies, and the commit reminder', () => {
    expect(PAGE).toContain('foreman.config.json changed — commit it so the team gets it');
    expect(SCRIPT).toContain('configDirty');
    expect(SCRIPT).toMatch(/'next-story': 'From the next story a slot picks'/);
    expect(SCRIPT).toMatch(/'next-run': 'When the run next starts'/);
    expect(SCRIPT).toMatch(/restart: 'When the run or dashboard restarts'/);
    for (const cls of ['.src.team', '.src.local']) expect(PAGE).toContain(cls);
  });

  it('has a control for each type: switch, number box, text, list and map', () => {
    expect(SCRIPT).toContain("'role', 'switch'");
    expect(SCRIPT).toContain("'aria-checked'");
    expect(SCRIPT).toContain("type = 'number'");
    expect(SCRIPT).toContain("el('textarea'");
    expect(SCRIPT).toContain('limits.keys');
  });

  it('turns what was typed into the value to send, or says what is wrong', () => {
    const draftValue = new Function(`${SCRIPT.match(/function draftValue\(s, d\) \{[\s\S]*?\n {2}\}\n/)[0]}; return draftValue;`)();
    expect(draftValue({ type: 'boolean' }, false)).toEqual({ value: false });
    expect(draftValue({ type: 'integer' }, ' 3 ')).toEqual({ value: 3 });
    expect(draftValue({ type: 'number' }, '2.5')).toEqual({ value: 2.5 });
    expect(draftValue({ type: 'integer' }, '')).toEqual({ error: 'Enter a number.' });
    expect(draftValue({ type: 'integer' }, 'abc')).toEqual({ error: 'Enter a number.' });
    expect(draftValue({ type: 'string' }, 'project = X')).toEqual({ value: 'project = X' });
    expect(draftValue({ type: 'string[]' }, 'https://a\n\n  https://b  \n')).toEqual({ value: ['https://a', 'https://b'] });
    expect(draftValue({ type: 'map' }, [['started', 'In Progress'], ['', '']])).toEqual({ value: { started: 'In Progress' } });
    expect(draftValue({ type: 'map' }, [['started', 'A'], ['started', 'B']])).toEqual({ error: 'started is there twice.' });
    expect(draftValue({ type: 'map' }, [['started', ' ']])).toEqual({ error: 'started: enter a value.' });
    expect(draftValue({ type: 'map' }, [['', 'Done']])).toEqual({ error: 'Choose a key for Done.' });
    expect(draftValue({ type: 'enum' }, 'a')).toEqual({ value: 'a' });
  });

  it('offers "Same as the story session" first in an enum that has an unset text', () => {
    const control = SCRIPT.match(/function settingControl\(s, labelId\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(control).toContain('s.unset');
    expect(control.indexOf('s.unset')).toBeLessThan(control.indexOf('s.limits && s.limits.values'));
  });

  it('turns "Same as the story session" into a reset on the layer saved to', () => {
    const pick = (re) => SCRIPT.match(re)[0];
    const settingBody = new Function(`${pick(/function draftValue\(s, d\) \{[\s\S]*?\n {2}\}\n/)}${pick(/function settingBody\(s, layer, reset, draft\) \{[\s\S]*?\n {2}\}\n/)}; return settingBody;`)();
    const name = 'roles.tester.model';
    const s = { name, type: 'enum', unset: 'Same as the story session' };
    expect(settingBody(s, 'team', false, '')).toEqual({ body: { name, reset: true, layer: 'team' } });
    expect(settingBody(s, 'local', false, '')).toEqual({ body: { name, reset: true, layer: 'local' } });
    expect(settingBody(s, 'local', false, 'haiku')).toEqual({ body: { name, value: 'haiku', layer: 'local' } });
    expect(settingBody(s, 'team', true, 'haiku')).toEqual({ body: { name, reset: true, layer: 'team' } });
    // An enum without an unset text never turns '' into a reset.
    expect(settingBody({ name: 'claude.fallback', type: 'enum' }, 'local', false, '')).toEqual({ body: { name: 'claude.fallback', value: '', layer: 'local' } });
    expect(settingBody({ name: 'rounds', type: 'integer' }, 'local', false, 'x')).toEqual({ error: 'Enter a number.' });
    expect(pick(/async function saveSetting\(s, layer, reset\) \{[\s\S]*?\n {2}\}\n/)).toContain('settingBody(s, layer, reset, draftOf(s))');
  });

  it('sends the worker control to the workers setting, this computer only', () => {
    expect(SCRIPT).toContain("{ name: 'workers', value: n, layer: 'local' }");
    expect(SCRIPT).not.toContain("action: 'workers'");
  });

  it('keeps tap targets at least 44 px', () => {
    expect(PAGE).toMatch(/\.tabs button\{min-height:44px/);
    expect(PAGE).toMatch(/\.sw\{[^}]*min-height:44px/);
    expect(PAGE).toMatch(/\.srow input\[type=text\][^{]*\{[^}]*min-height:44px/);
  });
});

// The page's own functions for the Waiting on you tab, lifted out and run on their own. Each is
// lifted when first called, so a missing one fails its own tests and not the whole file.
const lifted = (find, name) => (...args) => new Function(`${SCRIPT.match(find)[0]}; return ${name};`)()(...args);
const waitingCardView = lifted(/function waitingCardView\(it\) \{[\s\S]*?\n {2}\}\n/, 'waitingCardView');
const waitingRequest = lifted(/function waitingRequest\(it, actionId, note\) \{[\s\S]*?\n {2}\}\n/, 'waitingRequest');
const waitingCount = lifted(/function waitingCount\(n\) \{[\s\S]*?\n {2}\}\n/, 'waitingCount');
const waitingSummary = lifted(/function waitingSummary\(items\) \{[\s\S]*?\n {2}\}\n/, 'waitingSummary');
const waitingGroups = lifted(/function waitingGroups\(items\) \{[\s\S]*?\n {2}\}\n/, 'waitingGroups');
const waitingEmpty = lifted(/function waitingEmpty\(items, status\) \{[\s\S]*?\n {2}\}\n/, 'waitingEmpty');
const waitingNowCount = lifted(/function waitingNowCount\(items\) \{[\s\S]*?\n {2}\}\n/, 'waitingNowCount');
const bundleView = lifted(/function bundleView\(name, items\) \{[\s\S]*?\n {2}\}\n/, 'bundleView');
const bundleRequest = lifted(/function bundleRequest\(name, action\) \{[\s\S]*?\n {2}\}\n/, 'bundleRequest');
const bundleBusy = lifted(/function bundleBusy\(name, busy\) \{[\s\S]*?\n {2}\}\n/, 'bundleBusy');
const waitingHeadline = lifted(/function waitingHeadline\(status, items\) \{[\s\S]*?\n {2}\}\n/, 'waitingHeadline');
const waitingCounts = lifted(/function waitingCounts\(now, later\) \{[\s\S]*?\n {2}\}\n/, 'waitingCounts');
const waitingKey = lifted(/function waitingKey\(w\) \{[\s\S]*?\n {2}\}\n/, 'waitingKey');

// What GET /api/waiting returns (lib/console/waiting.mjs buildWaiting), one of each kind.
const WAITING = [
  { id: 'halt', kind: 'halt', title: 'The run is halted', why: 'smoke failed on /health', blocks: ['ACME-2'], frees: ['ACME-2'], actions: [{ id: 'fixed', label: 'I fixed it' }] },
  { id: 'd-1', kind: 'decision', title: 'Which search engine?', why: 'ACME-1 needs your decision', blocks: ['ACME-1', 'ACME-2'], frees: ['ACME-1'], actions: [{ id: 'option-0', label: 'Built in' }, { id: 'option-1', label: 'Hosted' }] },
  { id: 'd-2', kind: 'decision', title: 'Name the shop', why: 'ACME-1 needs your answer', blocks: ['ACME-1'], frees: ['ACME-1'], actions: [{ id: 'answer', label: 'Send answer' }] },
  { id: 'd-3', kind: 'decision', title: 'Pick a colour', why: 'Answer it on your decisions page.', blocks: [], frees: [], actions: [] },
  { id: 'task:ACME-3', kind: 'owner-task', title: 'Add the key (owner task)', why: 'An open owner task.', blocks: [], frees: [], link: 'stories/ACME-3.md', actions: [{ id: 'done', label: 'Mark done' }] },
  { id: 'task:ACME-4', kind: 'owner-task', title: 'Buy the domain (owner task)', why: 'An open owner task.', blocks: [], frees: [], link: 'https://acme.atlassian.net/browse/ACME-4', actions: [{ id: 'done', label: 'Mark done' }] },
  { id: 'release:ACME-5', kind: 'release', title: 'ACME-5 Checkout is ready to promote', why: 'waiting for the promotion to QA', blocks: [], frees: [], link: 'https://github.com/acme/shop/pull/5', actions: [{ id: 'check', label: 'Check now' }] },
  { id: 'slot:w2', kind: 'slot', title: 'Slot w2 is parked', why: 'Its folder has stray changes.', blocks: [], frees: [], actions: [{ id: 'resume-as-is', label: 'Resume as is' }, { id: 'discard', label: 'Discard changes and reset' }] },
];
const item = (id) => WAITING.find((i) => i.id === id);

describe('the Waiting on you tab', () => {
  it('is a third tab with the same keyboard and screen-reader behaviour', () => {
    expect(PAGE).toMatch(/<button type="button" role="tab" id="tab-waiting" aria-controls="view-waiting" aria-selected="false" tabindex="-1"><svg class="ticon" [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>Waiting on you <span class="tcount" id="wait-count"><\/span><\/button>/);
    const at = PAGE.indexOf('id="tab-waiting"');
    expect(at).toBeGreaterThan(PAGE.indexOf('id="tab-run"'));
    expect(at).toBeLessThan(PAGE.indexOf('id="tab-settings"'));
    expect(PAGE).toMatch(/id="view-waiting" role="tabpanel" aria-labelledby="tab-waiting"[^>]*hidden/);
    expect(SCRIPT).toContain("['waiting', $('tab-waiting'), $('view-waiting')]");
    expect(SCRIPT).toContain("'#waiting'");
    expect(SCRIPT).toContain("'ArrowRight'");
    expect(SCRIPT).toContain("'ArrowLeft'");
  });

  it('renders each kind from the list', () => {
    const views = WAITING.map(waitingCardView);
    expect(views.map((v) => v.slots.kind)).toEqual(['Halt', 'Decision', 'Decision', 'Decision', 'Owner task', 'Owner task', 'Ready to promote', 'Slot']);
    expect(views.map((v) => v.kind)).toEqual(WAITING.map((i) => i.kind));
    expect(views.map((v) => v.slots.title)).toEqual(WAITING.map((i) => i.title));
    expect(views.map((v) => v.slots.why)).toEqual(WAITING.map((i) => i.why));
    expect(() => waitingCardView({})).not.toThrow();

    const d1 = waitingCardView(item('d-1'));
    expect(d1.slots.frees).toBe('Frees ACME-1 now');
    const ten = Array.from({ length: 10 }, (_, i) => `ACME-${i + 1}`);
    expect(waitingCardView({ ...item('d-1'), frees: ten }).slots.frees).toBe('Frees ' + ten.slice(0, 8).join(', ') + ' and 2 more now');
    expect(waitingCardView({ ...item('d-1'), frees: [] }).slots.frees).toBe('Frees nothing by itself');
    expect(waitingCardView({ id: 'x-2', kind: 'decision', blocks: ['ACME-1'] }).slots.frees).toBe('Frees nothing by itself');
    expect(waitingCardView(item('task:ACME-3')).slots.frees).toBeNull();
    for (const v of views) {
      for (const gone of ['blocks', 'link', 'frees', 'kindLabel', 'title', 'why', 'actions']) expect(v, gone).not.toHaveProperty(gone);
      expect(Object.keys(v)).toEqual(['id', 'kind', 'section', 'urgent', 'note', 'slots']);
    }

    expect(views.filter((v) => v.note).map((v) => v.id)).toEqual(['d-1', 'd-2']);
    expect(waitingCardView(item('d-2')).slots.actions[0]).toMatchObject({ id: 'answer', needsNote: true });
    expect(d1.slots.actions.some((a) => a.needsNote)).toBe(false);

    expect(views.filter((v) => v.urgent).map((v) => v.id)).toEqual(['halt']);

    expect(waitingCardView(item('task:ACME-3')).slots.details.link).toEqual({ href: 'stories/ACME-3.md', web: false, text: 'Open' });
    expect(waitingCardView(item('task:ACME-4')).slots.details.link).toMatchObject({ web: true, text: 'Open' });
    expect(waitingCardView(item('release:ACME-5')).slots.details.link).toMatchObject({ web: true, text: 'Pull request' });
    expect(waitingCardView(item('halt')).slots.details).toBeNull();

    const slot = waitingCardView(item('slot:w2'));
    expect(slot.slots.actions.find((a) => a.id === 'discard')).toMatchObject({ confirm: true, cls: 'btn ghost danger' });
    expect(slot.slots.actions.find((a) => a.id === 'resume-as-is')).toMatchObject({ confirm: false, cls: 'btn' });
    expect(d1.slots.actions.map((a) => a.cls)).toEqual(['btn', 'btn ghost']);
    expect(slot.slots.actions[0].key).toBe('wait:slot:w2:resume-as-is');
    expect(d1.slots.actions[1]).toMatchObject({ id: 'option-1', label: 'Hosted', key: 'wait:d-1:option-1' });
    expect(waitingCardView(item('d-3')).slots.actions).toBeNull();
  });

  it('waitingCardView assigns each kind to its section', () => {
    const section = (it) => waitingCardView(it).section;
    expect(['halt', 'd-1', 'd-2', 'd-3', 'release:ACME-5', 'slot:w2'].map((id) => section(item(id)))).toEqual(Array(6).fill('now'));
    expect(['task:ACME-3', 'task:ACME-4'].map((id) => section(item(id)))).toEqual(['tasks', 'tasks']);
    expect(section({ ...item('task:ACME-3'), group: 'later', waitsOn: ['ACME-8'] })).toBe('later');
    const bundled = { id: 'd-9', kind: 'decision', title: 'Make the follow-ups', bundle: 'follow-ups', actions: [{ id: 'option-0', label: 'Create' }] };
    expect(section(bundled)).toBe('quick');
    expect(section({ ...bundled, bundle: '' })).toBe('now');
    expect(section({ id: 'f-1', kind: 'note', group: 'fyi' })).toBe('fyi');
    expect(section({ ...bundled, group: 'later' })).toBe('later');
    expect(section({ ...item('task:ACME-3'), group: 'fyi' })).toBe('fyi');
    expect(section({ id: 'x-1', kind: 'mystery' })).toBe('now');
    expect(section({})).toBe('now');

    expect(waitingCardView(item('halt')).urgent).toBe(true);
    expect(waitingCardView({ id: 'slot:w3', kind: 'slot', title: 'Slot w3 is down' }).urgent).toBe(true);
    expect(waitingCardView(item('slot:w2')).urgent).toBe(false);
    expect(waitingCardView({ id: 'd-4', kind: 'decision', title: 'Is the site down' }).urgent).toBe(false);
  });

  it('a learned item reads Learned, sits under FYI and keys its Undo and Keep by its id', () => {
    const it = { id: 'd-7', kind: 'learned', learned: { id: 'L-1', change: 'add', roles: ['developer'] }, title: 'Foreman learned L-1 for developer', why: 'developer: x', blocks: [], frees: [], group: 'fyi',
      actions: [{ id: 'undo', label: 'Undo the change', hint: 'Takes it out.' }, { id: 'keep', label: 'Keep the change', hint: null }] };
    const view = waitingCardView(it);
    expect(view.slots.kind).toBe('Learned');
    expect(view.section).toBe('fyi');
    expect(view.note).toBe(false);
    expect(view.slots.actions.map((a) => a.key)).toEqual(['wait:d-7:undo', 'wait:d-7:keep']);
    expect(waitingRequest(it, 'undo')).toEqual({ path: '/api/waiting/d-7', body: { action: 'undo' } });
  });

  it('has a Learned list after the Answered decisions, hidden until it has rows, drawn as text', () => {
    expect(PAGE).toContain('<section class="decs" id="learned" aria-labelledby="h-learned" hidden><h3 class="lsub dsub" id="h-learned">Learned</h3><div class="decs dsub" id="learned-list"></div></section>');
    expect(PAGE.indexOf('id="learned"')).toBeGreaterThan(PAGE.indexOf('id="dec-answered"'));
    const draw = SCRIPT.match(/function learnedRow\(r, i\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(draw).not.toContain('innerHTML');
    expect(draw).toContain("helpFor(help, 'learned', 'undo')");
    expect(SCRIPT).toContain("api('/api/learned/' + encodeURIComponent(id), { action: 'undo' })");
    // It loads wherever the waiting list loads, and again after every waiting answer.
    for (const at of ['loadDecisions(); loadWaiting(); loadLearned();', "if (name === 'waiting') { loadWaiting(); loadLearned(); }"]) expect(SCRIPT).toContain(at);
    expect(SCRIPT.match(/await loadWaiting\(\);\n {4}loadLearned\(\);/g)).toHaveLength(2);
  });

  it('learnedRowView gives each row its meta line, its reason and an Undo only while in force', () => {
    const view = lifted(/function learnedRowView\(r\) \{[\s\S]*?\n {2}\}\n/, 'learnedRowView');
    expect(view({ id: 'L-2', kind: 'skill', roles: ['developer', 'tester'], v: 2, status: 'on trial', reason: ' Routes keep breaking. ', by: 'foreman', at: 'x' }))
      .toEqual({ id: 'L-2', meta: 'skill · developer, tester · v2 · on trial', reason: 'Routes keep breaking.', undo: 'learned:L-2:undo' });
    expect(view({ id: 'L-1', kind: 'trait', roles: ['developer'], v: 0, status: 'undone', reason: 'Undone by you' }))
      .toEqual({ id: 'L-1', meta: 'trait · developer · v0 · undone', reason: 'Undone by you', undo: null });
    expect(view({ id: '<b>x</b>', v: 3 }).undo).toBeNull();
    expect(view(null)).toEqual({ id: '', meta: 'v0', reason: null, undo: null });
  });

  it('a run item reads Run and has no buttons', () => {
    const view = waitingCardView({ id: 'run:jira', kind: 'run', title: 'Picking paused', why: 'x', group: 'fyi', actions: [] });
    expect(view.section).toBe('fyi');
    expect(view.slots.kind).toBe('Run');
    expect(view.slots.actions).toBeNull();
  });

  it('a restart pending on new code lands in FYI as a Run card with no buttons', () => {
    const view = waitingCardView({ id: 'run:restart', kind: 'run', title: 'Restarting on new code', why: 'New code (a1b2c3d → e4f5a6b): restarting as soon as the slots being set up are ready; the stories in progress keep running.', group: 'fyi', actions: [] });
    expect(view.section).toBe('fyi');
    expect(view.slots.kind).toBe('Run');
    expect(view.slots.actions).toBeNull();
  });

  it('slots with no data are null', () => {
    const ORDER = ['kind', 'title', 'why', 'frees', 'need', 'takes', 'steps', 'doneWhen', 'explain', 'recommended', 'actions', 'details'];
    const nulls = Object.fromEntries(ORDER.map((k) => [k, null]));
    for (const it of [...WAITING, {}, null, { id: 'x-1', kind: 'mystery' }]) expect(Object.keys(waitingCardView(it).slots)).toEqual(ORDER);
    expect(waitingCardView({ id: 'x-1', kind: 'mystery' }).slots).toEqual({ ...nulls, kind: 'mystery', title: 'x-1' });
    expect(waitingCardView({}).slots).toEqual(nulls);
    expect(waitingCardView({ id: 'x-3', kind: 'decision', why: '   ', steps: [], actions: [] }).slots).toEqual({ ...nulls, kind: 'Decision', title: 'x-3' });

    const full = waitingCardView({
      id: 'task:ACME-6', kind: 'owner-task', title: 'Make the sandbox (owner task)', why: 'Frees ACME-7.', blocks: ['ACME-7'], frees: ['ACME-7'],
      need: 'Admin access to the Acme org', takes: 'about 15 minutes', steps: ['Open Setup', ' ', 'Create a sandbox'],
      doneWhen: 'The sandbox shows in the list', recommended: 'Use a developer sandbox', details: 'Full text',
      link: 'https://acme.atlassian.net/browse/ACME-6', actions: [{ id: 'done', label: 'Mark done' }],
      explain: { purpose: 'Gives the team a place to try changes.', happened: 'Only you can make it.', recommendation: 'Make it today.' },
    });
    expect(full.section).toBe('tasks');
    expect(full.slots).toEqual({
      kind: 'Owner task',
      title: 'Make the sandbox (owner task)',
      why: 'Frees ACME-7.',
      frees: 'Frees ACME-7 now',
      need: 'You need: Admin access to the Acme org',
      takes: 'Takes about 15 minutes',
      steps: ['Open Setup', 'Create a sandbox'],
      doneWhen: 'Done when: The sandbox shows in the list',
      explain: [
        { label: 'What this story is for', text: 'Gives the team a place to try changes.' },
        { label: 'What happened', text: 'Only you can make it.' },
        { label: 'Recommendation', text: 'Make it today.' },
      ],
      recommended: 'Use a developer sandbox',
      actions: [{ id: 'done', label: 'Mark done', key: 'wait:task:ACME-6:done', needsNote: false, confirm: false, cls: 'btn' }],
      details: { body: 'Full text', link: { href: 'https://acme.atlassian.net/browse/ACME-6', web: true, text: 'Open' } },
    });
    for (const k of ORDER) expect(full.slots[k], k).not.toBeNull();

    expect(waitingCardView({ ...item('d-1'), recommended: 'option-1' }).slots.recommended).toBe('Hosted');
    expect(waitingCardView({ ...item('d-1'), recommended: 'Hosted costs less' }).slots.recommended).toBe('Hosted costs less');
    expect(waitingCardView({ ...item('d-1'), recommended: 42 }).slots.recommended).toBeNull();
    expect(waitingCardView({ ...item('d-1'), recommended: ' ' }).slots.recommended).toBeNull();

    const hinted = waitingCardView({ ...item('d-1'), actions: [{ id: 'option-1', label: 'Hosted', hint: 'Costs less.', recommended: true }, { id: 'option-0', label: 'Built in', hint: null, recommended: false }] });
    expect(hinted.slots.recommended).toBe('Hosted');
    expect(hinted.slots.actions).toEqual([
      { id: 'option-1', label: 'Hosted', key: 'wait:d-1:option-1', needsNote: false, confirm: false, cls: 'btn' },
      { id: 'option-0', label: 'Built in', key: 'wait:d-1:option-0', needsNote: false, confirm: false, cls: 'btn ghost' },
    ]);
    const second = [{ id: 'option-0', label: 'Built in', hint: null, recommended: false }, { id: 'option-1', label: 'Hosted', hint: null, recommended: true }];
    expect(waitingCardView({ ...item('d-1'), actions: second, recommended: 'option-0' }).slots.recommended).toBe('Hosted');
    const none = [{ id: 'option-0', label: 'Built in', hint: null, recommended: false }, { id: 'option-1', label: 'Hosted', hint: null, recommended: false }];
    expect(waitingCardView({ ...item('d-1'), actions: none }).slots.recommended).toBeNull();
    expect(waitingCardView({ ...item('d-1'), actions: none, recommended: 'option-1' }).slots.recommended).toBe('Hosted');
    expect(waitingCardView({ ...item('d-1'), actions: [{ id: 'option-0', label: 'Built in', recommended: 'yes' }] }).slots.recommended).toBeNull();
    expect(waitingCardView(item('halt')).slots.details).toBeNull();
    expect(waitingCardView({ ...item('halt'), details: 'The whole log' }).slots.details).toEqual({ body: 'The whole log', link: null });
    expect(waitingCardView({ ...item('halt'), body: 'x' }).slots.details).toBeNull();
    expect(waitingCardView(item('task:ACME-3')).slots.details).toEqual({ body: null, link: { href: 'stories/ACME-3.md', web: false, text: 'Open' } });
    expect(waitingCardView({ ...item('task:ACME-3'), steps: [] }).slots.steps).toBeNull();
    expect(waitingCardView({ ...item('task:ACME-3'), steps: [' ', ''] }).slots.steps).toBeNull();
    expect(waitingCardView({ ...item('task:ACME-3'), actions: [] }).slots.actions).toBeNull();
    expect(waitingCardView({ ...item('task:ACME-3'), need: '', takes: ' ', doneWhen: null }).slots).toMatchObject({ need: null, takes: null, doneWhen: null });
  });

  it('on standby, the empty state says Foreman picks up new stories by itself', () => {
    const idle = { id: 'w1', state: 'idle', story: null };
    const queue = { now: [], next: [] };
    expect(waitingEmpty([], { loop: { state: 'standby' }, slots: [idle], queue })).toBe(
      'Nothing to build and nothing waiting on you. Foreman is on standby and picks up new stories automatically.',
    );
    expect(waitingEmpty([], { loop: { state: 'stopped' }, slots: [idle], queue })).toBe('Nothing left to build and nothing waiting on you. Add stories to the story source.');
  });

  it('the empty-state text depends on now, later and loop state', () => {
    const slot = (id, state, story) => ({ id, state, ...(story ? { story: { id: story } } : { story: null }) });
    const run = (slots, queue = { now: [], next: [] }) => ({ slots, queue });
    const later = (n, waitsOn) => Array.from({ length: n }, (_, i) => ({ id: `task:ACME-${40 + i}`, kind: 'owner-task', group: 'later', ...(waitsOn ? { waitsOn: i === 0 ? waitsOn : ['ACME-99'] } : {}) }));

    expect(waitingEmpty([], run([slot('w1', 'building', 'ACME-117'), slot('w2', 'idle')]))).toBe('Nothing needs you. The run is building ACME-117.');
    expect(waitingEmpty([], run([slot('w1', 'building', 'ACME-117'), slot('w2', 'building', 'ACME-118')]))).toBe('Nothing needs you. The run is building ACME-117 and ACME-118.');
    expect(waitingEmpty(later(9, ['ACME-31']), run([slot('w1', 'building', 'ACME-117')]))).toBe('Nothing you can do yet. 9 tasks open up as stories ship; the first after ACME-31.');
    expect(waitingEmpty(later(1, ['ACME-31']), null)).toBe('Nothing you can do yet. 1 task opens up as stories ship; the first after ACME-31.');
    expect(waitingEmpty(later(2), null)).toBe('Nothing you can do yet. 2 tasks open up as stories ship.');
    expect(waitingEmpty([], run([slot('w1', 'idle'), slot('w2', 'parked')]))).toBe('Nothing left to build and nothing waiting on you. Add stories to the story source.');
    expect(waitingEmpty([], run([slot('w1', 'idle')], { now: [], next: ['ACME-6'] }))).toBe('Nothing needs you.');
    expect(waitingEmpty([], run([slot('w1', 'idle')], { now: [{ id: 'ACME-6' }], next: [] }))).toBe('Nothing needs you.');
    expect(waitingEmpty([], null)).toBe('Nothing needs you.');
    expect(waitingEmpty(null, null)).toBe('Nothing needs you.');
    const fyi = [{ id: 'f-1', kind: 'note', group: 'fyi' }];
    expect(waitingEmpty(fyi, null)).toBe('Nothing needs you.');
    expect(waitingEmpty(fyi, run([slot('w1', 'building', 'ACME-117')]))).toBe('Nothing needs you. The run is building ACME-117.');
    expect(waitingEmpty(fyi, run([]))).toBe('Nothing left to build and nothing waiting on you. Add stories to the story source.');
    expect(waitingEmpty([item('task:ACME-3')], run([]))).toBe('');
    expect(waitingEmpty([...later(3, ['ACME-31']), { id: 'x', group: 'now' }], null)).toBe('');
    expect(waitingEmpty([{ id: 'x' }], null)).toBe('');
  });

  it('render() redraws the waiting cards when the empty text changes with the run, and only then', () => {
    const renderSrc = SCRIPT.match(/function render\(\) \{[\s\S]*?\n {2}\}\n/)[0];
    const emptySrc = SCRIPT.match(/function waitingEmpty\(items, status\) \{[\s\S]*?\n {2}\}\n/)[0];
    // Every other section render() draws becomes a no-op, so a new one added later keeps this working.
    const others = [...new Set([...renderSrc.matchAll(/\b(render\w+)\(/g)].map((m) => m[1]))].filter((n) => n !== 'render' && n !== 'renderWaiting');
    const harness = new Function('input', `
      let waitingItems = input.waitingItems, status = input.status;
      let waitingEmptyShown = input.waitingEmptyShown, waitingActable = input.waitingActable;
      const canAct = () => input.canAct;
      let calls = 0;
      ${others.map((n) => `const ${n} = () => {};`).join('\n')}
      function renderWaiting() { calls += 1; waitingActable = canAct(); waitingEmptyShown = waitingEmpty(waitingItems, status); }
      ${emptySrc}
      ${renderSrc}
      render();
      return { calls, waitingEmptyShown };
    `);
    const slot = (id, state, story) => ({ id, state, ...(story ? { story: { id: story } } : { story: null }) });
    const run = (slots, queue = { now: [], next: [] }) => ({ slots, queue });
    const building = run([slot('w1', 'building', 'ACME-117')]);
    const idle = run([slot('w1', 'idle')]);
    const buildingText = 'Nothing needs you. The run is building ACME-117.';
    const idleText = 'Nothing left to build and nothing waiting on you. Add stories to the story source.';

    expect(harness({ waitingItems: [], status: idle, waitingEmptyShown: buildingText, waitingActable: true, canAct: true }))
      .toEqual({ calls: 1, waitingEmptyShown: idleText });
    expect(harness({ waitingItems: [], status: building, waitingEmptyShown: buildingText, waitingActable: true, canAct: true }))
      .toEqual({ calls: 0, waitingEmptyShown: buildingText });
    expect(harness({ waitingItems: null, status: idle, waitingEmptyShown: buildingText, waitingActable: true, canAct: true }).calls).toBe(0);
    expect(harness({ waitingItems: [], status: building, waitingEmptyShown: buildingText, waitingActable: false, canAct: true }))
      .toEqual({ calls: 1, waitingEmptyShown: buildingText });
    const now = [{ id: 'task:ACME-3', group: 'now' }];
    expect(harness({ waitingItems: now, status: building, waitingEmptyShown: '', waitingActable: true, canAct: true }).calls).toBe(0);
    expect(harness({ waitingItems: now, status: idle, waitingEmptyShown: '', waitingActable: true, canAct: true }).calls).toBe(0);
  });

  it('its buttons post the right action', () => {
    expect(waitingRequest(item('d-1'), 'option-1', ' cheaper ')).toEqual({ path: '/api/waiting/d-1', body: { action: 'option-1', note: 'cheaper' } });
    expect(waitingRequest(item('d-1'), 'option-0', '  ')).toEqual({ path: '/api/waiting/d-1', body: { action: 'option-0' } });
    expect(waitingRequest(item('d-2'), 'answer', ' ')).toEqual({ error: 'Write your answer first.' });
    expect(waitingRequest(item('d-2'), 'answer', 'done it')).toEqual({ path: '/api/waiting/d-2', body: { action: 'answer', note: 'done it' } });
    expect(waitingRequest(item('task:ACME-3'), 'done', 'a note')).toEqual({ path: '/api/waiting/task:ACME-3', body: { action: 'done' } });
    expect(waitingRequest(item('halt'), 'fixed')).toEqual({ path: '/api/waiting/halt', body: { action: 'fixed' } });
    expect(waitingRequest(item('release:ACME-5'), 'check')).toEqual({ path: '/api/waiting/release:ACME-5', body: { action: 'check' } });
    expect(waitingRequest(item('slot:w2'), 'resume-as-is')).toEqual({ path: '/api/waiting/slot:w2', body: { action: 'resume-as-is' } });
    expect(waitingRequest(item('halt'), 'done')).toEqual({ error: 'That action is not offered here; reload the list.' });
    expect(waitingRequest(item('d-3'), 'answer', 'x')).toHaveProperty('error');
    const odd = waitingRequest({ id: 'a/b?c', kind: 'owner-task', actions: [{ id: 'done' }] }, 'done');
    expect(odd.path).toBe('/api/waiting/a%2Fb%3Fc');
    expect(odd.path).not.toContain('a/b?c');
  });

  it('shows the count on the tab', () => {
    expect(waitingCount(0)).toEqual({ text: '', hot: false });
    expect(waitingCount(3)).toEqual({ text: '3', hot: true });
    expect(SCRIPT).toContain("classList.toggle('hot'");
    expect(SCRIPT).toContain("$('wait-count')");
    expect(PAGE).toMatch(/\.tabs button\.hot[,{:]/);
    expect(PAGE).toMatch(/\.tabs \.tcount\{/);
  });

  it('sums it up in the Command centre, with a link to the tab', () => {
    expect(waitingSummary(null)).toEqual({ count: 0, text: 'Nothing is waiting on you.', top: null });
    expect(waitingSummary([])).toEqual({ count: 0, text: 'Nothing is waiting on you.', top: null });
    expect(waitingSummary([item('d-1')]).text).toBe('1 thing is waiting on you.');
    expect(waitingSummary(WAITING)).toEqual({ count: 8, text: '8 things are waiting on you.', top: { title: 'The run is halted', why: 'smoke failed on /health' } });
    const link = PAGE.indexOf('<a href="#waiting" id="wait-open">');
    expect(link).toBeGreaterThan(PAGE.indexOf('class="panel a-dec"'));
    expect(link).toBeLessThan(PAGE.indexOf('class="panel a-ctl"'));
    expect(SCRIPT).toContain("showTab('waiting', { focus: true })");
    expect(PAGE).not.toContain('id="dec-list"');
  });

  it('the headline comes from the status, and keeps its best item only while the list has it', () => {
    const head = { state: 'idle', text: 'Idle: the 2 stories left all wait on your tasks. Do Add the key first: 2 stories wait on it.', best: 'task:ACME-3' };
    const st = (headline) => ({ waiting: { count: 1, later: 0, items: [], headline } });
    expect(waitingHeadline(null, null)).toBeNull();
    expect(waitingHeadline({ waiting: null }, null)).toBeNull();
    expect(waitingHeadline(st(undefined), null)).toBeNull();
    expect(waitingHeadline(st('Idle'), null)).toBeNull();
    expect(waitingHeadline(st({ ...head, text: '' }), null)).toBeNull();
    expect(waitingHeadline(st({ ...head, text: undefined }), null)).toBeNull();
    expect(waitingHeadline(st(head), null)).toEqual(head);
    expect(waitingHeadline(st(head), [{ id: 'd-1' }, { id: 'task:ACME-3' }])).toEqual(head);
    expect(waitingHeadline(st(head), [{ id: 'd-1' }])).toEqual({ ...head, best: null });
    expect(waitingHeadline(st(head), [])).toEqual({ ...head, best: null });
    expect(waitingHeadline(st({ ...head, best: null }), null)).toEqual({ ...head, best: null });
  });

  it('counts now and later in one short line', () => {
    expect(waitingCounts(6, 9)).toBe('6 need you · 9 later');
    expect(waitingCounts(1, 0)).toBe('1 needs you');
    expect(waitingCounts(0, 2)).toBe('2 later');
    expect(waitingCounts(0, 0)).toBe('');
  });

  it('reloads the tab when the later count changes, not only the now items', () => {
    const snap = (over = {}) => ({ count: 2, later: 3, items: [{ id: 'd-1' }, { id: 'task:ACME-3' }], ...over });
    expect(waitingKey(null)).toBe('');
    expect(waitingKey(undefined)).toBe('');
    expect(waitingKey(snap({ later: 3 }))).not.toBe(waitingKey(snap({ later: 4 })));
    const { later, ...noLater } = snap();
    expect(waitingKey(noLater)).toBe(waitingKey(snap({ later: 0 })));
    expect(waitingKey(snap({ count: 1 }))).not.toBe(waitingKey(snap()));
    expect(waitingKey(snap({ items: [{ id: 'd-1' }, { id: 'task:ACME-4' }] }))).not.toBe(waitingKey(snap()));
    expect(SCRIPT).toContain('const key = waitingKey(status.waiting);');
  });

  it('puts the headline and Go to it at the top of the tab', () => {
    const view = PAGE.indexOf('id="view-waiting"');
    const goto = PAGE.indexOf('id="wait-goto"');
    expect(goto).toBeGreaterThan(view);
    expect(goto).toBeLessThan(PAGE.indexOf('id="wait-list"'));
    expect(PAGE).toContain('<a href="#waiting" id="wait-goto">Go to it</a>');
    expect(PAGE).toContain('<div class="whead" id="wait-head" hidden><p id="wait-headline"></p>');
    expect(SCRIPT).toContain('card.dataset.wid');
    expect(SCRIPT).toContain('scrollIntoView(');
    expect(SCRIPT).toContain("'wait:card:' + v.id");
    expect(SCRIPT).toContain("'wait:card:bundle:' + name");
  });

  it('asks before a discard, and keeps the answered decisions', () => {
    expect(SCRIPT).toMatch(/confirmRow\('Discard the changes in '[\s\S]{0,600}?'wait:' \+ /);
    expect(SCRIPT).not.toMatch(/\bconfirm\(/);
    expect(SCRIPT).toContain("api('/api/decisions')");
    expect(SCRIPT).toContain("'Change answer'");
    expect(SCRIPT).toContain("$('dec-answered')");
  });

  it('names each card heading by its place in the list, so no id can clash', () => {
    const waitingHeadingId = lifted(/function waitingHeadingId\(i\) \{[^\n]*\}\n/, 'waitingHeadingId');
    expect([0, 1, 7].map((i) => waitingHeadingId(i))).toEqual(['wcard-0', 'wcard-1', 'wcard-7']);
    // Item ids that once made the same heading id, or the id of one of the page's own elements.
    const ids = ['task:A-1', 'task-A-1', 'list', 'count', 'tag', 'summary'].map((_, i) => waitingHeadingId(i));
    expect(new Set(ids).size).toBe(6);
    const statics = new Set([...PAGE.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    for (const id of ids) expect(statics.has(id), id).toBe(false);
    expect([...statics].filter((id) => id.startsWith('wcard-'))).toEqual([]);
    expect(SCRIPT).toContain('waitingCard(it, i)');
    expect(SCRIPT).toContain('waitingHeadingId(i)');
    expect(SCRIPT).not.toContain("'wait-' + v.id");
  });

  it('splits the list into now and later, counts only now, and keeps Later folded as the owner left it', () => {
    const { now, later, fyi } = waitingGroups([{ id: 'a' }, { id: 'b', group: 'later' }, { id: 'c', group: 'now' }, { id: 'd', group: 'fyi' }]);
    expect(now.map((i) => i.id)).toEqual(['a', 'c']);
    expect(later.map((i) => i.id)).toEqual(['b']);
    expect(fyi.map((i) => i.id)).toEqual(['d']);
    expect(waitingGroups(null)).toEqual({ now: [], later: [], fyi: [] });
    expect(SCRIPT).toContain("'Later ('");
    expect(SCRIPT).toMatch(/<details|el\('details'/);
    expect(SCRIPT).toContain('laterOpen');
    expect(SCRIPT).toMatch(/const waitingTotal = [^\n]*waitingNowCount\(waitingItems\)/);
  });

  it('draws the sections, the Details fold, the Recommended chip and the empty text', () => {
    for (const text of ["'Needs you now'", "'Your tasks'", "'Quick decisions'", "'FYI'", "'Details'", 'detailsOpen', 'else if (waitingItems && waitingEmpty(waitingItems, status) !== waitingEmptyShown) renderWaiting();', 'let waitingEmptyShown']) expect(SCRIPT, text).toContain(text);
    expect(SCRIPT).toContain("'wait:' + v.id + ':details'");
    expect(PAGE).toMatch(/\.chip\.rec\{[^}]*var\(--accent\)/);
    expect(PAGE).toMatch(/\.wdetails summary[^{]*\{[^}]*min-height:44px/);
    expect(PAGE).toContain('class="wsecs" id="wait-list"');
    expect(PAGE).toMatch(/\.wsecs\{display:grid;gap:16px/);
  });

  // Twelve follow-ups from `foreman learn`, as GET /api/waiting gives them.
  const follow = (n, minor) => ({
    id: `d-202610150900${String(n).padStart(2, '0')}-fu${String(n).padStart(2, '0')}`, kind: 'decision', title: `Follow up on FM-${n}: ${minor} minor finding(s)?`,
    why: `${minor} minor: a; b`, blocks: [], frees: [], actions: [{ id: 'option-0', label: 'Create a follow-up story' }, { id: 'option-1', label: 'Ignore' }],
    group: 'now', bundle: 'follow-ups', story: `FM-${n}`, minor,
  });
  const TWELVE = [follow(19, 3), ...Array.from({ length: 11 }, (_, i) => follow(20 + i, i % 2 ? 3 : 2))];

  it('counts a bundle once, and leaves out Later and FYI', () => {
    const others = [item('halt'), item('d-1')];
    expect(waitingNowCount([...TWELVE, ...others])).toBe(3);
    expect(waitingNowCount([...TWELVE, ...others, { ...item('task:ACME-3'), group: 'later' }, { id: 'f-1', kind: 'note', group: 'fyi' }])).toBe(3);
    const trait = { ...item('d-1'), id: 'd-t', bundle: 'traits' };
    expect(waitingNowCount([...TWELVE, trait, { ...trait, id: 'd-t2' }])).toBe(2);
    expect(waitingNowCount([])).toBe(0);
    expect(waitingNowCount(null)).toBe(0);
    expect(waitingNowCount([undefined, undefined])).toBe(2);
    expect(waitingNowCount(WAITING)).toBe(8);
  });

  it('draws a bundle as one card: its heading, a line per story, Create all and Ignore all', () => {
    const sum = TWELVE.reduce((n, it) => n + it.minor, 0);
    const v = bundleView('follow-ups', TWELVE);
    expect(v.name).toBe('follow-ups');
    expect(v.heading).toBe(`12 follow-ups from recent runs: ${sum} minor findings`);
    expect(v.lines).toHaveLength(12);
    expect(v.lines[0]).toBe('FM-19 · 3 minor: a; b');
    expect(v.confirm).toBe(true);
    expect(v.actions).toEqual([
      { id: 'create-all', label: 'Create all', key: 'wait:bundle:follow-ups:create-all' },
      { id: 'ignore-all', label: 'Ignore all', key: 'wait:bundle:follow-ups:ignore-all' },
    ]);
    expect(v.open).toBe('wait:bundle:follow-ups:one-by-one');
    expect(bundleView('follow-ups', TWELVE.slice(0, 5)).confirm).toBe(false);
    expect(bundleView('follow-ups', TWELVE.slice(0, 6)).confirm).toBe(true);
    expect(bundleView('follow-ups', [follow(19, 1)]).heading).toBe('1 follow-up from recent runs: 1 minor finding');
    expect(bundleView('follow-ups', [{ ...follow(19, 3), why: '' }]).lines).toEqual(['FM-19 · 3 minor']);

    const trait = { ...item('d-1'), id: 'd-t', title: 'Add a trait for developer: Check inputs?', bundle: 'traits' };
    const t = bundleView('traits', [trait, { ...trait, id: 'd-t2' }]);
    expect(t.heading).toBe('2 trait proposals');
    expect(t.lines[0]).toBe('Add a trait for developer: Check inputs?');
    expect(t.actions.map((a) => a.label)).toEqual(['Add all', 'Ignore all']);
    expect(t.actions[0].key).toBe('wait:bundle:traits:create-all');
    expect(bundleView('traits', [trait]).heading).toBe('1 trait proposal');
    expect(bundleView('other', [trait, trait]).heading).toBe('2 quick decisions');
  });

  it('posts a bundle action to its own path', () => {
    expect(bundleRequest('follow-ups', 'create-all')).toEqual({ path: '/api/waiting/bundle/follow-ups', body: { action: 'create-all' } });
    expect(bundleRequest('traits', 'ignore-all')).toEqual({ path: '/api/waiting/bundle/traits', body: { action: 'ignore-all' } });
    expect(bundleRequest('a/b', 'ignore-all').path).toBe('/api/waiting/bundle/a%2Fb');
    expect(bundleRequest('follow-ups', 'make-all')).toHaveProperty('error');
    expect(bundleRequest('follow-ups', 'make-all')).not.toHaveProperty('path');
  });

  it('locks both of a bundle\'s buttons while either is on its way', () => {
    expect(bundleBusy('follow-ups', new Set(['wait:bundle:follow-ups:create-all']))).toBe(true);
    expect(bundleBusy('follow-ups', new Set(['wait:bundle:follow-ups:ignore-all']))).toBe(true);
    expect(bundleBusy('follow-ups', new Set())).toBe(false);
    expect(bundleBusy('follow-ups', new Set(['wait:bundle:traits:create-all']))).toBe(false);
    expect(bundleBusy('follow-ups', new Set(['wait:d-1:option-0']))).toBe(false);
    expect(bundleBusy('follow', new Set(['wait:bundle:follow-ups:create-all']))).toBe(false);
    expect(bundleBusy('traits', undefined)).toBe(false);

    // The card disables Create all and Ignore all together, and a second request (a click or a
    // confirm's Yes on the other action) is dropped while the first is on its way.
    const card = SCRIPT.match(/function bundleCard\(name, items, i\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(card).toContain('b.disabled = !canAct() || bundleBusy(name, busy)');
    expect(card).not.toContain('busy.has(a.key)');
    expect(SCRIPT).toMatch(/async function actBundle\(name, action\) \{[\s\S]*?if \(bundleBusy\(name, busy\)\) return;/);
  });

  it('sums a bundle up once in the Command centre', () => {
    expect(waitingSummary([...TWELVE, item('halt')])).toMatchObject({ count: 2, text: '2 things are waiting on you.', top: { title: 'Follow up on FM-19: 3 minor finding(s)?' } });
    expect(waitingSummary(TWELVE).text).toBe('1 thing is waiting on you.');
    expect(waitingSummary([undefined, undefined, item('halt')]).count).toBe(3);
  });

  it('draws Quick decisions as bundle cards, with a confirm and Answer one by one', () => {
    for (const text of ["'Answer one by one'", 'bundleOpen', 'confirmRow(', 'const bdrafts = {}', 'wbundle', 'actBundle(']) expect(SCRIPT, text).toContain(text);
    expect(SCRIPT).toMatch(/aria-expanded/);
    expect(SCRIPT).toMatch(/for \(const name of Object\.keys\(bdrafts\)\) if \(!names\.has\(name\)\) delete bdrafts\[name\]/);
  });

  const taskDetailsPath = lifted(/function taskDetailsPath\(id\) \{[\s\S]*?\n {2}\}\n/, 'taskDetailsPath');
  const withTaskDetails = lifted(/function withTaskDetails\(it, answer\) \{[\s\S]*?\n {2}\}\n/, 'withTaskDetails');
  const taskDetailsNote = lifted(/function taskDetailsNote\(it, answer\) \{[\s\S]*?\n {2}\}\n/, 'taskDetailsNote');

  it('asks for an owner task\'s details at its own path, colons kept', () => {
    expect(taskDetailsPath('task:ACME-3')).toBe('/api/waiting/task:ACME-3/details');
    expect(taskDetailsPath('task:a/b?c')).toBe('/api/waiting/task:a%2Fb%3Fc/details');
  });

  it('fills the card\'s slots from the details', () => {
    const answer = { need: ['A', 'B'], steps: ['Open Setup', 'Create a sandbox'], effort: 'about 15 minutes', doneWhen: 'The sandbox shows in the list' };
    const filled = withTaskDetails(item('task:ACME-3'), answer);
    expect(filled).toEqual({ ...item('task:ACME-3'), need: 'A; B', takes: 'about 15 minutes', steps: ['Open Setup', 'Create a sandbox'], doneWhen: 'The sandbox shows in the list' });
    expect(waitingCardView(filled).slots).toMatchObject({
      need: 'You need: A; B',
      takes: 'Takes about 15 minutes',
      steps: ['Open Setup', 'Create a sandbox'],
      doneWhen: 'Done when: The sandbox shows in the list',
    });
    expect(withTaskDetails(item('task:ACME-3'), { need: 'x', steps: null, effort: '', doneWhen: '' })).toMatchObject({ need: '', steps: [] });
    expect(withTaskDetails(item('task:ACME-3'), { pending: true })).toBe(item('task:ACME-3'));
    expect(withTaskDetails(item('task:ACME-3'), undefined)).toBe(item('task:ACME-3'));
    expect(withTaskDetails(item('task:ACME-3'), null)).toBe(item('task:ACME-3'));
  });

  it('says when the steps are on their way, or not written yet', () => {
    expect(taskDetailsNote(item('task:ACME-3'), undefined)).toEqual({ text: 'Fetching the steps…', link: null });
    expect(taskDetailsNote(item('task:ACME-3'), { pending: true })).toEqual({ text: 'Fetching the steps…', link: null });
    const missing = { need: [], steps: [], effort: '', doneWhen: '', missing: true };
    expect(taskDetailsNote(item('task:ACME-3'), missing)).toEqual({
      text: "No steps written yet. Add ## Steps and ## What you need to ACME-3's description.",
      link: { href: 'stories/ACME-3.md', web: false, text: 'Open' },
    });
    expect(taskDetailsNote(item('task:ACME-4'), missing)).toEqual({
      text: "No steps written yet. Add ## Steps and ## What you need to ACME-4's description.",
      link: { href: 'https://acme.atlassian.net/browse/ACME-4', web: true, text: 'Open' },
    });
    expect(taskDetailsNote({ id: 'task:ACME-9', kind: 'owner-task' }, missing)).toEqual({ text: "No steps written yet. Add ## Steps and ## What you need to ACME-9's description.", link: null });
    expect(taskDetailsNote(item('task:ACME-3'), null)).toBeNull();
    expect(taskDetailsNote(item('task:ACME-3'), { need: ['A'], steps: [], effort: '', doneWhen: '' })).toBeNull();
  });

  it('loads each Your tasks card\'s details once, and tries again while they are pending', () => {
    expect(SCRIPT).toContain('const taskInfo = new Map();');
    expect(SCRIPT).toContain('const TASK_RETRY_MS = 5000');
    expect(SCRIPT).toContain('const TASK_TRIES = 12');
    expect(SCRIPT).toMatch(/function renderWaiting\(\) \{[\s\S]*?loadTaskDetails\(/);
    expect(SCRIPT).toMatch(/function loadTaskDetails\(it\) \{[\s\S]*?api\(taskDetailsPath\(it\.id\)\)/);
    expect(SCRIPT).toMatch(/waitingCardView\(withTaskDetails\(it, taskInfo\.get\(/);
    expect(SCRIPT).toMatch(/for \(const id of taskInfo\.keys\(\)\) if \(!ids\.has\(id\)\) taskInfo\.delete\(id\)/);
  });

  // loadTaskDetails lifted out with stubs: an api that always says pending and a setTimeout
  // that keeps the retry so the test runs it by hand.
  const taskLoader = () => {
    const taskInfo = new Map();
    const timers = [];
    let calls = 0;
    const api = async () => {
      calls += 1;
      return { pending: true };
    };
    const load = new Function(
      'taskInfo', 'api', 'taskDetailsPath', 'setTimeout', 'renderWaiting', 'TASK_TRIES', 'TASK_RETRY_MS',
      SCRIPT.match(/async function loadTaskDetails\(it\) \{[\s\S]*?\n {2}\}\n/)[0] + '; return loadTaskDetails;',
    )(taskInfo, api, (id) => `/api/waiting/${id}/details`, (fn) => timers.push(fn), () => {}, 12, 5000);
    return { taskInfo, timers, load, calls: () => calls };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('does not ask again for a task that left the list while its retry waited', async () => {
    const t = taskLoader();
    await t.load({ id: 'task:ACME-3' });
    expect(t.timers).toHaveLength(1);
    t.taskInfo.delete('task:ACME-3');
    t.timers[0]();
    await flush();
    expect(t.calls()).toBe(1);
    expect(t.taskInfo.has('task:ACME-3')).toBe(false);
  });

  it('asks again while the task is still listed', async () => {
    const t = taskLoader();
    await t.load({ id: 'task:ACME-3' });
    expect(t.timers).toHaveLength(1);
    t.timers[0]();
    await flush();
    expect(t.calls()).toBe(2);
    expect(t.taskInfo.get('task:ACME-3').tries).toBe(2);
  });
});

// The page's own functions for the Set up tab, lifted out and run on their own, against an Acme
// GET /api/setup body with one step of each status.
const setupVisible = lifted(/function setupVisible\(steps\) \{[\s\S]*?\n {2}\}\n/, 'setupVisible');
const setupCount = lifted(/function setupCount\(steps\) \{[\s\S]*?\n {2}\}\n/, 'setupCount');
const tabOrder = lifted(/function tabOrder\(missing\) \{[\s\S]*?\n {2}\}\n/, 'tabOrder');
const setupPill = lifted(/function setupPill\(status\) \{[\s\S]*?\n {2}\}\n/, 'setupPill');
const setupProblems = lifted(/function setupProblems\(step\) \{[\s\S]*?\n {2}\}\n/, 'setupProblems');
const setupStateLine = lifted(/function setupStateLine\(step\) \{[\s\S]*?\n {2}\}\n/, 'setupStateLine');
// setupResultLine reads the page's CHECKING, so it is lifted with it.
const CHECKING_LINE = /const CHECKING = [^\n]*\n/;
const RESULT_LINE = /function setupResultLine\(step, nowMs\) \{[\s\S]*?\n {2}\}\n/;
const setupResultLine = (...args) => new Function(`${SCRIPT.match(CHECKING_LINE)[0]}${SCRIPT.match(RESULT_LINE)[0]}; return setupResultLine;`)()(...args);
const setupGuide = lifted(/function setupGuide\(step\) \{[\s\S]*?\n {2}\}\n/, 'setupGuide');
const setupInputs = lifted(/function setupInputs\(step\) \{[\s\S]*?\n {2}\}\n/, 'setupInputs');
const setupGroups = lifted(/function setupGroups\(steps, areas, off = \[\]\) \{[\s\S]*?\n {2}\}\n/, 'setupGroups');
const changeFields = lifted(/function changeFields\(form, ctx\) \{[\s\S]*?\n {2}\}\n/, 'changeFields');
const changeBody = lifted(/function changeBody\(answers, now\) \{[\s\S]*?\n {2}\}\n/, 'changeBody');
// changeDraftFor calls changeBody, so it is lifted with it.
const changeDraftFor = (...a) => new Function(SCRIPT.match(/function changeBody\(answers, now\) \{[\s\S]*?\n {2}\}\n/)[0] + SCRIPT.match(/function changeDraftFor\(draft, now\) \{[\s\S]*?\n {2}\}\n/)[0] + '; return changeDraftFor;')()(...a);
const setupMove = lifted(/function setupMove\(count, at, dir\) \{[\s\S]*?\n {2}\}\n/, 'setupMove');
const setupForward = lifted(/function setupForward\(step, last\) \{[\s\S]*?\n {2}\}\n/, 'setupForward');
// setupPlace calls setupVisible and setupMove, so it is lifted with them.
const setupPlace = (...args) => new Function(['setupVisible', 'setupMove', 'setupPlace']
  .map((name) => SCRIPT.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`))[0]).join('') + 'return setupPlace;')()(...args);

const TESTED = new Date(2026, 9, 24, 10, 42).toISOString();
const acmeStep = (id, area, status, more = {}) => ({
  id, area, title: `Acme ${id}`, why: `Why Acme needs ${id}.`, hint: `fix ${id} the Acme way`, applies: status !== 'skipped', optional: status === 'optional',
  checks: [], inputs: [], actions: [{ id: 'check', label: 'Try the Acme check' }], guide: [], more: null,
  status, results: [], checkedAt: null, confirmedAt: null, keys: [], ...more,
});
const SETUP = {
  checkedAt: TESTED,
  canChangeKeys: true,
  areas: [{ id: 'project', title: 'The Acme project' }, { id: 'claude', title: 'Acme agents' }, { id: 'stories', title: 'Acme stories' }, { id: 'salesforce', title: 'Acme orgs' }],
  steps: [
    acmeStep('project', 'project', 'broken', {
      checks: ['config', 'local settings'],
      inputs: [{ kind: 'config', name: 'project.name', configPath: 'project.name', required: true, present: true }],
      results: [
        { name: 'config', step: 'project', ok: false, level: 'error', detail: 'no acme config', fix: { step: 'project', hint: 'write the Acme config' }, checkedAt: TESTED },
        { name: 'local settings', step: 'project', ok: false, level: 'warn', detail: 'the Acme settings file is old', checkedAt: TESTED },
      ],
      checkedAt: TESTED,
      guide: [{ text: 'Run `acme init` in the Acme folder.' }],
    }),
    // The env check runs here, but its failure counts against another step.
    acmeStep('project-keys', 'project', 'optional', {
      results: [{ name: 'env variables', step: 'project-keys', ok: false, level: 'error', detail: 'ACME_MAIL_KEY is not set', fix: { step: 'notifications', hint: 'add ACME_MAIL_KEY' }, checkedAt: TESTED }],
      checkedAt: TESTED,
    }),
    acmeStep('jira-signin', 'stories', 'done', {
      results: [
        { name: 'jira signed in', step: 'jira-signin', ok: true, level: 'error', detail: 'acme.atlassian.net as Ana', checkedAt: TESTED },
        { name: 'jira sign-in age', step: 'jira-signin', ok: true, level: 'warn', detail: '', checkedAt: TESTED },
      ],
      checkedAt: TESTED,
      more: 'https://finefactory.ai/apps/foreman/docs/#acme',
    }),
    acmeStep('jira-app', 'stories', 'needs-you', {
      inputs: [
        { kind: 'key', name: 'JIRA_CLIENT_ID', required: true, present: false },
        { kind: 'key', name: 'JIRA_CLIENT_SECRET', required: true, present: false },
        { kind: 'key', name: 'ACME_TOKEN', required: false, present: true },
      ],
      keys: [
        { name: 'JIRA_CLIENT_ID', label: 'Acme app client ID', set: false, masked: null, source: null, file: '.env.foreman', testable: false, testLabel: 'Try it' },
        { name: 'JIRA_CLIENT_SECRET', label: 'Acme app secret', set: false, masked: null, source: null, file: '.env.foreman', testable: false, testLabel: 'Try it' },
        { name: 'ACME_TOKEN', label: 'Acme token', set: true, masked: '•••• 1234', source: 'file', file: '.env.local', testable: false, testLabel: 'Try it' },
      ],
      guide: [
        { text: 'Make an Acme key and copy it.', click: ['Acme console', 'Keys', 'Create key'] },
        { text: 'Paste it into `ACME_KEY` in the env file.' },
      ],
    }),
    acmeStep('sf-tools', 'salesforce', 'skipped'),
  ],
};
const stepIn = (id) => SETUP.steps.find((s) => s.id === id);

describe('an idle slot while a restart on new code is pending', () => {
  const idleLane = lifted(/function idleLane\(s, status\) \{[\s\S]*?\n {2}\}\n/, 'idleLane');
  const restartPending = { from: 'a1b2c3d', to: 'e4f5a6b', since: '2026-10-25T09:00:00.000Z' };
  const running = { state: 'running', reason: '' };

  it('reads Waiting for restart, and names the new code', () => {
    const view = idleLane({ id: 'w2', state: 'idle' }, { loop: running, workers: 2, restartPending });
    expect(view.chip).toBe('Waiting for restart');
    expect(view.title).toBe('Waiting for restart');
    expect(view.line).toContain('a1b2c3d → e4f5a6b');
    expect(view.line).toBe('New code arrived (a1b2c3d → e4f5a6b). The run restarts on it once the slots being set up are ready; the stories in progress keep running.');
  });

  it('keeps the usual words with no restart pending', () => {
    expect(idleLane({ id: 'w2', state: 'idle' }, { loop: running, workers: 2, restartPending: null })).toEqual({ chip: 'Idle', title: 'Waiting for the next story', line: 'It picks one up as soon as one is free to build.' });
    expect(idleLane({ id: 'w2', state: 'idle' }, { loop: { state: 'stopped' }, workers: 2 }).line).toBe('It picks one up when the run starts.');
  });

  it('says a slot over the worker count is not in use, even with a restart pending', () => {
    expect(idleLane({ id: 'w3', state: 'idle' }, { loop: running, workers: 2, restartPending })).toEqual({ chip: 'Idle', title: 'Waiting for the next story', line: 'Not in use at the current worker count.' });
  });

  describe('what holds the slot', () => {
    const slot = { id: 'w2', state: 'idle' };
    const queued = [{ id: 'ACME-3', slot: 'w2', text: 'ACME-3 queued for w2' }];

    it('names work queued for the slot', () => {
      const view = idleLane(slot, { loop: running, workers: 2, restartPending: null, queued });
      expect(view.title).toBe('Work queued for w2');
      expect(view.chip).toBe('Idle');
      expect(view.line).toBe('ACME-3 queued for w2.');
    });

    it('ignores work queued for another slot', () => {
      const view = idleLane(slot, { loop: running, workers: 2, queued: [{ id: 'ACME-3', slot: 'w1', text: 'ACME-3 queued for w1' }] });
      expect(view.title).toBe('Waiting for the next story');
    });

    it('says picking is held while the run is paused, with the reason', () => {
      const view = idleLane(slot, { loop: { state: 'paused', reason: 'Jira not reachable since 09:00: timeout' }, workers: 2 });
      expect(view.title).toBe('Picking held');
      expect(view.line.startsWith('Picking held: Jira not reachable')).toBe(true);
    });

    it('lets a pause beat queued work', () => {
      const view = idleLane(slot, { loop: { state: 'paused', reason: 'paused by you' }, workers: 2, queued });
      expect(view.title).toBe('Picking held');
    });

    it('says picking is held while backing off after failed sessions', () => {
      const backoffUntil = new Date(Date.now() + 600000).toISOString();
      const view = idleLane(slot, { loop: running, workers: 2, backoffUntil });
      expect(view.title).toBe('Picking held');
      expect(view.line.startsWith('Picking held: backing off after failed sessions until ')).toBe(true);
    });

    it('reads the usual words once the backoff is past', () => {
      const backoffUntil = new Date(Date.now() - 600000).toISOString();
      const view = idleLane(slot, { loop: running, workers: 2, backoffUntil });
      expect(view.line).toBe('It picks one up as soon as one is free to build.');
    });
  });

  it('is what the slot list uses for an idle slot', () => {
    const lane = SCRIPT.match(/function lane\(s\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(lane).toContain('idleLane(');
  });
});

describe('the stop box says who stopped the run', () => {
  const stopNote = lifted(/function stopNote\(status\) \{[\s\S]*?\n {2}\}\n/, 'stopNote');
  const by = { text: "ACME-9's session at 04:01 UTC" };

  it('while the run finishes: Stop requested by whoever asked', () => {
    expect(stopNote({ loop: { state: 'running' }, control: { stopRequested: true }, stoppedBy: by })).toEqual({
      on: true,
      text: "Stop requested by ACME-9's session at 04:01 UTC: the run finishes the stories in progress, then stops.",
    });
  });

  it('once stopped: Stopped by whoever asked, and how to start it again', () => {
    expect(stopNote({ loop: { state: 'stopped' }, control: { stopRequested: false }, stoppedBy: by })).toEqual({
      on: true,
      text: "Stopped by ACME-9's session at 04:01 UTC. Start it again with foreman run.",
    });
  });

  it('keeps the old words when nobody is named', () => {
    expect(stopNote({ loop: { state: 'running' }, control: { stopRequested: true }, stoppedBy: null })).toEqual({ on: true, text: 'Stop requested: the run finishes the stories in progress, then stops.' });
    expect(stopNote({ loop: { state: 'running' }, control: {} })).toEqual({ on: false, text: 'Stories in progress finish first.' });
    expect(stopNote({ loop: { state: 'stopped' } })).toEqual({ on: false, text: 'Stories in progress finish first.' });
    expect(stopNote(null)).toEqual({ on: false, text: 'Stories in progress finish first.' });
  });

  it('is what the stop box shows, set as text, never as HTML', () => {
    const controls = SCRIPT.slice(SCRIPT.indexOf("const box = $('stop-box')"), SCRIPT.indexOf('// ── feed, queue, results, progress'));
    expect(controls).toContain('stopNote(status)');
    expect(controls).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(SCRIPT).not.toMatch(/innerHTML/);
  });
});

describe('a decision explained in plain words', () => {
  const EXPLAIN = { purpose: 'Keeps the keys apart.', happened: 'A test step could change the real key file.', damage: 'No; it is unchanged.', recommendation: 'Retry: the fix is small.' };

  it('waitingCardView gives the explanation as labelled lines, in order', () => {
    const view = waitingCardView({ ...item('d-1'), explain: EXPLAIN });
    expect(view.slots.explain).toEqual([
      { label: 'What this story is for', text: 'Keeps the keys apart.' },
      { label: 'What happened', text: 'A test step could change the real key file.' },
      { label: 'Is anything damaged?', text: 'No; it is unchanged.' },
      { label: 'Recommendation', text: 'Retry: the fix is small.' },
    ]);
    const { damage, ...rest } = EXPLAIN;
    expect(waitingCardView({ ...item('d-1'), explain: rest }).slots.explain.map((l) => l.label)).toEqual(['What this story is for', 'What happened', 'Recommendation']);
    for (const it of [...WAITING, {}, { ...item('d-1'), explain: {} }, { ...item('d-1'), explain: { purpose: ' ', happened: 4 } }, { ...item('d-1'), explain: 'x' }]) {
      expect(waitingCardView(it).slots.explain, JSON.stringify(it)).toBeNull();
    }
  });

  it("the page's labels are the decisions module's", () => {
    const view = waitingCardView({ ...item('d-1'), explain: EXPLAIN });
    expect(view.slots.explain.map((l) => l.label)).toEqual(Object.values(EXPLAIN_LABELS));
  });

  const helpSrc = () => SCRIPT.match(/function helpFor\(help, kind, key, own\) \{[\s\S]*?\n {2}\}\n/)[0];
  const waitingHelpSrc = () => SCRIPT.match(/function waitingHelp\(help, it, action\) \{[\s\S]*?\n {2}\}\n/)[0];
  const waitingHelp = (...args) => new Function(`${helpSrc()}\n${waitingHelpSrc()}; return waitingHelp;`)()(...args);

  it("waitingHelp shows a decision's own hint when it is explained", () => {
    const help = { decision: { Drop: { hint: 'Drops the story.', more: 'Closes its pull requests.' } } };
    const drop = { id: 'option-0', label: 'Drop', hint: 'Stops all work on it.', recommended: false };
    const it = { id: 'd-9', kind: 'decision', title: 'ACME-12 could not pass review', explain: EXPLAIN, actions: [drop] };
    expect(waitingHelp(help, it, { id: 'option-0', label: 'Drop' })).toEqual({ hint: 'Stops all work on it.', more: 'Closes its pull requests.' });
    expect(waitingHelp({ decision: {} }, it, { id: 'option-0', label: 'Drop' })).toEqual({ hint: 'Stops all work on it.', more: 'Stops all work on it.' });
    const { explain, ...plain } = it;
    expect(waitingHelp(help, plain, { id: 'option-0', label: 'Drop' })).toEqual(help.decision.Drop);
    const noHint = { ...it, actions: [{ ...drop, hint: null }] };
    expect(waitingHelp(help, noHint, { id: 'option-0', label: 'Drop' })).toEqual(help.decision.Drop);
  });

  it('waitingHelp gives a learned item the help.learned entry for its action', () => {
    const help = { learned: ACTION_HELP.learned, decision: { 'Undo the change': { hint: 'Old words.', more: 'Old words.' } } };
    const it = { id: 'd-7', kind: 'learned', actions: [{ id: 'undo', label: 'Undo the change', hint: 'Own hint.' }, { id: 'ok', label: 'Got it', hint: null }] };
    expect(waitingHelp(help, it, { id: 'undo', label: 'Undo the change' })).toEqual(ACTION_HELP.learned.undo);
    expect(waitingHelp(help, it, { id: 'ok', label: 'Got it' })).toEqual(ACTION_HELP.learned.ok);
    expect(waitingHelp({}, it, { id: 'undo', label: 'Undo the change' })).toBeNull();
  });

  // The card drawn by the page's own waitingCard, on a tree of { tag, cls, text, children }.
  const drawCard = (it) => {
    const pick = (re) => SCRIPT.match(re)[0];
    const src = [
      pick(/function helpFor\(help, kind, key, own\) \{[\s\S]*?\n {2}\}\n/),
      pick(/function waitingHelp\(help, it, action\) \{[\s\S]*?\n {2}\}\n/),
      pick(/function waitingCardView\(it\) \{[\s\S]*?\n {2}\}\n/),
      pick(/function waitingCard\(it, i\) \{[\s\S]*?\n {2}\}\n/),
    ].join('\n');
    return new Function('input', `
      const help = input.help;
      const node = (tag, cls, text) => ({
        tag, cls: cls || null, text: text == null ? null : String(text), children: [], dataset: {}, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; },
        addEventListener() {}, append(...xs) { this.children.push(...xs); },
      });
      const el = node;
      const withHelp = (control, h) => { if (!h) return control; const box = node('div', 'hl'); box.append(control, node('p', 'hint', h.hint)); return box; };
      const drafts = {};
      const wdraft = (id) => (drafts[id] ??= {});
      const taskInfo = new Map(), detailsOpen = new Set(), busy = new Set();
      const canAct = () => true, waitingHeadingId = (i) => 'wait-h-' + i;
      const taskDetailsNote = () => null, withTaskDetails = (x) => x;
      const confirmRow = () => node('div', 'confirm'), actWaiting = () => {}, renderWaiting = () => {}, focusKey = () => {};
      const waitingLink = (link) => node('a', null, link.href);
      ${src}
      return waitingCard(input.it, 0);
    `)({ it, help: { decision: ACTION_HELP.decision, waiting: ACTION_HELP.waiting } });
  };
  const textOf = (n) => (typeof n === 'string' ? n : `${n.text ?? ''}${n.children.map(textOf).join('')}`);
  // The card's readable lines in order: each paragraph, heading, button and summary.
  const linesOf = (n, out = []) => {
    if (typeof n === 'string') return out;
    if (['p', 'h3', 'button', 'summary'].includes(n.tag)) out.push({ tag: n.tag, cls: n.cls, text: textOf(n) });
    else n.children.forEach((c) => linesOf(c, out));
    return out;
  };
  const find = (n, test) => (typeof n === 'string' ? null : test(n) ? n : n.children.map((c) => find(c, test)).find(Boolean) ?? null);

  // The story skill's example for ACME-12, read from its decisions file, as `decide add` would get it.
  const DECISIONS = readFileSync(new URL('../../skills/story/decisions.md', import.meta.url), 'utf8');
  const example = () => {
    const rows = DECISIONS.split('\n').map((l) => l.trim());
    const after = (label) => rows.find((l) => l.startsWith(label)).slice(label.length).trim();
    const options = rows.filter((l) => /^- (Retry with a note to the architect|I'll take it|Drop): /.test(l)).map((l) => [l.slice(2, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]);
    return { explain: { purpose: after('What this story is for:'), happened: after('What happened:'), damage: after('Is anything damaged?'), recommendation: after('Recommendation:') }, options };
  };

  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-page-explain-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ID = '[A-Z]+-\\d+';
  const story = { id: 'ACME-12', title: "Keep the factory's own keys out of story workspaces", ref: '', status: 'blocked', group: '', groupName: '', order: 0, dependsOn: [], blockedBy: 'Factory could not pass review', ownerTask: false, resources: [] };
  const BODY = "Major: 'foreman keys migrate' resolves the project root from FOREMAN_PROJECT_DIR, so the test can anchor .env.local in the real project; add a scratch check. Draft PR: https://example.test/pr/12";

  it('draws a review failure for ACME-12 in the skill\'s plain words, with the finding only under Details', () => {
    const { explain, options } = example();
    expect(options.map(([label]) => label)).toEqual(['Retry with a note to the architect', "I'll take it", 'Drop']);
    add(dir, {
      story: 'ACME-12',
      kind: 'decision',
      title: 'ACME-12 could not pass review',
      summary: explain.happened,
      body: BODY,
      options: options.map(([label]) => label),
      hints: options.map(([, hint]) => hint),
      recommend: 'Retry with a note to the architect',
      explain,
    });
    const [it] = buildWaiting({ decisions: { source: 'files', items: pending(dir) }, stories: [story], idPattern: ID });
    const card = drawCard(it);
    const lines = linesOf(card).map((l) => l.text);
    const at = (text) => lines.indexOf(text);
    const explained = [
      `What this story is for: ${explain.purpose}`,
      `What happened: ${explain.happened}`,
      `Is anything damaged? ${explain.damage}`,
      `Recommendation: ${explain.recommendation}`,
    ];
    for (const line of explained) expect(lines, line).toContain(line);
    expect(explained.map(at)).toEqual([...explained.map(at)].sort((a, b) => a - b));
    expect(at('Your options')).toBeGreaterThan(at(explained.at(-1)));
    const buttons = options.map(([label, hint]) => [at(label), hint]);
    for (const [i, hint] of buttons) {
      expect(i).toBeGreaterThan(at('Your options'));
      expect(lines[i + 1]).toBe(hint);
    }
    expect(buttons.map(([i]) => i)).toEqual([...buttons.map(([i]) => i)].sort((a, b) => a - b));
    expect(at('Details')).toBeGreaterThan(buttons.at(-1)[0]);
    expect(find(card, (n) => n.cls === 'chip rec')).toBeNull();

    const fold = find(card, (n) => n.tag === 'details');
    expect(textOf(fold)).toContain('FOREMAN_PROJECT_DIR');
    expect(textOf(fold)).toContain('.env.local');
    const outside = { ...card, children: card.children.filter((c) => c !== fold) };
    expect(textOf(outside)).not.toContain('FOREMAN_PROJECT_DIR');
    expect(textOf(outside)).not.toContain('.env.local');

    for (const text of [it.why, ...explained, ...options.map(([, hint]) => hint)]) expect(explainProblems({ happened: text }), text).toEqual([]);
  });

  it('draws a decision without an explanation as before', () => {
    add(dir, { story: 'ACME-12', kind: 'decision', title: 'ACME-12 could not pass review', summary: 'Two findings.', body: BODY, options: ['Retry with a note to the architect', 'Drop'], hints: ['Builds it again.', 'Stops it.'], recommend: 'Drop' });
    const [it] = buildWaiting({ decisions: { source: 'files', items: pending(dir) }, stories: [story], idPattern: ID });
    expect(it).not.toHaveProperty('explain');
    const card = drawCard(it);
    const lines = linesOf(card);
    expect(lines.map((l) => l.text)).not.toContain('Your options');
    expect(lines.some((l) => /What happened/.test(l.text))).toBe(false);
    const chip = find(card, (n) => n.cls === 'chip rec');
    expect(chip).not.toBeNull();
    expect(lines.map((l) => l.text)).toContain('Recommended Drop');
    // Without an explanation the help.mjs entry wins for a fixed label, as before.
    expect(lines[lines.findIndex((l) => l.tag === 'button' && l.text === 'Drop') + 1].text).toBe(ACTION_HELP.decision.Drop.hint);
    const fold = find(card, (n) => n.tag === 'details');
    expect(linesOf(fold)).toEqual([{ tag: 'summary', cls: null, text: 'Details' }, { tag: 'p', cls: 'dbody', text: BODY }]);
  });
});

describe('the Set up tab', () => {
  it('is a fourth tab, first while anything required is missing, with a done/total count', () => {
    expect(tabOrder(2)).toEqual(['setup', 'run', 'insights', 'waiting', 'settings']);
    expect(tabOrder(0)).toEqual(['run', 'insights', 'waiting', 'settings', 'setup']);
    expect(setupCount(SETUP.steps)).toEqual({ done: 1, total: 3, missing: 2 });
    expect(setupCount([])).toEqual({ done: 0, total: 0, missing: 0 });
    expect(PAGE).toMatch(/<button type="button" role="tab" id="tab-setup" aria-controls="view-setup" aria-selected="false" tabindex="-1"><svg class="ticon" [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>Set up <span class="tcount" id="setup-count"><\/span><\/button>/);
    const at = PAGE.indexOf('id="tab-setup"');
    expect(at).toBeGreaterThan(PAGE.indexOf('<nav class="tabs"'));
    expect(at).toBeLessThan(PAGE.indexOf('</nav>'));
    expect(PAGE).toMatch(/<section class="sview" id="view-setup" role="tabpanel" aria-labelledby="tab-setup" tabindex="-1" hidden>/);
    expect(SCRIPT).toContain("['setup', $('tab-setup'), $('view-setup')]");
    expect(SCRIPT).toContain("['waiting', $('tab-waiting'), $('view-waiting')]");
    expect(SCRIPT).toContain("'#setup'");
    // The arrow keys follow the order on screen.
    expect(SCRIPT).toContain('TABS.sort(');
    expect(SCRIPT).toContain('.append(...TABS.map(');
  });

  it('gives each status its pill, and hides the skipped steps', () => {
    expect(setupPill('done')).toEqual({ text: 'Done', cls: 'pill done' });
    expect(setupPill('needs-you')).toEqual({ text: 'Needs you', cls: 'pill needs' });
    expect(setupPill('broken')).toEqual({ text: 'Broken', cls: 'pill broken' });
    expect(setupPill('optional')).toEqual({ text: 'Optional', cls: 'pill opt' });
    expect(setupPill('skipped')).toBeNull();
    expect(setupPill('nope')).toBeNull();
    expect(setupVisible(SETUP.steps).map((s) => s.id)).toEqual(['project', 'project-keys', 'jira-signin', 'jira-app']);
    for (const cls of ['.pill{', '.pill.done{', '.pill.needs{', '.pill.broken{', '.pill.opt{']) expect(PAGE).toContain(cls);
  });

  it("lists only the problems that count against the step, with the result's fix or the step's hint", () => {
    expect(setupProblems(stepIn('project'))).toEqual([
      { level: 'error', wrong: 'no acme config', todo: 'write the Acme config' },
      { level: 'warn', wrong: 'the Acme settings file is old', todo: 'fix project the Acme way' },
    ]);
    expect(setupProblems(stepIn('project-keys'))).toEqual([]);
    expect(setupProblems(stepIn('jira-signin'))).toEqual([]);
    expect(setupProblems(acmeStep('notifications', 'notify', 'broken', { results: stepIn('project-keys').results }))).toEqual([
      { level: 'error', wrong: 'ACME_MAIL_KEY is not set', todo: 'add ACME_MAIL_KEY' },
    ]);
    expect(setupProblems(acmeStep('x', 'project', 'broken', { results: [{ name: 'x check', step: 'x', ok: false, level: 'error' }] }))).toEqual([
      { level: 'error', wrong: 'x check', todo: 'fix x the Acme way' },
    ]);
  });

  it('says where each step stands in one line, and when it was tested', () => {
    expect(setupStateLine(stepIn('project'))).toBe('no acme config');
    expect(setupStateLine(stepIn('jira-app'))).toBe('Missing JIRA_CLIENT_ID, JIRA_CLIENT_SECRET');
    expect(setupStateLine(stepIn('jira-signin'))).toBe('acme.atlassian.net as Ana');
    expect(setupStateLine(stepIn('project-keys'))).toBe('Works');
    expect(setupStateLine(acmeStep('github', 'github', 'done'))).toBe('Works');

    expect(setupResultLine(stepIn('jira-app'))).toBe('Not tested yet.');
    expect(setupResultLine(stepIn('jira-signin'))).toBe('Tested 10:42: works, acme.atlassian.net as Ana');
    expect(setupResultLine(stepIn('project'))).toBe('Tested 10:42: not working');
    expect(setupResultLine(stepIn('project-keys'))).toBe('Tested 10:42: works');
    expect(setupResultLine({ ...stepIn('jira-app'), checkedAt: new Date(2026, 9, 24, 7, 5).toISOString() })).toBe('Tested 07:05: needs you');
  });

  it('says how long ago a step was tested when it is given the time now', () => {
    const at = Date.parse(TESTED);
    const MIN = 60_000;
    expect(setupResultLine(stepIn('project-keys'), at + 20_000)).toBe('Tested 10:42, just now: works');
    expect(setupResultLine(stepIn('project-keys'), at + 12 * MIN)).toBe('Tested 10:42, 12 min ago: works');
    expect(setupResultLine(stepIn('project-keys'), at + 3 * 60 * MIN + 5 * MIN)).toBe('Tested 10:42, 3 h ago: works');
    expect(setupResultLine(stepIn('project-keys'), at + 2 * 24 * 60 * MIN + MIN)).toBe('Tested 10:42, 2 days ago: works');
    expect(setupResultLine(stepIn('jira-signin'), at + 12 * MIN)).toBe('Tested 10:42, 12 min ago: works, acme.atlassian.net as Ana');
    // A clock behind the test time is "just now", never a negative age.
    expect(setupResultLine(stepIn('project-keys'), at - 5000)).toBe('Tested 10:42, just now: works');
    expect(setupResultLine(stepIn('jira-app'), at)).toBe('Not tested yet.');
    expect(setupResultLine(stepIn('project-keys'), 'soon')).toBe('Tested 10:42: works');
  });

  it('says Checking… while the step is being checked, with the last result when there is one', () => {
    const at = Date.parse(TESTED);
    expect(SCRIPT.match(CHECKING_LINE)[0]).toMatch(/^const CHECKING = 'Checking…';/);
    expect(setupResultLine({ ...stepIn('project-keys'), checking: true }, at + 12 * 60_000)).toBe('Checking… Last tested 10:42, 12 min ago: works');
    expect(setupResultLine({ ...stepIn('project-keys'), checking: true })).toBe('Checking… Last tested 10:42: works');
    expect(setupResultLine({ ...stepIn('jira-app'), checking: true }, at)).toBe('Checking…');
    expect(setupResultLine({ ...stepIn('project-keys'), checking: false }, at + 12 * 60_000)).toBe('Tested 10:42, 12 min ago: works');
  });

  it("turns Test it off and makes it read Checking… while the page or the server is checking the step", () => {
    const busy = new Function(`const setupBusy = new Set(['github']); ${SCRIPT.match(/function setupStepBusy\(step\) \{[\s\S]*?\n {2}\}\n/)[0]}; return setupStepBusy;`)();
    expect(busy({ id: 'github' })).toBe(true);
    expect(busy({ id: 'project', checking: true })).toBe(true);
    expect(busy({ id: 'project', checking: false })).toBe(false);
    expect(busy({ id: 'project' })).toBe(false);
    const start = SCRIPT.indexOf("const action = formShown ? null : (s.actions || []).find((a) => a && a.id === 'check');");
    expect(start).toBeGreaterThan(-1);
    const render = SCRIPT.slice(start, SCRIPT.indexOf("box.append(result);", start));
    expect(render).toContain('const busy = setupStepBusy(s);');
    expect(render).toContain('busy ? CHECKING : String(action.label)');
    expect(render).toContain('b.disabled = busy || needsToken;');
    expect(render).toContain('setupResultLine({ ...s, checking: busy }, Date.now())');
  });

  it("numbers the guide from the step's own data, with its click path", () => {
    expect(setupGuide(stepIn('jira-app'))).toEqual([
      { n: 1, id: null, text: 'Make an Acme key and copy it.', click: 'Acme console › Keys › Create key', check: null },
      { n: 2, id: null, text: 'Paste it into `ACME_KEY` in the env file.', click: null, check: null },
    ]);
    expect(setupGuide(stepIn('jira-signin'))).toEqual([]);
  });

  it('lists the inputs read-only, with whether and where each is set', () => {
    expect(setupInputs(stepIn('jira-app'))).toEqual([
      { name: 'JIRA_CLIENT_ID', label: 'Acme app client ID', state: 'Not set' },
      { name: 'JIRA_CLIENT_SECRET', label: 'Acme app secret', state: 'Not set' },
      { name: 'ACME_TOKEN', label: 'Acme token (optional)', state: 'Set in .env.local (•••• 1234)' },
    ]);
    expect(setupInputs(stepIn('project'))).toEqual([{ name: 'project.name', label: 'project.name', state: 'Set in foreman.config.json' }]);
    expect(setupInputs(acmeStep('n', 'notify', 'optional', { inputs: [{ kind: 'choice', name: 'notify.adapter', required: true, present: false }] }))).toEqual([
      { name: 'notify.adapter', label: 'notify.adapter', state: 'Not set' },
    ]);
  });

  it('groups the checklist by area, in the order of the areas, dropping empty ones', () => {
    const groups = setupGroups(SETUP.steps, SETUP.areas);
    expect(groups.map((g) => [g.id, g.title, g.steps.map((s) => s.id)])).toEqual([
      ['project', 'The Acme project', ['project', 'project-keys']],
      ['stories', 'Acme stories', ['jira-signin', 'jira-app']],
    ]);
    const odd = setupGroups([...SETUP.steps, acmeStep('other', 'elsewhere', 'done')], SETUP.areas);
    expect(odd.at(-1)).toMatchObject({ id: 'elsewhere', title: 'elsewhere' });
    expect(odd.at(-1).steps.map((s) => s.id)).toEqual(['other']);
  });

  it('keeps a group that has only parts that are off, each with its Turn on', () => {
    const jira = { id: 'jira', area: 'stories', title: 'Jira', line: 'Acme Jira: off, because of Acme files.', turnOn: { label: 'Switch it on', step: 'project', choice: { field: 'source', value: 'jira' } } };
    const steps = SETUP.steps.filter((s) => s.area !== 'stories');
    const groups = setupGroups(steps, SETUP.areas, [jira]);
    expect(groups.map((g) => [g.id, g.steps.map((s) => s.id), g.off.map((e) => e.id)])).toEqual([
      ['project', ['project', 'project-keys'], []],
      ['stories', [], ['jira']],
    ]);
    expect(setupGroups(SETUP.steps, SETUP.areas, [jira]).find((g) => g.id === 'stories').steps.map((s) => s.id)).toEqual(['jira-signin', 'jira-app']);
    expect(setupGroups(steps, SETUP.areas).map((g) => g.id)).toEqual(['project']);
    expect(setupGroups(steps, SETUP.areas, null).map((g) => g.id)).toEqual(['project']);
  });

  it("shows the change form's fields for the project: the pack with sfdx only, the sandbox only when turning it on", () => {
    const form = PROJECT_FORM.change;
    const ids = (ctx) => changeFields(form, ctx).map((f) => f.id);
    expect(ids({ sfdx: false, pack: 'none', packNow: 'none' })).toEqual(['source']);
    expect(ids({ sfdx: false, pack: 'salesforce', packNow: 'none' })).toEqual(['source', 'alias', 'orgId']);
    expect(ids({ sfdx: true, pack: 'none', packNow: 'none' })).toEqual(['source', 'pack']);
    expect(ids({ sfdx: true, pack: 'salesforce', packNow: 'none' })).toEqual(['source', 'pack', 'alias', 'orgId']);
    expect(ids({ sfdx: true, pack: 'salesforce', packNow: 'salesforce' })).toEqual(['source', 'pack']);
    expect(ids({ sfdx: true, pack: 'none', packNow: 'salesforce' })).toEqual(['source', 'pack']);
    expect(changeFields(null, {})).toEqual([]);
  });

  it('sends only what changed, and the sandbox only with the pack', () => {
    const now = { source: 'markdown', pack: 'none', sfdx: true };
    expect(changeBody({ source: 'markdown', pack: 'none', alias: 'dev', orgId: '00D' }, now)).toEqual({});
    expect(changeBody({ source: 'jira', pack: 'none', alias: '', orgId: '' }, now)).toEqual({ source: 'jira' });
    expect(changeBody({ source: 'markdown', pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' }, now)).toEqual({ pack: 'salesforce', alias: 'dev', orgId: '00D000000000001' });
    expect(changeBody({ source: 'jira', pack: 'salesforce', alias: '', orgId: '' }, now)).toEqual({ source: 'jira', pack: 'salesforce', alias: '', orgId: '' });
    expect(changeBody({ source: 'markdown', pack: 'none', alias: 'dev', orgId: 'x' }, { source: 'markdown', pack: 'salesforce', sfdx: true })).toEqual({ pack: 'none' });
  });

  it('rebuilds the change draft when the project changes, unless the owner changed it', () => {
    const md = { source: 'markdown', pack: 'none', sfdx: false };
    const jira = { source: 'jira', pack: 'none', sfdx: false };
    const first = changeDraftFor(null, md);
    expect(first.answers).toEqual({ source: 'markdown', pack: 'none', alias: '', orgId: '' });
    expect(first.from).toEqual({ source: 'markdown', pack: 'none' });
    expect(first).toMatchObject({ errors: [], lines: [], saving: false });
    expect(changeDraftFor(first, md)).toBe(first);

    // Untouched, and the config moved to Jira under it: started again, so Save sends no revert.
    const moved = changeDraftFor(first, jira);
    expect(moved).not.toBe(first);
    expect(moved.answers.source).toBe('jira');
    expect(moved.from).toEqual({ source: 'jira', pack: 'none' });
    expect(changeBody(moved.answers, jira)).toEqual({});

    // Changed by the owner: kept, whatever the project does.
    const edited = changeDraftFor(null, md);
    edited.answers.source = 'jira';
    expect(changeDraftFor(edited, { source: 'markdown', pack: 'salesforce', sfdx: true })).toBe(edited);
    // Changed and changed back: untouched again, so it follows the project.
    edited.answers.source = 'markdown';
    expect(changeDraftFor(edited, jira)).not.toBe(edited);

    const saving = { ...changeDraftFor(null, md), saving: true };
    expect(changeDraftFor(saving, jira)).toBe(saving);

    expect(changeDraftFor(first, null)).toBe(first);
    expect(changeDraftFor(null, null)).toBeNull();
    expect(changeDraftFor(undefined, 'x')).toBeNull();
  });

  it('draws the change form from changeDraftFor, and a save moves the draft on to the new project', () => {
    const bodyOf = (sig) => {
      const start = SCRIPT.indexOf(sig);
      expect(start, sig).toBeGreaterThan(-1);
      return SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
    };
    expect(bodyOf('function changeDraft() {')).toContain('changeDraftFor(projectChangeDraft');
    expect(bodyOf('async function projectChangeSave(s) {')).toContain('d.from =');
  });

  it('saves the change through the project write route, and turns an area on from the list', () => {
    expect(SCRIPT).toContain("'/api/setup/project/write'");
    expect(SCRIPT).toMatch(/api\('\/api\/setup\/project\/write', \{ change: /);
    expect(SCRIPT).toContain("'setup:turn-on:'");
    expect(SCRIPT).toContain("'setup:project:change:save'");
  });

  it('moves one step at a time, and names the forward button by the step', () => {
    expect(setupMove(4, 0, -1)).toBe(0);
    expect(setupMove(4, 0, 1)).toBe(1);
    expect(setupMove(4, 3, 1)).toBe(3);
    expect(setupMove(4, 2, -1)).toBe(1);
    expect(setupForward(stepIn('jira-app'), true)).toBe('Finish');
    expect(setupForward(stepIn('project-keys'), false)).toBe('Skip');
    expect(setupForward(stepIn('jira-app'), false)).toBe('Next');
  });

  it('writes no instruction text of its own: every word of a step comes from the model', () => {
    const texts = [SETUP_FIRST, RUN_SETUP, ...AREAS.map((a) => a.title)];
    for (const step of STEPS) texts.push(step.title, step.why, step.hint, ...step.guide.map((g) => g.text), ...step.actions.map((a) => a.label));
    for (const f of PROJECT_FORM.fields) {
      texts.push(f.label);
      for (const k of ['help', 'placeholder', 'action', 'empty']) if (typeof f[k] === 'string') texts.push(f[k]);
      for (const o of f.options ?? []) texts.push(o.label);
    }
    texts.push(PROJECT_FORM.save, PROJECT_FORM.running, PROJECT_FORM.saving, PROJECT_FORM.saved, PROJECT_FORM.retry);
    // The change form's words. Its pack options, On and Off, are also the settings switches' own
    // words, which the page draws for every boolean setting, so they are left out here.
    const change = PROJECT_FORM.change;
    texts.push(change.title, change.save, change.saving, change.saved);
    for (const f of change.fields) {
      texts.push(f.label, f.help);
      for (const o of f.options ?? []) if (!['On', 'Off'].includes(o.label)) texts.push(o.label);
    }
    // The off line's words, without the {title} and {why} the model fills in.
    texts.push(OFF_WORDS.turnOn, ...OFF_WORDS.line.split(/\{title\}|\{why\}/).map((t) => t.trim()).filter((t) => t.length > 1));
    texts.push(...Object.values(PROJECT_WORDS).filter((v) => typeof v === 'string'));
    // The key card's words, without the {file} the page fills in.
    for (const words of Object.values(KEY_CARD)) texts.push(...words.split('{file}').map((t) => t.trim()).filter(Boolean));
    expect(texts).toContain(KEY_CARD.save);
    expect(texts).toContain('Test it');
    expect(texts).toContain('Run it');
    expect(texts).toContain(PROJECT_WORDS.badJobs);
    expect(texts).toContain(PROJECT_WORDS.nothingChanged);
    expect(texts).toContain('Story source');
    expect(texts).toContain('Turn on');
    for (const text of texts) expect(PAGE, text).not.toContain(text);
  });

  it('reads the steps and tests one through the set-up API, with the info button and the guide link', () => {
    expect(SCRIPT).toContain("api('/api/setup')");
    expect(SCRIPT).toContain("api('/api/setup/steps/' + encodeURIComponent(");
    expect(SCRIPT).toContain("infoButton('setup:'");
    expect(SCRIPT).toContain("if (s.more) more.append(linkTo(s.more, 'Read the guide'));");
    expect(SCRIPT).not.toMatch(/innerHTML/);
    expect(PAGE).toMatch(/#view-setup \.btn,#view-setup \.linkbtn\{min-height:44px/);
    expect(PAGE).toMatch(/\.sguide[^{]*\{[^}]*overflow-wrap:anywhere/);
  });

  // SETUP with some steps' statuses changed, for a GET /api/setup answer after a write or a check.
  const setupWith = (status, more = {}) => ({
    ...SETUP, ...more, steps: SETUP.steps.map((s) => (Object.hasOwn(status, s.id) ? { ...s, status: status[s.id] } : s)),
  });

  it("setupPlace finds the open step by its id, else keeps the old place within the steps", () => {
    expect(setupPlace(SETUP.steps, 'jira-signin', 3)).toBe(2);
    expect(setupPlace(setupWith({ 'project-keys': 'skipped' }).steps, 'jira-signin', 2)).toBe(1);
    expect(setupPlace(setupWith({ 'jira-app': 'skipped' }).steps, 'jira-app', 3)).toBe(2);
    expect(setupPlace(SETUP.steps, null, 9)).toBe(3);
    expect(setupPlace([], 'project', 2)).toBe(0);
  });

  // loadSetup and checkSetupStep lifted out with the page's Set up state, rendering stubbed, and an
  // api that records each path and answers from `answers`: a list in turn; an Error is thrown, a
  // function's answer awaited. `timers` records each setTimeout the page sets ({ fn, ms }).
  const setupLoader = (answers, timers = { set: [] }) => {
    const paths = [];
    const fakeTimeout = (fn, ms) => {
      timers.set.push({ fn, ms });
      return timers.set.length;
    };
    const api = async (path) => {
      paths.push(path);
      const a = Array.isArray(answers[path]) ? answers[path].shift() : answers[path];
      if (a instanceof Error) throw a;
      if (typeof a === 'function') return structuredClone(await a());
      return structuredClone(a);
    };
    const src = (find) => SCRIPT.match(find)[0];
    const h = new Function('api', 'document', 'setTimeout', `
      let setup = null, setupMode = null, setupAt = 0, setupLoading = false, setupNote = {};
      const START_HASH = '#setup'; let tabPicked = true;
      ${src(/ {2}const setupBusy = new Set\(\);[\s\S]*?let setupRecheck = null;[^\n]*\n/)}
      const renderSetup = () => {}, renderSetupTab = () => {}, showTab = () => {}, focusKey = () => {}, say = () => {};
      const $ = () => ({ replaceChildren() {} }); const el = () => null;
      ${src(/function setupVisible\(steps\) \{[\s\S]*?\n {2}\}\n/)}
      ${src(/function setupMove\(count, at, dir\) \{[\s\S]*?\n {2}\}\n/)}
      ${src(/function setupCount\(steps\) \{[\s\S]*?\n {2}\}\n/)}
      ${src(/function setupResultLine\(step, nowMs\) \{[\s\S]*?\n {2}\}\n/)}
      ${src(/function setupPlace\(steps, id, at\) \{[\s\S]*?\n {2}\}\n/)}
      ${src(/function setupRecheckLater\(\) \{[\s\S]*?\n {2}\}\n/)}
      ${src(/async function loadSetup\(\) \{[\s\S]*?\n {2}\}\n/)}
      ${src(/async function checkSetupStep\(id\) \{[\s\S]*?\n {2}\}\n/)}
      return {
        loadSetup, checkSetupStep,
        state: () => ({ setup, setupMode, setupAt, busy: [...setupBusy], note: setupNote, recheck: setupRecheck }),
        open(i) { setupMode = 'step'; setupAt = i; },
      };
    `)(api, { activeElement: null, body: {} }, fakeTimeout);
    return { ...h, paths, timers, openId: () => setupVisible(h.state().setup.steps)[h.state().setupAt]?.id };
  };
  const CHECK = '/api/setup/steps/project/check';
  const projectDone = { ...stepIn('project'), status: 'done', results: [], checkedAt: TESTED };

  it("loadSetup keeps the open step's id when the visible steps change", async () => {
    const h = setupLoader({ '/api/setup': [SETUP, setupWith({ 'project-keys': 'skipped' })] });
    await h.loadSetup();
    h.open(2);
    expect(h.openId()).toBe('jira-signin');
    await h.loadSetup();
    expect(h.openId()).toBe('jira-signin');
    expect(h.state().setupAt).toBe(1);

    // And the other way: a step that comes back moves the open one on.
    const back = setupLoader({ '/api/setup': [setupWith({ 'project-keys': 'skipped' }), SETUP] });
    await back.loadSetup();
    back.open(2);
    expect(back.openId()).toBe('jira-app');
    await back.loadSetup();
    expect(back.openId()).toBe('jira-app');
    expect(back.state().setupAt).toBe(3);
  });

  it('reads GET /api/setup again in 3 s, with one timer only, while the server checks a step this page did not ask for', async () => {
    const checking = setupWith({}, {});
    checking.steps = checking.steps.map((s) => (s.id === 'project' ? { ...s, checking: true } : s));
    const h = setupLoader({ '/api/setup': [checking, checking, SETUP] });
    await h.loadSetup();
    expect(h.timers.set.map((t) => t.ms)).toEqual([3000]);
    // A second load while the timer waits sets no other.
    await h.loadSetup();
    expect(h.timers.set).toHaveLength(1);
    // The timer's load sees the check ended, and sets none.
    h.timers.set[0].fn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.paths).toEqual(['/api/setup', '/api/setup', '/api/setup']);
    expect(h.state().setup.steps.find((s) => s.id === 'project').checking).toBeUndefined();
    expect(h.timers.set).toHaveLength(1);
    expect(h.state().recheck).toBeNull();
  });

  it('sets no timer when no step is being checked, or only one this page is checking itself', async () => {
    const h = setupLoader({ '/api/setup': [SETUP] });
    await h.loadSetup();
    expect(h.timers.set).toEqual([]);
    const own = setupWith({}, {});
    own.steps = own.steps.map((s) => (s.id === 'project' ? { ...s, checking: true } : s));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    // The page's own check, held open, then a load that sees the server checking it.
    const mine = setupLoader({ '/api/setup': [SETUP, own, SETUP], [CHECK]: () => gate.then(() => ({ ok: true, step: projectDone })) });
    await mine.loadSetup();
    const checked = mine.checkSetupStep('project');
    expect(mine.state().busy).toEqual(['project']);
    await mine.loadSetup();
    expect(mine.state().setup.steps.find((s) => s.id === 'project').checking).toBe(true);
    expect(mine.timers.set).toEqual([]);
    release();
    await checked;
    expect(mine.paths).toEqual(['/api/setup', CHECK, '/api/setup', '/api/setup']);
    expect(mine.timers.set).toEqual([]);
  });

  it('the first load still opens the first step that needs the owner', async () => {
    const h = setupLoader({ '/api/setup': [SETUP] });
    await h.loadSetup();
    expect(h.state().setupMode).toBe('list');
    expect(h.state().setupAt).toBe(0);
    const fresh = setupLoader({ '/api/setup': [setupWith({ project: 'done' }, { checkedAt: null })] });
    await fresh.loadSetup();
    expect(fresh.state().setupMode).toBe('wizard');
    expect(fresh.openId()).toBe('jira-app');
  });

  it("a successful check is followed by GET /api/setup, which updates another step's status", async () => {
    const h = setupLoader({
      '/api/setup': [SETUP, setupWith({ project: 'done', 'jira-app': 'done' })],
      [CHECK]: { ok: true, step: projectDone },
    });
    await h.loadSetup();
    await h.checkSetupStep('project');
    expect(h.paths).toEqual(['/api/setup', CHECK, '/api/setup']);
    const status = (id) => h.state().setup.steps.find((s) => s.id === id).status;
    expect(status('jira-app')).toBe('done');
    expect(status('project')).toBe('done');
    expect(h.state().busy).toEqual([]);
  });

  it('a refused check makes no reload and keeps the refusal under the button', async () => {
    const refused = 'This step is being checked already. Try again in a moment.';
    const h = setupLoader({ '/api/setup': [SETUP, SETUP], [CHECK]: new Error(refused) });
    await h.loadSetup();
    await h.checkSetupStep('project');
    expect(h.paths).toEqual(['/api/setup', CHECK]);
    expect(h.state().note.project).toEqual({ error: refused });
    expect(h.state().busy).toEqual([]);
  });

  it('a check keeps the open step when the refreshed steps change', async () => {
    const h = setupLoader({
      '/api/setup': [SETUP, setupWith({ project: 'done', 'project-keys': 'skipped' })],
      [CHECK]: { ok: true, step: projectDone },
    });
    await h.loadSetup();
    h.open(2);
    await h.checkSetupStep('project');
    expect(h.paths.at(-1)).toBe('/api/setup');
    expect(h.openId()).toBe('jira-signin');
    expect(h.state().setupAt).toBe(1);
  });

  it('a check whose own step stops showing keeps the open step', async () => {
    const CHECK_KEYS = '/api/setup/steps/project-keys/check';
    const h = setupLoader({
      '/api/setup': [SETUP, setupWith({ 'project-keys': 'skipped' })],
      [CHECK_KEYS]: { ok: true, step: { ...stepIn('project-keys'), status: 'skipped' } },
    });
    await h.loadSetup();
    h.open(2);
    await h.checkSetupStep('project-keys');
    expect(h.paths).toEqual(['/api/setup', CHECK_KEYS, '/api/setup']);
    expect(h.openId()).toBe('jira-signin');
    expect(h.state().setupAt).toBe(1);
  });
});

// The key card: one for every key, drawn from its row in GET /api/setup and the card's words.
const keyCardView = lifted(/function keyCardView\(row, draft, words, canChange\) \{[\s\S]*?\n {2}\}\n/, 'keyCardView');
const keyInputRow = lifted(/function keyInputRow\(step, name\) \{[\s\S]*?\n {2}\}\n/, 'keyInputRow');

// The project step's form: the 400 list kept as the server sent it, and a retry after a failed
// detection (FM-225).
describe('the project form: errors and retry', () => {
  const errorList = lifted(/function errorList\(err\) \{[\s\S]*?\n {2}\}\n/, 'errorList');
  const bodyOf = (sig) => {
    const start = SCRIPT.indexOf(sig);
    expect(start, sig).toBeGreaterThan(-1);
    return SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
  };

  it('keeps each error the server listed, even one with "; " in it', () => {
    const err = Object.assign(new Error('Jira site: bad; very bad; Give the project a name.'), { errors: ['Jira site: bad; very bad', 'Give the project a name.'] });
    expect(errorList(err)).toEqual(['Jira site: bad; very bad', 'Give the project a name.']);
  });

  it('splits the message when there is no list', () => {
    expect(errorList(new Error('a; b'))).toEqual(['a', 'b']);
    expect(errorList(Object.assign(new Error('a; b'), { errors: [] }))).toEqual(['a', 'b']);
  });

  it('keeps the list on the error api() throws, and both saves use it', () => {
    expect(bodyOf('async function api(path, body) {')).toContain('err.errors = data.errors');
    for (const sig of ['async function projectSave() {', 'async function projectChangeSave(s) {']) {
      const body = bodyOf(sig);
      expect(body, sig).not.toContain("split('; ')");
      expect(body, sig).toContain('errorList(err)');
    }
  });

  it('offers Try again after a failed detection, and a Set up refresh tries again too', () => {
    const form = bodyOf('function projectForm(s) {');
    expect(form).toContain("'setup:project:retry'");
    expect(form).toContain('form.retry');
    expect(bodyOf('async function loadSetup() {')).toContain("projectLoadError = ''");
  });
});

describe('the key card', () => {
  const W = KEY_CARD;
  const acmeKey = (more = {}) => ({
    name: 'ACME_MAIL_KEY', label: 'Acme mail key', set: false, masked: null, source: null, file: '.env.foreman',
    testable: true, testLabel: 'Try the Acme key', generate: false, ignored: true, ...more,
  });
  const saved = (more = {}) => acmeKey({ set: true, masked: '•••• 1234', source: 'file', ...more });
  const view = (row, draft, canChange = true) => keyCardView(row, draft, W, canChange);

  it('takes a key that is not set: the entry and Save', () => {
    expect(view(acmeKey())).toEqual({ state: W.notSet, entry: true, buttons: ['save'], confirm: false, warn: null, note: null, result: null, error: null });
  });

  it('offers Make one for me on a key Foreman can make', () => {
    expect(view(acmeKey({ generate: true })).buttons).toEqual(['save', 'generate']);
  });

  it('shows where a saved key is, masked, with Test, Replace and Remove', () => {
    const v = view(saved());
    expect(v.state).toBe('Saved in .env.foreman (•••• 1234)');
    expect(v.entry).toBe(false);
    expect(v.buttons).toEqual(['test', 'replace', 'remove']);
    expect(v.warn).toBeNull();
  });

  it('has no Test for a saved key with no test', () => {
    expect(view(saved({ testable: false })).buttons).toEqual(['replace', 'remove']);
  });

  it('takes the new key while replacing, with a way back', () => {
    const v = view(saved(), { mode: 'replace' });
    expect(v.entry).toBe(true);
    expect(v.buttons).toEqual(['save', 'cancel']);
    expect(view(saved({ generate: true }), { mode: 'replace' }).buttons).toEqual(['save', 'generate', 'cancel']);
  });

  it('draws no buttons of its own while the remove confirm is open', () => {
    const v = view(saved(), { mode: 'confirm' });
    expect(v.confirm).toBe(true);
    expect(v.buttons).toEqual([]);
    expect(v.entry).toBe(false);
  });

  it('says a key set in the environment can be changed only there, and only tests it', () => {
    const v = view(acmeKey({ set: true, masked: '•••• 9876', source: 'environment' }));
    expect(v.state).toBe(W.outside);
    expect(v.entry).toBe(false);
    expect(v.buttons).toEqual(['test']);
    expect(view(acmeKey({ set: true, masked: 'set', source: 'environment', testable: false })).buttons).toEqual([]);
  });

  it('warns when git does not ignore the file, with the fix', () => {
    const v = view(saved({ ignored: false }));
    expect(v.warn).toBe(W.notIgnored.replace('{file}', '.env.foreman'));
    expect(v.warn).toContain('.env.foreman');
    expect(v.buttons).toEqual(['test', 'replace', 'remove', 'ignore']);
    expect(view(saved({ ignored: null })).warn).toBeNull();
  });

  it('changes nothing on a dashboard other computers can reach', () => {
    for (const row of [acmeKey(), saved(), saved({ ignored: false })]) {
      const v = view(row, undefined, false);
      expect(v.buttons).toEqual([]);
      expect(v.entry).toBe(false);
      expect(v.note).toBe(W.localOnly);
    }
  });

  it("shows a test's result in plain words, and an error", () => {
    expect(view(saved(), { mode: 'view', result: { ok: true, detail: 'Resend accepted the key' } }).result).toEqual({ ok: true, text: W.works + ': Resend accepted the key' });
    expect(view(saved(), { mode: 'view', result: { ok: false, detail: 'Resend did not accept the key' } }).result).toEqual({ ok: false, text: W.notWorking + ': Resend did not accept the key' });
    expect(view(saved(), { mode: 'view', error: 'The dashboard did not answer.' }).error).toBe('The dashboard did not answer.');
  });

  it('takes the value in a password field that is cleared before it is sent, and never written into the page', () => {
    expect(SCRIPT).toContain("type = 'password'");
    expect(SCRIPT).toContain("autocomplete = 'off'");
    expect(SCRIPT).not.toContain("setAttribute('value'");
    expect(SCRIPT).not.toMatch(/innerHTML/);
    for (const path of ['/api/setup/keys', '/api/setup/keys/test', '/api/setup/keys/generate', '/api/setup/keys/ignore']) expect(SCRIPT).toContain(`'${path}'`);
    expect(SCRIPT).toMatch(/const value = input\.value;\s*input\.value = '';[\s\S]{0,300}?api\('\/api\/setup\/keys', \{ name, value \}\)/);
    expect(SCRIPT).toContain('setup.keyCard');
  });

  it("finds a key input's row by name, not by place", () => {
    const row = { name: 'ACME_TOKEN', label: 'Acme token' };
    const step = {
      inputs: [null, { kind: 'config', name: 'notify.adapter' }, { kind: 'key', name: 'ACME_LOST', required: true }, { kind: 'key', name: 'ACME_TOKEN', required: false }],
      keys: [row, { name: 'notify.adapter', label: 'Not a key' }],
    };
    expect(keyInputRow(step, 'ACME_TOKEN')).toBe(row);
    expect(keyInputRow(step, 'notify.adapter')).toBeNull();
    expect(keyInputRow(step, 'ACME_LOST')).toBeNull();
    expect(keyInputRow(step, 'ACME_UNKNOWN')).toBeNull();
    expect(keyInputRow(null, 'ACME_TOKEN')).toBeNull();
    expect(keyInputRow({}, 'ACME_TOKEN')).toBeNull();
  });

  // keyAction and dropKeyInput lifted out with their neighbours stubbed; keyRequest records
  // whether the field was still held when the request left.
  const keyActionHarness = new Function('input', `
    const keyInputs = new Map(input.held);
    const calls = [];
    const draft = { mode: 'replace', result: null, error: null };
    const keyDraft = () => draft;
    const renderSetup = () => {};
    const focusKey = () => {};
    const saveKey = () => {};
    const api = (path, body) => ({ path, body });
    const keyRequest = (name, act, send) => { calls.push({ act, held: keyInputs.has(name), sent: send() }); };
    ${SCRIPT.match(/function dropKeyInput\(name\) \{[\s\S]*?\n {2}\}\n/)[0]}
    ${SCRIPT.match(/function keyAction\(name, act\) \{[\s\S]*?\n {2}\}\n/)[0]}
    keyAction(input.name, input.act);
    return { calls, keyInputs, draft };
  `);

  it('lets go of the typed text before Make one for me leaves, as Cancel does', () => {
    const name = 'FOREMAN_DASHBOARD_TOKEN';
    const field = { value: 'part-typed' };
    const out = keyActionHarness({ held: [[name, field]], name, act: 'generate' });
    expect(field.value).toBe('');
    expect(out.keyInputs.has(name)).toBe(false);
    expect(out.calls).toEqual([{ act: 'generate', held: false, sent: { path: '/api/setup/keys/generate', body: { name } } }]);

    const kept = { value: 'part-typed' };
    const back = keyActionHarness({ held: [[name, kept]], name, act: 'cancel' });
    expect(kept.value).toBe('');
    expect(back.keyInputs.has(name)).toBe(false);
    expect(back.calls).toEqual([]);
    expect(back.draft.mode).toBe('view');
  });
});

// The Claude sign-in screen: its two cards and the login card, drawn from step.signin and
// step.inUse in GET /api/setup.
const signinParts = lifted(/function signinParts\(step\) \{[\s\S]*?\n {2}\}\n/, 'signinParts');

describe('the Claude sign-in screen', () => {
  const keyRow = (name, more = {}) => ({ name, label: name, set: false, masked: null, source: null, file: '.env.foreman', testable: true, testLabel: 'Test it', generate: false, ignored: true, ...more });
  const acmeSignin = {
    cards: [
      { id: 'api-key', key: 'ANTHROPIC_API_KEY', title: 'Acme pay-per-use key', note: 'For selling Acme.' },
      { id: 'subscription', key: 'CLAUDE_CODE_OAUTH_TOKEN', title: 'Acme plan', note: 'For your own Acme projects.' },
    ],
    login: { title: 'Acme signed in here', note: 'Acme uses the sign-in here.' },
    words: {},
  };
  const step = (more = {}) => ({
    id: 'claude-signin',
    signin: acmeSignin,
    inUse: { uses: 'api-key', line: 'In use: the Acme key.', login: false },
    keys: [keyRow('ANTHROPIC_API_KEY', { set: true, masked: '•••• 1234', source: 'file' }), keyRow('CLAUDE_CODE_OAUTH_TOKEN')],
    ...more,
  });

  it('gives the in-use line and each card with its row, title and note', () => {
    const s = step();
    expect(signinParts(s)).toEqual({
      line: 'In use: the Acme key.',
      cards: [
        { row: s.keys[0], title: 'Acme pay-per-use key', note: 'For selling Acme.' },
        { row: s.keys[1], title: 'Acme plan', note: 'For your own Acme projects.' },
      ],
      login: null,
      switchBack: false,
    });
  });

  it('offers the way back to the key only when inUse says so', () => {
    expect(signinParts(step({ inUse: { uses: 'fallback', line: 'In use: the Acme plan since 14:32.', login: false, switchBack: true } }))).toMatchObject({ line: 'In use: the Acme plan since 14:32.', switchBack: true });
    expect(signinParts(step({ inUse: { uses: 'api-key', line: 'x', login: false, switchBack: false } })).switchBack).toBe(false);
    expect(signinParts(step({ inUse: undefined })).switchBack).toBe(false);
    expect(signinParts(step({ inUse: { uses: 'fallback', line: 'x', login: false, switchBack: 'yes' } })).switchBack).toBe(false);
    expect(SCRIPT).toContain("api('/api/setup/claude/use-key', {})");
  });

  it('matches rows by name, not by place', () => {
    const s = step();
    const reversed = step({ keys: [...s.keys].reverse() });
    const parts = signinParts(reversed);
    expect(parts.cards.map((c) => c.row.name)).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
    expect(parts.cards[0].row.masked).toBe('•••• 1234');
  });

  it('shows the login card only when this computer is signed in', () => {
    expect(signinParts(step()).login).toBeNull();
    expect(signinParts(step({ inUse: undefined })).login).toBeNull();
    expect(signinParts(step({ inUse: { uses: 'login', line: 'x', login: true } })).login).toEqual({ title: 'Acme signed in here', note: 'Acme uses the sign-in here.' });
  });

  it('returns null for a step with no sign-in data', () => {
    expect(signinParts({ id: 'github', keys: [] })).toBeNull();
    expect(signinParts(null)).toBeNull();
  });

  it("holds none of SIGNIN's words, only reads of step.signin and step.inUse", () => {
    const texts = [];
    for (const c of SIGNIN.cards) texts.push(c.title, c.note);
    texts.push(SIGNIN.login.title, SIGNIN.login.note);
    for (const w of Object.values(SIGNIN.words)) texts.push(...w.split(/\{\w+\}/).map((t) => t.trim()).filter((t) => t.length >= 8));
    expect(texts.length).toBeGreaterThan(6);
    for (const text of texts) expect(PAGE, text).not.toContain(text);
    expect(SCRIPT).toContain('step.signin');
    expect(SCRIPT).toContain('step.inUse');
    expect(SCRIPT).toContain('signinParts(s)');
  });
});

// The Jira screens' own functions, lifted out and run on their own with Acme words.
const jiraSigninView = lifted(/function jiraSigninView\(login, words, canChange, startLabel\) \{[\s\S]*?\n {2}\}\n/, 'jiraSigninView');
const previewView = lifted(/function previewView\(preview, words\) \{[\s\S]*?\n {2}\}\n/, 'previewView');
const jqlForProject = lifted(/function jqlForProject\(template, key\) \{[\s\S]*?\n {2}\}\n/, 'jqlForProject');
const projectOfJql = lifted(/function projectOfJql\(jql\) \{[\s\S]*?\n {2}\}\n/, 'projectOfJql');
const shouldPreview = lifted(/function shouldPreview\(jql, lastSent\) \{[\s\S]*?\n {2}\}\n/, 'shouldPreview');
const movesDraft = lifted(/function movesDraft\(events, current, suggested, saved\) \{[\s\S]*?\n {2}\}\n/, 'movesDraft');
const moveOptions = lifted(/function moveOptions\(statuses, value, leave\) \{[\s\S]*?\n {2}\}\n/, 'moveOptions');
const jiraSaveBody = lifted(/function jiraSaveBody\(draft\) \{[\s\S]*?\n {2}\}\n/, 'jiraSaveBody');

describe('the Jira screens', () => {
  const SIGNIN_WORDS = {
    idle: 'Acme is not signed in yet.',
    waiting: 'Approve Acme in the other tab.',
    signedIn: 'Signed in to {site} as {account}.',
    again: 'Sign in to Acme again',
    pickSite: 'Pick the Acme site.',
    localOnly: 'Acme sign-in works on this computer only.',
  };
  const START = 'Sign in to Acme';
  const FILTER_WORDS = { count: 'About {count} issues match. The first ones:', firstOnes: 'The first Acme issues:', none: 'No Acme issue matches.' };
  const EVENTS = [{ id: 'started', label: 'a story starts' }, { id: 'blocked', label: 'a story is blocked' }, { id: 'review', label: 'a review opens' }, { id: 'failed', label: 'a story fails' }, { id: 'shipped', label: 'a story ships' }];

  it('says where the sign-in stands, with its one main action', () => {
    expect(jiraSigninView({ status: 'idle' }, SIGNIN_WORDS, true, START)).toEqual({ line: SIGNIN_WORDS.idle, action: 'start', label: START, sites: [], error: null, note: null });
    expect(jiraSigninView({ status: 'waiting' }, SIGNIN_WORDS, true, START)).toMatchObject({ line: SIGNIN_WORDS.waiting, action: null, error: null });
    expect(jiraSigninView({ status: 'signed-in', site: 'acme.atlassian.net', account: 'Ana' }, SIGNIN_WORDS, true, START))
      .toMatchObject({ line: 'Signed in to acme.atlassian.net as Ana.', action: 'again', label: SIGNIN_WORDS.again });
    const sites = [{ site: 'acme.atlassian.net', name: 'Acme' }, { site: 'acme-labs.atlassian.net', name: 'Acme Labs' }];
    expect(jiraSigninView({ status: 'pick-site', sites }, SIGNIN_WORDS, true, START)).toMatchObject({ line: SIGNIN_WORDS.pickSite, action: null, sites });
    expect(jiraSigninView({ status: 'failed', error: 'Acme refused the sign-in.' }, SIGNIN_WORDS, true, START))
      .toMatchObject({ action: 'start', label: START, error: 'Acme refused the sign-in.' });
    expect(jiraSigninView(null, SIGNIN_WORDS, true, START)).toMatchObject({ line: SIGNIN_WORDS.idle, action: 'start' });
  });

  it('offers no sign-in on a dashboard other computers can reach', () => {
    for (const status of ['idle', 'signed-in', 'failed', 'pick-site']) {
      const v = jiraSigninView({ status, site: 'acme.atlassian.net', account: 'Ana', sites: [{ site: 'acme.atlassian.net', name: 'Acme' }] }, SIGNIN_WORDS, false, START);
      expect(v.action, status).toBeNull();
      expect(v.sites, status).toEqual([]);
      expect(v.note, status).toBe(SIGNIN_WORDS.localOnly);
    }
  });

  it('draws the preview as a caption and rows, in order', () => {
    const issues = [{ key: 'ACME-1', title: 'Add the sign-in page', status: 'To Do' }, { key: 'ACME-2', title: 'Fix the footer', status: 'In Progress' }];
    expect(previewView({ issues, count: 3 }, FILTER_WORDS)).toEqual({ caption: 'About 3 issues match. The first ones:', rows: issues, empty: null });
    expect(previewView({ issues, count: null }, FILTER_WORDS)).toEqual({ caption: FILTER_WORDS.firstOnes, rows: issues, empty: null });
    expect(previewView({ issues: [], count: 0 }, FILTER_WORDS)).toMatchObject({ rows: [], empty: FILTER_WORDS.none });
    expect(previewView({ issues: [{ key: 'ACME-3', title: null, status: null }], count: 1 }, FILTER_WORDS).rows).toEqual([{ key: 'ACME-3', title: '', status: '' }]);
  });

  it('writes the JQL for a project, and reads the project back out of it', () => {
    expect(jqlForProject('project = {key} AND labels = foreman', 'ACME')).toBe('project = ACME AND labels = foreman');
    expect(projectOfJql('project = ACME AND labels = foreman ORDER BY Rank')).toBe('ACME');
    expect(projectOfJql('project="ACME_2" AND labels = foreman')).toBe('ACME_2');
    expect(projectOfJql('labels = x')).toBe('');
    expect(projectOfJql(null)).toBe('');
  });

  it('previews only a filled-in filter that changed', () => {
    expect(shouldPreview('   ', '')).toBe(false);
    expect(shouldPreview('project = ACME ', 'project = ACME')).toBe(false);
    expect(shouldPreview('project = ACME2', 'project = ACME')).toBe(true);
    expect(shouldPreview('project = ACME', null)).toBe(true);
  });

  it('starts the moves from the saved ones, then the suggestions, else leaves them', () => {
    const current = { started: 'Doing' };
    const suggested = { started: 'In Progress', blocked: null, review: 'In Review', failed: null, shipped: 'Done' };
    expect(movesDraft(EVENTS, current, suggested)).toEqual({ started: 'Doing', blocked: '', review: 'In Review', failed: '', shipped: 'Done' });
    expect(movesDraft(EVENTS, undefined, undefined)).toEqual({ started: '', blocked: '', review: '', failed: '', shipped: '' });
  });

  it('never re-suggests an event the owner left where it is once moves were saved', () => {
    expect(movesDraft(EVENTS, { started: 'In Progress', review: 'In Review' }, { started: 'Doing', shipped: 'Done', review: 'In Review' }, true))
      .toEqual({ started: 'In Progress', blocked: '', review: 'In Review', failed: '', shipped: '' });
    expect(movesDraft(EVENTS, {}, { shipped: 'Done' }, true)).toEqual({ started: '', blocked: '', review: '', failed: '', shipped: '' });
    expect(movesDraft(EVENTS, {}, { shipped: 'Done' }, false)).toEqual({ started: '', blocked: '', review: '', failed: '', shipped: 'Done' });
    // The page threads whether moves were ever saved from the server to the draft.
    expect(SCRIPT).toContain('movesDraft(events, d.current, d.suggested, d.saved)');
    expect(SCRIPT).toContain('transitionsSaved');
  });

  it('lists Leave where it is first, then the statuses, keeping a saved name Jira no longer has', () => {
    const statuses = [{ name: 'To Do', category: 'new' }, { name: 'Done', category: 'done' }];
    expect(moveOptions(statuses, 'Done', 'Leave Acme be')).toEqual([{ value: '', label: 'Leave Acme be' }, { value: 'To Do', label: 'To Do' }, { value: 'Done', label: 'Done' }]);
    expect(moveOptions(statuses, 'Ship it', 'Leave Acme be').map((o) => o.value)).toEqual(['', 'To Do', 'Done', 'Ship it']);
    expect(moveOptions(undefined, '', 'Leave Acme be')).toEqual([{ value: '', label: 'Leave Acme be' }]);
  });

  it('sends the trimmed filter and owner label, and only the events that move', () => {
    const draft = { jql: '  project = ACME  ', ownerLabel: ' acme-owner ', moves: { started: 'In Progress', blocked: '', review: '', failed: '', shipped: 'Done' } };
    expect(jiraSaveBody(draft)).toEqual({ jql: 'project = ACME', ownerLabel: 'acme-owner', transitions: { started: 'In Progress', shipped: 'Done' } });
  });

  it("holds none of JIRA_SCREEN's words, only reads of the step's jira data", () => {
    const texts = [];
    const ids = new Set(['part', 'id']);
    const walk = (v, key) => {
      if (typeof v === 'string') {
        if (!ids.has(key)) texts.push(...v.split(/\{\w+\}/).map((t) => t.trim()).filter((t) => t.length >= 8));
      } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(JIRA_SCREEN, '');
    expect(texts).toContain(JIRA_SCREEN.app.callback);
    expect(texts).toContain(JIRA_SCREEN.filter.leave);
    expect(texts.length).toBeGreaterThan(25);
    for (const text of texts) expect(PAGE, text).not.toContain(text);
  });

  it('talks to every Jira set-up route, copies with the clipboard and opens the sign-in safely', () => {
    for (const path of ['/api/setup/jira/login', '/api/setup/jira/site', '/api/setup/jira/projects', '/api/setup/jira/preview', '/api/setup/jira/statuses', '/api/setup/jira/save']) expect(SCRIPT).toContain(path);
    for (const text of ['navigator.clipboard.writeText', 'PREVIEW_WAIT_MS = 800', 'JIRA_POLL_MS = 2000', 'clearTimeout(', 's.jira', 'noopener', "window.open(", 'retryAfter']) expect(SCRIPT).toContain(text);
    expect(SCRIPT).not.toMatch(/innerHTML/);
  });
});

// The notifications screen's own functions, lifted out and run on their own.
const notifyParts = lifted(/function notifyParts\(step\) \{[\s\S]*?\n {2}\}\n/, 'notifyParts');
const notifyResultView = lifted(/function notifyResultView\(result\) \{[\s\S]*?\n {2}\}\n/, 'notifyResultView');
const notifySaveBody = lifted(/function notifySaveBody\(choice\) \{[\s\S]*?\n {2}\}\n/, 'notifySaveBody');
const notifyChoiceShown = (...a) => new Function(SCRIPT.match(/function notifyParts\(step\) \{[\s\S]*?\n {2}\}\n/)[0] + SCRIPT.match(/function notifyChoiceShown\(step, draft\) \{[\s\S]*?\n {2}\}\n/)[0] + '; return notifyChoiceShown;')()(...a);

describe('the notifications screen', () => {
  const step = (notifyConfig) => ({ id: 'notifications', notify: NOTIFY_SCREEN, notifyConfig });

  it('shows the key cards and the send button only for email', () => {
    expect(notifyParts(step({ adapter: 'email-resend', from: null, to: null, notifications: true }))).toEqual({
      choice: 'email-resend', choices: NOTIFY_SCREEN.choices, showCards: true, fromLine: null, toLine: null, canSend: true,
    });
    expect(notifyParts(step({ adapter: 'none', from: null, to: null, notifications: true }))).toMatchObject({ choice: 'none', showCards: false, canSend: false });
    expect(notifyParts(step(null))).toMatchObject({ choice: 'none', showCards: false, canSend: false });
  });

  it("says when foreman.config.json sets the sender or the recipient, in the model's words", () => {
    const v = notifyParts(step({ adapter: 'email-resend', from: 'bot@acme.test', to: 'owner@acme.test', notifications: true }));
    expect(v.fromLine).toBe(NOTIFY_SCREEN.fromConfig.replace('{from}', 'bot@acme.test'));
    expect(v.fromLine.startsWith('foreman.config.json sends from bot@acme.test')).toBe(true);
    expect(v.toLine).toBe(NOTIFY_SCREEN.toConfig.replace('{to}', 'owner@acme.test'));
  });

  it("shows the test's result: ok only when it was sent", () => {
    expect(notifyResultView({ sent: true, outbox: false, to: 'owner@acme.test', detail: 'Sent to owner@acme.test.' })).toEqual({ ok: true, text: 'Sent to owner@acme.test.' });
    expect(notifyResultView({ sent: false, outbox: true, detail: 'Outbox only.' })).toEqual({ ok: false, text: 'Outbox only.' });
    expect(notifyResultView(null)).toEqual({ ok: false, text: '' });
  });

  it('saves the choice as { adapter }', () => {
    expect(notifySaveBody('none')).toEqual({ adapter: 'none' });
    expect(notifySaveBody('email-resend')).toEqual({ adapter: 'email-resend' });
  });

  it('shows the pending choice while a save runs, else the saved one', () => {
    const none = step({ adapter: 'none', from: null, to: null, notifications: true });
    expect(notifyChoiceShown(none, { choice: 'email-resend' })).toBe('email-resend');
    expect(notifyChoiceShown(none, { choice: null })).toBe('none');
    expect(notifyChoiceShown(none, null)).toBe('none');
    expect(notifyChoiceShown(step(null), { choice: '' })).toBe('none');
    expect(notifyChoiceShown(step({ adapter: 'email-resend', from: null, to: null, notifications: true }), { choice: null })).toBe('email-resend');
  });

  it('notifySave keeps the clicked choice until the reload, and drops it on an error', async () => {
    const part = (re) => SCRIPT.match(re)[0];
    // notifySave run against a fake page: renderSetup records the radio it would draw, and
    // loadSetup brings back the saved config.
    const harness = (api) => new Function('api', `
      let notifyDraft = { saving: false, sending: false, lines: [], error: null, result: null, choice: null };
      const step = { id: 'notifications', notify: {}, notifyConfig: { adapter: 'none' } };
      const shown = [];
      const adapters = [];
      let loads = 0;
      function renderSetup() { shown.push(notifyChoiceShown(step, notifyDraft)); adapters.push(step.notifyConfig.adapter); }
      async function loadSetup() { loads += 1; step.notifyConfig = { adapter: 'email-resend' }; renderSetup(); }
      function focusKey() {}
      function say() {}
      ${part(/function notifyParts\(step\) \{[\s\S]*?\n {2}\}\n/)}
      ${part(/function notifyChoiceShown\(step, draft\) \{[\s\S]*?\n {2}\}\n/)}
      ${part(/function notifySaveBody\(choice\) \{[\s\S]*?\n {2}\}\n/)}
      ${part(/async function notifySave\(choice\) \{[\s\S]*?\n {2}\}\n/)}
      return { notifySave, draft: () => notifyDraft, drop: () => { notifyDraft = null; }, shown, adapters, loads: () => loads };
    `)(api);

    const ok = harness(async () => ({ ok: true, lines: ['Saved.'] }));
    await ok.notifySave('email-resend');
    expect(ok.shown).toEqual(['email-resend', 'email-resend', 'email-resend']);
    expect(ok.adapters[0]).toBe('none');
    expect(ok.draft().choice).toBeNull();
    expect(ok.draft().lines).toEqual(['Saved.']);
    expect(ok.loads()).toBe(1);

    const bad = harness(async () => { throw new Error('The dashboard answered 500.'); });
    await bad.notifySave('email-resend');
    expect(bad.shown).toEqual(['email-resend', 'none']);
    expect(bad.draft().choice).toBeNull();
    expect(bad.draft().error).toBe('The dashboard answered 500.');
    expect(bad.loads()).toBe(0);

    // The owner leaves the screen while the save runs: the draft is dropped, and the old one
    // still ends with no pending choice.
    let left = null;
    left = harness(async () => { left.drop(); return { ok: true, lines: ['Saved.'] }; });
    const old = left.draft();
    await expect(left.notifySave('email-resend')).resolves.toBeUndefined();
    expect(left.draft()).toBeNull();
    expect(old.choice).toBeNull();
    expect(left.loads()).toBe(1);
  });

  it('notifyScreen draws the radios from notifyChoiceShown', () => {
    const start = SCRIPT.indexOf('function notifyScreen(s) {');
    expect(start).toBeGreaterThan(-1);
    const body = SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
    expect(body).toContain('notifyChoiceShown(s, d)');
    expect(body).toContain('choice: null');
    expect(body).not.toMatch(/r\.checked = v\.choice/);
  });

  it("talks to both routes, and holds none of NOTIFY_SCREEN's words", () => {
    expect(SCRIPT).toContain("'/api/setup/notify/test'");
    expect(SCRIPT).toContain("'/api/setup/notify/save'");
    expect(SCRIPT).toContain('s.notify');
    for (const text of [NOTIFY_SCREEN.send, NOTIFY_SCREEN.localOnly, NOTIFY_SCREEN.results.sent, NOTIFY_SCREEN.heading, NOTIFY_SCREEN.choices[0].label]) {
      expect(PAGE, text).not.toContain(text);
    }
  });
});

// The Salesforce screen's own functions, lifted out and run on their own.
const sfKeyView = lifted(/function sfKeyView\(key, words, actions, canChange\) \{[\s\S]*?\n {2}\}\n/, 'sfKeyView');
const sfOrgRows = lifted(/function sfOrgRows\(step\) \{[\s\S]*?\n {2}\}\n/, 'sfOrgRows');
const sfConnectBody = lifted(/function sfConnectBody\(draft, words\) \{[\s\S]*?\n {2}\}\n/, 'sfConnectBody');
const sfConnectView = lifted(/function sfConnectView\(result, step\) \{[\s\S]*?\n {2}\}\n/, 'sfConnectView');
const sfFollowUpView = lifted(/function sfFollowUpView\(check, results, words\) \{[\s\S]*?\n {2}\}\n/, 'sfFollowUpView');

describe('the Salesforce screen', () => {
  const MODEL = stepById('sf-orgs');
  const ACME_DEV1_ID = '00D000000000001AAA';
  const ACME_QA_ID = '00D000000000002AAA';
  const result = (name, ok, detail = '') => ({ name, step: 'sf-orgs', ok, level: 'error', detail, checkedAt: TESTED });
  // The sf-orgs step as GET /api/setup answers it, for an Acme project.
  const sfStep = (more = {}) => acmeStep('sf-orgs', 'salesforce', 'broken', {
    ...JSON.parse(JSON.stringify({ checks: MODEL.checks, actions: MODEL.actions, guide: MODEL.guide, salesforce: MODEL.salesforce })),
    salesforceConfig: {
      orgs: [{ alias: 'acme-dev1', orgId: ACME_DEV1_ID, roles: ['build'] }, { alias: 'acme-qa', orgId: ACME_QA_ID, roles: ['stage qa'] }, { alias: 'acme-uat', orgId: null, roles: [] }],
      scratch: false,
      key: { status: 'none' },
    },
    ...more,
  });
  const READY = { status: 'ready', certificate: '-----BEGIN CERTIFICATE-----\nACME\n-----END CERTIFICATE-----\n', fingerprint: 'AA:BB', expires: '2030-01-01T00:00:00.000Z', subject: 'CN=Foreman acme' };

  it("shows the key card's state and buttons, in the model's words", () => {
    const none = sfKeyView({ status: 'none' }, SF_SCREEN, MODEL.actions, true);
    expect(none.state).toBe(SF_SCREEN.none);
    expect(none.buttons.map((b) => b.id)).toEqual(['generate', 'upload']);
    expect(none.buttons[0].label).toBe('Make the key');
    expect(none.buttons[1].label).toBe(SF_SCREEN.upload);
    expect(none.note).toBeNull();

    const ready = sfKeyView(READY, SF_SCREEN, MODEL.actions, true);
    expect(ready.state).toBe(SF_SCREEN.ready.replace('{fingerprint}', 'AA:BB').replace('{expires}', '2030-01-01T00:00:00.000Z'));
    expect(ready.state).toContain('AA:BB');
    expect(ready.buttons.map((b) => b.id)).toEqual(['download', 'replace']);
    expect(ready.buttons.map((b) => b.label)).toEqual([SF_SCREEN.download, SF_SCREEN.replace]);

    for (const key of [{ status: 'none' }, READY]) {
      const remote = sfKeyView(key, SF_SCREEN, MODEL.actions, false);
      expect(remote.buttons).toEqual([]);
      expect(remote.note).toBe(SF_SCREEN.localOnly);
    }
    expect(sfKeyView(null, SF_SCREEN, MODEL.actions, true).state).toBe(SF_SCREEN.none);
  });

  it("gives one row per configured org, its state from the org's own doctor check", () => {
    const step = sfStep({
      results: [
        result('salesforce org acme-dev1 (build)', true, 'sandbox 00D000000000001AAA'),
        result('salesforce org acme-qa (stage qa)', false, 'acme-qa is not signed in'),
        result('salesforce org acme-other (not used)', true, 'sandbox'),
        result('salesforce sf isolation', true, ''),
      ],
    });
    const rows = sfOrgRows(step);
    expect(rows.map((r) => r.alias)).toEqual(['acme-dev1', 'acme-qa', 'acme-uat']);
    expect(rows[0]).toEqual({ alias: 'acme-dev1', orgId: ACME_DEV1_ID, roles: ['build'], state: 'connected', line: SF_SCREEN.rowConnected.replace('{detail}', 'sandbox 00D000000000001AAA') });
    expect(rows[1]).toEqual({ alias: 'acme-qa', orgId: ACME_QA_ID, roles: ['stage qa'], state: 'broken', line: SF_SCREEN.rowBroken.replace('{detail}', 'acme-qa is not signed in') });
    expect(rows[2]).toEqual({ alias: 'acme-uat', orgId: null, roles: [], state: 'untested', line: SF_SCREEN.rowUntested });
    expect(sfOrgRows(sfStep({ salesforceConfig: null }))).toEqual([]);
  });

  it("takes each row's state from its own org check only, not source tracking or a longer alias", () => {
    const ACME_DEV10_ID = '00D000000000010AAA';
    const step = sfStep({
      salesforceConfig: {
        orgs: [{ alias: 'acme-dev1', orgId: ACME_DEV1_ID, roles: ['build'] }, { alias: 'acme-dev10', orgId: ACME_DEV10_ID, roles: ['build'] }, { alias: 'acme-qa', orgId: null, roles: ['stage qa'] }],
        scratch: false,
        key: { status: 'none' },
      },
      // The decoys come first: the row must skip them, not just find its own result before them.
      results: [
        result('salesforce source tracking acme-dev1', false, 'source tracking is off in acme-dev1'),
        result('salesforce org acme-dev10 (build)', false, 'acme-dev10 is not signed in'),
        result('salesforce source tracking acme-qa', true, ''),
        result('salesforce org acme-dev1 (build)', true, 'sandbox 00D000000000001AAA'),
      ],
    });
    expect(sfOrgRows(step)).toEqual([
      { alias: 'acme-dev1', orgId: ACME_DEV1_ID, roles: ['build'], state: 'connected', line: SF_SCREEN.rowConnected.replace('{detail}', 'sandbox 00D000000000001AAA') },
      { alias: 'acme-dev10', orgId: ACME_DEV10_ID, roles: ['build'], state: 'broken', line: SF_SCREEN.rowBroken.replace('{detail}', 'acme-dev10 is not signed in') },
      { alias: 'acme-qa', orgId: null, roles: ['stage qa'], state: 'untested', line: SF_SCREEN.rowUntested },
    ]);
  });

  it('sends only the alias, username, consumer key and a login URL that is not the default', () => {
    const draft = { alias: 'acme-dev1', username: '  admin@acme-dev1.acme.example ', clientId: ' 3MVG9Acme ', instanceUrl: SF_SCREEN.defaultInstanceUrl, busy: true, result: { ok: true }, extra: 'acme' };
    expect(sfConnectBody(draft, SF_SCREEN)).toEqual({ alias: 'acme-dev1', username: 'admin@acme-dev1.acme.example', clientId: '3MVG9Acme' });
    expect(sfConnectBody({ ...draft, instanceUrl: '   ' }, SF_SCREEN)).toEqual({ alias: 'acme-dev1', username: 'admin@acme-dev1.acme.example', clientId: '3MVG9Acme' });
    expect(sfConnectBody({ ...draft, instanceUrl: ` ${SF_SCREEN.defaultInstanceUrl} ` }, SF_SCREEN)).not.toHaveProperty('instanceUrl');
    expect(sfConnectBody({ ...draft, instanceUrl: ' https://acme--dev1.sandbox.my.salesforce.com ' }, SF_SCREEN)).toEqual({
      alias: 'acme-dev1', username: 'admin@acme-dev1.acme.example', clientId: '3MVG9Acme', instanceUrl: 'https://acme--dev1.sandbox.my.salesforce.com',
    });
  });

  it('shows a connected org with its org ID and what to do next', () => {
    const v = sfConnectView({ ok: true, status: 'connected', alias: 'acme-dev1', orgId: ACME_DEV1_ID }, sfStep());
    expect(v.ok).toBe(true);
    expect(v.text).toContain(ACME_DEV1_ID);
    expect(v.text).toContain(SF_SCREEN.testNext);
    expect(v.text.startsWith(SF_SCREEN.connected.replace('{orgId}', ACME_DEV1_ID))).toBe(true);
    expect(v).toMatchObject({ guide: null, openStep: null, field: null, update: null });
  });

  it.each(Object.keys(SF_ERRORS))('points a failed connect (%s) at the guide entry or the step that fixes it', (code) => {
    const entry = SF_ERRORS[code];
    const error = typeof entry.words === 'function' ? entry.words({ alias: 'acme-dev1', home: '/acme/sf-home', loggedOut: true }) : entry.words;
    const answer = { ok: false, status: 'failed', alias: 'acme-dev1', code, error, ...(entry.guide ? { guide: entry.guide } : {}), ...(entry.field ? { field: entry.field } : {}) };
    const v = sfConnectView(answer, sfStep());
    expect(v.ok).toBe(false);
    expect(v.text).toBe(error);
    const at = MODEL.guide.findIndex((g) => g.id === entry.guide);
    if (!entry.guide) {
      expect(v.guide).toBeNull();
      expect(v.openStep).toBeNull();
    } else if (at !== -1) {
      expect(v.guide).toEqual({ n: at + 1, id: entry.guide });
      expect(v.openStep).toBeNull();
    } else {
      expect(stepById(entry.guide)).toBeDefined();
      expect(v.openStep).toBe(entry.guide);
      expect(v.guide).toBeNull();
    }
    expect(v.field).toBe(entry.field ?? null);
    expect(v.update).toBeNull();
  });

  it('says production is refused, and offers nothing to save', () => {
    const v = sfConnectView({ ok: false, status: 'refused', alias: 'acme-dev1', code: 'production', error: SF_ERRORS.production.words({ alias: 'acme-dev1', home: '/acme/sf-home', loggedOut: true }), guide: 'connect' }, sfStep());
    expect(v.ok).toBe(false);
    expect(v.text).toContain('never connects to production');
    expect(v.guide).toEqual({ n: MODEL.guide.findIndex((g) => g.id === 'connect') + 1, id: 'connect' });
    expect(v.update).toBeNull();
  });

  it('offers to save an org ID that differs', () => {
    const answer = { ok: false, status: 'org-id-differs', alias: 'acme-dev1', orgId: '00D000000000042AAA', configured: ACME_DEV1_ID, update: { alias: 'acme-dev1', orgId: '00D000000000042AAA' }, error: 'acme-dev1 is org 00D000000000042AAA.' };
    const v = sfConnectView(answer, sfStep());
    expect(v.ok).toBe(false);
    expect(v.text).toBe('acme-dev1 is org 00D000000000042AAA.');
    expect(v.update).toEqual({ alias: 'acme-dev1', orgId: '00D000000000042AAA' });
  });

  it("verifies a Setup-only follow-up by its doctor check", () => {
    const check = 'salesforce source tracking';
    expect(sfFollowUpView(check, [], SF_SCREEN)).toEqual({ state: 'untested', text: SF_SCREEN.followUntested });
    expect(sfFollowUpView(check, [result('salesforce source tracking-acme', false, 'other')], SF_SCREEN).state).toBe('untested');
    expect(sfFollowUpView(check, [result('salesforce source tracking acme-dev1', true), result('salesforce source tracking acme-dev2', true)], SF_SCREEN)).toEqual({ state: 'done', text: SF_SCREEN.followDone });
    const not = sfFollowUpView(check, [result('salesforce source tracking acme-dev2', true), result('salesforce source tracking acme-dev1', false, 'source tracking is off in acme-dev1')], SF_SCREEN);
    expect(not).toEqual({ state: 'not', text: SF_SCREEN.followNot.replace('{detail}', 'source tracking is off in acme-dev1') });
  });

  it("numbers every guide entry of the model, with its id, click path and check", () => {
    const guide = setupGuide(sfStep());
    expect(guide).toHaveLength(MODEL.guide.length);
    MODEL.guide.forEach((g, i) => {
      expect(guide[i]).toEqual({ n: i + 1, id: g.id, text: g.text, click: g.click ? g.click.join(' › ') : null, check: g.check ?? null });
    });
    expect(guide.find((g) => g.id === 'source-tracking').check).toBe('salesforce source tracking');
  });

  it("takes its words and guide from the model, and talks to the Salesforce routes", () => {
    for (const text of ['External Client App', 'Permitted Users', 'Dev Hub', 'salesforce.com']) expect(SCRIPT, text).not.toContain(text);
    for (const text of [SF_SCREEN.replaceWarn, SF_SCREEN.connecting, SF_SCREEN.localOnly, SF_SCREEN.followUntested]) expect(PAGE, text).not.toContain(text);
    for (const path of ['/api/setup/salesforce/key', '/api/setup/salesforce/connect', '/api/setup/salesforce/org-id']) expect(SCRIPT).toContain(`'${path}'`);
    expect(SCRIPT).toContain('s.salesforce');
    expect(SCRIPT).toContain('URL.createObjectURL(new Blob([');
    expect(SCRIPT).toContain("'setup-guide-' + g.id");
    expect(SCRIPT).toContain('sfLeft();');
  });
});

// The Gearset screen's own functions, lifted out and run on their own.
const gearsetRows = lifted(/function gearsetRows\(read, step\) \{[\s\S]*?\n {2}\}\n/, 'gearsetRows');
const gearsetTestLine = lifted(/function gearsetTestLine\(stageName, step\) \{[\s\S]*?\n {2}\}\n/, 'gearsetTestLine');
const gearsetSaveBody = lifted(/function gearsetSaveBody\(choice\) \{[\s\S]*?\n {2}\}\n/, 'gearsetSaveBody');
const gearsetConfirmBody = lifted(/function gearsetConfirmBody\(stage, yes\) \{[\s\S]*?\n {2}\}\n/, 'gearsetConfirmBody');

describe('the Gearset screen', () => {
  const QA_ID = '00D000000000002AAA';
  const UAT_ID = '00D000000000003AAA';
  const CONFIRMED_AT = '2026-10-22T08:30:00.000Z';
  const step = ({ stages, confirmed = {} } = {}) => ({
    id: 'sf-gearset',
    gearset: GEARSET_SCREEN,
    gearsetConfig: { pipelineId: 'pipe-1', stages: [{ name: 'qa', org: 'acme-qa', orgId: QA_ID }, { name: 'uat', org: 'acme-uat', orgId: UAT_ID }], confirmed },
    results: stages ? [{ name: 'salesforce gearset ci tests', step: 'sf-gearset', ok: true, level: 'error', detail: '', stages }] : [],
  });
  const row = (over) => ({ name: 'QA', gearsetStage: 'Integration', targetOrgId: QA_ID, environmentId: 'env-qa', alias: 'acme-qa', stage: 'qa', ciJob: 'enabled', flag: null, ...over });

  it("draws each row, its flag line and the missing lines in s.gearset's words", () => {
    const read = {
      ok: true,
      rows: [row(), row({ name: 'Scratch', targetOrgId: '00D000000000098AAA', alias: null, stage: null, ciJob: 'off', flag: 'unmatched' }), row({ name: 'Live', gearsetStage: 'Production', alias: null, stage: null, ciJob: 'none', flag: 'production' })],
      missing: ['uat'],
    };
    const v = gearsetRows(read, step());
    expect(v.rows).toEqual([
      { name: 'QA', gearsetStage: 'Integration', org: 'acme-qa', stage: 'qa', ciJob: GEARSET_SCREEN.ciJob.enabled, flag: null },
      { name: 'Scratch', gearsetStage: 'Integration', org: '00D000000000098AAA', stage: '', ciJob: GEARSET_SCREEN.ciJob.off, flag: GEARSET_SCREEN.flags.unmatched },
      { name: 'Live', gearsetStage: 'Production', org: QA_ID, stage: '', ciJob: GEARSET_SCREEN.ciJob.none, flag: GEARSET_SCREEN.flags.production },
    ]);
    expect(v.missing).toEqual([GEARSET_SCREEN.missing.replace('{org}', `acme-uat (${UAT_ID})`).replace('{stage}', 'uat')]);
    expect(gearsetRows(null, step())).toEqual({ rows: [], missing: [] });
    expect(gearsetRows({ ok: false, error: 'x' }, step())).toEqual({ rows: [], missing: [] });
  });

  it('says Foreman checked the test level when the last deploy ran tests, with no button', () => {
    const v = gearsetTestLine('qa', step({ stages: [{ name: 'qa', state: 'ran', tests: 14 }] }));
    expect(v).toEqual({ state: 'checked', text: GEARSET_SCREEN.testsChecked.replace('{tests}', '14').replace('{stage}', 'qa'), button: null });
  });

  it('says no tests ran, with no confirm button, even when confirmed before', () => {
    const v = gearsetTestLine('qa', step({ stages: [{ name: 'qa', state: 'none', tests: 0 }], confirmed: { qa: CONFIRMED_AT } }));
    expect(v).toEqual({ state: 'none', text: GEARSET_SCREEN.testsNone.replace('{stage}', 'qa'), button: null });
  });

  it('shows the confirmation with its date and Undo when the check cannot say', () => {
    for (const stages of [undefined, [{ name: 'qa', state: 'unknown', tests: null }], [{ name: 'qa', state: 'no-deploy', tests: null }]]) {
      const v = gearsetTestLine('qa', step({ stages, confirmed: { qa: CONFIRMED_AT } }));
      expect(v).toEqual({ state: 'confirmed', text: GEARSET_SCREEN.confirmedByYou.replace('{date}', '2026-10-22'), button: { label: GEARSET_SCREEN.unconfirm, confirmed: false } });
    }
  });

  it('asks the owner to confirm otherwise', () => {
    const v = gearsetTestLine('uat', step({ stages: [{ name: 'qa', state: 'ran', tests: 3 }], confirmed: { qa: CONFIRMED_AT } }));
    expect(v).toEqual({ state: 'unknown', text: GEARSET_SCREEN.testsUnknown, button: { label: GEARSET_SCREEN.confirm, confirmed: true } });
    expect(gearsetTestLine('qa', { gearset: GEARSET_SCREEN })).toMatchObject({ state: 'unknown' });
  });

  it('builds the request bodies', () => {
    expect(gearsetSaveBody('pipe-1')).toEqual({ pipelineId: 'pipe-1' });
    expect(gearsetConfirmBody('qa', true)).toEqual({ stage: 'qa', confirmed: true });
    expect(gearsetConfirmBody('qa', false)).toEqual({ stage: 'qa', confirmed: false });
  });

  it("talks to the three Gearset routes, and holds none of GEARSET_SCREEN's sentences", () => {
    for (const path of ['/api/setup/gearset/read', '/api/setup/gearset/save', '/api/setup/gearset/confirm']) expect(SCRIPT).toContain(`'${path}'`);
    expect(SCRIPT).toContain('s.gearset');
    expect(SCRIPT).toContain('gearsetScreen(s)');
    const sentences = [GEARSET_SCREEN.heading, GEARSET_SCREEN.flags.unmatched, GEARSET_SCREEN.flags.production, GEARSET_SCREEN.testsUnknown, GEARSET_SCREEN.confirm, GEARSET_SCREEN.picker.noPipelines, GEARSET_SCREEN.picker.pickFirst, GEARSET_SCREEN.errors.tokenFirst];
    for (const text of sentences) expect(PAGE, text).not.toContain(text);
    for (const text of ['Edit CI job', 'RunLocalTests', 'Apex tests ran']) expect(SCRIPT, text).not.toContain(text);
  });
});

// The Cloud runner screen's own functions, lifted out and run on their own.
const cloudSecretRows = lifted(/function cloudSecretRows\(list, step\) \{[\s\S]*?\n {2}\}\n/, 'cloudSecretRows');
const cloudMissingLines = lifted(/function cloudMissingLines\(missing, step\) \{[\s\S]*?\n {2}\}\n/, 'cloudMissingLines');
const cloudSecretsBody = lifted(/function cloudSecretsBody\(token\) \{[\s\S]*?\n {2}\}\n/, 'cloudSecretsBody');
const cloudRunnerBody = lifted(/function cloudRunnerBody\(token\) \{[\s\S]*?\n {2}\}\n/, 'cloudRunnerBody');
const cloudParts = lifted(/function cloudParts\(step, mode\) \{[\s\S]*?\n {2}\}\n/, 'cloudParts');

describe('the Cloud runner screen', () => {
  const config = (over = {}) => ({
    mode: null,
    stateBranch: true,
    workflow: { exists: false, current: false },
    runnerFile: { file: '.env.runner', exists: false, ignored: 'ignored' },
    repo: 'acme/app',
    names: {
      token: 'FOREMAN_GH_TOKEN',
      signIn: [{ name: 'ANTHROPIC_API_KEY', stored: true, step: 'claude-signin' }, { name: 'CLAUDE_CODE_OAUTH_TOKEN', stored: false, step: 'claude-signin' }],
      keys: [{ name: 'RESEND_API_KEY', stored: false, step: 'notifications' }],
      runner: [{ name: 'FOREMAN_DASHBOARD_TOKEN', stored: false, step: 'project-keys' }, { name: 'RESEND_API_KEY', stored: false, step: 'notifications' }],
    },
    dockerRun: 'docker run -d --name foreman acme-image',
    ...over,
  });
  const step = (over) => ({ id: 'cloud-runner', cloud: CLOUD_SCREEN, cloudConfig: config(over) });

  it('draws only the choice when the mode is null', () => {
    const v = cloudParts(step(), null);
    expect(v).toEqual({ mode: null, modes: CLOUD_SCREEN.modes, parts: [], guide: [] });
  });

  it("draws Actions' parts, the state line only while the state is in files, and its guide entries", () => {
    expect(cloudParts(step(), 'actions')).toEqual({ mode: 'actions', modes: CLOUD_SCREEN.modes, parts: ['workflow', 'token', 'secrets'], guide: CLOUD_SCREEN.guides.actions });
    expect(cloudParts(step({ stateBranch: false }), 'actions').parts).toEqual(['state-branch', 'workflow', 'token', 'secrets']);
  });

  it("draws the container's parts, the ignore line only while git does not ignore the file", () => {
    expect(cloudParts(step(), 'container')).toEqual({ mode: 'container', modes: CLOUD_SCREEN.modes, parts: ['token', 'runner-file', 'docker-run', 'check'], guide: CLOUD_SCREEN.guides.container });
    expect(cloudParts(step({ runnerFile: { file: '.env.runner', exists: false, ignored: 'not-ignored' } }), 'container').parts).toEqual(['token', 'runner-file', 'ignore', 'docker-run', 'check']);
    expect(cloudParts(step(), 'elsewhere').parts).toEqual([]);
  });

  it("gives one row per secret in CLOUD_SCREEN's words", () => {
    const list = { ok: true, repo: 'acme/app', rows: [{ name: 'FOREMAN_GH_TOKEN', set: true, stored: false }, { name: 'ANTHROPIC_API_KEY', set: false, stored: true }], missing: [] };
    expect(cloudSecretRows(list, step())).toEqual([
      { name: 'FOREMAN_GH_TOKEN', github: CLOUD_SCREEN.secrets.yes, stored: CLOUD_SCREEN.secrets.no },
      { name: 'ANTHROPIC_API_KEY', github: CLOUD_SCREEN.secrets.no, stored: CLOUD_SCREEN.secrets.yes },
    ]);
    expect(cloudSecretRows(null, step())).toEqual([]);
    expect(cloudSecretRows({ ok: false, error: 'x' }, step())).toEqual([]);
  });

  it('says what is missing, and where each name is saved, linking to its step', () => {
    const lines = cloudMissingLines(['FOREMAN_GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'FOREMAN_DASHBOARD_TOKEN', 'RESEND_API_KEY'], step());
    expect(lines).toEqual([
      { text: CLOUD_SCREEN.missing.replace('{names}', 'FOREMAN_GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, FOREMAN_DASHBOARD_TOKEN, RESEND_API_KEY'), step: null },
      { text: CLOUD_SCREEN.saveFirst.replace('{name}', 'CLAUDE_CODE_OAUTH_TOKEN'), step: 'claude-signin' },
      { text: CLOUD_SCREEN.saveFirst.replace('{name}', 'FOREMAN_DASHBOARD_TOKEN'), step: 'project-keys' },
      { text: CLOUD_SCREEN.saveFirst.replace('{name}', 'RESEND_API_KEY'), step: 'notifications' },
    ]);
    expect(cloudMissingLines([], step())).toEqual([]);
    expect(cloudMissingLines(null, step())).toEqual([]);
  });

  it('sends the token only when one was typed, trimmed', () => {
    expect(cloudSecretsBody(' ghp_acme123 ')).toEqual({ ghToken: 'ghp_acme123' });
    expect(cloudSecretsBody('')).toEqual({});
    expect(cloudSecretsBody('   ')).toEqual({});
    expect(cloudRunnerBody('ghp_acme123')).toEqual({ ghToken: 'ghp_acme123' });
    expect(cloudRunnerBody(undefined)).toEqual({});
  });

  it('never prefills the token field, and clears it after each request', () => {
    const src = SCRIPT.match(/function cloudTokenInput\(\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(src).toContain("input.type = 'password'");
    expect(src.match(/\.value\s*=(?!=)/g) ?? []).toEqual([]);
    const clear = SCRIPT.match(/function cloudTakeToken\(\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(clear).toContain("cloudToken.value = ''");
    for (const fn of ['cloudSetSecrets', 'cloudWriteRunner']) {
      const body = SCRIPT.match(new RegExp(`async function ${fn}\\(\\) \\{[\\s\\S]*?\\n {2}\\}\\n`))[0];
      expect(body, fn).toContain('cloudTakeToken()');
    }
  });

  it("talks to the cloud routes, and holds none of CLOUD_SCREEN's sentences", () => {
    for (const path of ['/api/setup/cloud/state', '/api/setup/cloud/workflow', '/api/setup/cloud/secrets', '/api/setup/cloud/secrets/set', '/api/setup/cloud/runner-file', '/api/setup/cloud/runner-file/ignore', '/api/setup/cloud/check']) {
      expect(SCRIPT).toContain(`'${path}'`);
    }
    expect(SCRIPT).toContain('s.cloud');
    expect(SCRIPT).toContain('cloudScreen(s)');
    expect(SCRIPT).toContain('cloudLeft();');
    const sentences = [CLOUD_SCREEN.heading, CLOUD_SCREEN.token.note, CLOUD_SCREEN.localOnly, CLOUD_SCREEN.stateBranch.line, CLOUD_SCREEN.workflow.commit, CLOUD_SCREEN.modes[0].label, CLOUD_SCREEN.errors.tokenRefused];
    for (const text of sentences) expect(PAGE, text).not.toContain(text);
    for (const text of ['Personal access tokens', 'foreman-runner', 'docker run']) expect(SCRIPT, text).not.toContain(text);
  });
});

const projectPrefill = lifted(/function projectPrefill\(detected\) \{[\s\S]*?\n {2}\}\n/, 'projectPrefill');
const projectFields = lifted(/function projectFields\(form, source\) \{[\s\S]*?\n {2}\}\n/, 'projectFields');
const projectAnswers = lifted(/function projectAnswers\(draft\) \{[\s\S]*?\n {2}\}\n/, 'projectAnswers');

// An Acme POST /api/setup/project/detect body.
const ACME_DETECT = {
  suggested: {
    version: 1,
    project: { name: 'acme-shop' },
    install: { run: 'npm ci', when: 'package-lock.json', creates: 'node_modules' },
    checks: [{ run: 'npm test', when: 'always' }],
    stories: { adapter: 'markdown', dir: 'docs/stories' },
    ship: { steps: ['push', 'pr', 'merge'], ci: { required: ['Unit tests', 'lint'] } },
  },
  found: { ciJobs: ['Unit tests', 'lint'], storySourceHint: 'markdown', storiesDir: 'docs/stories' },
};

describe('the "This project" form', () => {
  it('fills the answers from the detection, with every CI job ticked', () => {
    expect(projectPrefill(ACME_DETECT)).toEqual({
      answers: { name: 'acme-shop', source: 'markdown', dir: 'docs/stories', site: '', jql: '', check: 'npm test', ci: ['Unit tests', 'lint'] },
      jobs: ['Unit tests', 'lint'],
    });
    const unknown = { ...ACME_DETECT, found: { ...ACME_DETECT.found, storySourceHint: 'unknown' } };
    expect(projectPrefill(unknown).answers.source).toBe('');
    const { checks, ...noChecks } = ACME_DETECT.suggested;
    expect(projectPrefill({ ...ACME_DETECT, suggested: noChecks }).answers.check).toBe('');
    expect(projectPrefill({}).answers).toMatchObject({ name: '', source: '', check: '', ci: [] });
  });

  it("shows the source's own fields only", () => {
    const ids = (source) => projectFields(PROJECT_FORM, source).map((f) => f.id);
    expect(ids('markdown')).toEqual(['name', 'source', 'dir', 'check', 'ci']);
    expect(ids('jira')).toEqual(['name', 'source', 'site', 'jql', 'check', 'ci']);
    expect(ids('')).toEqual(['name', 'source', 'check', 'ci']);
  });

  it("sends only the chosen source's answers, and the ticked jobs in their order", () => {
    const draft = {
      answers: { name: 'Acme', source: 'markdown', dir: 'stories', site: 'acme.atlassian.net', jql: 'project = ACME', check: 'npm test', ci: ['lint', 'Unit tests'] },
      jobs: ['Unit tests', 'lint', 'e2e'],
    };
    expect(projectAnswers(draft)).toEqual({ name: 'Acme', source: 'markdown', dir: 'stories', check: 'npm test', ci: ['Unit tests', 'lint'] });
    const jira = projectAnswers({ ...draft, answers: { ...draft.answers, source: 'jira' } });
    expect(jira).toEqual({ name: 'Acme', source: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME', check: 'npm test', ci: ['Unit tests', 'lint'] });
  });

  it('detects, runs the check and saves through the set-up API, with no markup from text', () => {
    expect(SCRIPT).toContain("api('/api/setup/project/detect'");
    expect(SCRIPT).toContain("'/api/setup/project/check-run'");
    expect(SCRIPT).toContain("'/api/setup/project/write'");
    expect(SCRIPT).toContain('answers:');
    expect(SCRIPT).toContain('setup.hasConfig === false');
    expect(SCRIPT).not.toMatch(/innerHTML/);
    expect(PAGE).toMatch(/\.stail\{[^}]*overflow-wrap:anywhere/);
    expect(PAGE).toMatch(/#view-setup input[^{]*\{[^}]*min-height:44px/);
  });

  // A foreman.config.json that does not load: its errors over the form, which replaces it.
  const brokenConfig = lifted(/function brokenConfig\(setup\) \{[\s\S]*?\n {2}\}\n/, 'brokenConfig');
  it('knows a config that does not load from the set-up answer', () => {
    expect(brokenConfig({ configErrors: ['x'] })).toBe(true);
    for (const setup of [{ configErrors: [] }, { configErrors: null }, {}, null]) expect(brokenConfig(setup)).toBe(false);
  });
  it('shows the form, with the errors, while the config does not load', () => {
    expect(SCRIPT).toContain('setup.hasConfig === false || brokenConfig(setup)');
    expect(SCRIPT).toContain('configErrors');
  });
});

describe('help text', () => {
  const helpFor = lifted(/function helpFor\(help, kind, key, own\) \{[\s\S]*?\n {2}\}\n/, 'helpFor');
  const helpParts = lifted(/function helpParts\(h, base, existing\) \{[\s\S]*?\n {2}\}\n/, 'helpParts');
  const HELP = {
    decision: { Drop: { hint: 'Drops the story.', more: 'Closes its pull requests.' } },
    slot: { park: { hint: 'Parks the slot.', more: 'It picks up nothing.' } },
    control: { pause: { hint: 'Pauses.', more: 'Slots finish first.' } },
  };

  it("a button's hint comes from help.mjs, else the option's own hint, else none", () => {
    expect(helpFor(HELP, 'decision', 'Drop', 'Own words.')).toEqual(HELP.decision.Drop);
    expect(helpFor(HELP, 'slot', 'park')).toEqual(HELP.slot.park);
    expect(helpFor(HELP, 'decision', 'Something new', ' Picks it. ')).toEqual({ hint: 'Picks it.', more: 'Picks it.' });
    expect(helpFor(HELP, 'decision', 'Something new', '')).toBeNull();
    expect(helpFor(HELP, 'decision', 'Something new', '   ')).toBeNull();
    expect(helpFor(HELP, 'decision', 'Something new')).toBeNull();
    expect(helpFor(HELP, 'decision', 'Something new', 42)).toBeNull();
    expect(helpFor(HELP, 'slot', 'fly', 'x')).toBeNull();
    expect(helpFor(HELP, 'control', 'fly')).toBeNull();
    expect(() => helpFor(null, 'decision', 'Drop')).not.toThrow();
    expect(helpFor(null, 'decision', 'Drop')).toBeNull();
    expect(helpFor(HELP, 'slot', '__proto__')).toBeNull();
    expect(helpFor(HELP, '__proto__', 'x')).toBeNull();
    expect(helpFor(HELP, 'decision', 'constructor')).toBeNull();
  });

  it("a Decisions card's option hint comes from its own hints, by index", () => {
    const cardSrc = SCRIPT.match(/function decisionCard\(it\) \{[\s\S]*?\n {2}\}\n/)[0];
    const helpSrc = SCRIPT.match(/function helpFor\(help, kind, key, own\) \{[\s\S]*?\n {2}\}\n/)[0];
    // Only the open card with options is drawn; its click handlers never run.
    const harness = new Function('input', `
      const help = input.help, drafts = {}, changing = new Set(), busy = new Set();
      const canAct = () => true, when = () => '';
      const seen = [];
      const el = (tag, cls, text) => ({ dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, textContent: text });
      const withHelp = (control, h, key) => { seen.push({ key, h }); return control; };
      ${helpSrc}
      ${cardSrc}
      decisionCard(input.it);
      return seen;
    `);
    const item = { id: 'd-1', kind: 'decision', title: 'Shop name', story: 'ACME-1', body: 'Pick the shop name.', options: ['Keep', 'Rename', 'Ask'], hints: ['Keeps Acme.', 'Renames the shop.', 'Asks the team.'] };
    const help = { decision: {}, form: {} };
    const options = (seen) => seen.filter((s) => /:opt:\d$/.test(s.key));

    expect(options(harness({ it: item, help }))).toEqual([
      { key: 'dec:d-1:opt:0', h: { hint: 'Keeps Acme.', more: 'Keeps Acme.' } },
      { key: 'dec:d-1:opt:1', h: { hint: 'Renames the shop.', more: 'Renames the shop.' } },
      { key: 'dec:d-1:opt:2', h: { hint: 'Asks the team.', more: 'Asks the team.' } },
    ]);
    const { hints, ...bare } = item;
    expect(options(harness({ it: bare, help })).map((s) => s.h)).toEqual([null, null, null]);
  });

  it('the answer form\'s save button says Save answer for any item with options, and Mark done only for a task without', () => {
    const cardSrc = SCRIPT.match(/function decisionCard\(it\) \{[\s\S]*?\n {2}\}\n/)[0];
    const helpSrc = SCRIPT.match(/function helpFor\(help, kind, key, own\) \{[\s\S]*?\n {2}\}\n/)[0];
    const harness = new Function('input', `
      const help = input.help, drafts = {}, changing = new Set(input.changing || []), busy = new Set();
      const canAct = () => true, when = () => '';
      const seen = [];
      const el = (tag, cls, text) => ({ dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, textContent: text });
      const withHelp = (control, h, key) => { seen.push({ key, h, text: control.textContent }); return control; };
      ${helpSrc}
      ${cardSrc}
      decisionCard(input.it);
      return seen;
    `);
    const help = { decision: {}, form: { 'save-answer': { hint: 'Saves.', more: 'Saves.' }, 'mark-done': { hint: 'Done.', more: 'Done.' } } };
    const saveOf = (it, changing) => harness({ it, help, changing }).find((s) => s.key === 'dec:' + it.id + ':save');
    const task = { id: 't-1', kind: 'task', title: 'Fix the shop key', story: 'ACME-1', body: 'The key failed.', options: ['Retry the story', 'Close the task'], hints: ['Runs it again.', 'Closes it.'] };

    const open = saveOf(task);
    expect(open.text).toBe('Save answer');
    expect(open.h).toEqual(help.form['save-answer']);

    const answered = { ...task, answer: { option: 'Retry the story', note: 'go' } };
    const reopened = saveOf(answered, ['t-1']);
    expect(reopened.text).toBe('Save answer');
    expect(reopened.h).toEqual(help.form['save-answer']);

    const withOptions = saveOf({ id: 'd-1', kind: 'decision', title: 'Shop name', options: ['Keep', 'Rename'] });
    expect(withOptions.text).toBe('Save answer');
    expect(withOptions.h).toEqual(help.form['save-answer']);

    const free = saveOf({ id: 'd-2', kind: 'decision', title: 'Shop motto' });
    expect(free.text).toBe('Save answer');
    expect(free.h).toEqual(help.form['save-answer']);

    const old = saveOf({ id: 't-2', kind: 'task', title: 'Old task', options: [] });
    expect(old.text).toBe('Mark done');
    expect(old.h).toEqual(help.form['mark-done']);
  });

  it('ties the hint and the tooltip to the control by safe ids', () => {
    expect(helpParts(null, 'help-x', '')).toBeNull();
    const h = { hint: 'a.', more: 'b' };
    expect(helpParts(h, 'help-wait-task-ACME-3-done', '')).toEqual({ hintId: 'help-wait-task-ACME-3-done-hint', tipId: 'help-wait-task-ACME-3-done-tip', describedBy: 'help-wait-task-ACME-3-done-hint help-wait-task-ACME-3-done-tip' });
    expect(helpParts(h, 'help-k', 'own-hint help-k-tip').describedBy).toBe('own-hint help-k-tip help-k-hint');
    expect(SCRIPT).toContain("'help-' + String(key).replace(/[^A-Za-z0-9_-]/g, '-')");
  });

  it('is wired into the page', () => {
    expect(SCRIPT).toContain("api('/api/help')");
    for (const fn of ['slotButton(s, action)', 'waitingCard(it, i)', 'decisionCard(it)']) {
      const start = SCRIPT.indexOf(`function ${fn} {`);
      expect(start, fn).toBeGreaterThan(-1);
      const body = SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
      expect(body, fn).toContain('withHelp(');
    }
    // A setting's help is its info button; the save buttons are described by shared hidden texts.
    const start = SCRIPT.indexOf('function settingRow(s) {');
    expect(start).toBeGreaterThan(-1);
    const row = SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
    expect(row).toContain('infoButton(');
    expect(row).not.toContain('withHelp(');
    expect(SCRIPT).toContain("'park-after'");
    expect(SCRIPT).toContain("'tipoff'");
    expect(SCRIPT).toContain('focusin');
    expect(PAGE).toContain('aria-describedby="pause-note pause-tip"');
    expect(PAGE).toContain('aria-describedby="fixed-note fixed-tip"');
    expect(PAGE).toContain('aria-describedby="next-note next-tip"');
    expect(PAGE).toContain('id="workers-tip"');
    expect(PAGE).toContain('role="tooltip"');
  });

  it('shows the tooltip as a popup by its control, and hides an empty one', () => {
    // Closed it takes no room; open it is a popover in the top layer, which moves nothing and
    // lets clicks through to the button under it.
    expect(PAGE).toMatch(/\n\.tip\{display:none\}/);
    const open = PAGE.match(/\.tip:popover-open\{([^}]*)\}/)?.[1] ?? '';
    expect(open).toContain('position:fixed');
    expect(open).toContain('pointer-events:none');
    expect(open).toContain('animation:ifade');
    expect(PAGE).toContain('.tip.held:popover-open{animation:none}');
    expect(PAGE).toContain('.tip:empty');
    expect(PAGE).toMatch(/body\.tipoff \.tip\{display:none!important\}/);
    expect(PAGE).toMatch(/prefers-reduced-motion: reduce\)\{[\s\S]*?\.tip:popover-open\{animation:none\}/);
    // No hover rule: the popup is opened from the script, so it never folds into the flow.
    expect(PAGE).not.toMatch(/\.hl:hover>\.tip/);
  });

  it('places the popup above its control, below when there is no room, inside the screen', () => {
    const fn = SCRIPT.match(/function placeTip\(anchor, pop, view\) \{[\s\S]*?\n {2}\}\n/)[0];
    const placeTip = new Function(`${fn}; return placeTip;`)();
    const view = { width: 1200, height: 800 };
    const a = { left: 100, top: 400, bottom: 430 };
    expect(placeTip(a, { height: 60 }, view)).toEqual({ left: 100, top: 334, width: 280, above: true });
    // No room above: below, with the gap.
    expect(placeTip({ left: 100, top: 40, bottom: 70 }, { height: 60 }, view)).toEqual({ left: 100, top: 76, width: 280, above: false });
    // Near the right edge it is pulled in; on a narrow screen it is the screen less 16.
    expect(placeTip({ left: 1100, top: 400, bottom: 430 }, { height: 60 }, view).left).toBe(912);
    expect(placeTip({ left: 20, top: 400, bottom: 430 }, { height: 60 }, { width: 200, height: 800 })).toMatchObject({ left: 8, width: 184 });
  });

  it('opens the popup once the pointer rests on a box, at once on keyboard focus, and closes it', () => {
    expect(SCRIPT).toMatch(/const TIP_REST = 450;/);
    expect(SCRIPT).toMatch(/addEventListener\('pointerover', \(e\) => \{[\s\S]*?restTimer = setTimeout\(\(\) => \{ if \(overAt === name\) showTip\(boxByName\(name\)\); \}, TIP_REST\);/);
    // A mouse press focusing a button does not open it; keyboard focus does.
    expect(SCRIPT).toMatch(/addEventListener\('focusin', \(e\) => \{[\s\S]*?e\.target\.matches\(':focus-visible'\)\) showTip\(/);
    // Closed on a press, on scroll, on Escape and when the pointer leaves the page.
    expect(SCRIPT).toContain("addEventListener('pointerdown', () => { tipsBack(); hideTips(); })");
    expect(SCRIPT).toMatch(/addEventListener\('scroll', \(\) => \{ if \(shownAt\) hideTips\(\); \}, \{ capture: true, passive: true \}\)/);
    expect(SCRIPT).toMatch(/classList\.add\('tipoff'\);\n\s*hideTips\(\);/);
    expect(SCRIPT).toMatch(/documentElement\.addEventListener\('pointerleave', \(\) => \{[\s\S]*?hideTips\(\);/);
    // One popup at a time.
    expect(SCRIPT).toMatch(/function showTip\(box[\s\S]*?if \(t !== tip\) t\.hidePopover\(\);/);
  });

  it('reopens an open popup in place when a redraw rebuilds its box', () => {
    // A redraw empties the panel first, so the box is known by name, not by node.
    expect(SCRIPT).toMatch(/function holdIfOpen\(tip, name = tip\.id\) \{\s*if \(!name \|\| name !== shownAt\) return;\s*queueMicrotask\(\(\) => \{[^\n]*showTip\(box, \{ held: true \}\)/);
    const help = SCRIPT.slice(SCRIPT.indexOf('function withHelp('), SCRIPT.indexOf('\n  }\n', SCRIPT.indexOf('function withHelp(')));
    expect(help).toContain('holdIfOpen(tip)');
    expect(SCRIPT).toContain("holdIfOpen(stip, 'stop-box');");
    const fns = `${SCRIPT.match(/function boxByName\(name\) \{[\s\S]*?\n {2}\}\n/)[0]}`;
    const node = (cls, parent) => ({ classList: { contains: (c) => c === cls }, closest: () => parent });
    const box = node('hl', null);
    const docs = { 'stop-box': box, 'help-w1-skip-tip': node('tip', box) };
    const boxByName = new Function('document', `${fns}; return boxByName;`)({ getElementById: (id) => docs[id] ?? null });
    expect(boxByName('stop-box')).toBe(box);
    expect(boxByName('help-w1-skip-tip')).toBe(box);
    expect(boxByName('')).toBe(null);
    expect(boxByName('gone')).toBe(null);
  });

  it('shows only the hovered or focused box\'s own tooltip', () => {
    // A descendant selector would open every tooltip inside a box at once.
    expect(PAGE).not.toMatch(/\.hl:(hover|focus-within) \.tip/);
    // A setting row has no help box or tooltip: its help is an info button by the name, and
    // the save buttons are described by shared hidden texts.
    const start = SCRIPT.indexOf('function settingRow(s) {');
    const body = SCRIPT.slice(start, SCRIPT.indexOf('\n  }\n', start));
    expect(body).not.toContain("'srow hl'");
    expect(body).not.toContain("'hl sbody'");
    expect(body).not.toContain("'role', 'tooltip'");
    expect(body).toContain("infoButton('set:' + s.name");
    expect(body).toMatch(/row\.append\(acts\)/);
  });

  // The info button and its popup (FM-130).
  const placeInfo = lifted(/function placeInfo\(anchor, pop, view\) \{[\s\S]*?\n {2}\}\n/, 'placeInfo');
  const fnBody = (sig, end = '\n  }\n') => {
    const start = SCRIPT.indexOf(sig);
    expect(start, sig).toBeGreaterThan(-1);
    return SCRIPT.slice(start, SCRIPT.indexOf(end, start));
  };
  const inside = (p, view, h = 200) => {
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(view.width - 8);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + Math.min(h, p.maxHeight)).toBeLessThanOrEqual(view.height - 8);
  };

  it('placeInfo keeps the popup inside the screen', () => {
    const phone = { width: 360, height: 640 };
    const left = placeInfo({ left: 0, right: 24, top: 100, bottom: 124 }, { height: 200 }, phone);
    expect(left).toEqual({ left: 8, width: 344, top: 130, above: false, maxHeight: 502 });
    inside(left, phone);
    const right = placeInfo({ left: 336, right: 360, top: 100, bottom: 124 }, { height: 200 }, phone);
    expect(right.left).toBe(8);
    expect(right.width).toBe(344);
    inside(right, phone);
    const laptop = { width: 1280, height: 800 };
    const far = placeInfo({ left: 1250, right: 1274, top: 100, bottom: 124 }, { height: 200 }, laptop);
    expect([far.width, far.left]).toEqual([320, 952]);
    inside(far, laptop);
    expect(placeInfo({ left: 40, right: 64, top: 100, bottom: 124 }, { height: 200 }, laptop).left).toBe(40);
  });

  it('placeInfo uses the screen width less 16 up to 480 px, and 320 above', () => {
    const icon = { left: 0, right: 24, top: 100, bottom: 124 };
    const widths = [[320, 304], [360, 344], [400, 384], [480, 464], [481, 320], [1280, 320]];
    for (const [screen, want] of widths) {
      const view = { width: screen, height: 640 };
      const p = placeInfo(icon, { height: 200 }, view);
      expect(p.width, `width at ${screen}`).toBe(want);
      if (screen <= 480) expect(p.left, `left at ${screen}`).toBe(8);
      inside(p, view);
    }
    expect(placeInfo(icon, { height: 200 }, { width: 16, height: 640 }).width).toBe(0);
  });

  it('placeInfo flips above the icon near the bottom of the screen', () => {
    const phone = { width: 360, height: 640 };
    const p = placeInfo({ left: 0, right: 24, top: 600, bottom: 624 }, { height: 200 }, phone);
    expect(p).toMatchObject({ above: true, top: 394, maxHeight: 586 });
    inside(p, phone);
  });

  it('placeInfo picks the larger side and caps the height on a short screen', () => {
    const short = { width: 360, height: 300 };
    const below = placeInfo({ left: 0, right: 24, top: 120, bottom: 144 }, { height: 400 }, short);
    expect(below).toMatchObject({ above: false, maxHeight: 142, top: 150 });
    inside(below, short, 400);
    const above = placeInfo({ left: 0, right: 24, top: 170, bottom: 194 }, { height: 400 }, short);
    expect(above).toMatchObject({ above: true, maxHeight: 156, top: 8 });
    inside(above, short, 400);
  });

  // A setting's popup, built from its /api/settings row (FM-131).
  const settingInfo = (s) => new Function(SCRIPT.match(/const APPLIES = [^\n]+/)[0] + SCRIPT.match(/const SET_BY = [^\n]+/)[0]
    + SCRIPT.match(/function settingInfo\(s\) \{[\s\S]*?\n {2}\}\n/)[0] + '; return settingInfo;')()(s);
  const termOf = (s, term) => settingInfo(s).find((x) => x.term === term)?.text;
  const ROW = { name: 'acme.limit', description: 'How far Acme goes.', type: 'integer', default: 2, applies: 'next-story', limits: { min: 1, max: 3 }, source: 'team' };

  it('settingInfo shows the default in words', () => {
    const def = (v) => termOf({ ...ROW, default: v }, 'Default');
    expect(def(true)).toBe('On');
    expect(def(false)).toBe('Off');
    expect(def(3)).toBe('3');
    expect(def(2.5)).toBe('2.5');
    for (const v of [null, undefined, '']) expect(def(v), String(v)).toBe('Not set');
    expect(def([])).toBe('None');
    expect(def({})).toBe('None');
    expect(def(['https://acme.example/a', 'https://acme.example/b'])).toBe('https://acme.example/a, https://acme.example/b');
    expect(def({ started: 'In Progress' })).toBe('started: In Progress');
    expect(def('127.0.0.1')).toBe('127.0.0.1');
  });

  it('settingInfo says what is allowed, and nothing without limits', () => {
    const allowed = (limits) => termOf({ ...ROW, limits }, 'Allowed');
    expect(allowed({ min: 1, max: 3 })).toBe('1 to 3');
    expect(allowed({ above: 0 })).toBe('More than 0');
    expect(allowed({ min: 0 })).toBe('0 or more');
    expect(allowed({ max: 9 })).toBe('Up to 9');
    for (const limits of [{}, undefined, { values: ['a'] }, { keys: ['started'] }]) {
      expect(settingInfo({ ...ROW, limits }).map((x) => x.term), JSON.stringify(limits)).not.toContain('Allowed');
    }
  });

  it('settingInfo says who set the value', () => {
    expect(termOf({ ...ROW, source: 'local' }, 'Set by')).toBe('This computer');
    expect(termOf({ ...ROW, source: 'team' }, 'Set by')).toBe('The team (foreman.config.json)');
    expect(termOf({ ...ROW, source: 'default' }, 'Set by')).toBe('Foreman\'s default');
    expect(settingInfo({ ...ROW, source: 'elsewhere' }).map((x) => x.term)).not.toContain('Set by');
  });

  it('settingInfo says when the value takes effect', () => {
    expect(termOf({ ...ROW, applies: 'next-story' }, 'Takes effect')).toBe('From the next story a slot picks');
    expect(termOf({ ...ROW, applies: 'next-run' }, 'Takes effect')).toBe('When the run next starts');
    expect(termOf({ ...ROW, applies: 'restart' }, 'Takes effect')).toBe('When the run or dashboard restarts');
    expect(settingInfo({ ...ROW, applies: 'someday' }).map((x) => x.term)).not.toContain('Takes effect');
  });

  it('settingInfo ends with the config key, in a fixed order, and never says when it is shown', () => {
    const info = settingInfo(ROW);
    expect(info.map((x) => x.term)).toEqual(['What it does', 'Default', 'Allowed', 'Set by', 'Takes effect', 'Config key']);
    expect(info[0].text).toBe('How far Acme goes.');
    expect(termOf(ROW, 'Config key')).toBe('acme.limit');
    for (const x of info) expect(x.text).not.toContain('Shown only when');
    // A row with no description still gets the rest.
    expect(settingInfo({ ...ROW, description: '  ' }).map((x) => x.term)).toEqual(['Default', 'Allowed', 'Set by', 'Takes effect', 'Config key']);
  });

  it("settingInfo says where a reviewer's model sits in the file, after the config key", () => {
    const where = 'the reviewer named security in roles.reviewers';
    const reviewer = { ...ROW, name: 'roles.reviewers.security.model', inFile: where };
    expect(settingInfo(reviewer).map((x) => x.term)).toEqual(['What it does', 'Default', 'Allowed', 'Set by', 'Takes effect', 'Config key', 'In the file']);
    expect(termOf(reviewer, 'In the file')).toBe(where);
    expect(termOf(reviewer, 'Config key')).toBe('roles.reviewers.security.model');
    expect(settingInfo({ ...reviewer, inFile: '  ' }).map((x) => x.term)).not.toContain('In the file');
    const { inFile, ...bare } = reviewer;
    expect(settingInfo(bare).map((x) => x.term)).not.toContain('In the file');
  });

  it('settingInfo gives every setting a description, a default, a source, a time and a key', () => {
    const rows = [...REGISTRY.map((e) => ({ ...e, limits: limitsOf(e, {}), source: 'default' })),
      { name: 'acme.mode', type: 'enum', description: 'The Acme mode.', default: 'a', applies: 'next-story', limits: { values: ['a', 'b'] }, source: 'default' }];
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(TYPES));
    for (const r of rows) {
      const info = settingInfo(r);
      expect(info[0].term, r.name).toBe('What it does');
      expect(info[0].text.trim(), r.name).not.toBe('');
      const terms = info.map((x) => x.term);
      for (const t of ['Default', 'Set by', 'Takes effect', 'Config key']) expect(terms, r.name + ' ' + t).toContain(t);
    }
  });

  it('builds a setting row from settingInfo, with shared hidden texts for the save buttons', () => {
    const row = fnBody('function settingRow(s) {');
    expect(row).toContain('settingInfo(');
    for (const gone of ['withHelp(', "'tip'", 'class="tip"', "'role', 'tooltip'", "' · applies: '"]) expect(row, gone).not.toContain(gone);
    expect(row).toContain("setAttribute('aria-describedby', 'set-help-' + ");
    expect(row).toContain("if (helpFor(help, 'form'");
    const render = fnBody('function renderSettings() {');
    expect(render).toContain("$('set-help')");
    expect(render).toContain("helpFor(help, 'form'");
    for (const k of ['save-local', 'save-team', 'reset-local', 'reset-team']) expect(render, k).toContain(`'${k}'`);
    expect(PAGE).toContain('<div class="sr" id="set-help"></div>');
    expect(fnBody('function settingControl(s, labelId) {')).toContain("'One per line.'");
    expect(SCRIPT).not.toContain('function infoMore(');
  });

  // The Settings tab drawn by the page's own renderSettings and settingRow, on a tree of plain nodes (FM-205).
  const drawSettings = (input) => {
    const pick = (re) => SCRIPT.match(re)[0];
    const src = [
      pick(/function helpFor\(help, kind, key, own\) \{[\s\S]*?\n {2}\}\n/),
      pick(/const APPLIES = [^\n]+/),
      pick(/const SET_BY = [^\n]+/),
      pick(/function settingInfo\(s\) \{[\s\S]*?\n {2}\}\n/),
      pick(/function settingRow\(s\) \{[\s\S]*?\n {2}\}\n/),
      pick(/function renderSettings\(\) \{[\s\S]*?\n {2}\}\n/),
    ].join('\n');
    return new Function('input', `
      const help = input.help, settings = input.settings, settingsError = null, needsToken = false;
      const busy = new Set(), snotes = {}, saveSetting = () => {}, foldable = () => {};
      const node = (tag, cls, text) => ({
        tag, cls: cls || null, text: text == null ? null : String(text), children: [], dataset: {}, attrs: {},
        hidden: false, id: '', title: '', type: '', disabled: false,
        setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
        hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
        addEventListener() {}, append(...xs) { this.children.push(...xs); }, replaceChildren(...xs) { this.children = xs; },
        get childElementCount() { return this.children.filter((c) => typeof c !== 'string').length; },
        querySelector() { return null; },
      });
      const el = node;
      const nodes = { 'set-dirty': node('p'), 'set-warnings': node('div'), 'set-help': node('div'), 'set-groups': node('div') };
      const $ = (id) => nodes[id];
      const infoButton = () => [node('button', 'ibtn')], settingControl = () => node('input');
      const keepFocus = (box, fn) => fn(), keepInfo = (box, fn) => fn();
      ${src}
      renderSettings();
      const buttons = [];
      const walk = (n) => {
        if (typeof n === 'string') return;
        if (['btn', 'btn ghost', 'linkbtn'].includes(n.cls) && /^set:.+:(local|team|reset)$/.test(n.dataset.key || '')) buttons.push(n);
        n.children.forEach(walk);
      };
      walk(nodes['set-groups']);
      return { nodes, buttons };
    `)(input);
  };
  const ACME_SETTINGS = {
    settings: [
      { name: 'acme.mode', label: 'Acme mode', type: 'enum', description: 'The Acme mode.', default: 'a', applies: 'next-story', limits: { values: ['a', 'b'] }, source: 'local', group: 'acme' },
      { name: 'acme.size', label: 'Acme size', type: 'int', description: 'How big.', default: 1, applies: 'next-story', limits: { min: 1, max: 4 }, source: 'team', group: 'acme' },
    ],
    groups: [{ name: 'acme', label: 'Acme' }],
    warnings: [],
  };

  it('with no help loaded, the save buttons are described by nothing and #set-help is empty', () => {
    for (const help of [null, {}, { form: {} }]) {
      const { nodes, buttons } = drawSettings({ help, settings: ACME_SETTINGS });
      const label = JSON.stringify(help);
      expect(buttons, label).toHaveLength(6);
      for (const b of buttons) {
        expect(b.getAttribute('aria-describedby'), `${label} ${b.dataset.key}`).toBeNull();
        expect(Object.keys(b.attrs), `${label} ${b.dataset.key}`).not.toContain('aria-describedby');
      }
      expect(nodes['set-help'].children, label).toHaveLength(0);
      // The rows are still drawn: one section for the Acme group.
      expect(nodes['set-groups'].childElementCount, label).toBe(1);
    }
  });

  it('with the help loaded, each save button is described by its shared hidden text', () => {
    const { nodes, buttons } = drawSettings({ help: { form: ACTION_HELP.form }, settings: ACME_SETTINGS });
    const KEY = { 'Save for me': 'save-local', 'Save for the team': 'save-team', 'Reset my value': 'reset-local', 'Reset the team value': 'reset-team' };
    expect(buttons).toHaveLength(6);
    for (const b of buttons) expect(b.getAttribute('aria-describedby'), b.text).toBe('set-help-' + KEY[b.text]);
    const spans = nodes['set-help'].children;
    expect(spans.map((n) => n.id)).toEqual(['set-help-save-local', 'set-help-save-team', 'set-help-reset-local', 'set-help-reset-team']);
    for (const n of spans) expect((n.text || '').trim(), n.id).not.toBe('');
  });

  it('wires the info button to a native popover, its announcer and the redraws', () => {
    const body = fnBody('function infoButton(key, label, content) {');
    for (const part of ["setAttribute('popover', 'auto')", "setAttribute('popovertarget', ", "'aria-expanded'", "addEventListener('toggle'", 'newState',
      "addEventListener('focusout'", 'hidePopover(', 'say(', "'About ' + label", 'content.firstElementChild.cloneNode(true)']) {
      expect(body, part).toContain(part);
    }
    expect(SCRIPT).toContain("addEventListener('resize'");
    expect(SCRIPT).toContain("addEventListener('scroll'");
    expect(fnBody('function renderSettings() {')).toContain('keepInfo(box');
    const keep = fnBody('const keepInfo = (box, fn) => {', '\n  };\n');
    expect(keep).toContain('showPopover()');
    expect(keep).toContain('dataset.quiet');
  });

  it('lets a capped popup scroll: its own scroll is not re-placed, and a re-place keeps its scroll', () => {
    expect(fnBody('const reInfo = (e) => {', '\n  };\n')).toContain('infoShown.pop.contains(e.target)');
    const now = fnBody('function placeInfoNow(btn, pop) {');
    expect(now).toContain('const scrolled = pop.scrollTop;');
    expect(now.indexOf('const scrolled = pop.scrollTop;')).toBeLessThan(now.indexOf("pop.style.maxHeight = 'none'"));
    expect(now).toContain('pop.scrollTop = scrolled;');
  });

  it('draws the info icon from one template, and resets the popover styles', () => {
    expect(PAGE).toContain('<template id="info-icon">');
    expect(PAGE).not.toContain('createElementNS');
    expect(PAGE).not.toContain('xmlns');
    expect(PAGE).toMatch(/\.ipop\{position:fixed;inset:auto;margin:0;/);
    expect(PAGE).not.toMatch(/\.ipop\{[^}]*display:/);
    expect(PAGE).toContain('@media (pointer:coarse){.ibtn::after{content:"";position:absolute;inset:-10px}}');
    expect(PAGE).toMatch(/prefers-reduced-motion: reduce\)\{[\s\S]*?\.ipop:popover-open\{animation:none\}/);
  });

  it('keeps the tooltips hidden after Escape until focus really moves', () => {
    const src = (re) => SCRIPT.match(re)[0];
    const focusMoved = new Function(`${src(/function focusName\(node\) \{[\s\S]*?\n {2}\}\n/)}${src(/function focusMoved\(at, node\) \{[\s\S]*?\n {2}\}\n/)}; return focusMoved;`)();
    const node = (key, id = '') => ({ dataset: key ? { key } : {}, id });
    // A redraw puts focus back on a new node for the same control: not a move.
    expect(focusMoved('w1:skip', node('w1:skip'))).toBe(false);
    expect(focusMoved('pause', node('', 'pause'))).toBe(false);
    // Focus on another control is a move.
    expect(focusMoved('w1:skip', node('w1:park'))).toBe(true);
    // Escape with nothing named in focus: any focus is a move.
    expect(focusMoved('', node(''))).toBe(true);
    expect(focusMoved(null, node('w1:skip'))).toBe(true);
    expect(focusMoved('w1:skip', null)).toBe(true);
    expect(SCRIPT).toMatch(/tipoffAt = focusName\(document\.activeElement\)/);
    expect(SCRIPT).toMatch(/addEventListener\('focusin', \(e\) => \{\s*if \(!focusMoved\(tipoffAt, e\.target\)\) return;/);
  });

  it('keeps the withHelp comment above withHelp', () => {
    expect(SCRIPT).toContain('// tooltip, both its description. Without help, the control as it is.\n  function withHelp(');
    expect(SCRIPT).not.toContain('Without help, the control as it is.\n  // The name of the control focus is on');
  });

  it('writes the Escape tooltip rule once, above the listeners', () => {
    expect(SCRIPT).toContain('// Hide the tooltips; see the listeners below.\n    tipoffAt = focusName(document.activeElement);');
    expect(SCRIPT.match(/Escape hides the tooltips until/g)).toHaveLength(1);
    expect(SCRIPT).toMatch(/\/\/ Escape hides the tooltips until focus moves to another control[\s\S]*?\n {2}function tipsBack\(\)/);
  });

  it('brings the tooltips back when the pointer moves to another box or presses', () => {
    const src = (re) => SCRIPT.match(re)[0];
    const fns = `${src(/function focusName\(node\) \{[\s\S]*?\n {2}\}\n/)}${src(/function boxName\(box\) \{[\s\S]*?\n {2}\}\n/)}${src(/function pointerMoved\(at, name\) \{[\s\S]*?\n {2}\}\n/)}`;
    const { boxName, pointerMoved } = new Function(`${fns}; return { boxName, pointerMoved };`)();
    const box = (id, tipId) => ({ id, querySelector: (s) => (s === ':scope > .tip' && tipId ? { id: tipId } : null) });
    expect(boxName(null)).toBe('');
    expect(boxName(box('stop-box'))).toBe('stop-box');
    expect(boxName(box('', 'help-w1-skip-tip'))).toBe('help-w1-skip-tip');
    expect(boxName(box('', null))).toBe('');
    // The same box, also after a redraw rebuilt it: not a move.
    expect(pointerMoved('help-w1-skip-tip', 'help-w1-skip-tip')).toBe(false);
    // Outside any box: not a move.
    expect(pointerMoved('help-w1-skip-tip', '')).toBe(false);
    expect(pointerMoved('help-w1-skip-tip', 'help-w1-park-tip')).toBe(true);
    // Escape with the pointer outside every box: any box is a move.
    expect(pointerMoved('', 'pause-tip')).toBe(true);
    expect(pointerMoved(null, 'pause-tip')).toBe(true);
    // Wiring.
    expect(SCRIPT).toMatch(/addEventListener\('keydown', \(e\) => \{\s*if \(e\.key !== 'Escape'\) return;[\s\S]*?tipoffOver = overAt[\s\S]*?\n {2}\}\);/);
    expect(SCRIPT).toMatch(/addEventListener\('pointerover', \(e\) => \{[\s\S]*?pointerMoved\(tipoffOver,[\s\S]*?tipsBack\(\)[\s\S]*?\n {2}\}\);/);
    expect(SCRIPT).toContain("addEventListener('pointerdown', () => { tipsBack(); hideTips(); })");
    expect(SCRIPT).toMatch(/function tipsBack\(\) \{[^\n]*classList\.remove\('tipoff'\)/);
  });
});

describe('the page and the snapshot it reads, from a real server', () => {
  let dir;
  let state;
  let server;
  let base;
  let decisionId;
  const now = new Date('2026-10-15T09:00:00Z');
  const t = (min) => new Date(now - min * 60000).toISOString();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'foreman-page-'));
    state = join(dir, '.foreman');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Sample Shop' }, slots: 2, checks: [{ run: 'true', when: 'always' }] }));
    writeFileSync(join(state, 'status.json'), JSON.stringify({
      updatedAt: now.toISOString(),
      loop: { state: 'running', since: t(30), reason: '' },
      workers: 2,
      slots: [
        { id: 'w1', state: 'building', reason: '', parkedFor: null, since: t(14),
          story: { id: 'S-5', title: 'Add the search box', stage: 'build', detail: 'writing tests', rounds: 1, startedAt: t(14) },
          agents: [{ id: 'a1', role: 'foreman:builder', story: 'S-5', since: t(6), lastAt: t(0.1), doing: 'editing src/search.js', tools: 12, quietFor: 0 }],
          actions: ['skip', 'takeover', 'park'] },
        { id: 'w2', state: 'parked', reason: 'Its folder has stray changes.', parkedFor: 'dirty', since: t(20), story: null, agents: [], actions: ['resume-as-is', 'discard'] },
      ],
      events: [{ at: t(1), text: 'builder started on S-5', kind: 'agent', slot: 'w1' }],
      recent: [{ id: 'S-4', title: 'List the products', result: 'shipped', startedAt: t(90), endedAt: t(40), rounds: 1, pr: 'https://example.com/pr/4', costUsd: 2.5, minutes: 50 }],
      totals: { since: t(120), stories: 1, shipped: 1, costUsd: 2.5, minutes: 50 },
      queue: { now: [{ id: 'S-6', title: 'Sort the list' }], next: ['S-6', 'S-7'], waiting: 1, ownerTasks: 0, decisions: 0 },
      progress: { done: 4, todo: 3, blocked: 0, total: 7, byGroup: [] },
      ownerClaims: [],
      fixProblem: null,
      waiting: { count: 1, items: [], checkedAt: now.toISOString() },
      control: { paused: false, handledNextAt: null, handledWorkersAt: null },
    }));
    decisionId = add(state, { story: 'S-5', kind: 'decision', title: 'Which search engine?', options: ['Built in', 'Hosted'] }, now);
    const { config } = loadConfig(dir);
    server = createDashboardServer({ root: dir, config, stateDir: state, env: {}, now: () => now });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the page with its content security policy', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await res.text()).toBe(PAGE);
  });

  it('adds the project, the requested commands and a stop request to the snapshot', async () => {
    let snap = await (await fetch(`${base}/api/status`)).json();
    expect(snap.project).toEqual({ name: 'Sample Shop', slots: 2, rounds: 3 });
    expect(snap.requested).toEqual({});
    expect(snap.control.stopRequested).toBe(false);
    expect(snap.slots.map((s) => s.id)).toEqual(['w1', 'w2']);
    expect(snap.recent[0]).toMatchObject({ costUsd: 2.5, minutes: 50 });
    expect(snap.totals).toMatchObject({ stories: 1, shipped: 1, costUsd: 2.5, minutes: 50 });

    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/api/control', { action: 'workers', n: 1 })).status).toBe(200);
    expect((await post('/api/control', { action: 'stop' })).status).toBe(200);
    snap = await (await fetch(`${base}/api/status`)).json();
    expect(snap.requested).toMatchObject({ workers: 1 });
    expect(snap.requested.workersAt).toBeTruthy();
    expect(snap.control.stopRequested).toBe(true);

    expect((await post(`/api/decisions/${decisionId}`, { option: 'Hosted', note: 'cheaper' })).status).toBe(200);
    const items = await (await fetch(`${base}/api/decisions`)).json();
    expect(items[0].answer).toMatchObject({ option: 'Hosted', note: 'cheaper' });
  });

  it('serves the settings the Settings tab and the worker control read and write', async () => {
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let body = await (await fetch(`${base}/api/settings`)).json();
    expect(body.settings.find((s) => s.name === 'workers')).toMatchObject({ value: 1, source: 'default', limits: { min: 1, max: 2 } });
    // what the worker control sends
    const res = await post('/api/settings', { name: 'workers', value: 2, layer: 'local' });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(join(state, 'settings.json'), 'utf8'))).toEqual({ workers: 2 });
    body = await (await fetch(`${base}/api/settings`)).json();
    expect(body.settings.find((s) => s.name === 'workers')).toMatchObject({ value: 2, source: 'local' });
  });

  it('serves the list the Waiting on you tab shows, and takes the posts its buttons build', async () => {
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', 'ACME-3.md'), '---\nid: ACME-3\ntitle: Add the key (owner task)\nstatus: todo\n---\n\n## Progress notes\n\n_Newest first._\n');
    const list = async () => (await fetch(`${base}/api/waiting`)).json();
    const send = ({ path, body }) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    let items = await list();
    const decision = items.find((i) => i.id === decisionId);
    const task = items.find((i) => i.id === 'task:ACME-3');
    expect(decision).toBeTruthy();
    expect(task).toBeTruthy();
    expect(() => items.map(waitingCardView)).not.toThrow();

    expect((await send(waitingRequest(decision, 'option-1', 'cheaper'))).status).toBe(200);
    items = await list();
    expect(items.some((i) => i.id === decisionId)).toBe(false);

    const req = waitingRequest(task, 'done');
    expect(req.path).toBe('/api/waiting/task:ACME-3');
    expect((await send(req)).status).toBe(200);
    expect(waitingSummary(await list()).text).toBe('Nothing is waiting on you.');
  });
});

describe('the header: busy slots, and draining after workers was lowered', () => {
  const busyText = lifted(/function busyText\(status, slots\) \{[\s\S]*?\n {2}\}\n/, 'busyText');
  it('shows a dash with no status', () => expect(busyText(null, [])).toBe('–'));
  it('shows the draining text while more run than the limit', () =>
    expect(busyText({ workers: 3, draining: { text: '4 running, limit 3: draining' } }, [{ state: 'building' }])).toBe('4 running, limit 3: draining'));
  it('shows busy of workers otherwise', () =>
    expect(busyText({ workers: 3, draining: null }, [{ state: 'building' }, { state: 'idle' }, { state: 'parked' }])).toBe('2 / 3'));
  it('is what renderHeader shows', () => {
    const header = SCRIPT.match(/function renderHeader\(\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(header).toContain("$('busy').textContent = busyText(status, slots());");
  });
});

describe('the held lane', () => {
  it('has a help sentence for each kind of hold, keyed on heldFor and haltedBy', () => {
    expect(SCRIPT).toContain("s.heldFor === 'api'");
    expect(SCRIPT).toContain("'It carries on by itself once the wait for the API ends. Resume queues it now; Take over if you want it yourself.'");
    expect(SCRIPT).toContain('s.haltedBy');
    expect(SCRIPT).toContain("'It ships once you press \"I\\'ve fixed it\" and the halt clears. Take over if you want it yourself.'");
    expect(SCRIPT).toContain("'It ships once the halt or pause is cleared. Resume queues it now; Take over if you want it yourself.'");
    expect(SCRIPT).not.toContain("'It ships once the halt or pause is cleared. Take over if you want it yourself.'");
  });
  it('still shows the slot reason as the why', () => {
    expect(SCRIPT).toContain("why.append(el('span', 'wtext', s.reason || said));");
  });
  it('labels the Resume action', () => {
    expect(SCRIPT).toMatch(/ACTION_LABEL = \{[^}]*resume:/);
  });
});

describe('queued work, on the Up next tab', () => {
  const queuedRows = lifted(/function queuedRows\(status\) \{[\s\S]*?\n {2}\}\n/, 'queuedRows');
  it('maps the status queued list to an id and its words, and drops items with no id', () => {
    expect(queuedRows({ queued: [{ id: 'ACME-4', text: 'ACME-4 queued for w4, which is over the worker count; w1 takes it next' }, { text: 'x' }, null, { id: 'ACME-5' }] })).toEqual([
      { id: 'ACME-4', text: 'ACME-4 queued for w4, which is over the worker count; w1 takes it next' },
      { id: 'ACME-5', text: 'ACME-5 queued' },
    ]);
  });
  it('is empty with no status or no queued list', () => {
    expect(queuedRows(null)).toEqual([]);
    expect(queuedRows({})).toEqual([]);
  });
  it('has its box and list in the page, and renderQueue fills them from queuedRows with text only', () => {
    expect(PAGE).toContain('id="queued-box"');
    expect(PAGE).toContain('id="queued-list"');
    const render = SCRIPT.match(/function renderQueue\(\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(render).toContain('queuedRows(status)');
    expect(render).toContain("$('queued-box').hidden = !rows.length");
    expect(render.slice(0, render.indexOf("$('queue')"))).toContain('queued-list');
    expect(render).not.toMatch(/innerHTML/);
  });
});

// 'Standby' is a real loop state, so the header must not show it before any status loads.
describe('the header status word', () => {
  const headerState = (...args) => new Function(`${SCRIPT.match(/const LOOP = [^\n]+/)[0]}; ${SCRIPT.match(/function headerState\(status, quiet\) \{[\s\S]*?\n {2}\}\n/)[0]}; return headerState;`)()(...args);
  it('says Connecting, with the grey lamp, before any status loads', () =>
    expect(headerState(null, false)).toEqual({ key: 'stopped', text: 'Connecting' }));
  it('says Standby only for the standby loop state', () =>
    expect(headerState({ loop: { state: 'standby' } }, false)).toEqual({ key: 'standby', text: 'Standby' }));
  it('says No signal when the run has gone quiet', () =>
    expect(headerState({ loop: { state: 'running' } }, true)).toEqual({ key: 'nosignal', text: 'No signal' }));
  it('says Stopped for a status with no loop state', () =>
    expect(headerState({}, false)).toEqual({ key: 'stopped', text: 'Stopped' }));
  it('starts the page on Connecting and draws the header through headerState', () => {
    expect(PAGE).toContain('<em id="st-text">Connecting</em>');
    const header = SCRIPT.match(/function renderHeader\(\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(header).toContain('headerState(status, silent())');
    expect(header).not.toContain("'Standby'");
  });
});

// The Help link: the user guide is on finefactory.ai, and the page only links to it.
describe('the Help link', () => {
  // A function or a one-line const of the page's script, by name.
  const pick = (name) => {
    const fn = SCRIPT.match(new RegExp(`\\n {2}function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`));
    if (fn) return fn[0];
    const line = SCRIPT.match(new RegExp(`\\n {2}const ${name} = [^\\n]+`));
    expect(line, name).not.toBeNull();
    return line[0];
  };
  // The named parts of the script, run against `doc`; returns the last one.
  const withDoc = (doc, names) => new Function('document', `${names.map(pick).join('\n')}; return ${names.at(-1)};`)(doc);

  // Just enough of a document for the page's builders: elements with children, attributes and
  // text, text nodes and fragments.
  function fakeDocument() {
    const text = (t) => ({ nodeType: 3, data: String(t), get textContent() { return this.data; } });
    const element = (tag) => {
      const n = {
        tag, nodeType: 1, attrs: {}, children: [], className: '', listeners: {},
        append(...xs) { for (const x of xs) n.children.push(typeof x === 'string' ? text(x) : x); },
        setAttribute(k, v) { n.attrs[k] = String(v); },
        getAttribute(k) { return Object.hasOwn(n.attrs, k) ? n.attrs[k] : null; },
        addEventListener(type, f) { n.listeners[type] = f; },
        get textContent() { return n.children.map((c) => c.textContent).join(''); },
        set textContent(v) { n.children = [text(v)]; },
      };
      return n;
    };
    return { createElement: element, createTextNode: text, createDocumentFragment: () => element('#fragment') };
  }
  const nodes = (root) => [root, ...(root.children || []).flatMap(nodes)];
  const find = (root, test) => nodes(root).find(test) ?? null;

  it('is a link beside the tabs, not a tab, and opens the site in a new tab', () => {
    expect(PAGE).not.toContain('id="tab-help"');
    expect(PAGE).not.toContain('id="view-help"');
    expect(PAGE).not.toContain('help-body');
    const link = PAGE.match(/<a class="helplink" id="help-link"[^>]*>[\s\S]*?<\/a>/);
    expect(link, 'the help link').not.toBeNull();
    expect(link[0]).toContain('target="_blank" rel="noopener noreferrer"');
    expect(link[0]).toMatch(/<svg class="ticon" [^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>Help</);
    expect(link[0]).toContain('<span class="sr"> (opens in a new tab)</span>');
    expect(link[0]).toContain('<span aria-hidden="true"> ↗</span>');
    const at = PAGE.indexOf('id="help-link"');
    const bar = PAGE.indexOf('<div class="tabbar">');
    expect(bar).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(PAGE.indexOf('</nav>', bar));
    expect(at).toBeLessThan(PAGE.indexOf('</div>', PAGE.indexOf('</nav>', bar)));
    // Outside role=tablist: a tablist holds only tabs.
    const nav = PAGE.slice(PAGE.indexOf('<nav class="tabs"'), PAGE.indexOf('</nav>', PAGE.indexOf('<nav class="tabs"')));
    expect(nav).not.toContain('help-link');
    expect(link[0]).not.toContain('role="tab"');
  });

  it('gets its address from the script, not the markup', () => {
    expect(SCRIPT).toContain(`const DOCS_URL = '${DOCS_URL}'`);
    expect(SCRIPT).toContain("$('help-link').href = DOCS_URL");
    expect(PAGE).not.toMatch(/id="help-link"[^>]*href=/);
  });

  it('opens the Command centre at #help, and has none of the old guide code', () => {
    const tabFor = withDoc(null, ['tabFor']);
    expect(tabFor('#help')).toBe('run');
    expect(tabFor('#help/settings')).toBe('run');
    expect(tabFor('#settings')).toBe('settings');
    for (const gone of ['loadGuide', 'renderGuide', 'guideFilter', 'guideLink', "'#help/'", "['help', $('tab-help')"]) expect(SCRIPT, gone).not.toContain(gone);
  });

  it('styles the link from the theme tokens, in the tab bar', () => {
    const style = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
    for (const gone of ['.help{', '.htoc', '.hdoc', '.hmark']) expect(style, gone).not.toContain(gone);
    expect(style).toContain('.tabbar{');
    const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /\.helplink\b/.test(m[1]));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) expect(`${selector.trim()}: ${/#[0-9a-f]{3,8}\b|rgba?\(/i.test(body)}`).toBe(`${selector.trim()}: false`);
    // The screen-reader text is absolutely positioned: without a positioned parent it would sit
    // outside the scrolling tab bar and widen the page on a phone.
    expect(style).toMatch(/\.helplink\{position:relative;/);
  });

  it("links Set up's Read the guide to the site in a new tab, and shows anything else as text", () => {
    const linkTo = withDoc(fakeDocument(), ['el', 'safeUrl', 'linkTo']);
    const a = linkTo(DOCS_URL + '#install', 'Read the guide');
    expect(a.tag).toBe('a');
    expect(a.href).toBe(DOCS_URL + '#install');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer');
    expect(find(a, (n) => n.className === 'sr').textContent).toBe(' (opens in a new tab)');
    expect(linkTo('#install', 'Read the guide')).toEqual(expect.objectContaining({ nodeType: 3, data: 'Read the guide' }));
    expect(SCRIPT).toContain('Read the guide');
    expect(SCRIPT).not.toContain('Open the README');
    expect(SCRIPT).not.toContain('setup.readme');
    expect(PAGE).not.toContain('github.com');
    expect(PAGE).not.toContain('README');
  });

  it('opens every other web link in a new tab, and says so', () => {
    const linkTo = withDoc(fakeDocument(), ['el', 'safeUrl', 'linkTo']);
    const a = linkTo('https://acme.example/pr/1', 'pull request');
    expect(a.tag).toBe('a');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer');
    expect(find(a, (n) => n.className === 'sr').textContent).toBe(' (opens in a new tab)');
    expect(find(a, (n) => n.getAttribute?.('aria-hidden') === 'true').textContent).toBe(' ↗');
    expect(linkTo('javascript:alert(1)', 'x')).toEqual(expect.objectContaining({ nodeType: 3, data: 'x' }));
  });

  it('builds the page from nodes and text only', () => {
    expect(SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write/);
  });
});

describe('the agent cards and the conversation view', () => {
  const NODE = `
    const node = (tag, cls, text) => ({
      tag, cls: cls || null, text: text == null ? null : String(text), children: [], dataset: {}, attrs: {}, hidden: false, on: {},
      get textContent() { return this.text; }, set textContent(v) { this.text = String(v); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
      addEventListener(t, f) { this.on[t] = f; }, append(...xs) { this.children.push(...xs); },
      prepend(...xs) { this.children.unshift(...xs); }, replaceChildren(...xs) { this.children = xs; },
    });
    const el = node;`;
  const pick = (re) => SCRIPT.match(re)[0];
  const CARD_SRC = [
    pick(/const ROLES = \{[\s\S]*?\n {2}\};\n/),
    pick(/const STAGES = [^\n]+/),
    pick(/const roleOf = \(r\) => \{[\s\S]*?\n {2}\};\n/),
    pick(/const secs = [^\n]+/),
    pick(/const tplus = [^\n]+/),
    pick(/const rawOpen = new Set\(\);[^\n]*/),
    pick(/const lasted = [^\n]+/),
    pick(/function viewButton\(target\) \{[\s\S]*?\n {2}\}\n/),
    pick(/function agentCards\(list, box, idleText, slotId\) \{[\s\S]*?\n {2}\}\n/),
  ].join('\n');
  const cards = (list, { slot = 'w1', opened = [] } = {}) => new Function('input', `
    ${NODE}
    const silent = () => false;
    const opened = [];
    const openConversation = (target, opener) => opened.push([target, opener]);
    ${CARD_SRC}
    for (const id of input.open) rawOpen.add(id);
    const box = node('div', 'agents');
    agentCards(input.list, box, 'Between agents.', input.slot);
    return { box, opened };
  `)({ list, slot, open: opened });

  const textOf = (n) => (typeof n === 'string' ? n : `${n.text ?? ''}${n.children.map(textOf).join('')}`);
  const find = (n, test) => (typeof n === 'string' ? null : test(n) ? n : n.children.map((c) => find(c, test)).find(Boolean) ?? null);
  const all = (n, test, out = []) => {
    if (typeof n === 'string') return out;
    if (test(n)) out.push(n);
    n.children.forEach((c) => all(c, test, out));
    return out;
  };
  const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
  const agent = (extra = {}) => ({ id: 'a1', role: 'foreman:tester', since: minutesAgo(6), lastAt: minutesAgo(3), doing: '$ SLOW_TEST_GUARD=report npm test', says: 'Run the full test suite', raw: 'SLOW_TEST_GUARD=report npm test', stage: 'test', tools: 7, modelName: 'Opus 5.5', modelNote: 'Set to Sonnet, runs on Opus 5.5', ...extra });

  it('draws the plain words as the main line, with the command behind Show command', () => {
    const { box } = cards([agent()]);
    const card = box.children[0];
    expect(find(card, (n) => n.cls?.startsWith('adoing')).text).toBe('Run the full test suite');
    const toggle = find(card, (n) => n.tag === 'button' && n.cls === 'linkbtn');
    expect(toggle.text).toBe('Show command');
    expect(toggle.attrs['aria-expanded']).toBe('false');
    const pre = find(card, (n) => n.tag === 'pre' && n.cls === 'araw');
    expect(toggle.attrs['aria-controls']).toBe(pre.id);
    expect(pre.hidden).toBe(true);
    expect(find(pre, (n) => n.tag === 'code').text).toBe('SLOW_TEST_GUARD=report npm test');
    toggle.on.click();
    expect(pre.hidden).toBe(false);
    expect(toggle.text).toBe('Hide command');
    expect(toggle.attrs['aria-expanded']).toBe('true');
  });

  it('keeps an opened command open across a redraw', () => {
    const first = cards([agent()]);
    find(first.box, (n) => n.cls === 'linkbtn').on.click();
    const again = cards([agent()], { opened: ['w1:a1'] });
    expect(find(again.box, (n) => n.cls === 'araw').hidden).toBe(false);
    expect(find(again.box, (n) => n.cls === 'linkbtn').text).toBe('Hide command');
  });

  it('shows the stage, run time, steps, and quiet time only past 2 minutes', () => {
    const meta = (a) => textOf(find(cards([a]).box, (n) => n.cls?.startsWith('ameta')));
    expect(meta(agent())).toMatch(/Test/);
    expect(meta(agent())).toMatch(/T\+0?\d:\d\d/);
    expect(meta(agent())).toContain('7 steps');
    expect(meta(agent())).toContain('quiet for 3 min');
    expect(meta(agent())).not.toContain('silent');
    expect(meta(agent({ lastAt: minutesAgo(1) }))).not.toContain('quiet for');
    expect(meta(agent({ stage: null }))).not.toContain('Test');
    const quiet = cards([agent({ lastAt: minutesAgo(12) })]).box.children[0];
    expect(quiet.cls).toContain('quiet');
    expect(textOf(find(quiet, (n) => n.cls?.startsWith('ameta')))).toContain('quiet for 12 min');
  });

  it('shows a card whose slot waits for a check slot as check queued, not quiet', () => {
    const queued = agent({ lastAt: minutesAgo(12), checkWait: { since: minutesAgo(7), text: 'check queued: waiting for a free check slot' } });
    const card = cards([queued]).box.children[0];
    expect(card.cls).not.toContain('quiet');
    const meta = textOf(find(card, (n) => n.cls?.startsWith('ameta')));
    expect(meta).toContain('check queued for 7 min');
    expect(meta).not.toContain('quiet for');
    const fresh = textOf(find(cards([agent({ lastAt: minutesAgo(12), checkWait: { since: new Date().toISOString() } })]).box.children[0], (n) => n.cls?.startsWith('ameta')));
    expect(fresh).toContain('check queued');
    expect(fresh).not.toContain(' for 0 min');
    expect(fresh).not.toContain('quiet for');
  });

  it('says in the lane that the check is queued and hands the wait to its agents', () => {
    const body = SCRIPT.match(/function lane\(s\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(body).toContain('Check queued: waiting for a free check slot');
    expect(body).toMatch(/checkWait: s\.checkWait/);
  });

  it('shows the short model, its mismatch note, and View conversation', () => {
    const { box, opened } = cards([agent()]);
    const card = box.children[0];
    expect(find(card, (n) => n.cls === 'amodel').text).toBe('Opus 5.5');
    expect(find(card, (n) => n.cls === 'anote').text).toBe('Set to Sonnet, runs on Opus 5.5');
    const view = find(card, (n) => n.tag === 'button' && n.text === 'View conversation');
    expect(view.cls).toBe('btn ghost');
    expect(view.dataset.key).toBe('conv:a1');
    view.on.click();
    expect(opened[0][0]).toMatchObject({ kind: 'agent', id: 'a1', running: true });
    const none = cards([agent({ modelName: null, modelNote: null, raw: null })]).box.children[0];
    expect(find(none, (n) => n.cls === 'amodel')).toBeNull();
    expect(find(none, (n) => n.cls === 'anote')).toBeNull();
    expect(find(none, (n) => n.cls === 'araw')).toBeNull();
  });

  it('draws a review relay as the reviewer it carries, via its engine, on the engine\'s model', () => {
    const relay = agent({ id: 'r1', role: 'foreman:review-relay', stage: 'review', modelName: 'Sonnet 5.5', modelNote: null, raw: 'foreman review --wait abc --for 540', says: 'Wait for the review', relay: { reviewer: 'compliance', agent: 'foreman:compliance-reviewer', engine: { name: 'antigravity', model: 'claude-opus-4-6-thinking' } } });
    const card = cards([relay]).box.children[0];
    expect(find(card, (n) => n.cls === 'badge').text).toBe('CP');
    const name = find(card, (n) => n.cls === 'aname');
    expect(textOf(name)).toBe('Compliancevia Antigravity');
    expect(find(card, (n) => n.cls === 'amodel').text).toBe('claude-opus-4-6-thinking');
    expect(find(card, (n) => n.cls === 'anote')).toBeNull();
    expect(find(card, (n) => n.tag === 'button' && n.text === 'View conversation').dataset.key).toBe('conv:r1');
    // Before the relay has named its reviewer, it is a relay; a reviewer without an engine in the config keeps the relay's own model.
    const bare = cards([agent({ id: 'r2', role: 'foreman:review-relay', modelName: 'Sonnet 5.5', modelNote: null, relay: undefined })]).box.children[0];
    expect(find(bare, (n) => n.cls === 'badge').text).toBe('RL');
    expect(textOf(find(bare, (n) => n.cls === 'aname'))).toBe('Review relayhands the review to another CLI');
    expect(find(bare, (n) => n.cls === 'amodel').text).toBe('Sonnet 5.5');
    const noEngine = cards([agent({ id: 'r3', role: 'foreman:review-relay', modelName: 'Sonnet 5.5', modelNote: null, relay: { reviewer: 'security', agent: 'foreman:security-reviewer', engine: null } })]).box.children[0];
    expect(textOf(find(noEngine, (n) => n.cls === 'aname'))).toBe('Securityvia a relay');
    expect(find(noEngine, (n) => n.cls === 'amodel').text).toBe('Sonnet 5.5');
  });

  it('opens the story session\'s conversation from the foreman\'s card', () => {
    const { box, opened } = cards([agent({ id: 'foreman', role: 'foreman', raw: null })], { slot: 'w2' });
    const view = find(box, (n) => n.text === 'View conversation');
    expect(view.dataset.key).toBe('conv:w2');
    view.on.click();
    expect(opened[0][0]).toMatchObject({ kind: 'slot', id: 'w2', running: true });
  });

  it('falls back to the older doing text, then to Starting', () => {
    expect(find(cards([agent({ says: undefined })]).box, (n) => n.cls?.startsWith('adoing')).text).toBe('$ SLOW_TEST_GUARD=report npm test');
    expect(find(cards([agent({ says: undefined, doing: undefined })]).box, (n) => n.cls?.startsWith('adoing')).text).toBe('Starting');
  });

  const DRAW_SRC = pick(/function drawEntry\(e\) \{[\s\S]*?\n {2}\}\n/);
  const draw = (e) => new Function('input', `${NODE}\n${DRAW_SRC}\nreturn drawEntry(input);`)(e);

  it('draws each kind of entry from text nodes only', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    for (const e of [{ kind: 'task', text: evil }, { kind: 'text', text: evil }, { kind: 'user', text: evil }, { kind: 'tool', says: evil, raw: evil }, { kind: 'result', text: evil }, { kind: 'result', error: true, text: evil, cut: 9000 }, { kind: 'text', report: true, text: evil }]) {
      const n = draw(e);
      expect(all(n, (x) => ['img', 'script'].includes(x.tag)), JSON.stringify(e)).toEqual([]);
      expect(textOf(n)).toContain(evil);
    }
  });

  it('draws the task, the words, the folded tool call and result, and the final report', () => {
    const task = draw({ kind: 'task', text: 'Build ACME-1' });
    expect(find(task, (n) => n.tag === 'h3').text).toBe('Task');
    expect(find(task, (n) => n.tag === 'pre').cls).toContain('ctext');
    expect(draw({ kind: 'text', text: 'Hello' }).tag).toBe('pre');
    expect(draw({ kind: 'user', text: 'Hi' }).tag).toBe('pre');
    const tool = draw({ kind: 'tool', says: 'Run the tests', raw: 'npm test' });
    expect(tool.tag).toBe('details');
    expect(tool.children[0].tag).toBe('summary');
    expect(tool.children[0].text).toBe('Run the tests');
    expect(find(tool, (n) => n.tag === 'pre').text).toBe('npm test');
    expect(textOf(draw({ kind: 'result', text: 'ok' }).children[0])).toBe('Result');
    expect(textOf(draw({ kind: 'result', error: true, text: 'no' }).children[0])).toBe('Error');
    expect(textOf(draw({ kind: 'result', text: 'ok', cut: 5000 }).children[0])).toBe('Result (cut)');
    const report = draw({ kind: 'text', report: true, text: 'All done.' });
    expect(report.tag).toBe('section');
    expect(find(report, (n) => n.tag === 'h3').text).toBe('Final report');
    expect(find(report, (n) => n.tag === 'pre').text).toBe('All done.');
  });

  const STAMP_SRC = [pick(/const convoTime = [^\n]+/), DRAW_SRC, pick(/function stampEntry\(e\) \{[\s\S]*?\n {2}\}\n/), pick(/function inOrder\(entries\) \{[\s\S]*?\n {2}\}\n/)].join('\n');
  const stamp = (e) => new Function('input', `${NODE}\n${STAMP_SRC}\nreturn stampEntry(input);`)(e);
  const ordered = (list) => new Function('input', `${NODE}\n${STAMP_SRC}\nreturn inOrder(input);`)(list);

  it('dates each entry, above what it says', () => {
    const at = '2026-10-31T15:23:07.000Z';
    const n = stamp({ kind: 'text', at, text: 'Hello' });
    expect(n.cls).toBe('centry');
    const time = n.children[0];
    expect(time.tag).toBe('time');
    expect(time.attrs.datetime).toBe(at);
    const d = new Date(at);
    expect(time.text).toContain(String(d.getDate()));
    expect(time.text).toContain(d.toLocaleString(undefined, { month: 'short' }));
    expect(time.text).toContain(String(d.getFullYear()));
    expect(time.text).toMatch(/\d\d:\d\d:\d\d/);
    expect(n.children[1].tag).toBe('pre');
    expect(textOf(n.children[1])).toBe('Hello');
    // No time in the transcript: the entry alone, without an empty stamp.
    const bare = stamp({ kind: 'text', text: 'Hi' });
    expect(bare.children.map((c) => c.tag)).toEqual(['pre']);
    expect(stamp({ kind: 'text', at: 'not a date', text: 'Hi' }).children.map((c) => c.tag)).toEqual(['pre']);
  });

  it('puts a page of entries oldest first, keeping ties and undated entries where they were', () => {
    const list = [
      { i: 0, at: '2026-10-31T10:00:02.000Z' },
      { i: 1, at: '2026-10-31T10:00:01.000Z' },
      { i: 2 },
      { i: 3, at: '2026-10-31T10:00:01.000Z' },
      { i: 4, at: '2026-10-31T10:00:03.000Z' },
    ];
    expect(ordered(list).map((e) => e.i)).toEqual([1, 2, 3, 0, 4]);
    expect(ordered([{ i: 0 }, { i: 1, at: '2026-10-31T10:00:00.000Z' }]).map((e) => e.i)).toEqual([0, 1]);
    expect(ordered([]).length).toBe(0);
  });

  it('draws the dated entries in time order and keeps paging by index', () => {
    const load = SCRIPT.match(/async function convoLoad\([^)]*\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(load).toContain('inOrder(data.entries || []).map(stampEntry)');
    expect(load).toContain('Math.max(...');
    expect(PAGE).toContain('.centry{display:grid;gap:4px;min-width:0}');
    expect(PAGE).toContain('.centry > *{margin:0;min-width:0}');
    expect(PAGE).toMatch(/\.ctime\{[^}]*font-size:11\.5px[^}]*color:var\(--dim\)/);
  });

  it('keeps the agent cards to a readable width', () => {
    expect(PAGE).toContain('.lmore .agents{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(280px,420px))}');
  });

  it('builds the conversation with el() and textContent only', () => {
    for (const name of ['drawEntry', 'stampEntry','openConversation', 'closeConversation', 'convoLoad', 'agentCards', 'lane']) {
      const body = SCRIPT.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n {2}\\}\\n`))[0];
      expect(body, name).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write/);
    }
    expect(SCRIPT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write/);
    expect(SCRIPT).not.toContain('localStorage.setItem(\'convo');
  });

  it('reads the conversation from the two routes and polls every 3 seconds', () => {
    expect(SCRIPT).toContain('/api/agents/');
    expect(SCRIPT).toContain('/api/slots/');
    expect(SCRIPT).toContain('CONVO_POLL_MS = 3000');
    expect(SCRIPT).toContain("'/transcript");
    const load = SCRIPT.match(/async function convoLoad\([^)]*\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(load).toContain('?after=');
    expect(load).toContain('?before=');
    expect(load).toContain('no longer kept');
    expect(SCRIPT.match(/\bTOKEN\b/g).length).toBe(5);
  });

  it('has a static dialog outside the lanes, labelled by its heading', () => {
    expect(PAGE).toContain('<dialog id="convo" aria-labelledby="convo-h">');
    expect(PAGE.indexOf('<dialog id="convo"')).toBeGreaterThan(PAGE.indexOf('id="lanes"'));
    for (const id of ['convo-h', 'convo-sub', 'convo-earlier', 'convo-body', 'convo-close']) expect(PAGE).toContain(`id="${id}"`);
    expect(PAGE.indexOf('<dialog id="convo"')).toBeLessThan(PAGE.indexOf('<script>'));
  });

  it('keeps the conversation inside a phone screen', () => {
    expect(PAGE).toContain('#convo{width:min(920px,calc(100vw - 16px));max-height:90vh}');
    expect(PAGE).toContain('#convo pre{white-space:pre-wrap;overflow-wrap:anywhere}');
    expect(PAGE).toContain('@media (max-width:640px){#convo{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;margin:0;border-radius:0}}');
    for (const cls of ['.araw', '.amodel', '.anote', '.lmodel']) expect(PAGE, cls).toContain(`${cls}{`);
  });

  it('keeps the model tags and the command toggle their own size, inside their column', () => {
    // A grid item stretches to its column: the tags and the toggle sit at the start instead.
    expect(PAGE).toContain('.agent > .amodel,.agent > .linkbtn{justify-self:start;width:max-content;max-width:100%}');
    // The slot column is fixed: the model tag wraps under the chip rather than into the story.
    expect(PAGE).toContain('.c-slot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-width:0}');
    expect(PAGE).toMatch(/\.lmodel\{[^}]*max-width:100%[^}]*overflow:hidden[^}]*text-overflow:ellipsis/);
  });

  it('shows the slot\'s model and its finished agents in the lane', () => {
    const body = SCRIPT.match(/function lane\(s\) \{[\s\S]*?\n {2}\}\n/)[0];
    expect(body).toMatch(/el\('span', 'lmodel', s\.model\)/);
    expect(body).toContain("'Finished · '");
    expect(body).toContain('s.finished');
    expect(body).toContain('viewButton(');
  });

  // The conversation dialog run against the page's own convoLoad, openConversation and
  // closeConversation, with a fake DOM, fake timers and an api that answers from `queue` in turn:
  // an Error is thrown, anything else (a value or a promise) is awaited. A request with nothing
  // queued throws, so a loop that polls too often fails the test instead of hanging.
  const makeNode = new Function(`${NODE}\nreturn node;`)();
  const convoHarness = (queue) => {
    const paths = [];
    const timers = [];
    const api = async (path) => {
      paths.push(path);
      if (!queue.length) throw new Error('unexpected request ' + path);
      const a = queue.shift();
      if (a instanceof Error) throw a;
      return await a;
    };
    const setTimeout = (fn, ms) => { const t = { id: timers.length + 1, fn, ms, cleared: false, fired: false }; timers.push(t); return t.id; };
    const clearTimeout = (id) => { const t = timers.find((x) => x.id === id); if (t) t.cleared = true; };
    const nodes = {
      'convo-h': makeNode('h2'),
      'convo-sub': makeNode('p'),
      'convo-body': Object.assign(makeNode('div'), { scrollHeight: 0, scrollTop: 0, clientHeight: 0 }),
      'convo-earlier': makeNode('button'),
      convo: Object.assign(makeNode('dialog'), { open: false, showModal() { this.open = true; }, close() { this.open = false; } }),
    };
    const src = new Function('api', 'setTimeout', 'clearTimeout', 'document', 'CSS', 'el', '$', `
      let convo = null;
      ${pick(/const CONVO_POLL_MS = [^\n]+/)}
      ${pick(/const CONVO_WAIT_TRIES = [^\n]+/)}
      ${STAMP_SRC}
      ${pick(/const convoAtBottom = [^\n]+/)}
      ${pick(/const convoToBottom = [^\n]+/)}
      ${pick(/async function convoLoad\(mode\) \{[\s\S]*?\n {2}\}\n/)}
      ${pick(/function openConversation\(target, opener\) \{[\s\S]*?\n {2}\}\n/)}
      ${pick(/function closeConversation\(\) \{[\s\S]*?\n {2}\}\n/)}
      return { convoLoad, openConversation, closeConversation };
    `)(api, setTimeout, clearTimeout, { querySelector: () => null }, { escape: (s) => s }, makeNode, (id) => nodes[id]);
    const pending = () => timers.filter((t) => !t.cleared && !t.fired);
    return {
      paths, nodes, pending,
      open: (target) => src.openConversation(target),
      load: (mode) => src.convoLoad(mode),
      close: () => src.closeConversation(),
      // Runs the one pending timer; returns what it started, so a test can await it or not.
      fire() {
        const due = pending();
        expect(due).toHaveLength(1);
        due[0].fired = true;
        return due[0].fn();
      },
      body: () => nodes['convo-body'],
      bodyText: () => textOf(nodes['convo-body']),
      sub: () => nodes['convo-sub'].text,
    };
  };
  const entry = (i, text = 'entry ' + i) => ({ i, kind: 'text', text });
  const notKept = Object.assign(new Error('gone'), { status: 404 });
  const running = { kind: 'agent', id: 'a1', title: 'Builder', running: true };
  const PATH = '/api/agents/a1/transcript';

  it('polls with ?after= and draws a new entry', async () => {
    const h = convoHarness([{ running: true, total: 2, first: 0, entries: [entry(0), entry(1)] }, { running: true, entries: [entry(2, 'brand new')] }]);
    await h.open(running);
    expect(h.body().children).toHaveLength(2);
    expect(h.pending().map((t) => t.ms)).toEqual([3000]);
    await h.fire();
    expect(h.paths.at(-1)).toBe(PATH + '?after=1');
    expect(h.body().children).toHaveLength(3);
    expect(h.bodyText()).toContain('brand new');
    expect(h.pending().map((t) => t.ms)).toEqual([3000]);
  });

  it('on the end: one more fetch, the report drawn, no further timer', async () => {
    const h = convoHarness([
      { running: true, total: 2, first: 0, entries: [entry(0), entry(1)] },
      { running: false, entries: [] },
      { running: false, total: 3, first: 0, entries: [entry(0), entry(1), { i: 2, kind: 'text', report: true, text: 'All done.' }] },
    ]);
    await h.open(running);
    await h.fire();
    expect(h.paths.slice(-2)).toEqual([PATH + '?after=1', PATH]);
    expect(h.pending()).toEqual([]);
    expect(h.bodyText()).toContain('Final report');
    expect(h.bodyText()).toContain('All done.');
    expect(h.sub()).toContain('Finished');
  });

  it('an empty transcript at open never asks after=-1', async () => {
    const h = convoHarness([
      { running: true, total: 0, first: 0, entries: [] },
      { running: true, total: 1, first: 0, entries: [entry(0, 'first words')] },
      { running: true, entries: [] },
    ]);
    await h.open(running);
    await h.fire();
    expect(h.paths.at(-1)).toBe(PATH);
    expect(h.bodyText()).toContain('first words');
    await h.fire();
    expect(h.paths.at(-1)).toBe(PATH + '?after=0');
    expect(h.paths.filter((p) => p.includes('after=-1'))).toEqual([]);
  });

  it('Show earlier prepends the page before the first', async () => {
    const h = convoHarness([
      { first: 2, total: 4, entries: [entry(2), entry(3)], running: true },
      { first: 0, entries: [entry(0), entry(1)] },
    ]);
    await h.open(running);
    expect(h.nodes['convo-earlier'].hidden).toBe(false);
    await h.load('earlier');
    expect(h.paths.at(-1)).toBe(PATH + '?before=2');
    expect(h.body().children.map(textOf)).toEqual(['entry 0', 'entry 1', 'entry 2', 'entry 3']);
    expect(h.nodes['convo-earlier'].hidden).toBe(true);
    expect(h.pending()).toHaveLength(1);
  });

  it('Show earlier during a poll leaves one chain and draws nothing twice', async () => {
    let answerPoll;
    const poll = new Promise((r) => { answerPoll = r; });
    const h = convoHarness([
      { first: 1, total: 2, entries: [entry(1)], running: true },
      poll,
      { first: 0, entries: [entry(0)] },
    ]);
    await h.open(running);
    const inFlight = h.fire();
    await h.load('earlier');
    answerPoll({ running: true, entries: [entry(1), entry(2)] });
    await inFlight;
    expect(h.pending()).toHaveLength(1);
    expect(h.body().children.map(textOf)).toEqual(['entry 0', 'entry 1', 'entry 2']);
  });

  it("only one Show earlier runs at a time", async () => {
    let answerEarlier;
    const earlier = new Promise((r) => { answerEarlier = r; });
    const h = convoHarness([{ first: 1, total: 2, entries: [entry(1)], running: true }, earlier]);
    await h.open(running);
    const one = h.load('earlier');
    await h.load('earlier');
    expect(h.paths).toHaveLength(2);
    answerEarlier({ first: 0, entries: [entry(0)] });
    await one;
    expect(h.body().children).toHaveLength(2);
  });

  it('drops a Show earlier answer when the page was drawn again meanwhile', async () => {
    let answerEarlier;
    const earlier = new Promise((r) => { answerEarlier = r; });
    const h = convoHarness([
      { first: 2, total: 4, entries: [entry(2), entry(3)], running: true },
      earlier,
      { first: 4, total: 6, entries: [entry(4), entry(5)], running: true },
    ]);
    await h.open(running);
    const one = h.load('earlier');
    await h.load('first');
    answerEarlier({ first: 0, entries: [entry(0), entry(1)] });
    await one;
    expect(h.body().children.map(textOf)).toEqual(['entry 4', 'entry 5']);
    expect(h.pending()).toHaveLength(1);
  });

  it("a running card's first 404 waits and tries again", async () => {
    const h = convoHarness([notKept, notKept, { running: true, total: 1, first: 0, entries: [entry(0)] }]);
    await h.open(running);
    expect(h.sub()).toBe('Waiting for the conversation to start…');
    expect(h.bodyText()).not.toContain('no longer kept');
    expect(h.pending().map((t) => t.ms)).toEqual([3000]);
    await h.fire();
    expect(h.pending()).toHaveLength(1);
    await h.fire();
    expect(h.bodyText()).toContain('entry 0');
    expect(h.sub()).toContain('Running');
  });

  it('gives up after CONVO_WAIT_TRIES', async () => {
    const h = convoHarness(Array.from({ length: 6 }, () => notKept));
    await h.open(running);
    for (let n = 0; n < 5; n++) await h.fire();
    expect(h.paths).toHaveLength(6);
    expect(h.bodyText()).toContain('no longer kept');
    expect(h.pending()).toEqual([]);
  });

  it("a finished agent's 404 says no longer kept at once", async () => {
    const h = convoHarness([notKept]);
    await h.open({ kind: 'agent', id: 'a1', title: 'Builder' });
    expect(h.paths).toHaveLength(1);
    expect(h.bodyText()).toContain('no longer kept');
    expect(h.pending()).toEqual([]);
  });

  it('a 404 after the conversation was read means it ended', async () => {
    const h = convoHarness([{ running: true, total: 1, first: 0, entries: [entry(0)] }, notKept]);
    await h.open(running);
    await h.fire();
    expect(h.bodyText()).toContain('no longer kept');
    expect(h.pending()).toEqual([]);
  });

  it('a failed poll shows the error and keeps polling; a failed Show earlier starts no second chain', async () => {
    const h = convoHarness([
      { first: 1, total: 2, entries: [entry(1)], running: true },
      Object.assign(new Error('Server hiccup'), { status: 500 }),
      Object.assign(new Error('Earlier hiccup'), { status: 500 }),
    ]);
    await h.open(running);
    await h.fire();
    expect(h.sub()).toBe('Server hiccup');
    expect(h.pending().map((t) => t.ms)).toEqual([3000]);
    await h.load('earlier');
    expect(h.sub()).toBe('Earlier hiccup');
    expect(h.pending()).toHaveLength(1);
  });

  it('closing stops the poll and drops a late answer', async () => {
    let answerPoll;
    const poll = new Promise((r) => { answerPoll = r; });
    const h = convoHarness([{ running: true, total: 1, first: 0, entries: [entry(0)] }, poll]);
    await h.open(running);
    const inFlight = h.fire();
    h.close();
    expect(h.pending()).toEqual([]);
    answerPoll({ running: true, entries: [entry(1)] });
    await inFlight;
    expect(h.body().children).toHaveLength(1);
    expect(h.pending()).toEqual([]);
    expect(h.nodes.convo.open).toBe(false);
  });
});
