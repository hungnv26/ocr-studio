// Shared state and helpers for every page. No build step: plain ES modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const view = $('#view');

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ocr-studio': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function toast(msg, err = false) {
  const el = document.createElement('div');
  el.textContent = msg;
  if (err) el.className = 'err';
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), err ? 7000 : 3500);
}

export function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

export const money = (n) => (n ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '—');
export const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
export const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// Escape-first Markdown: headings, fenced code, inline code, bold/italic,
// links (http/https only), nested bullet and numbered lists, tables.
export function md(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const parts = src.split(/^```[\w+-]*[ \t]*$/m);
  return parts
    .map((part, i) => {
      if (i % 2) return `<pre><code>${esc(part.replace(/^\n|\n$/g, ''))}</code></pre>`;
      return blocks(part);
    })
    .join('');
}

function inline(s) {
  let out = esc(s);
  const codes = [];
  out = out.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
}

function blocks(text) {
  const lines = text.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      html.push(`<div class="md-h md-h${h[1].length}">${inline(h[2])}</div>`);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      html.push(`<table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) items.push(lines[i++]);
      html.push(list(items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
    html.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return html.join('');
}

function list(items) {
  const indent = (l) => l.match(/^\s*/)[0].length;
  const base = indent(items[0]);
  const ordered = /^\s*\d+[.)]/.test(items[0]);
  const out = [];
  let k = 0;
  while (k < items.length) {
    const text = items[k].replace(/^\s*([-*]|\d+[.)])\s+/, '').trim();
    k++;
    const children = [];
    while (k < items.length && indent(items[k]) > base) children.push(items[k++]);
    const sub = children.filter((c) => /^\s*([-*]|\d+[.)])\s+/.test(c));
    const extra = children.filter((c) => !/^\s*([-*]|\d+[.)])\s+/.test(c)).map((c) => c.trim());
    out.push(`<li>${inline([text, ...extra].join(' '))}${sub.length ? list(sub) : ''}</li>`);
  }
  return ordered ? `<ol>${out.join('')}</ol>` : `<ul>${out.join('')}</ul>`;
}

const svg = (body, w = 2) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const I = {
  home: svg('<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2Z"/>'),
  review: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  scan: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>'),
  rules: svg('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  folder: svg('<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  git: svg('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
  edit: svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>'),
  branch: svg('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  commit: svg('<circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/>'),
  spark: svg('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>'),
  cpu: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'),
  check: svg('<polyline points="20 6 9 17 4 12"/>', 2.5),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>', 2.5),
  skip: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  wand: svg('<path d="m15 4 5 5L9 20l-5-5Z"/><path d="M14 2v2M20 8h2M17.5 3.5 19 2"/>'),
  open: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  list: svg('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  cards: svg('<rect x="3" y="3" width="18" height="7" rx="1.5"/><rect x="3" y="14" width="18" height="7" rx="1.5"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'),
  undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  verify: svg('<path d="M9 12l2 2 4-4"/><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>'),
  project: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  play: svg('<polygon points="6 3 20 12 6 21 6 3"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>'),
};
export const icon = (name, size = 15) => (I[name] || '').replace('<svg', `<svg width="${size}" height="${size}" style="vertical-align:-0.15em"`);

export const SEVS = ['critical', 'high', 'medium', 'low'];
export const MODELS = [
  { id: 'haiku', label: 'Haiku', note: 'fastest' },
  { id: 'sonnet', label: 'Sonnet', note: 'balanced' },
  { id: 'opus', label: 'Opus', note: 'deepest' },
];
export const EFFORTS = ['low', 'medium', 'high'];
export const FOCUS_LABELS = {
  bugs: 'Bugs',
  security: 'Security',
  performance: 'Performance',
  errors: 'Error handling',
  concurrency: 'Concurrency',
  maintainability: 'Maintainability',
  tests: 'Tests',
  style: 'Style nits',
};

// ------------------------------------------------------------------ app state

export const S = {
  health: null,
  repo: null,
  lastRepo: null,
  mode: 'diff',
  target: { kind: 'workspace', from: '', to: '', commit: '', paths: '' },
  preview: null,
  previewLoading: false,
  previewError: '',
  selected: new Set(),
  exclude: '',
  engine: { type: 'claude', model: 'sonnet', effort: 'medium' },
  focus: new Set(['bugs', 'security', 'performance', 'errors', 'concurrency', 'maintainability', 'tests']),
  background: '',
  starting: false,
  editors: null,
};

export function restorePrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('ocr-studio-prefs') || '{}');
    if (p.focus) S.focus = new Set(p.focus);
    if (p.engine) Object.assign(S.engine, p.engine);
    if (p.repo) S.lastRepo = p.repo;
  } catch {}
}

export function savePrefs() {
  try {
    localStorage.setItem('ocr-studio-prefs', JSON.stringify({ focus: [...S.focus], engine: S.engine, repo: S.repo?.repo || S.lastRepo }));
  } catch {}
}

// Small per-browser UI preferences (theme, density, view modes).
export function pref(key, fallback) {
  try {
    const v = localStorage.getItem(`ocr-studio-${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function setPref(key, value) {
  try {
    localStorage.setItem(`ocr-studio-${key}`, JSON.stringify(value));
  } catch {}
}

export function applyLook() {
  const theme = pref('theme', 'auto');
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.setAttribute('data-density', pref('density', 'comfortable'));
}

export function keepScroll(fn) {
  const y = window.scrollY;
  fn();
  window.scrollTo(0, y);
}

// Pages register a cleanup (timers, event sources, key handlers) that the
// router runs before showing the next page.
let cleanups = [];
export function onLeave(fn) {
  cleanups.push(fn);
}
export function runCleanups() {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
}

// ------------------------------------------------------------------ tools

export async function loadHealth(force = false) {
  if (force) await api('/api/tools/refresh', { method: 'POST' });
  S.health = await api('/api/health');
  if (!localStorage.getItem('ocr-studio-prefs')) {
    S.engine.model = S.health.settings.model;
    S.engine.effort = S.health.settings.effort;
  }
  renderSideStatus();
}

export function renderSideStatus() {
  const t = S.health?.tools;
  if (!t) return;
  const row = (ok, name, detail) => `<div class="row"><i class="dot ${ok ? 'ok' : 'bad'}"></i><span>${name}</span><span title="${esc(detail)}">${esc(detail)}</span></div>`;
  $('#side-status').innerHTML =
    row(!!t.claude, 'Claude Code', t.claude ? t.claude.version.split(' ')[0] : 'not found') +
    row(!!t.ocr, 'OCR CLI', t.ocr ? t.ocr.version.split(' ')[1] : 'not installed') +
    row(!!t.git?.ok, 'Git', t.git ? t.git.version.split(' ')[0] : 'missing');
}

export async function selectRepo(dir) {
  const info = await api('/api/repo/info', { method: 'POST', body: { path: dir } });
  S.repo = info;
  S.lastRepo = info.repo;
  S.target.from = info.defaultBranch && info.defaultBranch !== info.branch ? info.defaultBranch : info.branches.find((b) => b !== info.branch) || '';
  S.target.to = info.branch !== '(detached)' ? info.branch : info.branches[0] || '';
  S.target.commit = info.commits[0]?.hash || '';
  if (S.target.kind === 'workspace' && info.dirtyCount === 0 && S.mode === 'diff') S.target.kind = info.commits.length > 1 ? 'commit' : 'workspace';
  try {
    const g = await api('/api/guard', { method: 'POST', body: { repo: info.repo } });
    if (g.defaults?.model) S.engine.model = g.defaults.model;
    if (g.defaults?.effort) S.engine.effort = g.defaults.effort;
  } catch {}
  savePrefs();
  document.dispatchEvent(new CustomEvent('repo-changed'));
  return info;
}

export async function openInEditor(repo, path, line) {
  try {
    const r = await api('/api/open', { method: 'POST', body: { repo, path, line } });
    toast(`Opening in ${r.editor}…`);
  } catch (err) {
    toast(err.message, true);
  }
}

export async function copyText(text, msg = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(msg);
  }
}

export function download(name, body, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ dialogs

// Promise-based modal. `render` returns the inner HTML; `bind(root, close)`
// wires it up; resolves with whatever is passed to close().
export function modal(render, bind, { wide = false } = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="card modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${render()}</div>`;
    document.body.appendChild(back);
    const prevFocus = document.activeElement;
    const close = (value) => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(undefined);
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => e.target === back && close(undefined));
    bind?.(back.firstElementChild, close);
    const first = back.querySelector('[autofocus], textarea, input, .btn.primary');
    first?.focus();
  });
}

export function confirmDialog({ title, body = '', ok = 'Continue', danger = false, cancel = 'Cancel' }) {
  return modal(
    () => `<h2>${title}</h2><div class="modal-body">${body}</div>
      <div class="modal-actions"><button class="btn ghost" data-x>${cancel}</button><button class="btn ${danger ? 'danger-solid' : 'primary'}" data-ok>${ok}</button></div>`,
    (root, close) => {
      root.querySelector('[data-x]').addEventListener('click', () => close(false));
      root.querySelector('[data-ok]').addEventListener('click', () => close(true));
    }
  ).then((v) => !!v);
}

export function promptDialog({ title, body = '', placeholder = '', ok = 'Save', value = '', rows = 4, extra = '' }) {
  return modal(
    () => `<h2>${title}</h2><div class="modal-body">${body}<textarea data-v rows="${rows}" placeholder="${esc(placeholder)}" style="margin-top:10px">${esc(value)}</textarea>${extra}</div>
      <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${ok}</button></div>`,
    (root, close) => {
      const ta = root.querySelector('[data-v]');
      const done = () => close({ value: ta.value.trim(), root });
      root.querySelector('[data-x]').addEventListener('click', () => close(null));
      root.querySelector('[data-ok]').addEventListener('click', done);
      ta.addEventListener('keydown', (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && done());
      setTimeout(() => ta.focus(), 0);
    }
  );
}

// ------------------------------------------------------------------ keyboard

// One global handler; pages register shortcuts for their lifetime.
const keymap = new Map();
export function bindKeys(map) {
  for (const [k, fn] of Object.entries(map)) keymap.set(k, fn);
  onLeave(() => {
    for (const k of Object.keys(map)) keymap.delete(k);
  });
}
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (typing) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  if (document.querySelector('.modal-back')) return;
  const fn = keymap.get(e.key);
  if (fn) {
    e.preventDefault();
    fn(e);
  }
});

export function toolsMissingBanner() {
  const t = S.health?.tools || {};
  const issues = [];
  if (!t.ocr) issues.push('the <b>OCR CLI</b> is not installed');
  if (!t.claude) issues.push('<b>Claude Code</b> was not found');
  if (t.git && !t.git.ok) issues.push(`Git ${esc(t.git.version)} is older than 2.41`);
  if (!issues.length) return '';
  return `<div class="banner warn">⚠️ <div>Before you start: ${issues.join(', ')}. <a href="#/settings">Open Setup →</a></div></div>`;
}

// Tiny inline SVG sparkline for trends.
export function sparkline(values, { w = 120, h = 28, cls = '' } = {}) {
  if (!values.length) return '';
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="spark ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>${values
    .map((v, i) => `<circle cx="${(i * step).toFixed(1)}" cy="${(h - 3 - (v / max) * (h - 6)).toFixed(1)}" r="2" fill="currentColor"><title>${v}</title></circle>`)
    .join('')}</svg>`;
}
