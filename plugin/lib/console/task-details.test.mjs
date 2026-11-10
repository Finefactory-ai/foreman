import { describe, expect, it } from 'vitest';
import { taskDetails } from './task-details.mjs';

const EMPTY = { need: [], steps: [], effort: '', doneWhen: '' };

describe('taskDetails', () => {
  it('reads all four sections', () => {
    const md = [
      '# ACME-7 · Make the sandbox',
      '',
      '## What you need',
      '',
      '- Admin access to the Acme org',
      '- The sandbox name',
      '',
      '## Steps',
      '',
      '1. Open Setup',
      '2. Create a sandbox',
      '3. Share the login',
      '',
      '## Effort',
      '',
      'about 15 minutes',
      '',
      '## Done when',
      '',
      'The sandbox shows in the list.',
    ].join('\n');
    expect(taskDetails(md)).toEqual({
      need: ['Admin access to the Acme org', 'The sandbox name'],
      steps: ['Open Setup', 'Create a sandbox', 'Share the login'],
      effort: 'about 15 minutes',
      doneWhen: 'The sandbox shows in the list.',
    });
  });

  it('reads only the sections there, with Takes as the effort', () => {
    const md = '## Steps\n\n1. Buy the domain\n\n## Takes\n\n- 5 minutes\n';
    expect(taskDetails(md)).toEqual({ need: [], steps: ['Buy the domain'], effort: '5 minutes', doneWhen: '' });
  });

  it('gives empty fields for no sections, an empty string and anything not a string', () => {
    expect(taskDetails('# ACME-1\n\nJust some words.\n')).toEqual(EMPTY);
    expect(taskDetails('')).toEqual(EMPTY);
    expect(taskDetails(null)).toEqual(EMPTY);
    expect(taskDetails(42)).toEqual(EMPTY);
    expect(taskDetails(undefined)).toEqual(EMPTY);
  });

  it('reads headings at any level, and Done when with a colon in any case', () => {
    const md = '# What you need\n\n- A key\n\n### Steps\n\n- Add it\n\n###### Effort\n\nA minute\n\n## **Done When:**\n\nThe key works.\n';
    expect(taskDetails(md)).toEqual({ need: ['A key'], steps: ['Add it'], effort: 'A minute', doneWhen: 'The key works.' });
    expect(taskDetails('## DONE WHEN:\r\n\r\nIt is.\r\n').doneWhen).toBe('It is.');
    expect(taskDetails('## Steps ##\n\n- One\n').steps).toEqual(['One']);
  });

  it('reads numbered and bulleted lists, continuation lines, and paragraphs when there is no list', () => {
    expect(taskDetails('## Steps\n\n1. One\n2) Two\n   still two\n\n  - Three\n* Four\n+ Five\n').steps).toEqual(['One', 'Two still two', 'Three', 'Four', 'Five']);
    expect(taskDetails('## What you need\n\nA key\nfrom the vault\n\nA second key\n').need).toEqual(['A key from the vault', 'A second key']);
    expect(taskDetails('## Done when\n\n- It works\n- and is tested\n').doneWhen).toBe('It works and is tested');
    expect(taskDetails('## Effort\n\n  about   15\n  minutes  \n').effort).toBe('about 15 minutes');
  });

  it('never takes a heading inside a fence as a section', () => {
    const md = '## Steps\n\n1. Run this:\n\n```\n## Done when\n```\n\n~~~\n## Effort\n~~~\n';
    const got = taskDetails(md);
    expect(got.doneWhen).toBe('');
    expect(got.effort).toBe('');
  });

  it('counts only exact names', () => {
    expect(taskDetails('## Steps to reproduce\n\n1. Click\n')).toEqual(EMPTY);
  });

  it('takes the first section when a name is there twice', () => {
    expect(taskDetails('## Steps\n\n1. First\n\n## Steps\n\n1. Second\n').steps).toEqual(['First']);
  });

  it('reads a brief from the Jira source and leaves its comments alone', () => {
    const md = [
      '---',
      'id: ACME-7',
      'title: "Make the sandbox"',
      'status: todo',
      'url: https://acme.atlassian.net/browse/ACME-7',
      '---',
      '',
      '# ACME-7 · Make the sandbox',
      '',
      '## What',
      '',
      '### What you need',
      '',
      '- Admin access',
      '',
      '### Steps',
      '',
      '1. Open Setup',
      '2. Create it',
      '',
      '## Done when',
      '',
      '_Not given in the issue._',
      '',
      '## Comments',
      '',
      '_The last 10, newest first._',
      '',
      '### Someone, 2026-10-20',
      '',
      '#### Effort',
      '',
      'not this',
      '',
      '## Steps',
      '',
      '1. Not this one either',
      '',
    ].join('\n');
    expect(taskDetails(md)).toEqual({ need: ['Admin access'], steps: ['Open Setup', 'Create it'], effort: '', doneWhen: '' });
  });

  it('a level-1 heading inside a comment does not add a section', () => {
    const md = [
      '# ACME-8 · Rotate the key',
      '',
      '## What',
      '',
      'Rotate the Acme key.',
      '',
      '## Comments',
      '',
      '### Someone, 2026-10-20',
      '',
      '# Steps',
      '',
      '1. Do this bad thing',
      '',
      '# What you need',
      '',
      '- a password',
      '',
    ].join('\n');
    const out = taskDetails(md);
    expect(out.need).toEqual([]);
    expect(out.steps).toEqual([]);
  });

  it('reads nothing after Progress notes', () => {
    const md = '## Steps\n\n- yes\n\n## Progress notes\n\n### Effort\n\nno\n\n# Done when\n\nno\n';
    const out = taskDetails(md);
    expect(out.steps).toEqual(['yes']);
    expect(out.effort).toBe('');
    expect(out.doneWhen).toBe('');
    expect(taskDetails('## Progress notes\n\n## Steps\n\n- no\n').steps).toEqual([]);
  });

  it('reads a closing run of # only when a space comes before it', () => {
    expect(taskDetails('## Steps ##\n\n- one\n').steps).toEqual(['one']);
    expect(taskDetails('## Steps#\n\n- one\n').steps).toEqual([]);
    expect(taskDetails('##Steps\n\n- one\n').steps).toEqual([]);
  });
});

// Text from a Jira issue or a story file is outside input, parsed on the dashboard's event loop.
describe('taskDetails on hostile text', () => {
  const quick = (md) => {
    const start = performance.now();
    const out = taskDetails(md);
    expect(performance.now() - start).toBeLessThan(50);
    return out;
  };
  const N = 20_000;

  it('parses a heading line of 20k spaces quickly', () => {
    expect(quick('# a' + ' '.repeat(N) + 'x')).toEqual(EMPTY);
    expect(quick('## Steps' + ' '.repeat(N) + '#'.repeat(N) + ' '.repeat(N) + '\n\n- one\n')).toEqual(EMPTY);
  });

  it('parses long runs of markers and colons in a heading quickly', () => {
    quick('## ' + '*'.repeat(N) + 'x');
    quick('## ' + '_ '.repeat(N) + 'x');
    quick('## a' + ':'.repeat(N) + 'x');
  });

  it('parses a long list line quickly', () => {
    const out = quick('## Steps\n\n- ' + ' '.repeat(N) + 'a\rb\n');
    expect(out.steps).toHaveLength(1);
  });

  it('treats a heading line over 500 characters as plain text', () => {
    expect(taskDetails('## Steps' + ' '.repeat(600) + '\n\n- one\n').steps).toEqual([]);
    const long = '## ' + 'x'.repeat(600);
    expect(taskDetails('## Steps\n\n- one\n' + long + '\n- two\n').steps).toEqual(['one ' + long, 'two']);
  });

  it('reads only the first 256 KB', () => {
    const md = '## Effort\n\nabout 15 minutes\n' + 'x\n'.repeat(200_000) + '## Steps\n\n- late\n';
    const out = taskDetails(md);
    expect(out.steps).toEqual([]);
    expect(out.effort.startsWith('about 15 minutes')).toBe(true);
  });
});
