// Drives the dashboard page in headless Chrome over the DevTools protocol.
// Opt in: FOREMAN_BROWSER_IT=1 npm test (needs Chrome or Chromium; CHROME_PATH picks one).

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parseEnv } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDashboardServer } from './server.mjs';
import { loadConfig } from '../config/load.mjs';
import { add } from '../console/decisions.mjs';
import { OPTIONS } from '../engine/answers.mjs';
import { detect } from '../engine/init-helpers.mjs';
import { addItem, readLedger, updateItem } from '../engine/learning-store.mjs';
import { writeRun } from '../engine/run-record.mjs';
import { markSession } from '../engine/session-files.mjs';
import { setLoop, setSlot } from '../engine/state.mjs';
import { KEY_CARD } from '../setup/keys.mjs';
import { projectConfig } from '../setup/project.mjs';
import { PACKS } from '../../packs/index.mjs';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const KEYS = { ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, Escape: 27, Tab: 9, Enter: 13 };
const LONG = 60_000;

// CHROME_PATH, else Chrome where macOS puts it, else the first Chrome or Chromium on PATH.
function findChrome() {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    throw new Error(`CHROME_PATH is ${process.env.CHROME_PATH}, and there is no file there. Point CHROME_PATH at Chrome or Chromium.`);
  }
  if (existsSync(MAC_CHROME)) return MAC_CHROME;
  for (const dir of String(process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of NAMES) if (existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error('FOREMAN_BROWSER_IT=1 needs Chrome or Chromium, and none was found. Install one, or set CHROME_PATH to its program.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small DevTools protocol client: send(method, params) answers the reply with the same id.
function cdpClient(socket) {
  let next = 0;
  const waiting = new Map();
  socket.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id === undefined || !waiting.has(msg.id)) return;
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else resolve(msg.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject } of waiting.values()) reject(new Error('Chrome closed the connection.'));
    waiting.clear();
  });
  return {
    send(method, params = {}) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

describe.skipIf(process.env.FOREMAN_BROWSER_IT !== '1')('the dashboard in a real browser', () => {
  let chrome;
  let profile;
  let socket;
  let cdp;

  let dir;
  let state;
  let server;
  let base;
  let decisionId;
  const now = new Date('2026-10-15T09:00:00Z');
  const t = (min) => new Date(now - min * 60000).toISOString();

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expression}\n${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await evaluate(expression)) return;
      if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for: ${expression}`);
      await sleep(100);
    }
  };
  const key = async (name) => {
    const code = KEYS[name];
    // Enter's keyDown carries its text, as a real key press does, so a focused button activates.
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(type === 'keyDown' && name === 'Enter' ? { text: '\r' } : {}) });
    }
  };
  const type = (text) => cdp.send('Input.insertText', { text });
  const q = (s) => JSON.stringify(s);
  const list = async () => (await fetch(`${base}/api/waiting`)).json();

  // No headline by default, as an older status.json has none.
  function writeStatus(count, headline = null, later = 0) {
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
      waiting: { count, later, items: [], checkedAt: now.toISOString(), ...(headline ? { headline } : {}) },
      control: { paused: false, handledNextAt: null, handledWorkersAt: null },
    }));
  }

  // A project for 'Sample Shop' with a decision, an owner task and a parked slot waiting, its
  // dashboard served, and the page open on the Command centre with the list loaded.
  async function makeFactory() {
    dir = mkdtempSync(join(tmpdir(), 'foreman-browser-'));
    state = join(dir, '.foreman');
    mkdirSync(state, { recursive: true });
    writeFileSync(join(dir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Sample Shop' }, slots: 2, checks: [{ run: 'true', when: 'always' }] }));
    writeStatus(0);
    // The waiting list reads each slot's own file; status.json is what the Command centre shows.
    setSlot(state, 'w2', { state: 'parked', parkedFor: 'dirty', reason: 'Its folder has stray changes.' }, now);
    decisionId = add(state, { story: 'S-5', kind: 'decision', title: 'Which search engine?', options: ['Built in', 'Hosted'] }, now);
    mkdirSync(join(dir, 'stories'), { recursive: true });
    writeFileSync(join(dir, 'stories', 'ACME-3.md'), '---\nid: ACME-3\ntitle: Add the key (owner task)\nstatus: todo\n---\n\n## Progress notes\n\n_Newest first._\n');
    const { config } = loadConfig(dir);
    server = createDashboardServer({ root: dir, config, stateDir: state, env: {}, now: () => now });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const items = await list();
    writeStatus(items.length);
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining([decisionId, 'task:ACME-3', 'slot:w2']));

    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: `${base}/#run` });
    await waitFor(`location.origin === ${q(base)} && document.readyState === 'complete' && !!document.querySelector('#tab-run')`);
    await waitFor(`document.querySelector('#wait-count').textContent.trim() !== '' && !document.querySelector('#wait-list .empty')`);
    return items;
  }

  // Focus a button of the list once it is live, and click it.
  async function press(dataKey) {
    const sel = `[data-key=${q(dataKey)}]`;
    await waitFor(`!!document.querySelector(${q(sel)}) && !document.querySelector(${q(sel)}).disabled`);
    await evaluate(`(() => { const b = document.querySelector(${q(sel)}); b.focus(); b.click(); })()`);
  }

  // Every .sok line added to the list from now on, in window.__seen.
  const watchMessages = () => evaluate(`(() => {
    window.__seen = [];
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        for (const s of [n, ...n.querySelectorAll('.sok')]) if (s.matches('.sok')) window.__seen.push(s.textContent);
      }
    }).observe(document.querySelector('#wait-list'), { childList: true, subtree: true });
  })()`);

  beforeAll(async () => {
    const program = findChrome();
    profile = mkdtempSync(join(tmpdir(), 'foreman-chrome-'));
    const args = ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`];
    if (process.platform === 'linux') args.push('--no-sandbox');
    chrome = spawn(program, [...args, 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    const end = Date.now() + 15000;
    let port = '';
    while (!port) {
      if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) break;
      if (Date.now() > end) throw new Error(`Chrome (${program}) did not open its DevTools port within 15 s.`);
      await sleep(100);
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((x) => x.type === 'page');
    if (!page) throw new Error('Chrome opened no page to drive.');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to Chrome.')), { once: true });
    });
    cdp = cdpClient(socket);
    // Headless has no window focus of its own; this lets focus and key events behave as in a window.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }, LONG);

  afterAll(async () => {
    try { socket?.close(); } catch { /* gone already */ }
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      chrome.kill();
      const timer = setTimeout(() => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
      await exited;
      clearTimeout(timer);
    }
    if (profile) rmSync(profile, { recursive: true, force: true });
  }, LONG);

  let items;
  beforeEach(async () => { items = await makeFactory(); }, LONG);

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('the tab shows the count and stands out', async () => {
    expect(items).toHaveLength(3);
    expect(await evaluate(`document.querySelector('#wait-count').textContent`)).toBe(String(items.length));
    expect(await evaluate(`document.querySelector('#tab-waiting').classList.contains('hot')`)).toBe(true);
    const colour = (id) => evaluate(`getComputedStyle(document.querySelector('#${id}')).color`);
    expect(await colour('tab-waiting')).not.toBe(await colour('tab-settings'));
  }, LONG);

  it('arrow keys, Home and End move between the five tabs', async () => {
    const at = async () => evaluate(`(() => {
      const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
      const a = document.activeElement;
      return { id: a.id, selected: a.getAttribute('aria-selected'), view: !document.getElementById(a.getAttribute('aria-controls')).hidden,
        hash: location.hash, zero: tabs.filter((t) => t.tabIndex === 0).map((t) => t.id) };
    })()`);
    const expectAt = async (name) => {
      expect(await at()).toEqual({ id: `tab-${name}`, selected: 'true', view: true, hash: `#${name}`, zero: [`tab-${name}`] });
    };
    // Every required step is done here, so Set up is the last tab.
    await waitFor(`document.querySelector('#setup-count').textContent !== ''`);
    expect(await evaluate(`[...document.querySelectorAll('.tabs [role="tab"]')].map((t) => t.id)`)).toEqual(['tab-run', 'tab-insights', 'tab-waiting', 'tab-settings', 'tab-setup']);
    await evaluate(`document.querySelector('#tab-run').focus()`);
    await key('ArrowRight'); await expectAt('insights');
    await key('ArrowRight'); await expectAt('waiting');
    await key('ArrowRight'); await expectAt('settings');
    await key('ArrowRight'); await expectAt('setup');
    await key('ArrowRight'); await expectAt('run');
    await key('ArrowLeft'); await expectAt('setup');
    await key('Home'); await expectAt('run');
    await key('End'); await expectAt('setup');
  }, LONG);

  it('each card is labelled by its own heading', async () => {
    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`!document.querySelector('#view-waiting').hidden`);
    const cards = await evaluate(`[...document.querySelectorAll('#wait-list article')].map((a) => {
      const id = a.getAttribute('aria-labelledby');
      const h = document.getElementById(id);
      return { id, inside: !!h && h.tagName === 'H3' && a.contains(h) };
    })`);
    expect(cards).toHaveLength(items.length);
    for (const c of cards) expect(c.inside, c.id).toBe(true);
    const ids = cards.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^wcard-/);
  }, LONG);

  it('answering a decision shows the message on the card, then the card leaves and focus goes to the tab', async () => {
    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`!document.querySelector('#view-waiting').hidden`);
    await watchMessages();
    await press(`wait:${decisionId}:option-1`);
    await waitFor(`!document.querySelector(${q(`[data-key^="wait:${decisionId}:"]`)})`);
    await waitFor(`document.activeElement.id === 'view-waiting'`);
    expect(await evaluate('window.__seen.length')).toBeGreaterThan(0);
    expect(await evaluate(`document.querySelector('#wait-count').textContent`)).toBe('2');
    const decisions = await (await fetch(`${base}/api/decisions`)).json();
    expect(decisions.find((d) => d.id === decisionId).answer).toMatchObject({ option: 'Hosted' });
  }, LONG);

  it('Mark done takes the owner task off the list', async () => {
    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`!document.querySelector('#view-waiting').hidden`);
    await watchMessages();
    await press('wait:task:ACME-3:done');
    await waitFor(`!document.querySelector('[data-key^="wait:task:ACME-3:"]')`);
    await waitFor(`document.activeElement.id === 'view-waiting'`);
    expect(await evaluate('window.__seen.length')).toBeGreaterThan(0);
    expect((await list()).some((i) => i.id === 'task:ACME-3')).toBe(false);
  }, LONG);

  it('Escape closes the waiting discard confirm and puts focus back on its button', async () => {
    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`!document.querySelector('#view-waiting').hidden`);
    // Only opens the confirm and leaves it: its Discard button would reset a folder.
    await press('wait:slot:w2:discard');
    await waitFor(`document.activeElement.dataset.key === 'wait:slot:w2:discard:no'
      && !!document.querySelector('[data-key="wait:slot:w2:discard:no"]').closest('article').querySelector('.confirm')`);
    await key('Escape');
    await waitFor(`!document.querySelector('#wait-list .confirm') && document.activeElement.dataset.key === 'wait:slot:w2:discard'`);
    expect((await list()).some((i) => i.id === 'slot:w2')).toBe(true);
  }, LONG);

  it('a redraw while typing keeps the note and the caret', async () => {
    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`!document.querySelector('#view-waiting').hidden`);
    const note = `[data-key=${q(`wait:${decisionId}:note`)}]`;
    await waitFor(`!!document.querySelector(${q(note)})`);
    await evaluate(`document.querySelector(${q(note)}).focus()`);
    await type('cheaper option');
    await evaluate(`document.activeElement.setSelectionRange(3, 5)`);

    add(state, { story: 'S-6', kind: 'decision', title: 'Pick a colour', options: ['Red', 'Blue'] }, now);
    writeStatus(items.length + 1);
    await waitFor(`document.querySelector('#wait-list').textContent.includes('Pick a colour')`);
    expect(await evaluate(`(() => { const a = document.activeElement;
      return { tag: a.tagName, key: a.dataset.key, value: a.value, start: a.selectionStart, end: a.selectionEnd }; })()`))
      .toEqual({ tag: 'TEXTAREA', key: `wait:${decisionId}:note`, value: 'cheaper option', start: 3, end: 5 });
  }, LONG);

  it('shows each slot as one row, and opens its agents and buttons below it, still open after a redraw', async () => {
    await evaluate(`location.hash = '#run'`);
    await waitFor(`document.querySelectorAll('#lanes > .lane > .lrow').length === 2`);
    const row = (id) => `[aria-labelledby="lane-${id}"]`;
    // The parked slot says why in its row; the building slot names its story and stage.
    expect(await evaluate(`document.querySelector(${q(row('w2') + ' .c-reason')}).textContent`)).toBe('Its folder has stray changes.');
    expect(await evaluate(`document.querySelector(${q(row('w1') + ' .c-story')}).textContent`)).toContain('Add the search box');
    expect(await evaluate(`document.querySelector(${q(row('w1') + ' .c-cap')}).textContent`)).toBe('Build');
    // Closed: the buttons are not shown until the row opens.
    const shown = (sel) => evaluate(`(() => { const n = document.querySelector(${q(sel)}); return !!n && n.offsetParent !== null; })()`);
    const expanded = () => evaluate(`document.querySelector(${q(row('w1') + ' .c-toggle')}).getAttribute('aria-expanded')`);
    expect(await expanded()).toBe('false');
    expect(await shown('[data-key="w1:skip"]')).toBe(false);
    await evaluate(`document.querySelector(${q(row('w1') + ' .c-story')}).click()`);
    expect(await expanded()).toBe('true');
    expect(await shown('[data-key="w1:skip"]')).toBe(true);
    expect(await shown(row('w1') + ' .agent')).toBe(true);
    // A redraw keeps it open; the chevron closes it.
    writeStatus(items.length);
    await sleep(1500);
    expect(await expanded()).toBe('true');
    await evaluate(`document.querySelector(${q(row('w1') + ' .c-toggle')}).click()`);
    expect(await expanded()).toBe('false');
    expect(await shown('[data-key="w1:skip"]')).toBe(false);
  }, LONG);

  it('switches the run details card between its tabs', async () => {
    await evaluate(`location.hash = '#run'`);
    await waitFor(`!document.querySelector('#view-run').hidden`);
    const visible = () => evaluate(`[...document.querySelectorAll('.tabpane')].filter((p) => !p.hidden).map((p) => p.id)`);
    expect(await visible()).toEqual(['pane-feed']);
    await evaluate(`document.querySelector('#sub-done').click()`);
    expect(await visible()).toEqual(['pane-done']);
    expect(await evaluate(`document.querySelector('#pane-done').textContent`)).toContain('List the products');
    await evaluate(`document.querySelector('#sub-done').focus()`);
    await key('ArrowRight');
    expect(await evaluate('document.activeElement.id')).toBe('sub-prog');
    expect(await visible()).toEqual(['pane-prog']);
  }, LONG);

  it('folds the waiting sections: open where something needs the owner, each heading a button that stays as left', async () => {
    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`document.querySelectorAll('#wait-list > .wsec.acc').length === 2`);
    const state = () => evaluate(`[...document.querySelectorAll('#wait-list > .wsec')].map((s) => [s.id, s.querySelector('.acc-btn').getAttribute('aria-expanded'), s.querySelector('.decs').offsetParent !== null])`);
    expect(await state()).toEqual([['wsec-now', 'true', true], ['wsec-tasks', 'true', true]]);
    await evaluate(`document.querySelector('#wsec-tasks .acc-btn').focus()`);
    await key('Enter');
    expect(await state()).toEqual([['wsec-now', 'true', true], ['wsec-tasks', 'false', false]]);
    writeStatus(items.length + 1);
    await sleep(1500);
    expect((await state())[1]).toEqual(['wsec-tasks', 'false', false]);
  }, LONG);

  it('the Insights tab shows four numbers and five charts, each bar telling its values on focus', async () => {
    writeRun(state, { story: 'S-4', slot: 'w1', result: 'shipped', costUsd: 2.5, minutes: 50, rounds: 1, stages: { architect: 5, build: 30, test: 5, review: 10 }, startedAt: t(90), endedAt: t(40),
      agents: [{ role: 'builder', input: 1000, output: 500, cacheRead: 500, cacheWrite: 0 }, { role: 'architect', input: 500, output: 0, cacheRead: 0, cacheWrite: 0 }] });
    await evaluate(`location.hash = '#insights'`);
    await waitFor(`document.querySelectorAll('#insights .vtile').length === 4 && document.querySelectorAll('#insights .vcard').length === 5`);
    // Tokens per shipped story: the average so far, and a bar per agent.
    const per = `[...document.querySelectorAll('#insights .vcard')][4]`;
    expect(await evaluate(`${per}.querySelector('.ph').textContent`)).toBe('Tokens per shipped story');
    expect(await evaluate(`${per}.querySelector('.vbig').textContent`)).toContain('3K');
    expect(await evaluate(`[...${per}.querySelectorAll('.vbar')].map((b) => b.getAttribute('aria-label'))`)).toEqual(['Builder: 2K', 'Architect: 500']);
    expect(await evaluate(`[...document.querySelectorAll('#insights .vtile .vtl')].map((n) => n.textContent)`)).toEqual(['Stories shipped', 'Ship rate', 'Typical time to ship', 'Spend']);
    expect(await evaluate(`document.querySelector('#insights .vtile .vtv').textContent`)).toBe('1');
    // The last day's column says what it holds, to a pointer and to the keyboard alike.
    const col = `[...document.querySelectorAll('#insights .vcard')][0].querySelector('.vcol:last-child')`;
    expect(await evaluate(`${col}.getAttribute('aria-label')`)).toMatch(/: 1 shipped, 0 did not ship$/);
    await evaluate(`${col}.focus()`);
    await waitFor(`!document.querySelector('.vtip').hidden && document.querySelector('.vtip').textContent.includes('Shipped')`);
    // Every chart has its numbers as a table too.
    expect(await evaluate(`[...document.querySelectorAll('#insights .vcard')].every((c) => !!c.querySelector('details.vtable table'))`)).toBe(true);
  }, LONG);

  it('the Command centre summary shows the count and top item, and its link opens and focuses the tab', async () => {
    await evaluate(`location.hash = '#run'`);
    await waitFor(`!document.querySelector('#view-run').hidden`);
    const summary = await evaluate(`document.querySelector('#wait-summary').textContent`);
    expect(summary).toContain('3 things are waiting on you.');
    expect(summary).toContain(items[0].title);
    expect(await evaluate(`document.querySelector('#wait-tag').textContent`)).toBe('3 to answer');
    await evaluate(`document.querySelector('#wait-open').click()`);
    expect(await evaluate(`(() => { const t = document.querySelector('#tab-waiting');
      return { selected: t.getAttribute('aria-selected'), focused: document.activeElement === t, hash: location.hash, shown: !document.querySelector('#view-waiting').hidden }; })()`))
      .toEqual({ selected: 'true', focused: true, hash: '#waiting', shown: true });
  }, LONG);

  it('the tab badge counts now items, and Later is collapsed with its count in the heading', async () => {
    writeFileSync(join(dir, 'stories', 'ACME-8.md'), '---\nid: ACME-8\ntitle: Build the proof\nstatus: todo\n---\n');
    writeFileSync(join(dir, 'stories', 'ACME-9.md'), '---\nid: ACME-9\ntitle: Run the proof (owner task)\nstatus: todo\ndepends_on: [ACME-8]\n---\n');
    const all = await list();
    expect(all).toHaveLength(4);
    expect(all.find((i) => i.id === 'task:ACME-9')).toMatchObject({ group: 'later', waitsOn: ['ACME-8'] });

    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#wait-later')`);
    expect(await evaluate(`document.querySelector('#wait-count').textContent`)).toBe('3');
    expect(await evaluate(`document.querySelector('#wait-tag').textContent`)).toBe('3 to answer');
    expect(await evaluate(`document.querySelector('#wait-later').open`)).toBe(false);
    expect(await evaluate(`document.querySelector('#wait-later summary').textContent`)).toBe('Later (1)');
    const li = await evaluate(`document.querySelector('#wait-later li').textContent`);
    expect(li).toContain('Run the proof (owner task)');
    expect(li).toContain('Can start after ACME-8.');
    expect(await evaluate(`!!document.querySelector('#wait-later [data-key="wait:task:ACME-9:done"]')`)).toBe(true);
    expect(await evaluate(`document.querySelectorAll('#wait-list article').length`)).toBe(3);

    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`!document.querySelector('#view-waiting').hidden`);
    await evaluate(`document.querySelector('#wait-later summary').click()`);
    await waitFor(`document.querySelector('#wait-later').open`);
    // A new item redraws the list: Later stays as the owner left it.
    add(state, { story: 'S-6', kind: 'decision', title: 'Pick a colour', options: ['Red', 'Blue'] }, now);
    writeStatus(4);
    await waitFor(`document.querySelector('#wait-list').textContent.includes('Pick a colour')`);
    expect(await evaluate(`document.querySelector('#wait-later').open`)).toBe(true);

    await press('wait:task:ACME-9:done');
    await waitFor(`!document.querySelector('[data-key^="wait:task:ACME-9:"]')`);
    expect((await list()).some((i) => i.id === 'task:ACME-9')).toBe(false);
  }, LONG);

  // Owner tasks with a blocker still open: ACME-9 waits on ACME-8, so it sits under Later.
  const addLater = () => {
    writeFileSync(join(dir, 'stories', 'ACME-8.md'), '---\nid: ACME-8\ntitle: Build the proof\nstatus: todo\n---\n');
    writeFileSync(join(dir, 'stories', 'ACME-9.md'), '---\nid: ACME-9\ntitle: Run the proof (owner task)\nstatus: todo\ndepends_on: [ACME-8]\n---\n');
  };
  const openWaiting = async () => {
    await evaluate(`location.hash = '#waiting'`);
    await waitFor(`!document.querySelector('#view-waiting').hidden`);
  };

  it('sections appear in order with headings', async () => {
    await openWaiting();
    const sections = await evaluate(`[...document.querySelectorAll('#wait-list > section.wsec')].map((s) => {
      const h = document.getElementById(s.getAttribute('aria-labelledby'));
      return { id: s.id, heading: h ? h.textContent : null, own: !!h && h.tagName === 'H2' && h.parentElement === s };
    })`);
    expect(sections.map((s) => s.id)).toEqual(['wsec-now', 'wsec-tasks']);
    expect(sections.map((s) => s.heading)).toEqual(['Needs you now (2)', 'Your tasks (1)']);
    for (const s of sections) expect(s.own, s.id).toBe(true);
    const within = (sec, dataKey) => evaluate(`!!document.querySelector(${q(`#${sec} [data-key="${dataKey}"]`)})`);
    expect(await within('wsec-tasks', 'wait:task:ACME-3:done')).toBe(true);
    expect(await within('wsec-now', `wait:${decisionId}:option-1`)).toBe(true);
    expect(await within('wsec-now', 'wait:slot:w2:discard')).toBe(true);
    expect(await within('wsec-now', 'wait:task:ACME-3:done')).toBe(false);
    expect(await evaluate(`!!document.querySelector('#wsec-quick') || !!document.querySelector('#wsec-fyi')`)).toBe(false);

    addLater();
    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#wait-later') && !!document.querySelector('#wsec-tasks')`);
    expect(await evaluate(`!!(document.querySelector('#wsec-tasks').compareDocumentPosition(document.querySelector('#wait-later')) & Node.DOCUMENT_POSITION_FOLLOWING)`)).toBe(true);
    expect(await evaluate(`document.querySelector('#wait-later').parentElement.id`)).toBe('wait-list');
  }, LONG);

  it('FYI shows why picking is paused, with no buttons and no change to the badge', async () => {
    const since = new Date(t(10));
    const hhmm = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`;
    setLoop(state, 'paused', `Jira not reachable since ${hhmm}: fetch failed; picking paused, stories in progress carry on`, since);
    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#wsec-fyi')`);
    await openWaiting();
    expect(await evaluate(`document.getElementById(document.querySelector('#wsec-fyi').getAttribute('aria-labelledby')).textContent`)).toBe('FYI (1)');
    expect(await evaluate(`document.querySelectorAll('#wsec-fyi article').length`)).toBe(1);
    expect(await evaluate(`document.querySelector('#wsec-fyi article').textContent`)).toContain('Picking paused since');
    expect(await evaluate(`document.querySelectorAll('#wsec-fyi .decs button').length`)).toBe(0);
    expect(await evaluate(`document.querySelector('#wait-count').textContent`)).toBe(String(items.length));
    expect(items).toHaveLength(3);
  }, LONG);

  it('Later and Details are collapsed', async () => {
    addLater();
    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#wait-later')`);
    await openWaiting();
    expect(await evaluate(`document.querySelector('#wait-later').open`)).toBe(false);
    const fold = await evaluate(`(() => {
      const card = document.querySelector('[data-key="wait:task:ACME-3:done"]').closest('article');
      const d = card.querySelector('details.wdetails');
      return d && { open: d.open, key: d.querySelector('summary').dataset.key, text: d.querySelector('summary').textContent, body: d.textContent };
    })()`);
    expect(fold).toMatchObject({ open: false, key: 'wait:task:ACME-3:details', text: 'Details' });
    expect(fold.body).toContain('stories/ACME-3.md');

    const summary = '[data-key="wait:task:ACME-3:details"]';
    await evaluate(`(() => { const s = document.querySelector(${q(summary)}); s.focus(); s.click(); })()`);
    await waitFor(`document.querySelector(${q(summary)}).parentElement.open`);
    // A new item redraws the list: Details stays as the owner left it, with focus on its summary.
    add(state, { story: 'S-6', kind: 'decision', title: 'Pick a colour', options: ['Red', 'Blue'] }, now);
    writeStatus(4);
    await waitFor(`document.querySelector('#wait-list').textContent.includes('Pick a colour')`);
    expect(await evaluate(`document.querySelector(${q(summary)}).parentElement.open`)).toBe(true);
    expect(await evaluate(`document.activeElement.dataset.key`)).toBe('wait:task:ACME-3:details');
    expect(await evaluate(`document.querySelector('#wait-later').open`)).toBe(false);
  }, LONG);

  // Twelve follow-ups from `foreman learn`, S-10 to S-21, then the page reloaded on the tab.
  const addFollowUps = async () => {
    const ids = [];
    for (let n = 10; n <= 21; n += 1) {
      ids.push(add(state, { story: `S-${n}`, kind: 'decision', title: `Follow up on S-${n}: 2 minor finding(s)?`, options: ['Create a follow-up story', 'Ignore'], summary: '2 minor: a; b' }, new Date(now.getTime() + n * 1000)));
    }
    writeStatus(4);
    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#wsec-quick')`);
    await openWaiting();
    return ids;
  };

  it('Create all on 12 follow-ups empties Quick decisions and drops the count by one', async () => {
    await addFollowUps();
    expect(await evaluate(`document.querySelector('#wait-count').textContent`)).toBe('4');
    const quick = await evaluate(`(() => {
      const sec = document.querySelector('#wsec-quick');
      const cards = [...sec.querySelectorAll('article')];
      const b = sec.querySelector('article.wbundle');
      const h = b && document.getElementById(b.getAttribute('aria-labelledby'));
      return { cards: cards.length, bundles: sec.querySelectorAll('article.wbundle').length, lines: b ? b.querySelectorAll('li').length : 0,
        name: b && b.dataset.bundle, heading: h && b.contains(h) ? h.textContent : null, title: document.getElementById(sec.getAttribute('aria-labelledby')).textContent };
    })()`);
    expect(quick).toEqual({ cards: 1, bundles: 1, lines: 12, name: 'follow-ups', heading: '12 follow-ups from recent runs: 24 minor findings', title: 'Quick decisions (1)' });

    await press('wait:bundle:follow-ups:create-all');
    await waitFor(`document.activeElement.dataset.key === 'wait:bundle:follow-ups:create-all:no' && !!document.querySelector('#wsec-quick .confirm')`);
    expect(await evaluate(`document.querySelector('#wsec-quick .confirm').textContent`)).toContain('Create 12 follow-up stories?');
    expect((await list()).filter((i) => i.bundle)).toHaveLength(12);
    await press('wait:bundle:follow-ups:create-all:yes');
    await waitFor(`!document.querySelector('#wsec-quick')`);
    await waitFor(`document.querySelector('#wait-count').textContent === '3'`);
    expect((await list()).some((i) => i.bundle)).toBe(false);
    const decisions = await (await fetch(`${base}/api/decisions`)).json();
    expect(decisions.filter((d) => d.answer?.option === 'Create a follow-up story')).toHaveLength(12);
  }, LONG);

  it('Answer one by one shows each follow-up, and Escape closes the bundle confirm', async () => {
    const ids = await addFollowUps();
    const one = 'wait:bundle:follow-ups:one-by-one';
    expect(await evaluate(`document.querySelector(${q(`[data-key="${one}"]`)}).getAttribute('aria-expanded')`)).toBe('false');
    await press(one);
    await waitFor(`document.querySelector(${q(`[data-key="${one}"]`)}).getAttribute('aria-expanded') === 'true'`);
    expect(await evaluate(`document.querySelectorAll('#wsec-quick article:not(.wbundle)').length`)).toBe(12);
    expect(await evaluate(`document.querySelectorAll('#wsec-quick .decs').length`)).toBe(1);

    await press(`wait:${ids[0]}:option-1`);
    await waitFor(`!document.querySelector(${q(`[data-key^="wait:${ids[0]}:"]`)})`);
    expect(await evaluate(`document.querySelectorAll('#wsec-quick article:not(.wbundle)').length`)).toBe(11);
    expect(await evaluate(`document.querySelectorAll('#wsec-quick article.wbundle li').length`)).toBe(11);
    expect((await list()).filter((i) => i.bundle)).toHaveLength(11);

    await press('wait:bundle:follow-ups:ignore-all');
    await waitFor(`document.activeElement.dataset.key === 'wait:bundle:follow-ups:ignore-all:no' && !!document.querySelector('#wsec-quick .confirm')`);
    expect(await evaluate(`document.querySelector('#wsec-quick .confirm').textContent`)).toContain('Ignore all 11?');
    await key('Escape');
    await waitFor(`!document.querySelector('#wsec-quick .confirm') && document.activeElement.dataset.key === 'wait:bundle:follow-ups:ignore-all'`);
    expect((await list()).filter((i) => i.bundle)).toHaveLength(11);
  }, LONG);

  it('Tab order goes through cards and buttons as before', async () => {
    await openWaiting();
    await waitFor(`[...document.querySelectorAll('#wait-list button')].every((b) => !b.disabled)`);
    // What Tab should reach, in DOM order: nothing inside a closed fold but its summary.
    const expected = await evaluate(`[...document.querySelectorAll('#wait-list button, #wait-list textarea, #wait-list summary, #wait-list a[href]')]
      .filter((e) => !e.disabled)
      .filter((e) => { const d = e.parentElement.closest('details'); return !d || d.open || (e.tagName === 'SUMMARY' && e.parentElement === d); })
      .map((e) => e.dataset.key || e.tagName)`);
    expect(expected.length).toBeGreaterThan(0);
    await evaluate(`document.querySelector('#view-waiting').focus()`);
    const seen = [];
    for (let i = 0; i < expected.length; i += 1) {
      await key('Tab');
      seen.push(await evaluate(`document.activeElement.dataset.key || document.activeElement.tagName`));
    }
    expect(seen).toEqual(expected);
    expect(await evaluate(`document.querySelector('#wsec-now').contains(document.querySelector(${q(`[data-key="${seen[0]}"]`)}))`)).toBe(true);
    const actions = await evaluate(`[...document.querySelectorAll('#wait-list .dec button')].map((b) => b.dataset.key)`);
    for (const a of actions) expect(seen, a).toContain(a);
  }, LONG);

  it('the headline says why the factory is idle, and Go to it focuses the best card', async () => {
    // ACME-3 on purpose: its card is not the first one.
    const text = 'Building S-5. 3 things need you; none is stopping the run.';
    writeStatus(items.length, { state: 'running', text, best: 'task:ACME-3' });
    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !document.querySelector('#wait-list .empty') && !!document.querySelector('#wait-list article')`);
    await openWaiting();
    await waitFor(`!document.querySelector('#wait-head').hidden`);
    expect(await evaluate(`document.querySelector('#wait-headline').textContent`)).toBe(text);
    expect(await evaluate(`(() => { const a = document.querySelector('#wait-goto'); return !a.hidden && a.getBoundingClientRect().height > 0; })()`)).toBe(true);
    expect(await evaluate(`document.querySelector('#wait-list article').dataset.wid`)).not.toBe('task:ACME-3');

    await evaluate(`document.querySelector('#wait-goto').click()`);
    await waitFor(`document.activeElement && document.activeElement.dataset.wid === 'task:ACME-3'`);
    expect(await evaluate(`(() => {
      const a = document.activeElement;
      const r = a.getBoundingClientRect();
      return { tag: a.tagName, inTasks: document.querySelector('#wsec-tasks').contains(a),
        inView: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth };
    })()`)).toEqual({ tag: 'ARTICLE', inTasks: true, inView: true });

    await evaluate(`location.hash = '#run'`);
    await waitFor(`!document.querySelector('#view-run').hidden`);
    const summary = await evaluate(`document.querySelector('#wait-summary').textContent`);
    expect(summary).toContain(text);
    expect(summary).toContain('3 need you');
    expect(summary).not.toContain('First:');
  }, LONG);

  it('Go to it focuses the closed bundle when the best item is bundled', async () => {
    const ids = await addFollowUps();
    expect((await list()).find((i) => i.id === ids[0]).bundle).toBe('follow-ups');
    writeStatus(4, { state: 'running', text: 'Building S-5. 4 things need you; none is stopping the run.', best: ids[0] });
    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#wsec-quick article.wbundle')`);
    await openWaiting();
    await waitFor(`!document.querySelector('#wait-head').hidden`);
    // The bundle is closed, so the best item has no card of its own.
    expect(await evaluate(`!!document.querySelector(${q(`#wait-list article[data-wid="${ids[0]}"]`)})`)).toBe(false);
    expect(await evaluate(`document.querySelector('#wait-goto').hidden`)).toBe(false);

    await evaluate(`document.querySelector('#wait-goto').click()`);
    await waitFor(`document.activeElement && document.activeElement.dataset.bundle === 'follow-ups'`);
    expect(await evaluate(`(() => {
      const a = document.activeElement;
      const r = a.getBoundingClientRect();
      return { tag: a.tagName, inQuick: document.querySelector('#wsec-quick').contains(a),
        inView: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth };
    })()`)).toEqual({ tag: 'ARTICLE', inQuick: true, inView: true });
  }, LONG);

  it('Go to it says the item is gone when its card has been removed', async () => {
    writeStatus(items.length, { state: 'running', text: 'Building S-5. 3 things need you; none is stopping the run.', best: 'task:ACME-3' });
    await cdp.send('Page.reload');
    await waitFor(`document.readyState === 'complete' && !document.querySelector('#wait-list .empty') && !!document.querySelector('#wait-list article')`);
    await openWaiting();
    await waitFor(`!document.querySelector('#wait-head').hidden && !document.querySelector('#wait-goto').hidden`);

    // One evaluate, so no redraw can put the card back between the removal and the click.
    await evaluate(`(() => {
      document.querySelector('#wait-list article[data-wid="task:ACME-3"]').remove();
      document.querySelector('#wait-goto').click();
    })()`);
    await waitFor(`document.querySelector('#announce').textContent === 'That item is no longer waiting.'`);
    const focused = await evaluate(`(() => {
      const a = document.activeElement;
      return { wid: (a && a.dataset && a.dataset.wid) || null, tag: a ? a.tagName : null };
    })()`);
    expect(focused.wid).not.toBe('task:ACME-3');
    expect(focused.tag).not.toBe('ARTICLE');
  }, LONG);

  describe('what Foreman learned', () => {
    const V1 = 'Acme: give every new route a test.';
    const roleFile = () => join(state, 'learned/traits/developer.md');
    // The Learned list row of L-1 as text, and whether it has an Undo button.
    const row = () => evaluate(`(() => {
      const b = document.querySelector('[data-key="learned:L-1:undo"]');
      const r = [...document.querySelectorAll('#learned-list article')].find((a) => a.querySelector('h3')?.textContent.startsWith('L-1'));
      return r ? { text: r.textContent, undo: !!b, shown: !document.querySelector('#learned').hidden } : null;
    })()`);
    const trait = () => addItem(state, { kind: 'trait', roles: ['developer'], text: V1, source: { key: 'untested-routes', stories: ['S-4', 'S-5'] }, reason: 'two stories shipped untested routes' }, { now });

    it('one click on the FYI\'s Undo restores v1, records the owner\'s undo and takes the FYI away', async () => {
      trait();
      updateItem(state, 'L-1', { text: 'Acme: give every new route and every error path a test.', reason: 'a third story missed the error path' }, { now });
      const decId = add(state, { story: 'S-5', kind: 'decision', title: 'Foreman changed L-1 for developer', options: OPTIONS.learned }, now);
      await cdp.send('Page.reload');
      await waitFor(`document.readyState === 'complete' && !!document.querySelector('#wsec-fyi')`);
      await openWaiting();
      await waitFor(`!!document.querySelector('#learned-list article')`);
      expect((await row()).text).toContain('v2');

      await press(`wait:${decId}:undo`);
      await waitFor(`!document.querySelector(${q(`[data-key="wait:card:${decId}"]`)})`);
      expect(readFileSync(roleFile(), 'utf8')).toBe(`[L-1] ${V1}\n`);
      expect(readLedger(state).at(-1)).toMatchObject({ id: 'L-1', action: 'undo', by: 'owner', v: 1 });
      expect((await list()).some((i) => i.id === decId)).toBe(false);
      await waitFor(`(document.querySelector('#learned-list article')?.textContent || '').includes('v1')`);
      const r = await row();
      expect(r).toMatchObject({ undo: true, shown: true });
      expect(r.text).toContain('v1');
      expect(r.text).toContain('on trial');
    }, LONG);

    it('Undo in the Learned list removes a one-version trait, and the row then reads undone with no Undo', async () => {
      trait();
      await cdp.send('Page.reload');
      await waitFor(`document.readyState === 'complete' && !!document.querySelector('#tab-waiting')`);
      await openWaiting();
      await waitFor(`!!document.querySelector('[data-key="learned:L-1:undo"]')`);

      await press('learned:L-1:undo');
      await waitFor(`!document.querySelector('[data-key="learned:L-1:undo"]')`);
      expect(existsSync(roleFile())).toBe(false);
      expect(readLedger(state).at(-1)).toMatchObject({ id: 'L-1', action: 'undo', by: 'owner', v: 0 });
      const r = await row();
      expect(r.undo).toBe(false);
      expect(r.text).toContain('undone');
      expect(r.text).toContain('Undid L-1: removed.');
    }, LONG);

    it('hides the Learned list while nothing was learned', async () => {
      await openWaiting();
      await sleep(300);
      expect(await evaluate(`document.querySelector('#learned').hidden`)).toBe(true);
    }, LONG);
  });

  describe('the Help link', () => {
    afterEach(async () => {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    });

    it('points at the user guide in a new tab, sits outside the tab list, and #help opens the Command centre', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
      await cdp.send('Page.navigate', { url: `${base}/` });
      await waitFor(`document.readyState === 'complete' && !!document.querySelector('#help-link')`);
      expect(await evaluate(`document.querySelector('#help-link').getAttribute('href')`)).toBe('https://finefactory.ai/apps/foreman/docs/');
      expect(await evaluate(`document.querySelector('#help-link').target`)).toBe('_blank');
      expect(await evaluate(`document.querySelector('#help-link').rel`)).toBe('noopener noreferrer');
      expect(await evaluate(`!!document.querySelector('#help-link').closest('[role="tablist"]')`)).toBe(false);
      expect(await evaluate(`document.querySelector('#help-link').getAttribute('role')`)).toBeNull();
      expect(await evaluate(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(360);
      await cdp.send('Page.navigate', { url: `${base}/#help` });
      await waitFor(`location.hash === '#help' && !document.querySelector('#view-run').hidden`);
    }, LONG);
  });

  // A project with no foreman.config.json: the dashboard in set-up mode, the page opened with no
  // hash on a 360 px screen. The step-check tests write a loadable config to get Test it; an
  // unloadable one would show the project form instead (FM-218).
  describe('the Set up tab', () => {
    let setupDir;
    let setupServer;
    let setupBase;
    let setupScript = null;
    const projectCheck = (run) => ({ name: 'config', step: 'project', run });
    const failing = () => ({ ok: false, level: 'error', detail: 'no foreman.config.json', fix: { step: 'project', hint: 'write it' } });
    const TITLE = `document.querySelector('#setup-step-title .sname')?.textContent`;

    // A foreman.config.json that loads, so the project step shows Test it rather than its form.
    const LOADS = JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 1, checks: [{ run: 'true', when: 'always' }] });

    // `configText`, when given, is written as foreman.config.json: an unloadable one shows the
    // project step's form (FM-218), a loadable one (LOADS) shows its Test it.
    async function openSetup({ run = failing, configText, beforeLoad } = {}) {
      // `beforeLoad`, when given, is a script that runs before the page's own on the load.
      setupDir = mkdtempSync(join(tmpdir(), 'foreman-browser-setup-'));
      if (configText !== undefined) writeFileSync(join(setupDir, 'foreman.config.json'), configText);
      const stateDir = join(setupDir, '.foreman');
      const doctor = () => Promise.resolve({ config: null, ctx: {}, checks: [projectCheck(run)] });
      setupServer = createDashboardServer({ root: setupDir, config: null, stateDir, env: {}, doctor });
      await new Promise((resolve) => setupServer.listen(0, '127.0.0.1', resolve));
      setupBase = `http://127.0.0.1:${setupServer.address().port}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
      if (beforeLoad !== undefined) setupScript = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: beforeLoad })).identifier;
      await cdp.send('Page.navigate', { url: `${setupBase}/` });
      await waitFor(`location.origin === ${q(setupBase)} && document.readyState === 'complete' && !!document.querySelector('#setup-step-title')`);
      const body = await (await fetch(`${setupBase}/api/setup`)).json();
      return { body, shown: body.steps.filter((s) => s.status !== 'skipped') };
    }

    // With a loadable config Set up is no longer the first tab: open it, then the project step from the list.
    async function openProject(shown) {
      await evaluate(`document.querySelector('#tab-setup').click()`);
      await waitFor(`!document.querySelector('#view-setup').hidden`);
      await evaluate(`document.querySelector('[data-key="setup:list"]').click()`);
      await waitFor(`!!document.querySelector('[data-key="setup:open:project"]')`);
      await evaluate(`document.querySelector('[data-key="setup:open:project"]').click()`);
      await waitFor(`${TITLE} === ${q(shown[0].title)}`);
    }

    // Tab from where focus is until the element matching `sel` has it.
    async function tabTo(sel) {
      for (let i = 0; i < 40; i += 1) {
        if (await evaluate(`document.activeElement === document.querySelector(${q(sel)})`)) return;
        await key('Tab');
      }
      throw new Error(`Tab never reached ${sel}`);
    }
    const focused = () => evaluate(`document.activeElement.id`);
    const narrow = async () => expect(await evaluate(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(360);

    afterEach(async () => {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      if (setupScript !== null) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: setupScript });
      setupScript = null;
      if (setupServer) await new Promise((resolve) => setupServer.close(resolve));
      if (setupDir) rmSync(setupDir, { recursive: true, force: true });
      setupServer = null;
      setupDir = null;
    });

    it('comes first with its count, and walks the wizard by keyboard at 360 px', async () => {
      const { body, shown } = await openSetup();
      const counted = body.steps.filter((s) => ['done', 'needs-you', 'broken'].includes(s.status));
      const done = counted.filter((s) => s.status === 'done').length;
      expect(done).toBeLessThan(counted.length);
      expect(await evaluate(`[...document.querySelectorAll('[role="tab"]')].map((t) => t.id)[0]`)).toBe('tab-setup');
      expect(await evaluate(`document.querySelector('#tab-setup').getAttribute('aria-selected')`)).toBe('true');
      expect(await evaluate(`document.querySelector('#tab-setup').classList.contains('hot')`)).toBe(true);
      expect(await evaluate(`!document.querySelector('#view-setup').hidden`)).toBe(true);
      expect(await evaluate(`document.querySelector('#setup-count').textContent`)).toBe(`${done}/${counted.length}`);
      expect(await evaluate(`document.querySelector('#setup-body .lsub').textContent`)).toBe(`Step 1 of ${shown.length}`);
      expect(await evaluate(TITLE)).toBe(shown[0].title);
      await narrow();

      for (let i = 1; i <= 3; i += 1) {
        await tabTo('[data-key="setup:next"]');
        await key('Enter');
        await waitFor(`${TITLE} === ${q(shown[i].title)}`);
        expect(await focused()).toBe('setup-step-title');
        expect(await evaluate(`document.querySelector('#setup-body .lsub').textContent`)).toBe(`Step ${i + 1} of ${shown.length}`);
        await narrow();
      }
      await tabTo('[data-key="setup:back"]');
      await key('Enter');
      await waitFor(`${TITLE} === ${q(shown[2].title)}`);
      expect(await focused()).toBe('setup-step-title');
    }, LONG);

    it("a step's Read the guide links to its section of the user guide on the website", async () => {
      const JIRA = JSON.stringify({ version: 1, project: { name: 'Acme' }, slots: 1, checks: [{ run: 'true', when: 'always' }], stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME ORDER BY Rank' } });
      await openSetup({ configText: JIRA });
      await evaluate(`document.querySelector('#tab-setup').click()`);
      await waitFor(`!document.querySelector('#view-setup').hidden`);
      if (await evaluate(`!!document.querySelector('[data-key="setup:list"]')`)) await evaluate(`document.querySelector('[data-key="setup:list"]').click()`);
      await waitFor(`!!document.querySelector('[data-key="setup:open:jira-site"]')`);
      await evaluate(`document.querySelector('[data-key="setup:open:jira-site"]').click()`);
      const link = `[...document.querySelectorAll('#setup-body .smore a')].find((a) => a.textContent.startsWith('Read the guide'))`;
      await waitFor(`!!${link}`);
      expect(await evaluate(`${link}.getAttribute('href')`)).toBe('https://finefactory.ai/apps/foreman/docs/#stories-from-jira');
      expect(await evaluate(`${link}.target`)).toBe('_blank');
      await narrow();
    }, LONG);

    it('arrow keys, Home and End follow the tabs when Set up comes first', async () => {
      await openSetup();
      const at = async () => evaluate(`(() => {
        const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
        const a = document.activeElement;
        return { id: a.id, selected: a.getAttribute('aria-selected'), view: !document.getElementById(a.getAttribute('aria-controls')).hidden,
          zero: tabs.filter((t) => t.tabIndex === 0).map((t) => t.id) };
      })()`);
      const expectAt = async (name) => {
        expect(await at()).toEqual({ id: `tab-${name}`, selected: 'true', view: true, zero: [`tab-${name}`] });
      };
      expect(await evaluate(`[...document.querySelectorAll('.tabs [role="tab"]')].map((t) => t.id)`)).toEqual(['tab-setup', 'tab-run', 'tab-insights', 'tab-waiting', 'tab-settings']);
      await evaluate(`document.querySelector('#tab-setup').focus()`);
      await key('ArrowRight'); await expectAt('run');
      await key('End'); await expectAt('settings');
      await key('Home'); await expectAt('setup');
      await key('ArrowLeft'); await expectAt('settings');
    }, LONG);

    it("tests a step by keyboard, and shows the result and what is wrong", async () => {
      const { shown } = await openSetup({ configText: LOADS });
      await openProject(shown);
      expect(shown[0].id).toBe('project');
      expect(await evaluate(`document.querySelector('#setup-result').textContent`)).toBe('Not tested yet.');
      await tabTo('[data-key="setup:check:project"]');
      await key('Enter');
      await waitFor(`document.querySelector('#setup-result').textContent.startsWith('Tested')`);
      const problems = await evaluate(`[...document.querySelectorAll('#setup-body .sprob')].map((p) => [...p.children].map((c) => c.textContent))`);
      expect(problems).toEqual([["What's wrong", 'no foreman.config.json', 'Do this', 'write it']]);
      expect(await evaluate(`document.querySelector('[data-key="setup:check:project"]').disabled`)).toBe(false);
      await narrow();
    }, LONG);

    it('makes a valid config from the project form alone: Run it, then Save', async () => {
      await openSetup({ run: () => ({ ok: true, level: 'error', detail: 'foreman.config.json is valid' }) });
      await waitFor(`!!document.querySelector('[data-key="setup:project:save"]')`);
      expect(await evaluate(`!!document.querySelector('[data-key="setup:check:project"]')`)).toBe(false);
      const type = (id, value) => evaluate(`(() => { const i = document.querySelector('[data-key="setup:project:${id}"]'); i.value = ${q(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await type('name', 'Acme');
      await evaluate(`document.querySelector('[data-key="setup:project:source:markdown"]').click()`);
      await waitFor(`!!document.querySelector('[data-key="setup:project:dir"]')`);
      expect(await evaluate(`!!document.querySelector('[data-key="setup:project:site"]')`)).toBe(false);
      await type('dir', 'stories');
      await type('check', 'echo acme-ran');
      await evaluate(`document.querySelector('[data-key="setup:project:run"]').click()`);
      await waitFor(`/^Passed/.test(document.querySelector('#setup-body [role="status"]')?.textContent || '')`);
      expect(await evaluate(`document.querySelector('#setup-body pre.stail').textContent`)).toBe('acme-ran');
      // The answers typed stay put across the redraw.
      expect(await evaluate(`document.querySelector('[data-key="setup:project:name"]').value`)).toBe('Acme');
      await narrow();
      await evaluate(`document.querySelector('[data-key="setup:project:save"]').click()`);
      await waitFor(`!!document.querySelector('[data-key="setup:check:project"]') && [...document.querySelectorAll('#setup-body li')].some((li) => li.textContent === 'wrote foreman.config.json')`);
      await waitFor(`document.querySelector('#setup-result').textContent.startsWith('Tested')`);
      expect(JSON.parse(readFileSync(join(setupDir, 'foreman.config.json'), 'utf8'))).toMatchObject({ project: { name: 'Acme' }, checks: [{ run: 'echo acme-ran', when: 'always' }], stories: { adapter: 'markdown', dir: 'stories' } });
      expect(loadConfig(setupDir).errors ?? []).toEqual([]);
      await narrow();
    }, LONG);

    it('shows a failed detect with Try again, and loads the form on retry', async () => {
      // The first detection answers 400; the ones after reach the server.
      const beforeLoad = `(() => {
        const real = window.fetch.bind(window);
        let failed = false;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : (input && input.url) || String(input);
          if (!failed && init && init.method === 'POST' && new URL(url, location.href).pathname === '/api/setup/project/detect') {
            failed = true;
            return Promise.resolve(new Response(JSON.stringify({ error: 'Acme detect failed.' }), { status: 400, headers: { 'content-type': 'application/json' } }));
          }
          return real(input, init);
        };
      })();`;
      await openSetup({ beforeLoad });
      await waitFor(`[...document.querySelectorAll('#setup-body .swarn')].some((p) => p.textContent === 'Acme detect failed.' && p.getAttribute('role') === 'alert')`);
      await waitFor(`!!document.querySelector('[data-key="setup:project:retry"]')`);
      expect(await evaluate(`!!document.querySelector('[data-key="setup:project:name"]')`)).toBe(false);
      await evaluate(`document.querySelector('[data-key="setup:project:retry"]').click()`);
      await waitFor(`!!document.querySelector('[data-key="setup:project:name"]')`);
      expect(await evaluate(`!!document.querySelector('[data-key="setup:project:retry"]')`)).toBe(false);
      await narrow();
    }, LONG);

    it("shows the server's refusal under the button when the step is being checked already", async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let started;
      const begun = new Promise((resolve) => { started = resolve; });
      const { shown } = await openSetup({ run: async () => { started(); await gate; return failing(); }, configText: LOADS });
      await openProject(shown);
      await evaluate(`(() => { window.__errors = []; addEventListener('error', (e) => window.__errors.push(String(e.message))); addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason))); })()`);
      const first = fetch(`${setupBase}/api/setup/steps/project/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      await begun;
      await tabTo('[data-key="setup:check:project"]');
      await key('Enter');
      await waitFor(`document.querySelector('#setup-result + .swarn')?.textContent === 'This step is being checked already. Try again in a moment.'`);
      release();
      expect((await first).status).toBe(200);
      expect(await evaluate(`document.querySelector('[data-key="setup:check:project"]').disabled`)).toBe(false);
      expect(await evaluate(`document.querySelector('#setup-result').textContent`)).toBe('Not tested yet.');
      expect(await evaluate(`window.__errors`)).toEqual([]);
    }, LONG);

    it('Finish and Show the list open the checklist by area, and Open focuses the step', async () => {
      const { body, shown } = await openSetup();
      for (let i = 1; i < shown.length; i += 1) {
        await evaluate(`document.querySelector('[data-key="setup:next"]').click()`);
        await waitFor(`${TITLE} === ${q(shown[i].title)}`);
        await narrow();
      }
      expect(await evaluate(`document.querySelector('[data-key="setup:next"]').textContent`)).toBe('Finish');
      await evaluate(`document.querySelector('[data-key="setup:next"]').click()`);
      await waitFor(`!!document.querySelector('[data-key^="setup:open:"]')`);

      const areas = body.areas.filter((a) => shown.some((s) => s.area === a.id)).map((a) => a.title);
      expect(await evaluate(`[...document.querySelectorAll('#setup-body h3')].map((h) => h.textContent)`)).toEqual(areas);
      const opens = await evaluate(`[...document.querySelectorAll('[data-key^="setup:open:"]')].map((b) => b.dataset.key)`);
      expect([...opens].sort()).toEqual(shown.map((s) => `setup:open:${s.id}`).sort());
      await narrow();

      const github = shown.find((s) => s.id === 'github');
      // A done area starts folded: open it, as the owner would, before reaching its button.
      await evaluate(`(() => { const sec = document.querySelector('[data-key="setup:open:github"]').closest('.acc'); if (sec && !sec.classList.contains('open')) sec.querySelector('.acc-btn').click(); })()`);
      await evaluate(`document.querySelector('[data-key="setup:open:github"]').focus()`);
      await key('Enter');
      await waitFor(`${TITLE} === ${q(github.title)}`);
      expect(await focused()).toBe('setup-step-title');
      expect(await evaluate(`!!document.querySelector('#setup-body .lsub')`)).toBe(false);
      await evaluate(`document.querySelector('[data-key="setup:list"]').click()`);
      await waitFor(`document.activeElement === document.querySelector('[data-key="setup:open:github"]')`);

      // A new visit, with nothing tested yet, starts the wizard again; Show the list leaves it.
      await cdp.send('Page.navigate', { url: `${setupBase}/` });
      await waitFor(`document.readyState === 'complete' && !!document.querySelector('[data-key="setup:list"]')`);
      expect(await evaluate(`document.querySelector('[data-key="setup:list"]').textContent`)).toBe('Show the list');
      await evaluate(`document.querySelector('[data-key="setup:list"]').click()`);
      await waitFor(`document.querySelectorAll('[data-key^="setup:open:"]').length === ${shown.length}`);
    }, LONG);
  });

  // An Acme project in a git repo whose .gitignore keeps .env.foreman out, notifying by Resend,
  // with a fake Resend that takes any key; the page open on Set up on a 360 px screen.
  describe('the keys screen', () => {
    let keysDir;
    let keysServer;
    let keysBase;
    let resend;
    const RESEND = 'RESEND_API_KEY';
    const OWN = 'FOREMAN_DASHBOARD_TOKEN';
    const TITLE = `document.querySelector('#setup-step-title .sname')?.textContent`;
    const sel = (name, id) => `[data-key="setup:key:${name}:${id}"]`;
    const stateOf = (name) => `document.querySelector('section[aria-labelledby="sk-${name}-head"] .kstate')?.textContent`;
    const headOf = (name) => `document.querySelector('#sk-${name}-head')?.textContent`;
    const rowLabel = (body, step, name) => body.steps.find((s) => s.id === step).keys.find((k) => k.name === name).label;
    const resultOf = (name) => `document.querySelector('section[aria-labelledby="sk-${name}-head"] [role="status"]')?.textContent`;
    const ownFile = () => join(keysDir, '.env.foreman');
    const saved = () => (existsSync(ownFile()) ? parseEnv(readFileSync(ownFile(), 'utf8')) : {});
    const mode = () => statSync(ownFile()).mode & 0o777;
    const narrow = async () => expect(await evaluate(`document.documentElement.scrollWidth`)).toBeLessThanOrEqual(360);
    const click = async (selector) => {
      await waitFor(`!!document.querySelector(${q(selector)}) && !document.querySelector(${q(selector)}).disabled`);
      await evaluate(`(() => { const b = document.querySelector(${q(selector)}); b.focus(); b.click(); })()`);
    };
    const focusedKey = () => evaluate(`document.activeElement?.dataset?.key ?? ''`);
    // Neither the page nor any field holds the secret, nor its first 20 characters.
    const clean = async (secret) => {
      const html = await evaluate(`document.documentElement.outerHTML`);
      expect(html.includes(secret)).toBe(false);
      expect(html.includes(secret.slice(0, 20))).toBe(false);
      const values = await evaluate(`[...document.querySelectorAll('input')].map((i) => i.value)`);
      for (const v of values) expect(v.includes(secret.slice(0, 20))).toBe(false);
    };
    const sentinel = () => `re_SENTINEL${randomBytes(16).toString('hex')}`;

    async function openKeys() {
      resend = { seen: [] };
      resend.server = createServer((req, res) => {
        resend.seen.push(String(req.headers.authorization ?? ''));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":[]}');
      });
      await new Promise((resolve) => resend.server.listen(0, '127.0.0.1', resolve));
      keysDir = mkdtempSync(join(tmpdir(), 'foreman-browser-keys-'));
      spawnSync('git', ['init', '-q'], { cwd: keysDir });
      writeFileSync(join(keysDir, '.gitignore'), '.env.foreman\n');
      writeFileSync(join(keysDir, 'foreman.config.json'), JSON.stringify({ version: 1, project: { name: 'Acme' }, checks: [{ run: 'true', when: 'always' }], notify: { adapter: 'email-resend' } }));
      const { config } = loadConfig(keysDir);
      keysServer = createDashboardServer({
        root: keysDir, config, stateDir: join(keysDir, '.foreman'), env: {},
        keyBase: { resend: `http://127.0.0.1:${resend.server.address().port}` }, keyTimeoutMs: 3000,
        doctor: () => Promise.resolve({ config, ctx: {}, checks: [] }),
      });
      await new Promise((resolve) => keysServer.listen(0, '127.0.0.1', resolve));
      keysBase = `http://127.0.0.1:${keysServer.address().port}`;
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
      await cdp.send('Page.navigate', { url: `${keysBase}/#setup` });
      await waitFor(`location.origin === ${q(keysBase)} && document.readyState === 'complete' && !!document.querySelector('#setup-step-title')`);
      const body = await (await fetch(`${keysBase}/api/setup`)).json();
      return body;
    }

    async function openStep(body, id) {
      await click('[data-key="setup:list"]');
      await click(`[data-key="setup:open:${id}"]`);
      await waitFor(`${TITLE} === ${q(body.steps.find((s) => s.id === id).title)}`);
    }

    afterEach(async () => {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      if (keysServer) await new Promise((resolve) => keysServer.close(resolve));
      if (resend?.server) await new Promise((resolve) => resend.server.close(resolve));
      if (keysDir) rmSync(keysDir, { recursive: true, force: true });
      keysServer = null;
      keysDir = null;
      resend = null;
    });

    it('saves, tests, replaces and removes a key, never putting it in the page, and keeps .env.foreman at 600', async () => {
      const body = await openKeys();
      await openStep(body, 'notifications');
      expect(await evaluate(stateOf(RESEND))).toBe(KEY_CARD.notSet);
      expect(await evaluate(headOf(RESEND))).toBe(rowLabel(body, 'notifications', RESEND));
      expect(await evaluate(`(() => { const i = document.querySelector(${q(sel(RESEND, 'input'))}); return [i.type, i.autocomplete, document.querySelector('label[for="' + i.id + '"]') !== null]; })()`)).toEqual(['password', 'off', true]);
      await narrow();

      // Save, by Enter in the field.
      const first = sentinel();
      await evaluate(`document.querySelector(${q(sel(RESEND, 'input'))}).focus()`);
      await type(first);
      await key('Enter');
      await waitFor(`(${stateOf(RESEND)} || '').startsWith('Saved in .env.foreman (')`);
      expect(await evaluate(stateOf(RESEND))).toBe(`Saved in .env.foreman (•••• ${first.slice(-4)})`);
      await clean(first);
      expect(saved()[RESEND]).toBe(first);
      expect(mode()).toBe(0o600);
      expect(await focusedKey()).toBe(`setup:key:${RESEND}:test`);
      await narrow();

      // Test.
      await click(sel(RESEND, 'test'));
      await waitFor(`(${resultOf(RESEND)} || '').startsWith(${q(KEY_CARD.works + ': ')})`);
      expect(await evaluate(resultOf(RESEND))).toBe(`${KEY_CARD.works}: Resend accepted the key`);
      expect(resend.seen).toEqual([`Bearer ${first}`]);
      await clean(first);

      // Replace.
      const second = sentinel();
      await click(sel(RESEND, 'replace'));
      await waitFor(`document.activeElement === document.querySelector(${q(sel(RESEND, 'input'))})`);
      await type(second);
      await click(sel(RESEND, 'save'));
      await waitFor(`${stateOf(RESEND)} === ${q(`Saved in .env.foreman (•••• ${second.slice(-4)})`)}`);
      expect(saved()[RESEND]).toBe(second);
      expect(mode()).toBe(0o600);
      await clean(first);
      await clean(second);
      await narrow();

      // Remove: Escape puts the confirm away, then Yes removes it.
      await click(sel(RESEND, 'remove'));
      await waitFor(`!!document.querySelector(${q(sel(RESEND, 'remove:yes'))})`);
      await narrow();
      await key('Escape');
      await waitFor(`!document.querySelector(${q(sel(RESEND, 'remove:yes'))})`);
      expect(await focusedKey()).toBe(`setup:key:${RESEND}:remove`);
      await click(sel(RESEND, 'remove'));
      await click(sel(RESEND, 'remove:yes'));
      await waitFor(`${stateOf(RESEND)} === ${q(KEY_CARD.notSet)}`);
      expect(Object.hasOwn(saved(), RESEND)).toBe(false);
      expect(mode()).toBe(0o600);
      expect(await focusedKey()).toBe(`setup:key:${RESEND}:input`);
      await clean(second);
      await narrow();
    }, LONG);

    it('makes the dashboard token, and never puts it in the page', async () => {
      const body = await openKeys();
      await openStep(body, 'project-keys');
      expect(await evaluate(stateOf(OWN))).toBe(KEY_CARD.notSet);
      const label = rowLabel(body, 'project-keys', OWN);
      expect(label).toBe('Dashboard access token');
      expect(await evaluate(headOf(OWN))).toBe(label);
      await click(sel(OWN, 'generate'));
      await waitFor(`(${stateOf(OWN)} || '').startsWith('Saved in .env.foreman (')`);
      const made = saved()[OWN];
      expect(made.length).toBeGreaterThanOrEqual(32);
      expect(await evaluate(stateOf(OWN))).toBe(`Saved in .env.foreman (•••• ${made.slice(-4)})`);
      expect(mode()).toBe(0o600);
      await clean(made);
      await narrow();

      // Replace, type part of a key, then Make one for me: the typed text goes with the request.
      const partial = sentinel();
      await click(sel(OWN, 'replace'));
      await waitFor(`document.activeElement === document.querySelector(${q(sel(OWN, 'input'))})`);
      await type(partial);
      await click(sel(OWN, 'generate'));
      for (let i = 0; i < 100 && saved()[OWN] === made; i += 1) await sleep(100);
      const remade = saved()[OWN];
      expect(remade).not.toBe(made);
      expect(remade).not.toBe(partial);
      await waitFor(`${stateOf(OWN)} === ${q(`Saved in .env.foreman (•••• ${remade.slice(-4)})`)} && !document.querySelector(${q(sel(OWN, 'input'))})`);
      expect(mode()).toBe(0o600);
      await click(sel(OWN, 'replace'));
      await waitFor(`document.activeElement === document.querySelector(${q(sel(OWN, 'input'))})`);
      expect(await evaluate(`document.querySelector(${q(sel(OWN, 'input'))}).value`)).toBe('');
      await clean(partial);
      await clean(remade);
    }, LONG);

    it('shows the Claude sign-in as two named cards and the in-use line, with no third card', async () => {
      const body = await openKeys();
      await openStep(body, 'claude-signin');
      const step = body.steps.find((s) => s.id === 'claude-signin');
      const heads = await evaluate(`[...document.querySelectorAll('#setup-body .skey:not(.slogin) h3')].map((h) => h.textContent)`);
      expect(heads.filter((h) => h === 'Console API key')).toHaveLength(1);
      expect(heads.filter((h) => h === 'Subscription')).toHaveLength(1);
      expect(heads).toHaveLength(2);
      expect(await evaluate(`document.querySelector('#setup-body .sinuse')?.textContent`)).toBe(step.inUse.line);
      expect(await evaluate(`document.querySelector('#setup-body .sinuse')?.getAttribute('role')`)).toBe('status');
      expect(await evaluate(`[...document.querySelectorAll('#setup-body .skey .cnote')].length`)).toBeGreaterThanOrEqual(2);
      await narrow();
    }, LONG);
  });

  // An Acme git repo with the markdown config the Set up form writes, its dashboard in full mode
  // with a temporary HOME (so no real Jira sign-in is read), and the page open on Set up.
  describe('the change form on a project with a config', () => {
    let changeDir;
    let changeHome;
    let changeServer;
    let changeBase;
    const TITLE = `document.querySelector('#setup-step-title .sname')?.textContent`;
    const sel = (dataKey) => `[data-key=${q(dataKey)}]`;
    const SOURCE = (value) => sel(`setup:project:change:source:${value}`);
    const SAVE = sel('setup:project:change:save');
    const configFile = () => join(changeDir, 'foreman.config.json');
    const click = async (selector) => {
      await waitFor(`!!document.querySelector(${q(selector)}) && !document.querySelector(${q(selector)}).disabled`);
      await evaluate(`(() => { const b = document.querySelector(${q(selector)}); b.focus(); b.click(); })()`);
    };
    const checked = (selector) => evaluate(`document.querySelector(${q(selector)})?.checked === true`);
    const disabled = (selector) => evaluate(`document.querySelector(${q(selector)})?.disabled === true`);

    async function openChange() {
      changeDir = mkdtempSync(join(tmpdir(), 'foreman-browser-change-'));
      changeHome = mkdtempSync(join(tmpdir(), 'foreman-browser-change-home-'));
      spawnSync('git', ['init', '-q'], { cwd: changeDir });
      writeFileSync(join(changeDir, '.gitignore'), '.env.foreman\n.foreman/\n');
      const made = projectConfig(detect(changeDir, { packs: PACKS }), { name: 'Acme', source: 'markdown', dir: 'stories', check: 'true', ci: [] });
      expect(made.ok, JSON.stringify(made)).toBe(true);
      writeFileSync(configFile(), `${JSON.stringify(made.config, null, 2)}\n`);
      const loaded = loadConfig(changeDir);
      expect(loaded.errors ?? []).toEqual([]);
      changeServer = createDashboardServer({
        root: changeDir, config: loaded.config, stateDir: join(changeDir, '.foreman'), env: { HOME: changeHome },
        doctor: () => Promise.resolve({ config: null, ctx: {}, checks: [] }),
      });
      await new Promise((resolve) => changeServer.listen(0, '127.0.0.1', resolve));
      changeBase = `http://127.0.0.1:${changeServer.address().port}`;
      await cdp.send('Page.navigate', { url: `${changeBase}/#setup` });
      await waitFor(`location.origin === ${q(changeBase)} && document.readyState === 'complete' && !!document.querySelector('#setup-step-title')`);
      return (await fetch(`${changeBase}/api/setup`)).json();
    }

    async function openProject(body) {
      await click(sel('setup:list'));
      await click(sel('setup:open:project'));
      await waitFor(`${TITLE} === ${q(body.steps.find((s) => s.id === 'project').title)}`);
    }

    afterEach(async () => {
      if (changeServer) await new Promise((resolve) => changeServer.close(resolve));
      for (const d of [changeDir, changeHome]) if (d) rmSync(d, { recursive: true, force: true });
      changeServer = null;
      changeDir = null;
      changeHome = null;
    });

    it('Turn on Jira, then Save, shows the Jira steps', async () => {
      await openChange();
      await evaluate(`document.querySelector('#tab-setup').click()`);
      await click(sel('setup:list'));
      await click(sel('setup:turn-on:jira'));
      await waitFor(`document.querySelector(${q(SOURCE('jira'))})?.checked === true && document.querySelector(${q(SAVE)})?.disabled === false`);
      expect(await evaluate(`document.activeElement?.dataset?.key ?? ''`)).toBe('setup:project:change:save');

      await click(SAVE);
      await waitFor(`[...document.querySelectorAll('#setup-body li')].some((li) => li.textContent === 'set stories.adapter to jira')`);
      expect(JSON.parse(readFileSync(configFile(), 'utf8')).stories.adapter).toBe('jira');

      await click(sel('setup:list'));
      for (const id of ['jira-app', 'jira-signin', 'jira-site']) await waitFor(`!!document.querySelector(${q(sel(`setup:open:${id}`))})`);
      expect(await evaluate(`!!document.querySelector(${q(sel('setup:turn-on:jira'))})`)).toBe(false);
    }, LONG);

    it('follows a config changed on disk while the form is open', async () => {
      const body = await openChange();
      await evaluate(`document.querySelector('#tab-setup').click()`);
      await openProject(body);
      await waitFor(`!!document.querySelector(${q(SOURCE('markdown'))})`);
      expect(await checked(SOURCE('markdown'))).toBe(true);
      expect(await disabled(SAVE)).toBe(true);

      const file = JSON.parse(readFileSync(configFile(), 'utf8'));
      writeFileSync(configFile(), `${JSON.stringify({ ...file, stories: { adapter: 'jira', site: 'acme.atlassian.net', jql: 'project = ACME' } }, null, 2)}\n`);
      // Showing Set up again reads /api/setup again.
      await evaluate(`document.querySelector('#tab-run').click()`);
      await evaluate(`document.querySelector('#tab-setup').click()`);
      await openProject(body);
      await waitFor(`document.querySelector(${q(SOURCE('jira'))})?.checked === true`);
      expect(await disabled(SAVE)).toBe(true);

      // An owner's own choice still counts as a change.
      await evaluate(`document.querySelector(${q(SOURCE('markdown'))}).click()`);
      await waitFor(`document.querySelector(${q(SAVE)})?.disabled === false`);
      expect(await checked(SOURCE('markdown'))).toBe(true);
    }, LONG);
  });

  // Each setting's help is an info button beside its name, opening a native popover (FM-130).
  describe('the Settings info popups', () => {
    const WORKERS = '[data-key="set:workers:info"]';
    const SLOTS = '[data-key="set:slots:info"]';
    const isOpen = (id) => `document.querySelector(${q(id)}).matches(':popover-open')`;
    const openSettings = async () => {
      await evaluate(`document.querySelector('#tab-settings').click()`);
      await waitFor(`!document.querySelector('#view-settings').hidden && !!document.querySelector(${q(WORKERS)})`);
    };
    const expanded = (sel) => evaluate(`document.querySelector(${q(sel)}).getAttribute('aria-expanded')`);
    const focusedOn = (sel) => evaluate(`document.activeElement === document.querySelector(${q(sel)})`);

    it('opens by keyboard, keeps focus on the icon, and closes on Escape and Tab away', async () => {
      await openSettings();
      await evaluate(`document.querySelector('#view-settings').focus()`);
      let reached = false;
      for (let i = 0; i < 15 && !reached; i += 1) {
        await key('Tab');
        reached = await focusedOn(WORKERS);
      }
      expect(reached, 'Tab never reached the Workers info button').toBe(true);

      await key('Enter');
      await waitFor(isOpen('#info-set-workers'));
      await waitFor(`document.querySelector(${q(WORKERS)}).getAttribute('aria-expanded') === 'true'`);
      expect(await focusedOn(WORKERS)).toBe(true);
      await waitFor(`document.querySelector('#announce').textContent.startsWith('Workers. ')`);

      await key('Escape');
      await waitFor(`!${isOpen('#info-set-workers')}`);
      await waitFor(`document.querySelector(${q(WORKERS)}).getAttribute('aria-expanded') === 'false'`);
      expect(await focusedOn(WORKERS)).toBe(true);

      await key('Enter');
      await waitFor(isOpen('#info-set-workers'));
      await key('Tab');
      await waitFor(`!${isOpen('#info-set-workers')}`);
      await waitFor(`document.querySelector(${q(WORKERS)}).getAttribute('aria-expanded') === 'false'`);
      expect(await expanded(WORKERS)).toBe('false');
    }, LONG);

    it('keeps one popup open at a time', async () => {
      await openSettings();
      await evaluate(`document.querySelector(${q(WORKERS)}).click()`);
      await waitFor(isOpen('#info-set-workers'));
      await evaluate(`document.querySelector(${q(SLOTS)}).click()`);
      await waitFor(isOpen('#info-set-slots'));
      expect(await evaluate(isOpen('#info-set-workers'))).toBe(false);
    }, LONG);

    it('closes on a click outside it', async () => {
      await openSettings();
      await evaluate(`document.querySelector(${q(WORKERS)}).click()`);
      await waitFor(isOpen('#info-set-workers'));
      // The page title's left end, above the tabs: the popup opens below the tabs, so it never covers it.
      await evaluate(`window.scrollTo(0, 0)`);
      const at = await evaluate(`(() => { const r = document.querySelector('#project-name').getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; })()`);
      expect(await evaluate(`document.elementFromPoint(${at.x}, ${at.y}) === document.querySelector('#project-name')`)).toBe(true);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await waitFor(`!${isOpen('#info-set-workers')}`);
    }, LONG);

    it('reopens the open popup on the new node after a save redraws the tab, without announcing it again', async () => {
      await openSettings();
      await evaluate(`document.querySelector(${q(WORKERS)}).click()`);
      await waitFor(isOpen('#info-set-workers'));
      await evaluate(`window.__oldPop = document.querySelector('#info-set-workers')`);
      const SAVE = '[data-key="set:workers:local"]';
      await waitFor(`!document.querySelector(${q(SAVE)}).disabled`);
      // A click from script: a real press outside the popup would close it before the save.
      await evaluate(`document.querySelector(${q(SAVE)}).click()`);
      const ok = `document.querySelector('[data-key="set:workers:input"]').closest('article').querySelector('.sok')`;
      await waitFor(`!window.__oldPop.isConnected && !!(${ok})`);
      await waitFor(isOpen('#info-set-workers'));
      expect(await evaluate(`document.querySelector('#info-set-workers') !== window.__oldPop`)).toBe(true);
      expect(await expanded(WORKERS)).toBe('true');
      expect(await evaluate(`document.querySelector('#info-set-workers').dataset.quiet`)).toBeUndefined();
      // The save's own message is the last thing said: the reopen did not say "Workers. ..." again.
      await waitFor(`document.querySelector('#announce').textContent === (${ok}).textContent`);
      await sleep(200);
      expect(await evaluate(`document.querySelector('#announce').textContent`)).toBe(await evaluate(`(${ok}).textContent`));
      expect(await evaluate(`document.querySelector('#announce').textContent.startsWith('Workers. ')`)).toBe(false);
      await key('Escape');
      await waitFor(`!${isOpen('#info-set-workers')}`);
    }, LONG);

    it('keeps every popup inside a 360 px screen, and moves nothing in its row', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
      try {
        await openSettings();
        const keys = await evaluate(`[...document.querySelectorAll('.ibtn')].map((b) => b.dataset.key)`);
        expect(keys.length).toBeGreaterThan(1);
        for (const k of keys) {
          const btn = `[data-key=${q(k)}]`;
          const ctl = `[data-key=${q(k.replace(/:info$/, ':input'))}]`;
          const rect = (sel) => `(() => { const n = document.querySelector(${q(sel)}); if (!n) return null; const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`;
          await evaluate(`document.querySelector(${q(btn)}).scrollIntoView({ block: 'center' })`);
          const before = await evaluate(rect(ctl));
          const pop = await evaluate(`document.querySelector(${q(btn)}).getAttribute('aria-controls')`);
          await evaluate(`document.querySelector(${q(btn)}).click()`);
          await waitFor(isOpen('#' + pop));
          await evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
          const box = await evaluate(rect('#' + pop));
          expect(box.left, k).toBeGreaterThanOrEqual(0);
          expect(box.top, k).toBeGreaterThanOrEqual(0);
          expect(box.left + box.width, k).toBeLessThanOrEqual(360);
          expect(box.top + box.height, k).toBeLessThanOrEqual(640);
          expect(await evaluate(`document.documentElement.scrollWidth`), k).toBeLessThanOrEqual(360);
          expect(await evaluate(rect(ctl)), k).toEqual(before);
          await key('Escape');
          await waitFor(`!${isOpen('#' + pop)}`);
        }
      } finally {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
      }
    }, LONG);

    it('hovering or focusing a save button does not move the next row', async () => {
      const rect = (sel) => `(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`;
      const NEXT = '[data-key="set:slots:input"]';
      const nextRow = `(() => { const r = document.querySelector(${q(NEXT)}).closest('article').getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`;
      const frames = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;
      const check = async (size) => {
        await openSettings();
        await evaluate(`document.querySelector(${q(NEXT)}).scrollIntoView({ block: 'center' })`);
        await evaluate(frames);
        const before = { ctl: await evaluate(rect(NEXT)), row: await evaluate(nextRow) };
        for (const sel of ['[data-key="set:workers:local"]', '[data-key="set:workers:team"]']) {
          await evaluate(`document.querySelector(${q(sel)}).focus()`);
          await evaluate(frames);
          expect({ ctl: await evaluate(rect(NEXT)), row: await evaluate(nextRow) }, `${size} focus ${sel}`).toEqual(before);
          const at = await evaluate(`(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
          await evaluate(frames);
          expect({ ctl: await evaluate(rect(NEXT)), row: await evaluate(nextRow) }, `${size} hover ${sel}`).toEqual(before);
        }
        expect(await evaluate(`document.querySelectorAll('#set-groups .tip').length`)).toBe(0);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
      };
      await check('default');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 1, mobile: true });
      try {
        await check('360x640');
      } finally {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
      }
    }, LONG);

    it('describes the save buttons by the shared hidden texts', async () => {
      await openSettings();
      await waitFor(`document.querySelector('#set-help').childElementCount === 4`);
      const tied = await evaluate(`[...document.querySelectorAll('.sacts button[aria-describedby]')].map((b) => b.getAttribute('aria-describedby'))`);
      expect(tied.length).toBeGreaterThan(0);
      for (const ids of tied) {
        for (const id of ids.split(/\s+/)) {
          expect(id).toMatch(/^set-help-/);
          expect(await evaluate(`(document.getElementById(${q(id)})?.textContent || '').trim()`), id).not.toBe('');
        }
      }
      const words = await evaluate(`(() => { const b = document.querySelector('[data-key="set:workers:local"]'); return b.getAttribute('aria-describedby').split(' ').map((id) => document.getElementById(id).textContent).join(' '); })()`);
      expect(words).toContain('this computer');
    }, LONG);

    it('when /api/help fails, no save button is described and #set-help is empty', async () => {
      // Runs before the page's own script on the next load: /api/help fails as an unreachable server would.
      const source = `(() => {
        const real = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : (input && input.url) || String(input);
          if (new URL(url, location.href).pathname.endsWith('/api/help')) {
            window.__helpAsked = (window.__helpAsked || 0) + 1;
            return Promise.reject(new TypeError('blocked by test'));
          }
          return real(input, init);
        };
      })();`;
      const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
      try {
        // A reload, not a navigate: the page is already on /#run, and the same URL would only move the hash.
        await cdp.send('Page.reload', { ignoreCache: true });
        await waitFor('window.__helpAsked > 0');
        await waitFor(`document.readyState === 'complete' && !!document.querySelector('#tab-settings')`);
        await openSettings();
        expect(await evaluate(`document.querySelectorAll('.sacts button').length`)).toBeGreaterThan(0);
        expect(await evaluate(`document.querySelectorAll('.sacts button[aria-describedby]').length`)).toBe(0);
        expect(await evaluate(`document.querySelector('#set-help').childElementCount`)).toBe(0);
        expect(await evaluate(`document.querySelector('#set-help').textContent.trim()`)).toBe('');
      } finally {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      }
    }, LONG);

    it("a setting's popup holds what it does, its default, limits, source, timing and key", async () => {
      await openSettings();
      await evaluate(`document.querySelector(${q(WORKERS)}).click()`);
      await waitFor(isOpen('#info-set-workers'));
      const text = await evaluate(`document.querySelector('#info-set-workers').textContent`);
      for (const part of ['What it does', 'Default', '1', 'Allowed', 'Set by', 'Takes effect', 'From the next story a slot picks', 'workers']) expect(text, part).toContain(part);
      expect(text).not.toContain('Shown only when');
      await key('Escape');
      await waitFor(`!${isOpen('#info-set-workers')}`);
    }, LONG);

    it('a popup capped on a short screen scrolls inside its cap', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 220, deviceScaleFactor: 1, mobile: true });
      try {
        await openSettings();
        const frames = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;
        // The popup that overflows its cap the most.
        const keys = await evaluate(`[...document.querySelectorAll('.ibtn')].map((b) => b.dataset.key)`);
        let best = null;
        for (const k of keys) {
          const btn = `[data-key=${q(k)}]`;
          await evaluate(`document.querySelector(${q(btn)}).scrollIntoView({ block: 'center' })`);
          const pop = '#' + await evaluate(`document.querySelector(${q(btn)}).getAttribute('aria-controls')`);
          await evaluate(`document.querySelector(${q(btn)}).click()`);
          await waitFor(isOpen(pop));
          await evaluate(frames);
          const over = await evaluate(`(() => { const p = document.querySelector(${q(pop)}); return p.scrollHeight - p.clientHeight; })()`);
          if (!best || over > best.over) best = { btn, pop, over };
          await key('Escape');
          await waitFor(`!${isOpen(pop)}`);
        }
        expect(best.over, 'no popup is capped at 360x220').toBeGreaterThan(10);

        await evaluate(`document.querySelector(${q(best.btn)}).scrollIntoView({ block: 'center' })`);
        await evaluate(`document.querySelector(${q(best.btn)}).click()`);
        await waitFor(isOpen(best.pop));
        await evaluate(frames);
        const want = Math.min(40, best.over);
        await evaluate(`document.querySelector(${q(best.pop)}).scrollTop = ${want}`);
        await evaluate(frames);
        expect(await evaluate(`document.querySelector(${q(best.pop)}).scrollTop`)).toBe(want);

        // A wheel over the popup scrolls it, and it stays scrolled.
        await evaluate(`document.querySelector(${q(best.pop)}).scrollTop = 0`);
        await evaluate(frames);
        const at = await evaluate(`(() => { const r = document.querySelector(${q(best.pop)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 60 });
        await waitFor(`document.querySelector(${q(best.pop)}).scrollTop > 0`);
        const after = await evaluate(`document.querySelector(${q(best.pop)}).scrollTop`);
        await evaluate(frames);
        expect(await evaluate(`document.querySelector(${q(best.pop)}).scrollTop`)).toBe(after);
        expect(await evaluate(isOpen(best.pop))).toBe(true);
        await key('Escape');
      } finally {
        await cdp.send('Emulation.clearDeviceMetricsOverride');
      }
    }, LONG);
  });
  describe('the agent cards and the conversation view', () => {
    const SESSION = '4947378a-6485-4e40-9357-671b81c4acf3';
    const EVIL = '<img src=x onerror="window.__x=1">';
    const line = (o) => JSON.stringify(o);
    const asst = (content) => line({ type: 'assistant', timestamp: '2026-10-24T09:00:02.000Z', message: { model: 'claude-sonnet-5-5', content } });

    // A mark for slot w1, the agent's transcript in a tmp projects folder, the agent's file, and
    // the status the page shows with the plain words, command and model.
    beforeEach(async () => {
      const projects = join(dir, 'claude', 'projects');
      const file = join(projects, '-tmp-acme', SESSION, 'subagents', 'agent-a1.jsonl');
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, `${[
        line({ type: 'user', timestamp: '2026-10-24T09:00:01.000Z', message: { content: 'Build S-5' } }),
        asst([{ type: 'text', text: `Starting the build. ${EVIL}` }]),
        asst([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }]),
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'all passed' }] } }),
      ].join('\n')}\n`);
      const log = join(state, 'logs', 'w1.log');
      mkdirSync(join(state, 'logs'), { recursive: true });
      writeFileSync(log, `${line({ type: 'system', subtype: 'init', session_id: SESSION })}\n`);
      markSession(state, 'w1', { story: 'S-5', pid: process.pid, log, projects });
      mkdirSync(join(state, 'slots', 'w1', 'agents'), { recursive: true });
      writeFileSync(join(state, 'slots', 'w1', 'agents', 'a1.json'), JSON.stringify({ id: 'a1', role: 'foreman:builder', since: t(6), lastAt: t(0.1), tools: 12 }));
      const status = JSON.parse(readFileSync(join(state, 'status.json'), 'utf8'));
      Object.assign(status.slots[0], { model: 'Opus 5.5', finished: [] });
      Object.assign(status.slots[0].agents[0], { says: 'Run the tests', raw: 'npm test', stage: 'build', modelName: 'Sonnet 5.5', modelNote: 'Set to Opus, runs on Sonnet 5.5' });
      writeFileSync(join(state, 'status.json'), JSON.stringify(status));
      await waitFor(`!!document.querySelector('.lmodel')`);
    }, LONG);

    for (const [width, height] of [[1280, 900], [360, 640]]) {
      it(`shows the plain words, the command, and the conversation at ${width} px, and Escape returns focus`, async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 640 });
        try {
          await evaluate(`location.hash = '#run'`);
          const row = '[aria-labelledby="lane-w1"]';
          await waitFor(`!!document.querySelector(${q(row + ' .c-story')})`);
          expect(await evaluate(`document.querySelector(${q(row + ' .lmodel')}).textContent`)).toBe('Opus 5.5');
          await evaluate(`document.querySelector(${q(row + ' .c-story')}).click()`);
          await waitFor(`document.querySelector(${q(row + ' .adoing')})?.offsetParent !== null`);
          expect(await evaluate(`document.querySelector(${q(row + ' .adoing')}).textContent`)).toBe('Run the tests');
          expect(await evaluate(`document.querySelector(${q(row + ' .anote')}).textContent`)).toBe('Set to Opus, runs on Sonnet 5.5');
          // The command is hidden until Show command.
          const raw = row + ' .araw';
          expect(await evaluate(`document.querySelector(${q(raw)}).offsetParent === null`)).toBe(true);
          await press('raw:w1:a1');
          await waitFor(`document.querySelector(${q(raw)}).offsetParent !== null`);
          expect(await evaluate(`document.querySelector(${q(raw)}).textContent`)).toBe('npm test');
          expect(await evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);

          await press('conv:a1');
          await waitFor(`document.querySelector('#convo').open && document.querySelectorAll('#convo-body details').length >= 2`);
          expect(await evaluate(`document.querySelector('#convo-sub').textContent`)).toContain('Running');
          expect(await evaluate(`document.querySelector('#convo-body').textContent`)).toContain('Starting the build.');
          // The tool call is described first; its input opens on its summary.
          const summary = await evaluate(`document.querySelector('#convo-body details summary').textContent`);
          expect(summary).toBe('Run the tests');
          await evaluate(`document.querySelector('#convo-body details summary').click()`);
          await waitFor(`document.querySelector('#convo-body details').open`);
          expect(await evaluate(`document.querySelector('#convo-body details pre').textContent`)).toBe('npm test');
          // Text is text: the img in the transcript is never made.
          expect(await evaluate(`document.querySelectorAll('#convo-body img').length`)).toBe(0);
          expect(await evaluate(`window.__x === undefined`)).toBe(true);
          expect(await evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
          const box = await evaluate(`(() => { const r = document.querySelector('#convo').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight }; })()`);
          expect(box.l).toBeGreaterThanOrEqual(0);
          expect(box.r).toBeLessThanOrEqual(box.w + 0.5);
          expect(box.b).toBeLessThanOrEqual(box.h + 0.5);
          if (width < 640) expect(Math.round(box.r - box.l)).toBe(box.w);

          await key('Escape');
          await waitFor(`!document.querySelector('#convo').open`);
          await waitFor(`document.activeElement?.dataset?.key === 'conv:a1'`);
        } finally {
          await cdp.send('Emulation.clearDeviceMetricsOverride');
        }
      }, LONG);
    }
  });
});
