import { describe, expect, it } from 'vitest';
import { adfToMarkdown, markdownToAdf } from './adf.mjs';

const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, ...marks) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });
const li = (...content) => ({ type: 'listItem', content });
const ul = (...items) => ({ type: 'bulletList', content: items });
const ol = (...items) => ({ type: 'orderedList', content: items });

describe('adfToMarkdown', () => {
  it('gives empty text for nothing', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown(doc())).toBe('');
  });

  it('passes a plain string through (a text custom field)', () => {
    expect(adfToMarkdown('  The page loads.  ')).toBe('The page loads.');
  });

  it('separates paragraphs with a blank line', () => {
    expect(adfToMarkdown(doc(p(t('One.')), p(t('Two.'))))).toBe('One.\n\nTwo.');
  });

  it('writes headings at their level', () => {
    expect(adfToMarkdown(doc({ type: 'heading', attrs: { level: 2 }, content: [t('Plan')] }, p(t('x'))))).toBe('## Plan\n\nx');
    expect(adfToMarkdown(doc({ type: 'heading', attrs: { level: 4 }, content: [t('Deep')] }))).toBe('#### Deep');
  });

  it('writes bullet and ordered lists, nested', () => {
    const md = adfToMarkdown(doc(ul(li(p(t('a'))), li(p(t('b')), ol(li(p(t('b1'))), li(p(t('b2'))))))));
    expect(md).toBe('- a\n- b\n  1. b1\n  2. b2');
  });

  it('starts an ordered list at its order', () => {
    expect(adfToMarkdown(doc({ type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('c'))), li(p(t('d')))] }))).toBe('3. c\n4. d');
  });

  it('writes a code block with its language', () => {
    expect(adfToMarkdown(doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [t('const a = 1;\nconst b = 2;')] }))).toBe('```js\nconst a = 1;\nconst b = 2;\n```');
    expect(adfToMarkdown(doc({ type: 'codeBlock', content: [t('ls')] }))).toBe('```\nls\n```');
  });

  it('quotes a blockquote and a panel', () => {
    expect(adfToMarkdown(doc({ type: 'blockquote', content: [p(t('said')), p(t('twice'))] }))).toBe('> said\n>\n> twice');
    expect(adfToMarkdown(doc({ type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Note this.'))] }))).toBe('> Note this.');
  });

  it('writes a rule and a hard break', () => {
    expect(adfToMarkdown(doc(p(t('a')), { type: 'rule' }, p(t('b'), { type: 'hardBreak' }, t('c'))))).toBe('a\n\n---\n\nb\nc');
  });

  it('applies text marks', () => {
    const md = adfToMarkdown(doc(p(
      t('bold', { type: 'strong' }), t(' '),
      t('it', { type: 'em' }), t(' '),
      t('x()', { type: 'code' }), t(' '),
      t('gone', { type: 'strike' }), t(' '),
      t('site', { type: 'link', attrs: { href: 'https://example.com' } }), t(' '),
      t('both', { type: 'strong' }, { type: 'em' }),
    )));
    expect(md).toBe('**bold** *it* `x()` ~~gone~~ [site](https://example.com) ***both***');
  });

  it('writes mentions as @name and emoji as their text', () => {
    const md = adfToMarkdown(doc(p(
      { type: 'mention', attrs: { id: 'abc', text: '@Ada Lovelace' } }, t(' and '),
      { type: 'mention', attrs: { id: 'def', text: 'Grace' } }, t(' '),
      { type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } },
      { type: 'emoji', attrs: { shortName: ':custom:' } },
    )));
    expect(md).toBe('@Ada Lovelace and @Grace 😄:custom:');
  });

  it('writes inline cards as links', () => {
    expect(adfToMarkdown(doc(p(t('See '), { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/APP-1' } })))).toBe('See <https://acme.atlassian.net/browse/APP-1>');
    expect(adfToMarkdown(doc({ type: 'blockCard', attrs: { url: 'https://x.dev' } }))).toBe('<https://x.dev>');
  });

  it('writes a simple pipe table, header first', () => {
    const cell = (type, text) => ({ type, content: [p(t(text))] });
    const row = (...cells) => ({ type: 'tableRow', content: cells });
    const md = adfToMarkdown(doc({
      type: 'table',
      content: [row(cell('tableHeader', 'Name'), cell('tableHeader', 'Note')), row(cell('tableCell', 'a|b'), cell('tableCell', 'ok'))],
    }));
    expect(md).toBe('| Name | Note |\n| --- | --- |\n| a\\|b | ok |');
  });

  it('keeps the text of unknown nodes', () => {
    const md = adfToMarkdown(doc(
      { type: 'expand', attrs: { title: 'More' }, content: [p(t('hidden text'))] },
      p({ type: 'status', attrs: { text: 'IN REVIEW' } }, t(' now')),
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
    ));
    expect(md).toBe('hidden text\n\nIN REVIEW now');
  });
});

describe('markdownToAdf', () => {
  it('makes a doc of paragraphs', () => {
    expect(markdownToAdf('One.\n\nTwo.')).toEqual(doc(p(t('One.')), p(t('Two.'))));
  });

  it('turns single line breaks into hard breaks', () => {
    expect(markdownToAdf('a\nb')).toEqual(doc(p(t('a'), { type: 'hardBreak' }, t('b'))));
  });

  it('makes bullet lists', () => {
    expect(markdownToAdf('Do:\n\n- one\n* two')).toEqual(doc(p(t('Do:')), ul(li(p(t('one'))), li(p(t('two'))))));
  });

  it('reads a link that shows its own address as a bare URL', () => {
    const url = 'https://github.com/o/r/pull/1';
    expect(adfToMarkdown(markdownToAdf(`PR: ${url}`))).toBe(`PR: ${url}`);
  });

  it('makes headings', () => {
    expect(markdownToAdf('- a\n\n## Done when\n\nIt works.')).toEqual(doc(ul(li(p(t('a')))), { type: 'heading', attrs: { level: 2 }, content: [t('Done when')] }, p(t('It works.'))));
    expect(adfToMarkdown(markdownToAdf('One.\n## Two\nThree.'))).toBe('One.\n\n## Two\n\nThree.');
  });

  it('makes links, bare URLs and inline code', () => {
    expect(markdownToAdf('See [the PR](https://github.com/o/r/pull/1), `npm test` and https://x.dev/a.')).toEqual(doc(p(
      t('See '),
      t('the PR', { type: 'link', attrs: { href: 'https://github.com/o/r/pull/1' } }),
      t(', '),
      t('npm test', { type: 'code' }),
      t(' and '),
      t('https://x.dev/a', { type: 'link', attrs: { href: 'https://x.dev/a' } }),
      t('.'),
    )));
  });

  it('makes an ordered list of "1. " and "1) " lines, starting at the first number', () => {
    expect(markdownToAdf('Steps:\n\n1. one\n2) two')).toEqual(doc(p(t('Steps:')), ol(li(p(t('one'))), li(p(t('two'))))));
    expect(markdownToAdf('3. three\n4. four')).toEqual(doc({ type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('three'))), li(p(t('four')))] }));
    expect(adfToMarkdown(markdownToAdf('1. one\n2. two'))).toBe('1. one\n2. two');
  });

  it('keeps a fenced block, blank lines included, as a codeBlock with its language', () => {
    const md = 'Run:\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.';
    expect(markdownToAdf(md)).toEqual(doc(p(t('Run:')), { type: 'codeBlock', attrs: { language: 'js' }, content: [t('const a = 1;\n\nconst b = 2;')] }, p(t('Done.'))));
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
    expect(markdownToAdf('```\nplain\n```')).toEqual(doc({ type: 'codeBlock', content: [t('plain')] }));
  });

  it('keeps list, heading and bold markers inside a fence as code, and closes a fence left open at the end', () => {
    expect(markdownToAdf('```\n- not a list\n## not a heading\n```')).toEqual(doc({ type: 'codeBlock', content: [t('- not a list\n## not a heading')] }));
    expect(markdownToAdf('```\nopen')).toEqual(doc({ type: 'codeBlock', content: [t('open')] }));
  });

  it('makes **text** the strong mark, and leaves a lone ** alone', () => {
    expect(markdownToAdf('A **bold** word and `code`.')).toEqual(doc(p(t('A '), t('bold', { type: 'strong' }), t(' word and '), t('code', { type: 'code' }), t('.'))));
    expect(markdownToAdf('2 ** 3')).toEqual(doc(p(t('2 ** 3'))));
    expect(adfToMarkdown(markdownToAdf('- **Item** one'))).toBe('- **Item** one');
  });

  it('gives an empty doc for empty text, and round-trips through adfToMarkdown', () => {
    expect(markdownToAdf('')).toEqual(doc());
    const md = 'Foreman: started.\n\n- see `x`\n- [PR](https://g.dev/1)';
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
