// Syntax highlighting with a vendored highlight.js, applied line by line so
// snippets keep their line numbers and per-line highlighting.

import { esc } from './core.js';

let hljs = null;
const extra = new Set(['dart', 'gradle', 'dockerfile', 'groovy', 'properties', 'scala', 'protobuf', 'nginx']);
const loading = new Map();

export async function loadHighlighter() {
  if (hljs) return hljs;
  try {
    hljs = (await import('/vendor/hljs/highlight.min.js')).default;
  } catch {
    hljs = null;
  }
  return hljs;
}

const BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', pyi: 'python', swift: 'swift', java: 'java', kt: 'kotlin', kts: 'kotlin',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', cs: 'csharp', c: 'c', h: 'objectivec', m: 'objectivec', mm: 'objectivec',
  cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', plist: 'xml', xib: 'xml', storyboard: 'xml', svg: 'xml', vue: 'xml',
  json: 'json', yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', md: 'markdown',
  lua: 'lua', r: 'r', pl: 'perl', graphql: 'graphql', gql: 'graphql', toml: 'ini', ini: 'ini', cfg: 'ini',
  xcconfig: 'ini', properties: 'properties', gradle: 'gradle', groovy: 'groovy', dart: 'dart', scala: 'scala',
  proto: 'protobuf', jsx_: 'javascript',
};

export function languageFor(path) {
  const base = String(path || '').split('/').pop();
  if (/^Dockerfile/i.test(base)) return 'dockerfile';
  if (/^Makefile$/i.test(base)) return 'makefile';
  if (/^Podfile$|\.podspec$/i.test(base)) return 'ruby';
  if (/\.gradle\.kts$/i.test(base)) return 'kotlin';
  if (/nginx.*\.conf$/i.test(base)) return 'nginx';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return BY_EXT[ext] || null;
}

// Loads grammars that aren't in the common bundle; re-renders are cheap, so
// callers simply render again once the promise resolves.
export function ensureLanguage(lang) {
  if (!hljs || !lang || hljs.getLanguage(lang)) return Promise.resolve(true);
  if (!extra.has(lang)) return Promise.resolve(false);
  if (!loading.has(lang)) {
    loading.set(
      lang,
      import(`/vendor/hljs/languages/${lang}.min.js`)
        .then((m) => {
          hljs.registerLanguage(lang, m.default);
          return true;
        })
        .catch(() => false)
    );
  }
  return loading.get(lang);
}

// Returns one HTML string per input line. Spans that cross line breaks
// (block comments, multi-line strings) are closed and reopened per line.
export function highlightLines(lines, path) {
  const lang = languageFor(path);
  if (!hljs || !lang || !hljs.getLanguage(lang)) {
    if (hljs && lang && !hljs.getLanguage(lang)) ensureLanguage(lang);
    return lines.map((l) => esc(l));
  }
  let html;
  try {
    html = hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value;
  } catch {
    return lines.map((l) => esc(l));
  }
  const out = [];
  const stack = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      stack.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      stack.pop();
      cur += m[2];
    } else if (m[3]) {
      out.push(cur + '</span>'.repeat(stack.length));
      cur = stack.join('');
    } else cur += m[4];
  }
  out.push(cur + '</span>'.repeat(stack.length));
  while (out.length < lines.length) out.push('');
  return out;
}

export function highlightBlock(code, path) {
  return highlightLines(String(code || '').split('\n'), path).join('\n');
}
