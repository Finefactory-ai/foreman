// A tiny path glob, enough for config paths: `**` matches any number of folders, `*` any
// characters within one folder, `?` one character other than `/`, and `{a,b}` any one of
// its comma-separated globs (not nested; braces without a comma are literal). Everything
// else is literal. (Node's path.matchesGlob is still experimental, so it is not used.)

const cache = new Map();

// The regex source for a glob, without anchors.
function source(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    const close = c === '{' ? pattern.indexOf('}', i) : -1;
    const inner = close === -1 ? '' : pattern.slice(i + 1, close);
    if (close !== -1 && inner.includes(',') && !inner.includes('{')) {
      re += `(?:${inner.split(',').map(source).join('|')})`;
      i = close;
    } else if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

const toRegExp = (pattern) => new RegExp(`^${source(pattern)}$`);

export function matchesGlob(path, pattern) {
  let re = cache.get(pattern);
  if (!re) {
    re = toRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(path);
}
