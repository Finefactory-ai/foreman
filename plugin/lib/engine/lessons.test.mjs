import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyOf } from './learn.mjs';
import { clusterFindings, errorSignature, LESSON_STORIES, lessons, lessonWindow, notFixedKey, sessionStory, similarity, SOURCES, toolErrors, topicWords } from './lessons.mjs';

const MISSING_TEST = [
  'Each behaviour has a test that fails when it breaks',
  'Judge the tests: each behaviour has a test that fails if it breaks',
  'Each behaviour in the design has a test',
  'Each behaviour in the design has a test that would fail if it broke',
  "How we work: each behaviour has a test (CLAUDE.md 'Tests first')",
];

const atOf = (n) => new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString();

// One finding line on story S-n, written at minute n unless `at` says otherwise.
const finding = (n, rule, extra = {}) => ({ at: atOf(n), story: `S-${n}`, result: 'shipped', builder: 'developer', stage: 'tester', severity: 'minor', rule, where: 'src/acme.mjs:1', observed: 'seen', fix: 'do it', ...extra });

const run = (story, extra = {}) => ({ story, slot: 'w1', result: 'shipped', startedAt: '2026-10-24T09:00:00.000Z', endedAt: '2026-10-24T09:30:00.000Z', rounds: 1, ...extra });

const of = (r, source) => r.candidates.filter((c) => c.source === source);

describe('topicWords', () => {
  it('drops list numbers and keeps a non-generic label as the topic', () => {
    expect(topicWords('4/5 Secrets and errors: internal detail should not reach a response')).toEqual(['secret', 'error']);
    expect(topicWords('Input: validate outside input (skills-lock.json is repo content)')).toEqual(['input']);
  });

  it('drops a generic heading, even with a letter after it', () => {
    expect(topicWords('Test plan B: tests should show x')).toEqual(['test', 'show']);
    expect(topicWords('Design:')).toEqual([]);
  });

  it('stems plurals and past tenses', () => {
    expect(topicWords('Error paths are tested')).toEqual(['error', 'path', 'test']);
  });
});

describe('similarity', () => {
  it('is the Dice score of two word lists', () => {
    expect(similarity(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(similarity(['a', 'b'], ['a', 'c'])).toBe(0.5);
    expect(similarity([], [])).toBe(0);
  });
});

describe('clusterFindings', () => {
  it('puts the five real wordings of the missing-test rule in one cluster', () => {
    const clusters = clusterFindings(MISSING_TEST.map((rule, i) => finding(i + 1, rule)));
    expect(clusters).toHaveLength(1);
    expect(clusters[0].family).toBe('review');
    expect(clusters[0].key).toMatch(/^f-[0-9a-f]{12}$/);
  });

  it('skips a line with no topic words or no story', () => {
    expect(clusterFindings([finding(1, 'Design:'), { ...finding(2, 'Error paths are tested'), story: '' }])).toEqual([]);
  });
});

describe('lessons: findings', () => {
  it('the five wordings make one candidate on all five stories', () => {
    const r = lessons({ findings: MISSING_TEST.map((rule, i) => finding(i + 1, rule)) });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ source: 'findings', role: 'developer', stories: ['S-1', 'S-2', 'S-3', 'S-4', 'S-5'] });
    expect(r.window).toEqual({ size: LESSON_STORIES, stories: 5 });
  });

  it("'Error paths are tested' stays out of the missing-test cluster", () => {
    const r = lessons({ findings: [...MISSING_TEST.map((rule, i) => finding(i + 1, rule)), finding(6, 'Error paths are tested')] });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].stories).not.toContain('S-6');
  });

  it('two serious stories make a candidate; one does not', () => {
    const rule = 'Acme routes check their input';
    const two = lessons({ findings: [finding(1, rule, { severity: 'blocker' }), finding(2, rule, { severity: 'major' })] });
    expect(of(two, 'findings')).toHaveLength(1);
    expect(of(two, 'findings')[0].stories).toEqual(['S-1', 'S-2']);
    const one = lessons({ findings: [finding(1, rule, { severity: 'blocker' }), finding(2, rule)] });
    expect(of(one, 'findings')).toEqual([]);
  });

  it('a minor rule needs five stories', () => {
    const rule = 'Acme docs stay current';
    const four = [1, 2, 3, 4].map((n) => finding(n, rule));
    expect(lessons({ findings: four }).candidates).toEqual([]);
    expect(lessons({ findings: [...four, finding(5, rule)] }).candidates).toHaveLength(1);
  });

  it('fixed round lines count as serious', () => {
    const rule = 'Acme routes check their input';
    const r = lessons({ findings: [1, 2].map((n) => finding(n, rule, { severity: 'major', round: 1, resolved: true })) });
    expect(of(r, 'findings')).toHaveLength(1);
  });

  it('a cluster stays within its stage family', () => {
    const rule = 'Acme docs stay current';
    const lines = [finding(1, rule), finding(2, rule), finding(3, rule, { stage: 'compliance' }), finding(4, rule, { stage: 'merge' }), finding(5, rule, { stage: 'merge' })];
    expect(lessons({ findings: lines }).candidates).toEqual([]);
  });

  it('counts only the last 60 stories', () => {
    const rule = 'Acme docs stay current';
    const lines = [1, 2, 3, 4, 5].map((n) => finding(n, rule));
    const runs = Array.from({ length: 56 }, (_, i) => run(`S-${i + 6}`, { endedAt: new Date(Date.UTC(2026, 9, 2, 0, i)).toISOString() }));
    const r = lessons({ findings: lines, runs });
    expect(r.window.stories).toBe(60);
    expect(r.candidates).toEqual([]);
    expect(lessons({ findings: lines, runs, size: 61 }).candidates).toHaveLength(1);
  });

  it('keeps its key as members are added and as the window shrinks', () => {
    // The seed (S-1) has a word the later members lack, so a key taken from any
    // other member, or from only the in-window findings, would differ.
    const seed = finding(1, 'Acme docs stay current in the guide');
    expect(topicWords(seed.rule)).toEqual(['acme', 'doc', 'current', 'guide']);
    const five = [seed, ...[2, 3, 4, 5].map((n) => finding(n, 'Acme docs stay current'))];
    const key = lessons({ findings: five }).candidates[0].key;
    expect(key).toBe('f-' + createHash('sha256').update('review\nacme current doc guide').digest('hex').slice(0, 12));
    const six = [...five, finding(6, 'Acme docs current wording')];
    const grown = lessons({ findings: six });
    expect(grown.candidates[0].stories).toHaveLength(6);
    expect(grown.candidates[0].key).toBe(key);
    const shrunk = lessons({ findings: six, size: 5 });
    expect(shrunk.candidates[0].stories).toEqual(['S-2', 'S-3', 'S-4', 'S-5', 'S-6']);
    expect(shrunk.candidates[0].key).toBe(key);
  });
});

describe('lessonWindow', () => {
  it('orders stories by their latest time, oldest first, and keeps the last `size`', () => {
    const findings = [finding(5, 'x'), { ...finding(1, 'x'), at: 'not a time' }, finding(3, 'x')];
    const runs = [run('S-3', { endedAt: atOf(9) })];
    expect(lessonWindow({ findings, runs })).toEqual(['S-1', 'S-5', 'S-3']);
    expect(lessonWindow({ findings, runs }, 2)).toEqual(['S-5', 'S-3']);
  });
});

describe('lessons: failed runs and retry notes', () => {
  it('a failed run gives one candidate with the story builder as its role', () => {
    const r = lessons({ findings: [finding(3, 'Acme routes check their input', { severity: 'major' })], runs: [run('S-3', { result: 'failed', rounds: 3 })] });
    const failed = of(r, 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ source: 'failed', stories: ['S-3'], role: 'developer' });
    expect(failed[0].key).toMatch(/^r-[0-9a-f]{12}$/);
    expect(failed[0].evidence.at(-1)).toEqual({ rounds: 3 });
  });

  it("a note for the architect gives a candidate; other notes and notes outside the window do not", () => {
    const runs = [run('S-2')];
    const note = { story: 'S-2', date: '2026-10-24', text: 'Note for the architect: use the Acme cache' };
    const r = lessons({ runs, notes: [note] });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ source: 'retry-note', role: 'architect', stories: ['S-2'] });
    expect(r.candidates[0].key).toMatch(/^a-[0-9a-f]{12}$/);
    expect(r.candidates[0].evidence).toEqual([note]);
    expect(lessons({ runs, notes: [{ ...note, text: 'Started.' }] }).candidates).toEqual([]);
    expect(lessons({ runs, notes: [{ ...note, story: 'S-9' }] }).candidates).toEqual([]);
  });
});

describe('lessons: a fix that did not fix', () => {
  const rule = 'Acme routes check their input';
  const at = atOf(1);
  const line = (round, extra = {}) => finding(1, rule, { at, severity: 'blocker', ...(round === undefined ? {} : { round }), ...extra });

  it('the same cluster in rounds 1 and 2 of one story gives a candidate', () => {
    const r = lessons({ findings: [line(1, { resolved: true }), line(2, { resolved: true })] });
    const nf = of(r, 'not-fixed');
    expect(nf).toHaveLength(1);
    expect(nf[0]).toMatchObject({ stories: ['S-1'], role: 'developer' });
    expect(nf[0].key).toMatch(/^n-[0-9a-f]{12}$/);
  });

  it('notFixedKey gives the key of the not-fixed candidate', () => {
    const findings = [line(1, { resolved: true }), line(2, { resolved: true })];
    const [c] = clusterFindings(findings);
    expect(of(lessons({ findings }), 'not-fixed')[0].key).toBe(notFixedKey(c.key, 'S-1'));
  });

  it('rounds 1 and 3 only give none', () => {
    expect(of(lessons({ findings: [line(1), line(3)] }), 'not-fixed')).toEqual([]);
  });

  it('the final line without a round counts as the next round', () => {
    expect(of(lessons({ findings: [line(1, { resolved: true }), line(undefined)] }), 'not-fixed')).toHaveLength(1);
  });
});

describe('tool errors', () => {
  const ERROR = (n) => `Exit code 1\nls: /tmp/acme/plans/S-${n}.json: No such file or directory`;
  const log = (errors) => {
    const lines = [JSON.stringify({ type: 'system', subtype: 'init' })];
    errors.forEach((text, i) => {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `tu-${i}`, name: 'Bash', input: { command: 'ls' } }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${i}`, is_error: true, content: text }] } }));
    });
    return `${lines.join('\n')}\n`;
  };
  const runs = [run('S-1', { slot: 'w1', startedAt: '2026-10-24T09:00:00.000Z' }), run('S-2', { slot: 'w2', startedAt: '2026-10-24T10:00:01.000Z' })];
  const SIG = 'Bash: ls: <path>: no such file or directory';

  it('errorSignature strips paths and the exit line, and is null without words', () => {
    expect(errorSignature(ERROR(1))).toBe('ls: <path>: no such file or directory');
    expect(errorSignature('Exit code 1')).toBeNull();
    expect(errorSignature('{"a":1}\nfetch FM-12 at 3f9a2b1c failed after 30 tries')).toBe('fetch <id> at <hex> failed after <n> tries');
  });

  it('toolErrors reads the failed tool results and skips torn lines', () => {
    const text = `${log([ERROR(1)])}{"type":"user","is_error":true,"message":{"content":[\n`;
    expect(toolErrors(text)).toEqual([{ tool: 'Bash', signature: SIG, text: ERROR(1) }]);
  });

  it('toolErrors joins text blocks', () => {
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: [{ type: 'text', text: 'Exit code 2' }, { type: 'text', text: 'permission denied for acme cache' }] }] } });
    expect(toolErrors(line)).toEqual([{ tool: 'tool', signature: 'tool: permission denied for acme cache', text: 'Exit code 2\npermission denied for acme cache' }]);
  });

  it('sessionStory maps a log to its run, within 5 seconds', () => {
    expect(sessionStory('w1-20261024-090000.log', runs)).toBe('S-1');
    expect(sessionStory('w2-20261024-100000.log', runs)).toBe('S-2');
    expect(sessionStory('w1-20261024-090000-2.log', runs)).toBe('S-1');
    expect(sessionStory('w2-20261024-100010.log', runs)).toBeNull();
    expect(sessionStory('w3-20261024-090000.log', runs)).toBeNull();
    expect(sessionStory('supervisor.out', runs)).toBeNull();
  });

  it('the same error in two stories gives one candidate', () => {
    const logs = [
      { name: 'w1-20261024-090000.log', text: log([ERROR(1)]) },
      { name: 'w2-20261024-100000.log', text: log([ERROR(2)]) },
      { name: 'w9-20261024-110000.log', text: log([ERROR(9)]) },
    ];
    const r = lessons({ runs, logs });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ source: 'tool-error', role: 'all', cluster: SIG, stories: ['S-1', 'S-2'] });
    expect(r.candidates[0].key).toMatch(/^t-[0-9a-f]{12}$/);
    expect(r.candidates[0].evidence[0]).toMatchObject({ story: 'S-2', session: 'w2-20261024-100000.log', tool: 'Bash' });
  });

  it('one session gives none, unless the error is there three times', () => {
    expect(lessons({ runs, logs: [{ name: 'w1-20261024-090000.log', text: log([ERROR(1), ERROR(1)]) }] }).candidates).toEqual([]);
    const three = lessons({ runs, logs: [{ name: 'w1-20261024-090000.log', text: log([ERROR(1), ERROR(2), ERROR(3)]) }] });
    expect(three.candidates).toHaveLength(1);
    expect(three.candidates[0].stories).toEqual(['S-1']);
    expect(three.candidates[0].evidence).toHaveLength(3);
  });

  it('redacts secrets in the evidence', () => {
    const secret = `Exit code 1\ncurl failed: sk-ant-api03-${'a'.repeat(30)} was refused`;
    const r = lessons({ runs, logs: [{ name: 'w1-20261024-090000.log', text: log([secret]) }, { name: 'w2-20261024-100000.log', text: log([secret]) }] });
    expect(r.candidates).toHaveLength(1);
    const text = JSON.stringify(r.candidates[0]);
    expect(text).toContain('•••');
    expect(text).not.toContain('sk-ant-api03');
  });

  it('redacts a configured value before the signature lowercases it', () => {
    const secret = 'Exit code 1\nerror: login refused for AcmeInternalSecret';
    const logs = [{ name: 'w1-20261024-090000.log', text: log([secret]) }, { name: 'w2-20261024-100000.log', text: log([secret]) }];
    const r = lessons({ runs, logs, redactValues: ['AcmeInternalSecret'] });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].cluster).toBe('Bash: error: login refused for •••');
    const text = JSON.stringify(r.candidates[0]).toLowerCase();
    expect(text).not.toContain('acmeinternalsecret');
    expect(toolErrors(log([secret]), { redactValues: ['AcmeInternalSecret'] })[0]).toEqual({ tool: 'Bash', signature: 'Bash: error: login refused for •••', text: 'Exit code 1\nerror: login refused for •••' });
  });

  it('redacts env, file values and looks-secret text before the signature, key and evidence', () => {
    const jwt = (tail) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY21lIn0.${tail}`;
    const leak = (v, token, sb) => `Exit code 1\ncurl: error: refused X_KEY=${v} token ${token} ${sb} AcmeFileValue123 ghsecretvalue1`;
    const raw = ['acmekeyone', 'acmekeytwo', jwt('Sig0neAcme12'), jwt('Sig7woAcme34'), 'sb_secret_Acme1aaaaaaa', 'sb_secret_Acme2bbbbbbb', 'AcmeFileValue123', 'ghsecretvalue1'];
    const logs = [
      { name: 'w1-20261024-090000.log', text: log([leak(raw[0], raw[2], raw[4])]) },
      { name: 'w2-20261024-100000.log', text: log([leak(raw[1], raw[3], raw[5])]) },
    ];
    const r = lessons({ runs, logs, env: { GH_TOKEN: 'ghsecretvalue1' }, redactValues: ['AcmeFileValue123'] });
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.cluster).toBe('Bash: curl: error: refused x_key=••• token ••• ••• ••• •••');
    expect(c.key).toBe(`t-${createHash('sha256').update(c.cluster).digest('hex').slice(0, 12)}`);
    const text = JSON.stringify(c);
    expect(text).toContain('•••');
    for (const v of raw) expect(text.toLowerCase()).not.toContain(v.toLowerCase());
  });

  it('toolErrors blanks an env secret name value', () => {
    const [e] = toolErrors(log(['Exit code 1\nerror: login refused with ghsecretvalue1 for acme']), { env: { GH_TOKEN: 'ghsecretvalue1' } });
    expect(e.text).toBe('Exit code 1\nerror: login refused with ••• for acme');
    expect(e.signature).toBe('Bash: error: login refused with ••• for acme');
  });

  it('an uppercase secret-looking value gives a key hashed from its cluster', () => {
    const upper = 'Exit code 1\nerror: login refused for SK_ABCDEFGH';
    const logs = [{ name: 'w1-20261024-090000.log', text: log([upper]) }, { name: 'w2-20261024-100000.log', text: log([upper]) }];
    const r = lessons({ runs, logs });
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.cluster).toBe('Bash: error: login refused for •••');
    expect(c.key).toBe(`t-${createHash('sha256').update(c.cluster).digest('hex').slice(0, 12)}`);
  });

  it('values that clean to the same signature count as one lesson', () => {
    const logs = [
      { name: 'w1-20261024-090000.log', text: log(['Exit code 1\nerror: login refused for SK_ABCDEFGH']) },
      { name: 'w2-20261024-100000.log', text: log(['Exit code 1\nerror: login refused for SK_ZYXWVUTS']) },
    ];
    const r = lessons({ runs, logs });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ cluster: 'Bash: error: login refused for •••', stories: ['S-1', 'S-2'] });
  });

  it('toolErrors cleans the lowercased signature', () => {
    expect(toolErrors(log(['Exit code 1\nerror: login refused for SK_ABCDEFGH']))[0].signature).toBe('Bash: error: login refused for •••');
  });

  it('errorSignature caps a very long line', () => {
    const start = Date.now();
    const sig = errorSignature('error ' + 'z'.repeat(200000));
    const took = Date.now() - start;
    expect(sig).toBe('error ' + 'z'.repeat(114));
    expect(took).toBeLessThan(1000);
  });

  it('a tool result made only of a secret gives no candidate', () => {
    const only = 'Exit code 1\nX_KEY=abc';
    const logs = [{ name: 'w1-20261024-090000.log', text: log([only]) }, { name: 'w2-20261024-100000.log', text: log([only]) }];
    expect(lessons({ runs, logs }).candidates).toEqual([]);
    expect(toolErrors(log([only]))).toEqual([]);
  });
});

describe('lessons: skipped, covered and redacted', () => {
  const rule = 'Acme docs stay current';
  const five = [1, 2, 3, 4, 5].map((n) => finding(n, rule));
  const key = lessons({ findings: five }).candidates[0].key;

  it('a key in skip gives nothing', () => {
    expect(lessons({ findings: five, skip: [key] }).candidates).toEqual([]);
  });

  it("a member's learn key in skip gives nothing", () => {
    expect(lessons({ findings: five, skip: [keyOf('developer', rule)] }).candidates).toEqual([]);
  });

  it('an item in force moves the candidate to covered; one at v0 does not', () => {
    const covered = lessons({ findings: five, items: [{ id: 'L-1', v: 1, source: { key } }] });
    expect(covered.candidates).toEqual([]);
    expect(covered.covered).toEqual([{ key, id: 'L-1', source: 'findings', cluster: 'Acme docs stay current', stories: ['S-1', 'S-2', 'S-3', 'S-4', 'S-5'] }]);
    const removed = lessons({ findings: five, items: [{ id: 'L-1', v: 0, source: { key } }] });
    expect(removed.candidates).toHaveLength(1);
    expect(removed.covered).toEqual([]);
  });

  it('skipped wins over covered', () => {
    const r = lessons({ findings: five, skip: [key], items: [{ id: 'L-1', v: 1, source: { key } }] });
    expect(r).toMatchObject({ candidates: [], covered: [] });
  });

  it('redacts the configured values in findings evidence, at most five, most recent first', () => {
    const lines = [...five, finding(6, rule, { observed: 'AcmeInternal leaked into the reply' })];
    const c = lessons({ findings: lines, redactValues: ['AcmeInternal'] }).candidates[0];
    expect(c.evidence).toHaveLength(5);
    expect(c.evidence[0]).toMatchObject({ story: 'S-6', stage: 'tester', severity: 'minor', rule, observed: '••• leaked into the reply' });
    expect(c.evidence.map((e) => e.story)).toEqual(['S-6', 'S-5', 'S-4', 'S-3', 'S-2']);
  });

  it('cut redacts findings evidence', () => {
    const lines = [...five, finding(6, rule, { observed: 'sent Bearer abc.def and sb_secret_xxxxxxxxxx to Acme' })];
    const c = lessons({ findings: lines }).candidates[0];
    expect(c.evidence[0].observed).toBe('sent Bearer ••• and ••• to Acme');
    expect(JSON.stringify(c)).not.toMatch(/abc\.def|sb_secret_x/);
  });
});

describe('lessons: order', () => {
  it('sorts by stories, then source, then key', () => {
    const rule = 'Acme routes check their input';
    const findings = [finding(1, rule, { severity: 'major' }), finding(2, rule, { severity: 'major' })];
    const runs = [run('S-1'), run('S-2'), run('S-3', { result: 'failed' })];
    const notes = [{ story: 'S-3', date: '2026-10-24', text: 'Note for the architect: split it' }];
    const r = lessons({ findings, runs, notes });
    expect(r.candidates.map((c) => c.source)).toEqual(['findings', 'failed', 'retry-note']);
    expect(SOURCES).toEqual(['findings', 'not-fixed', 'failed', 'retry-note', 'tool-error']);
  });
});
