// Review changes: uncommitted work, a branch comparison, or one commit.

import { $, $$, view, esc, api, toast, I, icon, SEVS, MODELS, EFFORTS, FOCUS_LABELS, S, savePrefs, keepScroll, selectRepo, toolsMissingBanner, plural, kfmt, confirmDialog } from '../core.js';
import { openRepoPicker } from '../repo-picker.js';
import { openGuardrails } from '../guardrails.js';
import { loadScanFiles, renderScan } from './scan.js';


export async function pageNew(mode) {
  S.mode = mode;
  if (!S.repo && S.lastRepo) {
    try {
      await selectRepo(S.lastRepo);
    } catch {}
  }
  if (mode === 'scan') return S.repo ? loadScanFiles() : renderScan();
  renderNew();
  if (S.repo) refreshPreview();
}

function howItWorks() {
  return `<div class="how">
    <div><span class="k">1 · OCR</span><b>Picks the files</b>Filters generated, vendored and binary files deterministically.</div>
    <div><span class="k">2 · OCR</span><b>Matches the rules</b>Language-specific review checklists per file group.</div>
    <div><span class="k">3 · Claude Code</span><b>Reviews each batch</b>One isolated Claude run per rule group, reading code for context.</div>
    <div><span class="k">4 · You</span><b>Triage &amp; fix</b>Mark findings, or let Claude apply a fix you can undo.</div>
  </div>`;
}

export function renderNew() {
  if (S.mode === 'scan') return renderScan();
  const r = S.repo;
  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Review code changes</h1>
        <p>Get a second pair of eyes on uncommitted work, a branch, or a single commit before it lands.</p>
      </div>
    </div>
    ${toolsMissingBanner()}
    ${howItWorks()}

    <div class="card section">
      <h2 class="section-title"><span class="step-num ${r ? 'done' : ''}">1</span>Repository</h2>
      <p class="section-sub">Which project should be reviewed?</p>
      ${
        r
          ? `<div class="repo-card">
              <div class="ico">${I.git}</div>
              <div class="grow">
                <div><b>${esc(r.name)}</b> <span class="pill">${I.branch.replace('<svg', '<svg width="12" height="12"')} ${esc(r.branch)}</span> ${r.dirtyCount ? `<span class="pill warn">${r.dirtyCount} uncommitted</span>` : '<span class="pill ok">clean</span>'}</div>
                <div class="faint mono ellipsis">${esc(r.repo)}</div>
              </div>
              <button class="btn" id="guard-btn">🛡️ Guardrails</button>
              <button class="btn" id="change-repo">${I.folder} Change</button>
            </div>`
          : `<button class="btn primary" id="change-repo">${I.folder} Choose a repository</button>`
      }
    </div>

    ${r ? renderTargetSection() : ''}
    ${r ? renderFilesSection() : ''}
    ${r ? renderReviewerSection() : ''}
    ${r ? renderStartBar() : ''}
  `;
  bindNew();
}

function renderTargetSection() {
  const r = S.repo;
  const t = S.target;
  const branchOpts = (sel) => r.branches.map((b) => `<option ${b === sel ? 'selected' : ''}>${esc(b)}</option>`).join('');
  return `<div class="card section">
    <h2 class="section-title"><span class="step-num done">2</span>What to review</h2>
    <p class="section-sub">Pick the set of changes you want feedback on.</p>
    <div class="choices">
      <button class="choice ${t.kind === 'workspace' ? 'selected' : ''}" data-kind="workspace">
        <div class="ico">${I.edit}</div><b>Uncommitted changes</b>
        <span>Staged, unstaged and new files in your working tree.</span>
        <span class="corner pill ${r.dirtyCount ? 'warn' : ''}">${r.dirtyCount} file${r.dirtyCount === 1 ? '' : 's'}</span>
      </button>
      <button class="choice ${t.kind === 'range' ? 'selected' : ''}" data-kind="range" ${r.branches.length < 2 ? 'disabled' : ''}>
        <div class="ico">${I.branch}</div><b>Branch comparison</b>
        <span>Everything a branch adds since it split off — like a pull request.</span>
      </button>
      <button class="choice ${t.kind === 'commit' ? 'selected' : ''}" data-kind="commit">
        <div class="ico">${I.commit}</div><b>A single commit</b>
        <span>What one commit changed compared with its parent.</span>
      </button>
    </div>
    ${
      t.kind === 'range'
        ? `<div class="grid2" style="margin-top:14px">
            <div class="field"><label>Base (merge into)</label><select id="from">${branchOpts(t.from)}</select></div>
            <div class="field"><label>Branch with the changes</label><select id="to">${branchOpts(t.to)}</select></div>
          </div>`
        : ''
    }
    ${
      t.kind === 'commit'
        ? `<div class="field" style="margin-top:14px"><label>Commit</label>
            <select id="commit">${r.commits.map((c) => `<option value="${c.hash}" ${c.hash === t.commit ? 'selected' : ''}>${c.short} · ${esc(c.subject.slice(0, 90))} — ${esc(c.author)}, ${esc(c.date)}</option>`).join('')}</select></div>`
        : ''
    }
  </div>`;
}

export function statusLetter(s) {
  const map = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', scan: 'S', untracked: 'A', copied: 'A' };
  const l = map[s] || (s || '?')[0].toUpperCase();
  return `<span class="status-letter ${l}" title="${esc(s)}">${l}</span>`;
}

function renderFilesSection() {
  const p = S.preview;
  let body;
  if (S.previewLoading) body = `<div class="row muted" style="padding:14px 2px"><span class="spinner"></span> Asking OCR which files are worth reviewing…</div>`;
  else if (S.previewError) body = `<div class="banner bad">${esc(S.previewError)}</div>`;
  else if (!p) body = '';
  else if (!p.reviewable.length)
    body = `<div class="empty"><div class="big">🌤️</div><b>Nothing to review here.</b><div>${p.excluded.length ? `${p.excluded.length} changed file(s) were filtered out — see below.` : 'No changes found for this selection.'}</div></div>`;
  else {
    const byGroup = new Map();
    for (const g of p.groups || []) for (const f of g.files) byGroup.set(f, g.pattern);
    const groups = new Map();
    for (const f of p.reviewable) {
      const key = byGroup.get(f.path) || 'other files';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const all = p.reviewable.length;
    const sel = p.reviewable.filter((f) => S.selected.has(f.path)).length;
    body = `<div class="files">
      <div class="files-head">
        <input type="checkbox" id="sel-all" ${sel === all ? 'checked' : ''} />
        <span><b>${sel}</b> of ${all} files selected</span>
        <span class="grow"></span>
        <span class="add">+${p.reviewable.reduce((a, f) => a + (f.insertions || 0), 0)}</span>
        <span class="del">−${p.reviewable.reduce((a, f) => a + (f.deletions || 0), 0)}</span>
      </div>
      ${[...groups]
        .map(
          ([pattern, files]) => `<div class="group-head">rule: ${esc(pattern)}</div>${files
            .map(
              (f) => `<label class="file-row">
                <input type="checkbox" data-file="${esc(f.path)}" ${S.selected.has(f.path) ? 'checked' : ''} />
                ${statusLetter(f.status)}
                <span class="p grow ellipsis" title="${esc(f.path)}">${esc(f.path)}</span>
                <span class="add">+${f.insertions || 0}</span><span class="del">−${f.deletions || 0}</span>
              </label>`
            )
            .join('')}`
        )
        .join('')}
    </div>`;
  }
  const excluded = p?.excluded?.length
    ? `<details class="excluded"><summary>${p.excluded.length} file(s) skipped automatically by OCR</summary>
        <div class="files" style="margin-top:6px">${p.excluded
          .map((f) => `<div class="file-row"><span class="p grow ellipsis">${esc(f.path)}</span><span class="tag">${esc(String(f.reason).replace(/_/g, ' '))}</span></div>`)
          .join('')}</div></details>`
    : '';
  return `<div class="card section">
    <h2 class="section-title"><span class="step-num ${S.selected.size ? 'done' : ''}">3</span>Files</h2>
    <p class="section-sub">OCR chose these files and grouped them by the review rules that apply. Untick anything you want to leave out.</p>
    ${body}
    ${excluded}
    <div class="row" style="margin-top:12px">
      <input id="exclude" class="grow mono" placeholder="Extra exclude patterns, e.g. **/*.test.ts, docs/**" value="${esc(S.exclude)}" />
      <button class="btn" id="apply-exclude">Apply</button>
    </div>
  </div>`;
}

function renderReviewerSection() {
  const t = S.health?.tools || {};
  const e = S.engine;
  const native = t.ocrNative;
  return `<div class="card section">
    <h2 class="section-title"><span class="step-num done">4</span>Reviewer</h2>
    <p class="section-sub">Who does the reviewing, and what should they look for?</p>
    <div class="choices">
      <button class="choice ${e.type === 'claude' ? 'selected' : ''} ${t.claude ? '' : 'disabled'}" data-engine="claude">
        <div class="ico">${I.spark}</div><b>Claude Code</b>
        <span>Uses your Claude Code login. OCR picks files &amp; rules, Claude reviews with read-only access to your repo.</span>
        <span class="corner pill ${t.claude ? 'ok' : 'bad'}">${t.claude ? 'ready' : 'not found'}</span>
      </button>
      <button class="choice ${e.type === 'ocr' ? 'selected' : ''} ${native ? '' : 'disabled'}" data-engine="ocr">
        <div class="ico">${I.cpu}</div><b>OCR built-in agent</b>
        <span>${native ? `Runs OCR's own review agent with ${esc(native.provider)} / ${esc(native.model)}.` : 'Needs an API key set up with <code>ocr config provider</code>. See Setup.'}</span>
        <span class="corner pill ${native ? 'ok' : ''}">${native ? 'ready' : 'not set up'}</span>
      </button>
    </div>
    ${
      e.type === 'claude'
        ? `<div class="row wrap" style="margin-top:16px;gap:22px">
            <div class="field"><label>Claude model</label><div class="seg" id="model">${MODELS.map((m) => `<button data-v="${m.id}" class="${e.model === m.id ? 'on' : ''}">${m.label}<small>${m.note}</small></button>`).join('')}</div></div>
            <div class="field"><label>Thinking effort</label><div class="seg" id="effort">${EFFORTS.map((x) => `<button data-v="${x}" class="${e.effort === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div></div>
          </div>`
        : ''
    }
    <div class="field" style="margin-top:16px">
      <label>Look for</label>
      <div class="chips" id="focus">${Object.entries(FOCUS_LABELS).map(([k, l]) => `<button class="chip ${S.focus.has(k) ? 'on' : ''}" data-k="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="field" style="margin-top:16px">
      <label>Context for the reviewer <span class="faint">(optional)</span></label>
      <textarea id="background" rows="3" placeholder="What is this change supposed to do? Paste the ticket or requirements — the reviewer will also check the change matches them.">${esc(S.background)}</textarea>
    </div>
  </div>`;
}

function renderStartBar() {
  const n = S.preview ? S.preview.reviewable.filter((f) => S.selected.has(f.path)).length : 0;
  const per = S.health?.settings?.filesPerBatch || 4;
  const batches = (S.preview?.groups || []).reduce((a, g) => a + Math.ceil(g.files.filter((f) => S.selected.has(f)).length / per), 0) || Math.ceil(n / per);
  const who = S.engine.type === 'claude' ? `Claude ${MODELS.find((m) => m.id === S.engine.model)?.label || S.engine.model}` : 'OCR agent';
  const ready = n > 0 && !S.previewLoading && !S.starting && S.health?.tools?.ocr && (S.engine.type === 'claude' ? S.health.tools.claude : S.health.tools.ocrNative);
  return `<div class="startbar">
    <div class="summary">${n ? `<b>${n} file${n === 1 ? '' : 's'}</b> · ${who}${S.engine.type === 'claude' ? ` · ${batches} batch${batches === 1 ? '' : 'es'}, ${Math.min(batches, S.health?.settings?.concurrency || 3)} at a time` : ''}` : 'Select at least one file to review'}</div>
    <button class="btn primary big" id="start" ${ready ? '' : 'disabled'}>${S.starting ? '<span class="spinner"></span> Starting…' : `${I.spark} Start review`}</button>
  </div>`;
}

export function currentTarget() {
  const t = S.target;
  if (t.kind === 'range') return { kind: 'range', from: t.from, to: t.to };
  if (t.kind === 'commit') return { kind: 'commit', commit: t.commit };
  return { kind: 'workspace' };
}

let previewSeq = 0;
export async function refreshPreview() {
  if (S.mode === 'scan') return loadScanFiles(true);
  const seq = ++previewSeq;
  S.previewLoading = true;
  S.previewError = '';
  renderNew();
  try {
    const p = await api('/api/preview', { method: 'POST', body: { repo: S.repo.repo, target: currentTarget(), exclude: S.exclude } });
    if (seq !== previewSeq) return;
    S.preview = p;
    S.selected = new Set(p.reviewable.map((f) => f.path));
  } catch (err) {
    if (seq !== previewSeq) return;
    S.preview = null;
    S.previewError = err.message;
  }
  S.previewLoading = false;
  renderNew();
}

function bindNew() {
  $('#change-repo')?.addEventListener('click', () => openRepoPicker());
  $('#guard-btn')?.addEventListener('click', () => openGuardrails(S.repo.repo));
  view.querySelectorAll('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.disabled) return;
      S.target.kind = b.dataset.kind;
      refreshPreview();
    })
  );
  $('#from')?.addEventListener('change', (e) => ((S.target.from = e.target.value), refreshPreview()));
  $('#to')?.addEventListener('change', (e) => ((S.target.to = e.target.value), refreshPreview()));
  $('#commit')?.addEventListener('change', (e) => ((S.target.commit = e.target.value), refreshPreview()));
  $('#apply-exclude')?.addEventListener('click', () => ((S.exclude = $('#exclude').value.trim()), refreshPreview()));
  $('#exclude')?.addEventListener('keydown', (e) => e.key === 'Enter' && $('#apply-exclude').click());
  $('#sel-all')?.addEventListener('change', (e) => {
    S.selected = e.target.checked ? new Set(S.preview.reviewable.map((f) => f.path)) : new Set();
    renderNew();
  });
  view.querySelectorAll('[data-file]').forEach((cb) =>
    cb.addEventListener('change', () => {
      cb.checked ? S.selected.add(cb.dataset.file) : S.selected.delete(cb.dataset.file);
      const y = window.scrollY;
      renderNew();
      window.scrollTo(0, y);
    })
  );
  view.querySelectorAll('[data-engine]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.classList.contains('disabled')) return;
      S.engine.type = b.dataset.engine;
      savePrefs();
      keepScroll(renderNew);
    })
  );
  view.querySelectorAll('#model button').forEach((b) => b.addEventListener('click', () => ((S.engine.model = b.dataset.v), savePrefs(), keepScroll(renderNew))));
  view.querySelectorAll('#effort button').forEach((b) => b.addEventListener('click', () => ((S.engine.effort = b.dataset.v), savePrefs(), keepScroll(renderNew))));
  view.querySelectorAll('#focus .chip').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.k;
      S.focus.has(k) ? S.focus.delete(k) : S.focus.add(k);
      savePrefs();
      b.classList.toggle('on');
    })
  );
  $('#background')?.addEventListener('input', (e) => (S.background = e.target.value));
  $('#start')?.addEventListener('click', startReview);
}

export async function startReview() {
  S.starting = true;
  keepScroll(renderNew);
  try {
    const job = await api('/api/reviews', {
      method: 'POST',
      body: {
        repo: S.repo.repo,
        target: currentTarget(),
        exclude: S.exclude,
        files: [...S.selected],
        engine: S.engine,
        focus: [...S.focus],
        background: S.background,
      },
    });
    S.starting = false;
    location.hash = `#/review/${job.id}`;
  } catch (err) {
    S.starting = false;
    keepScroll(renderNew);
    toast(err.message, true);
  }
}

