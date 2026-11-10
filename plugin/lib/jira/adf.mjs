// Atlassian Document Format (ADF), the JSON Jira Cloud's v3 API uses for rich text, to and
// from markdown.
//
// adfToMarkdown(doc) covers what issue descriptions and comments hold: paragraph, heading,
// bullet and ordered lists (nested), codeBlock, blockquote, panel (as a quote), rule,
// hardBreak, tables (a simple pipe table, first row as the header), text marks (strong, em,
// code, strike, link), mention (@name), emoji, inlineCard and blockCard (as <url>). Any
// other node gives its text content. A plain string (a text custom field) passes through.
//
// markdownToAdf(text) is the small subset Foreman writes: paragraphs (a single line break is
// a hardBreak), "## " headings, bullet lists ("- " or "* "), ordered lists ("1. " or "1) ", the
// first number kept when it is not 1), fenced ``` blocks as codeBlock (the language after the
// fence is attrs.language; blank lines stay inside the block, and a fence left open runs to the
// end), [links](url), bare URLs, `inline code` and **bold** as the strong mark.

// ---- ADF -> markdown ----

const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date', 'placeholder', 'inlineExtension', 'mediaInline']);

const MARKS = {
  code: (s) => `\`${s}\``,
  em: (s) => `*${s}*`,
  strong: (s) => `**${s}**`,
  strike: (s) => `~~${s}~~`,
};
// Innermost first, so a link wraps everything else.
const MARK_ORDER = ['code', 'em', 'strong', 'strike', 'link'];

function textNode(node) {
  let s = String(node.text ?? '');
  if (!s.trim()) return s;
  const marks = [...(node.marks ?? [])].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type));
  for (const m of marks) {
    // A link that shows its own address stays a bare URL.
    if (m.type === 'link' && m.attrs?.href) s = s === m.attrs.href ? s : `[${s}](${m.attrs.href})`;
    else if (MARKS[m.type]) s = MARKS[m.type](s);
  }
  return s;
}

function inline(nodes = []) {
  return nodes.map(inlineNode).join('');
}

function inlineNode(node) {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'text':
      return textNode(node);
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const name = String(node.attrs?.text ?? '').replace(/^@/, '');
      return `@${name || 'someone'}`;
    }
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard':
      return node.attrs?.url ? `<${node.attrs.url}>` : '';
    default:
      if (typeof node.text === 'string') return node.text;
      if (typeof node.attrs?.text === 'string') return node.attrs.text;
      return Array.isArray(node.content) ? inline(node.content) : '';
  }
}

const plainText = (nodes = []) => nodes.map((n) => (n.type === 'text' ? String(n.text ?? '') : plainText(n.content))).join('');

const indent = (text, by) => text.split('\n').map((l, i) => (i === 0 || l === '' ? l : `${' '.repeat(by)}${l}`)).join('\n');
const quote = (text) => text.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

function blocks(nodes = [], sep = '\n\n') {
  return nodes.map(block).filter((s) => s !== '').join(sep);
}

function list(node, ordered) {
  const start = Number(node.attrs?.order) || 1;
  return (node.content ?? [])
    .map((item, i) => {
      const marker = ordered ? `${start + i}. ` : '- ';
      const body = item.type === 'listItem' ? blocks(item.content, '\n') : block(item);
      return `${marker}${indent(body, marker.length)}`;
    })
    .join('\n');
}

function table(node) {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return '';
  const cells = rows.map((r) => (r.content ?? []).map((c) => blocks(c.content, ' ').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()));
  const width = Math.max(...cells.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(cells[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...cells.slice(1).map(line)].join('\n');
}

function block(node) {
  if (!node || typeof node !== 'object') return '';
  switch (node.type) {
    case 'doc':
      return blocks(node.content);
    case 'paragraph':
      return inline(node.content);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `${'#'.repeat(level)} ${inline(node.content)}`;
    }
    case 'bulletList':
      return list(node, false);
    case 'orderedList':
      return list(node, true);
    case 'listItem':
      return blocks(node.content, '\n');
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language ?? ''}\n${plainText(node.content)}\n\`\`\``;
    case 'blockquote':
    case 'panel': {
      const inner = blocks(node.content);
      return inner ? quote(inner) : '';
    }
    case 'rule':
      return '---';
    case 'blockCard':
    case 'embedCard':
      return node.attrs?.url ? `<${node.attrs.url}>` : '';
    case 'table':
      return table(node);
    default: {
      if (INLINE.has(node.type)) return inlineNode(node);
      const content = node.content ?? [];
      if (content.length && content.every((c) => INLINE.has(c?.type))) return inline(content);
      return blocks(content);
    }
  }
}

export function adfToMarkdown(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc.trim();
  return block(doc).trim();
}

// ---- markdown -> ADF ----

const TOKEN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*\s](?:[^*]*[^*\s])?)\*\*|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
const text = (s, ...marks) => ({ type: 'text', text: s, ...(marks.length ? { marks } : {}) });
const link = (href) => ({ type: 'link', attrs: { href } });

function inlineAdf(line) {
  const out = [];
  let at = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > at) out.push(text(line.slice(at, m.index)));
    if (m[1] !== undefined) out.push(text(m[1], link(m[2])));
    else if (m[3] !== undefined) out.push(text(m[3], { type: 'code' }));
    else if (m[4] !== undefined) out.push(text(m[4], { type: 'strong' }));
    else out.push(text(m[5], link(m[5])));
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push(text(line.slice(at)));
  return out;
}

const paragraph = (lines) => ({
  type: 'paragraph',
  content: lines.flatMap((l, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...inlineAdf(l)]),
});

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const FENCE_OPEN = /^\s*```([^\s`]*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

// The text outside fences, as blocks.
function blocksOf(markdown) {
  const content = [];
  for (const chunk of markdown.split(/\n[ \t]*\n/)) {
    const lines = chunk.split('\n').filter((l) => l.trim() !== '');
    let para = [];
    let items = [];
    let numbered = null; // { start, items }
    const flushPara = () => {
      if (para.length) content.push(paragraph(para));
      para = [];
    };
    const flushList = () => {
      if (items.length) content.push({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [paragraph([i])] })) });
      items = [];
      if (numbered) {
        content.push({ type: 'orderedList', ...(numbered.start === 1 ? {} : { attrs: { order: numbered.start } }), content: numbered.items.map((i) => ({ type: 'listItem', content: [paragraph([i])] })) });
      }
      numbered = null;
    };
    for (const line of lines) {
      const bullet = BULLET.exec(line);
      const number = NUMBERED.exec(line);
      const heading = HEADING.exec(line);
      if (heading) {
        flushPara();
        flushList();
        content.push({ type: 'heading', attrs: { level: heading[1].length }, content: inlineAdf(heading[2]) });
      } else if (bullet) {
        flushPara();
        if (numbered) flushList();
        items.push(bullet[1]);
      } else if (number) {
        flushPara();
        if (items.length) flushList();
        if (!numbered) numbered = { start: Number(number[1]), items: [] };
        numbered.items.push(number[2]);
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  }
  return content;
}

export function markdownToAdf(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const content = [];
  let plain = [];
  const flush = () => {
    if (plain.length) content.push(...blocksOf(plain.join('\n')));
    plain = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      plain.push(lines[i]);
      continue;
    }
    flush();
    const code = [];
    for (i += 1; i < lines.length && !FENCE_CLOSE.test(lines[i]); i += 1) code.push(lines[i]);
    const body = code.join('\n');
    content.push({ type: 'codeBlock', ...(open[1] ? { attrs: { language: open[1] } } : {}), ...(body === '' ? {} : { content: [text(body)] }) });
  }
  flush();
  return { type: 'doc', version: 1, content };
}
