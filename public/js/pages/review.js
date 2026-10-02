// Review page: header, progress, tabs and all interaction wiring.

import { S, selectRepo, $, $$, view, api, esc, toast, icon, dur, money, kfmt, plural, ago, onLeave, bindKeys, setPref, openInEditor, copyText, download, modal, confirmDialog } from '../core.js';
import { openGuardrails } from '../guardrails.js';
import { RV, resetRV, visibleFindings, pickable, needsYou, flagged, unchecked, inFlight, isFixed, STATUS_FILTERS } from '../review/state.js';
import { renderFindingsTab, renderSelectionBar, KEY_HELP } from '../review/findings.js';
import { renderChangesTab, renderFilesTab, renderActivityTab, renderCompareTab, renderCodeTab, undoHunk, commitChanges } from '../review/tabs.js';
import { quickFix, fixDialog, proposalWizard, ignoreDialog, markMany, ask, copyForClaude, undoFix, decide, undoBatch } from '../review/fixflow.js';

export async function pageReview(id, fid) {
  resetRV();
  RV.job = await api(`/api/reviews/${id}`);
  RV.guard = await api('/api/guard', { method: 'POST', body: { repo: RV.job.repo } }).catch(() => null);
  if (S.repo?.repo !== RV.job.repo) selectRepo(RV.job.repo).catch(() => {});
  RV.tab = RV.job.status === 'running' && !RV.job.findings.length ? 'activity' : 'findings';
  if (fid && RV.job.findings.some((f) => f.id === fid)) {
    RV.sel = fid;
    RV.tab = 'findings';
    if (!visibleFindings().some((f) => f.id === fid)) RV.status = 'all';
  }
  RV.render = () => preserve(renderReview);
  RV.reload = async () => {
    RV.job = await api(`/api/reviews/${RV.job.id}`);
    RV.render();
  };
  RV.connect = () => connect(RV.job.id);

  view.onclick = onClick;
  view.oninput = onInput;
  view.onchange = onChange;
  view.onkeydown = onKeyDown;
  onLeave(() => {
    view.onclick = view.oninput = view.onchange = view.onkeydown = null;
    RV.es?.close();
    RV.es = null;
  });
  renderReview();
  if (fid) setTimeout(() => $('.wb-row.on')?.scrollIntoView({ block: 'center' }), 50);
  connect(id);
  const tick = setInterval(() => {
    const el = $('#elapsed');
    if (el && RV.job?.status === 'running') el.textContent = dur(Date.now() - Date.parse(RV.job.createdAt));
  }, 1000);
  onLeave(() => clearInterval(tick));
  bindKeys(keyMap());
}

// ------------------------------------------------------------------ live updates

function connect(id) {
  if (RV.es) return;
  const es = new EventSource(`/api/reviews/${id}/events`);
  RV.es = es;
  es.onmessage = (e) => {
    const job = JSON.parse(e.data);
    const wasRunning = RV.job?.status === 'running';
    const live = (j) => (j?.findings || []).filter(inFlight).map((f) => f.id);
    for (const x of live(RV.job)) RV.fixWatch.add(x);
    const beforeApplied = (RV.job?.findings || []).filter((f) => f.fix?.status === 'applied').length;
    RV.job = { ...RV.job, ...job };
    const now = live(job);
    for (const x of now) RV.fixWatch.add(x);
    if (RV.fixWatch.size && !now.length) {
      const done = job.findings.filter((f) => RV.fixWatch.has(f.id));
      RV.fixWatch.clear();
      const c = (s) => done.filter((f) => f.fix?.status === s).length;
      const parts = [`${c('applied')} applied`];
      if (c('proposed')) parts.push(`${c('proposed')} waiting for you`);
      if (c('rejected')) parts.push(`${c('rejected')} rejected by the checker`);
      if (c('blocked')) parts.push(`${c('blocked')} blocked by guardrails`);
      if (c('unchanged') + c('failed')) parts.push(`${c('unchanged') + c('failed')} unchanged/failed`);
      toast(`Fixes finished: ${parts.join(', ')}`);
      notify(`${job.repoName}: ${parts.join(', ')}`);
    }
    if (job.findings.filter((f) => f.fix?.status === 'applied').length !== beforeApplied) RV.changes = null;
    if (wasRunning && job.status !== 'running') {
      if (RV.tab === 'activity') RV.tab = 'findings';
      toast(job.status === 'done' ? `Review finished: ${plural(job.findings.length, 'finding')}` : `Review ${job.status}`);
      notify(`${job.repoName}: ${plural(job.findings.length, 'finding')}`);
      if (job.verifies) RV.compare = null;
    }
    if (job.verifies && RV.tab === 'compare' && job.status === 'running') RV.compare = null;
    RV.render();
  };
}

function notify(body) {
  if (document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('OCR Studio', { body });
}

// Re-rendering replaces the DOM, so carry over scroll positions, the focused
// input and its caret.
function preserve(fn) {
  const y = window.scrollY;
  const scrolls = {};
  $$('[data-scroll-key]').forEach((el) => (scrolls[el.dataset.scrollKey] = el.scrollTop));
  const a = document.activeElement;
  const keep = a?.dataset?.keep ? { key: a.dataset.keep, start: a.selectionStart, end: a.selectionEnd } : null;
  fn();
  $$('[data-scroll-key]').forEach((el) => {
    if (scrolls[el.dataset.scrollKey] != null) el.scrollTop = scrolls[el.dataset.scrollKey];
  });
  window.scrollTo(0, y);
  if (keep) {
    const el = $(`[data-keep="${CSS.escape(keep.key)}"]`);
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(keep.start, keep.end);
      } catch {}
    }
  }
}

// ------------------------------------------------------------------ render

function eta(j) {
  const done = (j.batches || []).filter((b) => b.state === 'done' && b.durationMs);
  const remaining = (j.batches || []).filter((b) => b.state === 'queued' || b.state === 'running').length;
  if (!done.length || !remaining) return '';
  const avg = done.reduce((a, b) => a + b.durationMs, 0) / done.length;
  const ms = Math.ceil(remaining / (j.engine?.concurrency || 3)) * avg;
  return ` · about ${dur(ms)} left`;
}

function renderReview() {
  const j = RV.job;
  if (!j) return;
  const running = j.status === 'running';
  const doneFiles = j.files.filter((f) => ['reviewed', 'skipped', 'failed'].includes(f.state)).length;
  const pct = j.files.length ? Math.round((doneFiles / j.files.length) * 100) : 0;
  const total = j.findings.length;
  const handled = j.findings.filter((f) => f.mark !== 'open').length;
  const tpct = total ? Math.round((handled / total) * 100) : 0;
  const statusPill = {
    running: `<span class="pill run"><i class="dot run"></i> ${esc(j.phase || 'Running')}</span>`,
    done: '<span class="pill ok">✓ Finished</span>',
    failed: '<span class="pill bad">Failed</span>',
    cancelled: '<span class="pill warn">Cancelled</span>',
    interrupted: '<span class="pill warn">Interrupted</span>',
  }[j.status];
  const engine = j.engine.type === 'claude' ? `Claude ${j.engine.model} · ${j.engine.effort} effort` : 'OCR built-in agent';
  const fixedCount = j.findings.filter(isFixed).length;
  const needs = j.findings.filter((f) => needsYou(f) || flagged(f)).length;
  const tab = (id, label, extra = '') => `<button data-tab="${id}" class="${RV.tab === id ? 'on' : ''}">${label}${extra}</button>`;

  view.innerHTML = `
    <div class="page-head">
      <div class="grow" style="min-width:0">
        <div class="crumbs"><a href="#/project/${encodeURIComponent(j.repo)}">${esc(j.repoName)}</a> › <a href="#/history">reviews</a></div>
        <div class="row wrap" style="margin-bottom:4px"><h1 style="margin:0">${esc(j.title)}</h1>${statusPill}${j.verifies ? '<span class="pill">verification</span>' : ''}</div>
        <p>${esc(engine)} · started ${ago(j.createdAt)}</p>
      </div>
      <div class="actions">
        ${running ? `<button class="btn danger" data-g="cancel">${icon('x', 14)} Stop review</button>` : ''}
        <button class="btn" data-g="guard">${icon('shield', 14)} Guardrails</button>
        ${!running && fixedCount && !j.verifies ? `<button class="btn" data-g="verify" title="Re-review the files you fixed and compare">${icon('verify', 14)} Verify fixes</button>` : ''}
        <details class="menu"><summary class="btn">${icon('download', 14)} Export</summary><div class="menu-list card">
          <button data-export="md-copy">Copy as Markdown</button><button data-export="md">Download Markdown</button>
          <button data-export="json">Download JSON</button><button data-export="sarif">Download SARIF</button><button data-export="patch">Download fixes as .patch</button></div></details>
        ${!running ? `<button class="btn" data-g="rerun">${icon('history', 14)} Run again</button><button class="btn ghost danger" data-g="delete">Delete</button>` : ''}
      </div>
    </div>
    ${j.error ? `<div class="banner bad"><b>Problem:</b>&nbsp;${esc(j.error)}</div>` : ''}

    <div class="card progress-card">
      <div class="pc-col">
        <div class="row"><b>${doneFiles} / ${j.files.length} files reviewed</b><span class="grow"></span><span class="muted">${icon('clock', 13)} <span id="elapsed">${dur(running ? Date.now() - Date.parse(j.createdAt) : j.stats.durationMs)}</span>${running ? eta(j) : ''}</span></div>
        <div class="progress ${running ? '' : 'done'}"><div style="width:${running ? Math.max(4, pct) : 100}%"></div></div>
        <div class="faint" style="font-size:12px;margin-top:4px">${money(j.stats.costUsd)} reported by Claude Code · ${kfmt(j.stats.inputTokens + j.stats.outputTokens)} tokens</div>
      </div>
      <div class="pc-col">
        <div class="row"><b>${handled} / ${total} findings handled</b><span class="grow"></span>${needs ? `<a href="javascript:void 0" data-status-go="needs" class="pill warn">${needs} need you</a>` : ''}</div>
        <div class="progress triage"><div style="width:${tpct}%"></div></div>
        <div class="faint" style="font-size:12px;margin-top:4px">${fixedCount} fixed · ${j.findings.filter((f) => f.mark === 'ignored').length} ignored · ${j.findings.filter((f) => f.mark === 'open').length} open</div>
      </div>
    </div>

    <div class="tabs">
      ${tab('findings', 'Findings', ` <span class="count">${total}</span>`)}
      ${tab('changes', 'Changes', j.fixRounds?.length || fixedCount ? ` <span class="count">${new Set(j.findings.filter((f) => f.fix?.status === 'applied').map((f) => f.path)).size}</span>` : '')}
      ${tab('files', 'Files', ` <span class="count">${j.files.length}</span>`)}
      ${tab('activity', `${running ? '<span class="spinner"></span> ' : ''}Activity`)}
      ${j.verifies ? tab('compare', 'Compare') : ''}
      ${tab('code', 'Code')}
    </div>
    <div id="tab-body">${
      RV.tab === 'changes' ? renderChangesTab() : RV.tab === 'files' ? renderFilesTab() : RV.tab === 'activity' ? renderActivityTab() : RV.tab === 'compare' ? renderCompareTab() : RV.tab === 'code' ? renderCodeTab() : renderFindingsTab()
    }</div>
    ${renderSelectionBar()}`;
  $$('[data-ind]').forEach((el) => (el.indeterminate = true));
  if (RV.tab === 'code' && RV.code?.line && RV._scrollToLine) {
    RV._scrollToLine = false;
    setTimeout(() => document.getElementById(`L${RV.code.line}`)?.scrollIntoView({ block: 'center' }), 0);
  }
}

// ------------------------------------------------------------------ selection helpers

function current() {
  return RV.job.findings.find((f) => f.id === RV.sel);
}

function select(id, { scroll = true } = {}) {
  RV.sel = id;
  history.replaceState(null, '', `#/review/${RV.job.id}/${id}`);
  RV.render();
  if (scroll) $('.wb-row.on')?.scrollIntoView({ block: 'nearest' });
  const d = $('.wb-detail');
  if (d) d.scrollTop = 0;
}

function move(delta) {
  const list = visibleFindings();
  if (!list.length) return;
  if (RV.layout === 'cards') {
    const i = Math.max(0, Math.min(list.length - 1, list.findIndex((f) => f.id === RV.sel) + delta));
    RV.sel = list[i].id;
    document.getElementById(`finding-${RV.sel}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const i = list.findIndex((f) => f.id === RV.sel);
  const next = list[Math.max(0, Math.min(list.length - 1, (i < 0 ? 0 : i) + delta))];
  if (next) select(next.id);
}

// After a finding leaves the current filter, keep the reviewer moving forward.
function advanceFrom(id) {
  const list = visibleFindings();
  const i = list.findIndex((f) => f.id === id);
  return list[i + 1]?.id || list[i - 1]?.id || null;
}

async function setMark(f, mark) {
  const nextId = advanceFrom(f.id);
  await markMany([f.id], mark);
  if (!visibleFindings().some((x) => x.id === f.id) && nextId) RV.sel = nextId;
  RV.render();
}

function showCode(path, line) {
  RV.code = { path, line };
  RV._scrollToLine = true;
  RV.tab = 'code';
  RV.render();
}

// ------------------------------------------------------------------ events

async function onClick(e) {
  const t = e.target;
  const j = RV.job;
  const el = (sel) => t.closest(sel);

  if (el('summary') && el('details.menu')) return;
  const exp = el('[data-export]');
  if (exp) {
    t.closest('details')?.removeAttribute('open');
    return exportAs(exp.dataset.export);
  }
  const g = el('[data-g]');
  if (g) return headerAction(g.dataset.g);

  const tabBtn = el('.tabs [data-tab]');
  if (tabBtn) {
    RV.tab = tabBtn.dataset.tab;
    return RV.render();
  }
  const sg = el('[data-status-go]');
  if (sg) {
    RV.tab = 'findings';
    RV.status = sg.dataset.statusGo;
    return RV.render();
  }

  // findings toolbar
  const st = el('[data-status]');
  if (st) {
    RV.status = st.dataset.status;
    RV.sel = null;
    return RV.render();
  }
  const sv = el('[data-sevf]');
  if (sv) {
    const s = sv.dataset.sevf;
    RV.sev.has(s) ? RV.sev.delete(s) : RV.sev.add(s);
    RV.sel = null;
    return RV.render();
  }
  const lay = el('[data-layout]');
  if (lay) {
    RV.layout = lay.dataset.layout;
    setPref('layout', RV.layout);
    return RV.render();
  }
  if (el('[data-keys]')) return keyHelp();
  if (el('[data-clearfile]')) {
    RV.file = null;
    return RV.render();
  }
  if (el('[data-resetf]')) {
    Object.assign(RV, { q: '', status: 'all', sev: new Set(), cat: null, conf: false, file: null });
    return RV.render();
  }
  const col = el('[data-collapse]');
  if (col) {
    const k = col.dataset.collapse;
    RV.collapsed.has(k) ? RV.collapsed.delete(k) : RV.collapsed.add(k);
    return RV.render();
  }
  if (t.matches('[data-pick]')) return;
  const row = el('[data-fid]');
  if (row) return select(row.dataset.fid, { scroll: false });

  // detail actions
  const act = el('[data-act]');
  if (act) {
    const box = act.closest('[data-detail]');
    const f = box ? j.findings.find((x) => x.id === box.dataset.detail) : current();
    if (f) return findingAction(act.dataset.act, f);
  }
  const quick = el('[data-quick]');
  if (quick) {
    const f = j.findings.find((x) => x.id === quick.closest('[data-detail]')?.dataset.detail);
    if (f) return ask(f, quick.dataset.quick);
  }
  const askGo = el('[data-ask-go]');
  if (askGo) return submitAsk(askGo.closest('[data-detail]'));

  const ga = el('[data-act-global]');
  if (ga) return globalAction(ga.dataset.actGlobal);

  const ru = el('[data-round-undo]');
  if (ru) return undoBatch(ru.dataset.roundUndo);
  const rc = el('[data-round-check]');
  if (rc) {
    await api(`/api/reviews/${j.id}/rounds/${rc.dataset.roundCheck}/check`, { method: 'POST' }).catch((err) => toast(err.message, true));
    return toast('Running your check command…');
  }

  // other tabs
  const hu = el('[data-hunk-undo]');
  if (hu) return undoHunk(hu.dataset.hunkUndo, Number(hu.dataset.hunk));
  const lu = el('[data-legacy-undo]');
  if (lu) {
    const f = j.findings.find((x) => x.id === lu.dataset.legacyUndo);
    await undoFix(f);
    RV.changes = null;
    return RV.render();
  }
  const of = el('[data-open-file]');
  if (of) return openInEditor(j.repo, of.dataset.openFile, 1);
  const fr = el('[data-file-row]');
  if (fr) {
    RV.file = fr.dataset.fileRow;
    RV.tab = 'findings';
    RV.status = 'all';
    RV.sel = null;
    return RV.render();
  }
  const fs = el('[data-fsort]');
  if (fs) {
    const k = fs.dataset.fsort;
    RV.fileSort = { key: k, dir: RV.fileSort.key === k ? -RV.fileSort.dir : k === 'path' ? 1 : -1 };
    return RV.render();
  }
  const jump = el('[data-jump]');
  if (jump) {
    RV.tab = 'findings';
    RV.status = 'all';
    return select(jump.dataset.jump);
  }
}

function onInput(e) {
  const t = e.target;
  if (t.matches('[data-search]')) {
    RV.q = t.value;
    RV.sel = null;
    return RV.render();
  }
  if (t.matches('[data-ask]')) {
    const id = t.closest('[data-detail]')?.dataset.detail;
    if (id) RV.drafts[id] = t.value;
  }
  if (t.matches('[data-commitmsg]')) RV.drafts.__commit = t.value;
}

function onChange(e) {
  const t = e.target;
  if (t.matches('[data-pick]')) {
    t.checked ? RV.picked.add(t.dataset.pick) : RV.picked.delete(t.dataset.pick);
    return RV.render();
  }
  if (t.matches('[data-pickall]')) {
    for (const f of visibleFindings().filter(pickable)) t.checked ? RV.picked.add(f.id) : RV.picked.delete(f.id);
    return RV.render();
  }
  if (t.matches('[data-catf]')) {
    RV.cat = t.value || null;
    RV.sel = null;
    return RV.render();
  }
  if (t.matches('[data-conf]')) {
    RV.conf = t.checked;
    RV.sel = null;
    return RV.render();
  }
  if (t.matches('[data-group]')) {
    RV.group = t.value;
    setPref('group', RV.group);
    return RV.render();
  }
  if (t.matches('[data-sort]')) {
    RV.sort = t.value;
    setPref('sort', RV.sort);
    return RV.render();
  }
  if (t.matches('[data-allevents]')) {
    RV.allEvents = t.checked;
    return RV.render();
  }
  if (t.matches('[data-codefile]')) {
    RV.code = { path: t.value, line: null };
    return RV.render();
  }
}

function onKeyDown(e) {
  if (e.target.matches('[data-ask]') && e.key === 'Enter') {
    e.preventDefault();
    submitAsk(e.target.closest('[data-detail]'));
  }
}

function submitAsk(box) {
  const f = RV.job.findings.find((x) => x.id === box?.dataset.detail);
  const input = box?.querySelector('[data-ask]');
  const q = input?.value.trim();
  if (!f || !q) return;
  RV.drafts[f.id] = '';
  ask(f, q);
}

async function findingAction(kind, f) {
  const j = RV.job;
  switch (kind) {
    case 'fix':
      return quickFix(f.id);
    case 'fix-instr':
      return fixDialog([f.id], { focusInstructions: true });
    case 'done':
      return setMark(f, 'fixed');
    case 'reopen':
      return setMark(f, 'open');
    case 'ignore': {
      const nextId = advanceFrom(f.id);
      if (await ignoreDialog([f.id])) {
        if (!visibleFindings().some((x) => x.id === f.id) && nextId) RV.sel = nextId;
        RV.render();
      }
      return;
    }
    case 'wizard':
      return proposalWizard(f.id);
    case 'apply':
      return decide(f, 'apply');
    case 'discard':
      return decide(f, 'discard');
    case 'undo':
      return undoFix(f);
    case 'copy':
      return copyForClaude([f]);
    case 'editor':
      return openInEditor(j.repo, f.path, f.start_line);
    case 'code':
      return showCode(f.path, f.start_line);
    case 'link':
      return copyText(`${location.origin}/#/review/${j.id}/${f.id}`, 'Link copied');
    case 'prev':
      return move(-1);
    case 'next':
      return move(1);
    case 'open-ask':
      RV.layout = 'workbench';
      setPref('layout', 'workbench');
      return select(f.id);
  }
}

async function globalAction(kind) {
  const j = RV.job;
  const picked = () => [...RV.picked];
  switch (kind) {
    case 'pick-clear':
      RV.picked.clear();
      return RV.render();
    case 'bulk-fix':
      return fixDialog(picked());
    case 'bulk-done':
      await markMany(picked(), 'fixed');
      toast(`${plural(RV.picked.size, 'finding')} marked done`);
      RV.picked.clear();
      return RV.render();
    case 'bulk-ignore':
      if (await ignoreDialog(picked())) {
        RV.picked.clear();
        RV.render();
      }
      return;
    case 'bulk-copy':
      return copyForClaude(picked().map((id) => j.findings.find((f) => f.id === id)));
    case 'wizard':
      return proposalWizard();
    case 'cancel-fixes': {
      const { cancelled } = await api(`/api/reviews/${j.id}/fix/cancel`, { method: 'POST' });
      toast(`Cancelled ${plural(cancelled, 'waiting fix', 'waiting fixes')}`);
      return RV.reload();
    }
    case 'show-flagged':
      RV.status = 'needs';
      return RV.render();
    case 'all-batches':
      RV.showBatches = true;
      return RV.render();
    case 'audit': {
      const n = j.findings.filter(unchecked).length;
      const ok = await confirmDialog({
        title: `Re-check ${plural(n, 'applied fix', 'applied fixes')}?`,
        body: 'Each fix gets a separate, read-only Claude run that judges whether it is safe. Nothing in your code changes; risky or wrong fixes are flagged for you.',
        ok: 'Re-check',
      });
      if (!ok) return;
      await api(`/api/reviews/${j.id}/audit-fixes`, { method: 'POST' }).catch((err) => toast(err.message, true));
      return RV.reload();
    }
    case 'refresh-changes':
      RV.changes = null;
      return RV.render();
    case 'commit': {
      const msg = $('[data-commitmsg]')?.value || '';
      return commitChanges(msg);
    }
  }
}

async function headerAction(kind) {
  const j = RV.job;
  switch (kind) {
    case 'cancel':
      await api(`/api/reviews/${j.id}/cancel`, { method: 'POST' });
      return toast('Stopping review…');
    case 'guard':
      return openGuardrails(j.repo, async () => {
        RV.guard = await api('/api/guard', { method: 'POST', body: { repo: j.repo } });
        RV.render();
      });
    case 'delete':
      if (!(await confirmDialog({ title: 'Delete this review?', body: 'It is removed from History. Your code and any applied fixes are not touched.', ok: 'Delete', danger: true }))) return;
      await api(`/api/reviews/${j.id}`, { method: 'DELETE' });
      location.hash = '#/history';
      return;
    case 'rerun':
      try {
        const job = await api('/api/reviews', {
          method: 'POST',
          body: { repo: j.repo, target: j.target, exclude: j.exclude, files: j.files.map((f) => f.path), engine: j.engine, focus: j.focus, background: j.background, label: j.label },
        });
        location.hash = `#/review/${job.id}`;
      } catch (err) {
        toast(err.message, true);
      }
      return;
    case 'verify': {
      const files = new Set(j.findings.filter(isFixed).map((f) => f.path)).size;
      const ok = await confirmDialog({
        title: 'Verify the fixes?',
        body: `Starts a fresh review of the ${plural(files, 'file')} you fixed, then compares it with this one: which findings are resolved, which are still there, and anything new the fixes introduced.`,
        ok: 'Start verification',
      });
      if (!ok) return;
      try {
        const job = await api(`/api/reviews/${j.id}/verify`, { method: 'POST' });
        location.hash = `#/review/${job.id}`;
      } catch (err) {
        toast(err.message, true);
      }
    }
  }
}

async function exportAs(format) {
  const j = RV.job;
  try {
    if (format === 'md-copy' || format === 'md') {
      const { markdown } = await api(`/api/reviews/${j.id}/export?format=md`);
      if (format === 'md') return download(`${j.repoName}-${j.id}.md`, markdown, 'text/markdown');
      return copyText(markdown, 'Copied the review as Markdown');
    }
    const r = await api(`/api/reviews/${j.id}/export?format=${format}`);
    download(r.name, r.body, r.type);
  } catch (err) {
    toast(err.message, true);
  }
}

function keyHelp() {
  modal(
    () => `<h2>${icon('keyboard', 18)} Keyboard shortcuts</h2><div class="keys">${KEY_HELP.map(([k, d]) => `<div><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join('')}</div>
      <div class="modal-actions"><button class="btn primary" data-x>Got it</button></div>`,
    (root, close) => root.querySelector('[data-x]').addEventListener('click', () => close())
  );
}

function keyMap() {
  const onFinding = (fn) => () => {
    if (RV.tab !== 'findings') return;
    const f = current();
    if (f) fn(f);
  };
  const statuses = STATUS_FILTERS.map((s) => s.id);
  const map = {
    j: () => RV.tab === 'findings' && move(1),
    ArrowDown: () => RV.tab === 'findings' && RV.layout === 'workbench' && move(1),
    k: () => RV.tab === 'findings' && move(-1),
    ArrowUp: () => RV.tab === 'findings' && RV.layout === 'workbench' && move(-1),
    x: onFinding((f) => {
      if (!pickable(f)) return;
      RV.picked.has(f.id) ? RV.picked.delete(f.id) : RV.picked.add(f.id);
      RV.render();
    }),
    f: onFinding((f) => pickable(f) && quickFix(f.id)),
    F: onFinding((f) => pickable(f) && fixDialog([f.id], { focusInstructions: true })),
    d: onFinding((f) => f.mark === 'open' && setMark(f, 'fixed')),
    i: onFinding((f) => f.mark === 'open' && findingAction('ignore', f)),
    o: onFinding((f) => f.mark !== 'open' && setMark(f, 'open')),
    a: () => RV.job.findings.some(needsYou) && proposalWizard(current()?.id),
    q: onFinding(() => $('[data-ask]')?.focus()),
    c: onFinding((f) => showCode(f.path, f.start_line)),
    e: onFinding((f) => openInEditor(RV.job.repo, f.path, f.start_line)),
    '/': () => {
      RV.tab = 'findings';
      RV.render();
      $('[data-search]')?.focus();
    },
    '?': keyHelp,
    Escape: () => {
      if (RV.picked.size) {
        RV.picked.clear();
        RV.render();
      }
    },
  };
  statuses.forEach((s, i) => {
    map[String(i + 1)] = () => {
      RV.tab = 'findings';
      RV.status = s;
      RV.sel = null;
      RV.render();
    };
  });
  return map;
}
