// Scan & audit: pick parts of a codebase and read every line.

import { $, $$, view, esc, api, toast, I, icon, SEVS, MODELS, EFFORTS, FOCUS_LABELS, S, savePrefs, keepScroll, selectRepo, toolsMissingBanner, plural, kfmt, confirmDialog } from '../core.js';
import { openRepoPicker } from '../repo-picker.js';
import { openGuardrails } from '../guardrails.js';

//
// Scanning is a different job from reviewing a diff: there are no "changes" to
// pick, so the page is built around choosing parts of the codebase and an
// audit goal, and it warns before a scan grows large.

const AUDIT_PRESETS = [
  { id: 'security', label: 'Security audit', icon: '🛡️', desc: 'Injection, secrets, unsafe input handling, auth mistakes.', focus: ['security', 'errors'] },
  { id: 'bugs', label: 'Bug hunt', icon: '🐞', desc: 'Logic errors, edge cases, races and crash paths.', focus: ['bugs', 'errors', 'concurrency'] },
  { id: 'health', label: 'Code health', icon: '🩺', desc: 'Dead code, duplication, slow paths, missing tests.', focus: ['maintainability', 'performance', 'tests'] },
  { id: 'all', label: 'Full audit', icon: '🔎', desc: 'Everything above in one pass. Slower, more findings.', focus: ['bugs', 'security', 'performance', 'errors', 'concurrency', 'maintainability', 'tests'] },
];
const SCAN_WARN_FILES = 60;
const SCAN_WARN_LINES = 15000;

const SC = { repo: null, files: null, excluded: [], groups: [], loading: false, error: '', sel: new Set(), open: new Set(), filter: '', preset: 'bugs', recent: null, recentLoading: false };

export async function loadScanFiles(force = false) {
  if (!S.repo) return;
  if (!force && SC.repo === S.repo.repo && SC.files) return renderScan();
  SC.loading = true;
  SC.error = '';
  renderScan();
  try {
    const p = await api('/api/preview', { method: 'POST', body: { repo: S.repo.repo, target: { kind: 'scan', paths: [] }, exclude: S.exclude } });
    SC.repo = S.repo.repo;
    SC.files = p.reviewable;
    SC.excluded = p.excluded;
    SC.groups = p.groups || [];
    SC.recent = null;
    const keep = new Set(p.reviewable.map((f) => f.path));
    SC.sel = new Set([...SC.sel].filter((x) => keep.has(x)));
    if (!SC.sel.size && p.reviewable.length <= 40) SC.sel = new Set(keep);
    SC.open = new Set([''].concat(topDirs(p.reviewable).length <= 6 ? topDirs(p.reviewable) : []));
  } catch (err) {
    SC.files = null;
    SC.error = err.message;
  }
  SC.loading = false;
  renderScan();
}

function topDirs(files) {
  return [...new Set(files.map((f) => f.path.split('/')[0]).filter((d, i, a) => files.some((f) => f.path.startsWith(d + '/'))))];
}

export function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [], count: 0, lines: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.count++;
    node.lines += f.insertions || 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [], count: 0, lines: 0 });
      node = node.dirs.get(parts[i]);
      node.count++;
      node.lines += f.insertions || 0;
    }
    node.files.push(f);
  }
  return root;
}

export function filesUnder(node) {
  const out = [...node.files.map((f) => f.path)];
  for (const d of node.dirs.values()) out.push(...filesUnder(d));
  return out;
}

export const fmtLines = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function renderTreeNode(node, depth, filtering) {
  const rows = [];
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    const all = filesUnder(d);
    const picked = all.filter((p) => SC.sel.has(p)).length;
    const open = filtering || SC.open.has(d.path);
    rows.push(`<div class="tree-row dir" style="padding-left:${10 + depth * 18}px">
      <button class="caret ${open ? 'open' : ''}" data-toggle="${esc(d.path)}" aria-label="Expand">▸</button>
      <input type="checkbox" data-dir="${esc(d.path)}" ${picked === all.length ? 'checked' : ''} ${picked && picked < all.length ? 'data-ind="1"' : ''} />
      <span class="tree-ico">${I.folder}</span>
      <span class="grow ellipsis" data-toggle="${esc(d.path)}" style="cursor:pointer"><b>${esc(d.name)}</b></span>
      ${picked ? `<span class="pill run">${picked}/${all.length}</span>` : ''}
      <span class="faint tree-meta">${d.count} file${d.count === 1 ? '' : 's'} · ${fmtLines(d.lines)} lines</span>
    </div>`);
    if (open) rows.push(renderTreeNode(d, depth + 1, filtering));
  }
  for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    const name = f.path.split('/').pop();
    const recent = SC.recent?.has(f.path);
    rows.push(`<label class="tree-row file" style="padding-left:${10 + depth * 18 + 22}px">
      <input type="checkbox" data-file="${esc(f.path)}" ${SC.sel.has(f.path) ? 'checked' : ''} />
      <span class="p grow ellipsis mono" title="${esc(f.path)}">${esc(name)}</span>
      ${recent ? '<span class="pill warn">recently changed</span>' : ''}
      <span class="faint tree-meta">${fmtLines(f.insertions || 0)} lines</span>
    </label>`);
  }
  return rows.join('');
}

function scanSummary() {
  const files = (SC.files || []).filter((f) => SC.sel.has(f.path));
  const lines = files.reduce((a, f) => a + (f.insertions || 0), 0);
  const per = S.health?.settings?.filesPerBatch || 4;
  const conc = S.health?.settings?.concurrency || 3;
  const byRule = new Map();
  for (const g of SC.groups) byRule.set(g.pattern, g.files.filter((p) => SC.sel.has(p)).length);
  const batches = [...byRule.values()].reduce((a, n) => a + Math.ceil(n / per), 0) || Math.ceil(files.length / per);
  // About one minute per batch for whole-file reads; only a rough guide.
  const minutes = Math.max(1, Math.round(Math.ceil(batches / conc) * 1));
  return { files: files.length, lines, batches, minutes, big: files.length > SCAN_WARN_FILES || lines > SCAN_WARN_LINES };
}

export function renderScan() {
  if (S.mode !== 'scan') return;
  const r = S.repo;
  const t = S.health?.tools || {};
  const sum = scanSummary();
  const filtering = SC.filter.trim().toLowerCase();
  let treeBody = '';
  if (SC.loading) treeBody = `<div class="row muted" style="padding:16px"><span class="spinner"></span> OCR is listing the source files in ${esc(r?.name)}…</div>`;
  else if (SC.error) treeBody = `<div class="banner bad" style="margin:12px">${esc(SC.error)}</div>`;
  else if (SC.files && !SC.files.length) treeBody = `<div class="empty"><div class="big">🗂️</div><b>No scannable source files.</b><div>OCR skipped everything in this repository (see the list below).</div></div>`;
  else if (SC.files) {
    const shown = filtering ? SC.files.filter((f) => f.path.toLowerCase().includes(filtering)) : SC.files;
    treeBody = shown.length ? renderTreeNode(buildTree(shown), 0, !!filtering) : `<div class="muted" style="padding:16px">No files match “${esc(SC.filter)}”.</div>`;
  }
  const preset = AUDIT_PRESETS.find((p) => p.id === SC.preset) || AUDIT_PRESETS[1];
  const ready = sum.files > 0 && !SC.loading && !S.starting && t.ocr && (S.engine.type === 'claude' ? t.claude : t.ocrNative);

  view.innerHTML = `
    <div class="page-head scan-head">
      <div class="scan-badge">${I.scan}</div>
      <div>
        <h1>Scan &amp; audit files</h1>
        <p>Point Claude at parts of a codebase and read every line, not just recent changes. Use it to audit code you inherited, a risky module, or a whole small project.</p>
      </div>
    </div>
    ${toolsMissingBanner()}

    <div class="card section">
      <div class="row wrap">
        ${
          r
            ? `<div class="ico-sq">${I.git}</div><div class="grow"><b>${esc(r.name)}</b> <span class="faint mono">${esc(r.repo)}</span></div>
               <button class="btn small" id="guard-btn">🛡️ Guardrails</button>
               <button class="btn small" id="change-repo">${I.folder} Change repository</button>`
            : `<div class="grow muted">Choose the repository you want to audit.</div><button class="btn primary" id="change-repo">${I.folder} Choose a repository</button>`
        }
      </div>
    </div>

    ${
      r
        ? `
    <div class="scan-grid">
      <div class="card scan-tree">
        <div class="tree-toolbar">
          <div>
            <b>1 · What to scan</b>
            <div class="faint" style="font-size:12.5px">${SC.files ? `${SC.files.length} source files found${SC.excluded.length ? `, ${SC.excluded.length} skipped (generated, vendored, binary…)` : ''}` : ''}</div>
          </div>
          <span class="grow"></span>
          <input id="tree-filter" placeholder="Filter files…" value="${esc(SC.filter)}" style="width:170px" />
        </div>
        <div class="tree-quick">
          <span class="faint">Quick pick:</span>
          <button class="chip" id="pick-all">Everything</button>
          <button class="chip" id="pick-recent">${SC.recentLoading ? '<span class="spinner"></span>' : ''} Changed in last 30 days</button>
          ${filtering ? `<button class="chip" id="pick-matches">Matches of “${esc(SC.filter)}”</button>` : ''}
          <button class="chip" id="pick-none">Clear</button>
        </div>
        <div class="tree">${treeBody}</div>
        ${
          SC.excluded.length
            ? `<details class="excluded" style="padding:0 14px 12px"><summary>${SC.excluded.length} file(s) OCR will not scan</summary>
                <div class="files" style="margin-top:6px;max-height:220px;overflow:auto">${SC.excluded
                  .map((f) => `<div class="file-row"><span class="p grow ellipsis">${esc(f.path)}</span><span class="tag">${esc(String(f.reason).replace(/_/g, ' '))}</span></div>`)
                  .join('')}</div></details>`
            : ''
        }
      </div>

      <div class="scan-side">
        <div class="card section">
          <h2 class="section-title">2 · Audit goal</h2>
          <div class="presets">${AUDIT_PRESETS.map(
            (p) => `<button class="preset ${SC.preset === p.id ? 'selected' : ''}" data-preset="${p.id}"><span class="em">${p.icon}</span><span><b>${p.label}</b><small>${p.desc}</small></span></button>`
          ).join('')}</div>
          <div class="field" style="margin-top:14px">
            <label>What is this code for? <span class="faint">(optional)</span></label>
            <textarea id="background" rows="3" placeholder="e.g. Payment webhook handlers; inputs come from the internet.">${esc(S.background)}</textarea>
          </div>
        </div>

        <div class="card section">
          <h2 class="section-title">3 · Auditor</h2>
          ${
            t.ocrNative
              ? `<div class="seg" id="engine" style="margin-bottom:12px"><button data-v="claude" class="${S.engine.type === 'claude' ? 'on' : ''}">Claude Code</button><button data-v="ocr" class="${S.engine.type === 'ocr' ? 'on' : ''}">OCR agent</button></div>`
              : `<div class="muted" style="font-size:13px;margin-bottom:12px">${I.spark.replace('<svg', '<svg width="14" height="14" style="vertical-align:-2px"')} Claude Code, read-only access to the repository.</div>`
          }
          ${
            S.engine.type === 'claude'
              ? `<div class="field"><label>Model</label><div class="seg" id="model">${MODELS.map((m) => `<button data-v="${m.id}" class="${S.engine.model === m.id ? 'on' : ''}">${m.label}<small>${m.note}</small></button>`).join('')}</div></div>
                 <div class="field" style="margin-top:10px"><label>Thinking effort</label><div class="seg" id="effort">${EFFORTS.map((x) => `<button data-v="${x}" class="${S.engine.effort === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div></div>`
              : ''
          }
          <details style="margin-top:12px"><summary class="muted" style="cursor:pointer;font-size:13px">Advanced: exclude patterns</summary>
            <div class="row" style="margin-top:8px"><input id="exclude" class="grow mono" placeholder="**/*.test.ts, migrations/**" value="${esc(S.exclude)}" /><button class="btn small" id="apply-exclude">Apply</button></div>
          </details>
        </div>

        <div class="card section scan-estimate ${sum.big ? 'big' : ''}">
          <div class="est-grid">
            <div><div class="n">${sum.files}</div><div class="l">files</div></div>
            <div><div class="n">${fmtLines(sum.lines)}</div><div class="l">lines to read</div></div>
            <div><div class="n">${sum.batches}</div><div class="l">Claude runs</div></div>
            <div><div class="n">~${sum.minutes}m</div><div class="l">rough time</div></div>
          </div>
          ${sum.big ? `<div class="banner warn" style="margin:12px 0 0">⚠️ <div>This is a large scan and will use a fair share of your Claude usage. Consider narrowing it to the folders you care about most.</div></div>` : ''}
          <button class="btn primary big" id="start" style="width:100%;margin-top:14px" ${ready ? '' : 'disabled'}>${S.starting ? '<span class="spinner"></span> Starting…' : `${I.scan} Start ${preset.label.toLowerCase()}`}</button>
          ${sum.files ? '' : '<div class="faint" style="text-align:center;margin-top:8px;font-size:12.5px">Tick files or folders on the left to begin.</div>'}
        </div>
      </div>
    </div>`
        : ''
    }`;
  view.querySelectorAll('[data-ind]').forEach((el) => (el.indeterminate = true));
  bindScan();
}

// Collapses the selection to whole folders where possible, for a readable
// review title and a shorter `ocr scan --path` argument.
function compressSelection() {
  const tree = buildTree(SC.files || []);
  const out = [];
  const walk = (node) => {
    for (const d of node.dirs.values()) {
      const all = filesUnder(d);
      if (all.every((p) => SC.sel.has(p))) out.push(d.path);
      else if (all.some((p) => SC.sel.has(p))) walk(d);
    }
    for (const f of node.files) if (SC.sel.has(f.path)) out.push(f.path);
  };
  walk(tree);
  return out.length && SC.sel.size === (SC.files || []).length ? [] : out;
}

function bindScan() {
  const rerender = () => keepScroll(renderScan);
  $('#change-repo')?.addEventListener('click', () => openRepoPicker(() => loadScanFiles(true)));
  $('#guard-btn')?.addEventListener('click', () => openGuardrails(S.repo.repo));
  const filter = $('#tree-filter');
  filter?.addEventListener('input', (e) => {
    SC.filter = e.target.value;
    const pos = e.target.selectionStart;
    rerender();
    const el = $('#tree-filter');
    el.focus();
    el.setSelectionRange(pos, pos);
  });
  view.querySelectorAll('[data-toggle]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const p = el.dataset.toggle;
      SC.open.has(p) ? SC.open.delete(p) : SC.open.add(p);
      rerender();
    })
  );
  view.querySelectorAll('[data-dir]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const prefix = cb.dataset.dir + '/';
      const q = SC.filter.trim().toLowerCase();
      for (const f of SC.files) if (f.path.startsWith(prefix) && (!q || f.path.toLowerCase().includes(q))) cb.checked ? SC.sel.add(f.path) : SC.sel.delete(f.path);
      rerender();
    })
  );
  view.querySelectorAll('[data-file]').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? SC.sel.add(cb.dataset.file) : SC.sel.delete(cb.dataset.file);
      rerender();
    })
  );
  $('#pick-all')?.addEventListener('click', () => ((SC.sel = new Set(SC.files.map((f) => f.path))), rerender()));
  $('#pick-none')?.addEventListener('click', () => ((SC.sel = new Set()), rerender()));
  $('#pick-matches')?.addEventListener('click', () => {
    const q = SC.filter.trim().toLowerCase();
    SC.sel = new Set(SC.files.filter((f) => f.path.toLowerCase().includes(q)).map((f) => f.path));
    rerender();
  });
  $('#pick-recent')?.addEventListener('click', async () => {
    SC.recentLoading = true;
    rerender();
    try {
      const { files } = await api('/api/repo/recent', { method: 'POST', body: { repo: S.repo.repo, days: 30 } });
      SC.recent = new Set(files);
      SC.sel = new Set(SC.files.filter((f) => SC.recent.has(f.path)).map((f) => f.path));
      for (const p of SC.sel) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) SC.open.add(parts.slice(0, i).join('/'));
      }
      if (!SC.sel.size) toast('No source files changed in the last 30 days');
    } catch (err) {
      toast(err.message, true);
    }
    SC.recentLoading = false;
    rerender();
  });
  view.querySelectorAll('[data-preset]').forEach((b) =>
    b.addEventListener('click', () => {
      SC.preset = b.dataset.preset;
      rerender();
    })
  );
  view.querySelectorAll('#engine button').forEach((b) => b.addEventListener('click', () => ((S.engine.type = b.dataset.v), savePrefs(), rerender())));
  view.querySelectorAll('#model button').forEach((b) => b.addEventListener('click', () => ((S.engine.model = b.dataset.v), savePrefs(), rerender())));
  view.querySelectorAll('#effort button').forEach((b) => b.addEventListener('click', () => ((S.engine.effort = b.dataset.v), savePrefs(), rerender())));
  $('#background')?.addEventListener('input', (e) => (S.background = e.target.value));
  $('#apply-exclude')?.addEventListener('click', () => ((S.exclude = $('#exclude').value.trim()), loadScanFiles(true)));
  $('#start')?.addEventListener('click', startScan);
}

async function startScan() {
  const preset = AUDIT_PRESETS.find((p) => p.id === SC.preset);
  S.starting = true;
  keepScroll(renderScan);
  try {
    const job = await api('/api/reviews', {
      method: 'POST',
      body: {
        repo: S.repo.repo,
        target: { kind: 'scan', paths: compressSelection() },
        exclude: S.exclude,
        files: [...SC.sel],
        engine: S.engine,
        focus: preset.focus,
        label: preset.label,
        background: S.background,
      },
    });
    S.starting = false;
    location.hash = `#/review/${job.id}`;
  } catch (err) {
    S.starting = false;
    keepScroll(renderScan);
    toast(err.message, true);
  }
}

