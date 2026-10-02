// Findings tab: a two-pane triage workbench (or classic cards) with search,
// status filters, grouping, keyboard navigation and bulk actions.

import { esc, md, icon, SEVS, plural, setPref, openInEditor, copyText, ago } from '../core.js';
import { RV, STATUS_FILTERS, visibleFindings, countBy, pickable, needsYou, flagged, unchecked, inFlight, isFixed, FIX_IN_FLIGHT } from './state.js';
import { renderSnippet, renderCode, fixBox, threadBox, statusBadge, confBadge } from './render.js';

const CATS = ['bug', 'security', 'performance', 'maintainability', 'test', 'style', 'documentation', 'other'];

export function renderFindingsTab() {
  const j = RV.job;
  if (!j.findings.length) {
    if (j.status === 'running') return `<div class="empty"><div class="spinner" style="width:26px;height:26px"></div><p>Findings appear here as each batch finishes.</p></div>`;
    if (j.status === 'done') return `<div class="empty"><div class="big">✅</div><b>No issues found.</b><div>The reviewer went through ${plural(j.files.filter((f) => f.state === 'reviewed').length, 'file')} and found nothing worth flagging.</div></div>`;
    return `<div class="empty">No findings.</div>`;
  }
  const list = visibleFindings();
  if (RV.sel && !list.some((f) => f.id === RV.sel) && !j.findings.some((f) => f.id === RV.sel)) RV.sel = null;
  if (!RV.sel && list.length && RV.layout === 'workbench') RV.sel = list[0].id;
  const cats = CATS.filter((c) => j.findings.some((f) => f.category === c));
  const shownPickable = list.filter(pickable);
  const allPicked = shownPickable.length > 0 && shownPickable.every((f) => RV.picked.has(f.id));
  const somePicked = shownPickable.some((f) => RV.picked.has(f.id));

  const toolbar = `<div class="wb-toolbar">
    <div class="row wrap">
      <div class="search"><input data-keep="search" data-search placeholder="Search findings…  ( / )" value="${esc(RV.q)}" /></div>
      <div class="seg status-seg">${STATUS_FILTERS.map((s) => `<button data-status="${s.id}" class="${RV.status === s.id ? 'on' : ''}">${s.label}<small>${countBy(s.test)}</small></button>`).join('')}</div>
    </div>
    <div class="row wrap" style="margin-top:8px">
      <div class="chips">${SEVS.map((s) => `<button class="chip sevchip ${s} ${RV.sev.has(s) ? 'on' : ''}" data-sevf="${s}">${s}<span class="count">${countBy((f) => f.severity === s && f.mark === 'open')}</span></button>`).join('')}</div>
      <select data-catf><option value="">All types</option>${cats.map((c) => `<option value="${c}" ${RV.cat === c ? 'selected' : ''}>${c} (${countBy((f) => f.category === c)})</option>`).join('')}</select>
      ${j.findings.some((f) => f.confidence) ? `<label class="row toggle" title="Only findings the reviewer was highly confident about"><input type="checkbox" data-conf ${RV.conf ? 'checked' : ''}/> High confidence</label>` : ''}
      ${RV.file ? `<span class="pill run">${icon('file', 12)} ${esc(RV.file)} <a href="javascript:void 0" data-clearfile>×</a></span>` : ''}
      <span class="grow"></span>
      <select data-group title="Group by"><option value="file" ${RV.group === 'file' ? 'selected' : ''}>Group: file</option><option value="severity" ${RV.group === 'severity' ? 'selected' : ''}>Group: severity</option><option value="none" ${RV.group === 'none' ? 'selected' : ''}>No grouping</option></select>
      <select data-sort title="Sort by"><option value="severity" ${RV.sort === 'severity' ? 'selected' : ''}>Sort: severity</option><option value="file" ${RV.sort === 'file' ? 'selected' : ''}>Sort: file</option><option value="confidence" ${RV.sort === 'confidence' ? 'selected' : ''}>Sort: confidence</option></select>
      <div class="seg icon-seg"><button data-layout="workbench" class="${RV.layout === 'workbench' ? 'on' : ''}" title="List + detail">${icon('list', 14)}</button><button data-layout="cards" class="${RV.layout === 'cards' ? 'on' : ''}" title="Cards">${icon('cards', 14)}</button></div>
      <button class="btn small ghost" data-keys title="Keyboard shortcuts">${icon('keyboard', 15)}</button>
    </div>
  </div>`;

  const panels = `${renderFixProgress()}${renderAudit()}${renderApprovals()}${renderRounds()}`;
  const pickRow = shownPickable.length
    ? `<div class="pick-row"><label class="row" style="gap:8px"><input type="checkbox" data-pickall ${allPicked ? 'checked' : ''} ${somePicked && !allPicked ? 'data-ind="1"' : ''} />
        Select all <b>${shownPickable.length}</b> shown</label><span class="faint">${list.length} of ${j.findings.length} findings shown</span></div>`
    : `<div class="faint" style="margin:4px 2px 8px">${list.length} of ${j.findings.length} findings shown</div>`;

  let body;
  if (!list.length) body = `<div class="empty">No findings match. <a href="javascript:void 0" data-resetf>Reset filters</a></div>`;
  else if (RV.layout === 'cards') body = list.map((f) => `<div class="card finding-card ${f.severity}" id="finding-${f.id}">${renderDetail(f, { card: true })}</div>`).join('');
  else {
    const sel = j.findings.find((f) => f.id === RV.sel) || list[0];
    body = `<div class="wb"><div class="wb-list card" data-scroll-key="wb-list">${renderList(list)}</div>
      <div class="wb-detail card" data-scroll-key="wb-detail">${sel ? renderDetail(sel) : ''}</div></div>`;
  }
  return toolbar + panels + pickRow + body;
}

function renderList(list) {
  const rows = [];
  let group = null;
  for (const f of list) {
    const key = RV.group === 'file' ? f.path : RV.group === 'severity' ? f.severity : null;
    if (key !== group && key != null) {
      group = key;
      const members = list.filter((x) => (RV.group === 'file' ? x.path === key : x.severity === key));
      const collapsed = RV.collapsed.has(key);
      if (RV.group === 'file') {
        const parts = key.split('/');
        const name = parts.pop();
        const dots = SEVS.map((s) => members.filter((m) => m.severity === s).length).map((n, i) => (n ? `<span class="sevdot ${SEVS[i]}" title="${n} ${SEVS[i]}">${n}</span>` : '')).join('');
        rows.push(`<div class="wb-group" data-collapse="${esc(key)}"><span class="caret ${collapsed ? '' : 'open'}">▸</span><span class="mono ellipsis grow"><b>${esc(name)}</b> <span class="faint">${esc(parts.join('/'))}</span></span>${dots}</div>`);
      } else rows.push(`<div class="wb-group" data-collapse="${esc(key)}"><span class="caret ${collapsed ? '' : 'open'}">▸</span><span class="pill sev ${key}">${key}</span><span class="faint">${members.length}</span></div>`);
    }
    if (key != null && RV.collapsed.has(key)) continue;
    rows.push(`<div class="wb-row ${RV.sel === f.id ? 'on' : ''} ${RV.picked.has(f.id) ? 'picked' : ''} ${f.mark !== 'open' ? 'done' : ''}" data-fid="${f.id}">
      ${pickable(f) ? `<input type="checkbox" class="pick" data-pick="${f.id}" ${RV.picked.has(f.id) ? 'checked' : ''} />` : '<span class="pick-spacer"></span>'}
      <span class="sevbar ${f.severity}"></span>
      <div class="grow" style="min-width:0">
        <div class="t ellipsis">${esc(f.title)}</div>
        <div class="m ellipsis">${RV.group === 'file' ? `line ${f.start_line}` : `${esc(f.path.split('/').pop())}:${f.start_line}`} · ${esc(f.category)} ${confBadge(f)}</div>
      </div>
      ${statusBadge(f)}
    </div>`);
  }
  return rows.join('');
}

export function renderDetail(f, { card = false } = {}) {
  const j = RV.job;
  const lines = f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}–${f.end_line}`;
  const busy = inFlight(f) || needsYou(f);
  const list = visibleFindings();
  const idx = list.findIndex((x) => x.id === f.id);
  const actions = [];
  if (f.mark === 'open' && !busy && f.fix?.status !== 'applied') {
    actions.push(`<div class="split"><button class="btn small primary" data-act="fix">${icon('wand', 13)} Fix with Claude</button><button class="btn small primary" data-act="fix-instr" title="Fix with instructions">…</button></div>`);
    actions.push(`<button class="btn small" data-act="done">${icon('check', 13)} Mark done</button>`);
    actions.push(`<button class="btn small" data-act="ignore">Ignore…</button>`);
  } else if (f.mark !== 'open') actions.push(`<button class="btn small" data-act="reopen">Reopen</button>`);
  if (needsYou(f)) actions.push(`<button class="btn small primary" data-act="wizard">Review change</button>`);
  return `<div class="detail" data-detail="${f.id}">
    <div class="detail-head">
      ${card && pickable(f) ? `<input type="checkbox" class="pick" data-pick="${f.id}" ${RV.picked.has(f.id) ? 'checked' : ''} />` : ''}
      <div class="grow">
        <div class="row wrap" style="gap:6px;margin-bottom:6px">
          <span class="pill sev ${f.severity}">${f.severity}</span><span class="tag">${esc(f.category)}</span>${confBadge(f)}
          <a class="loc" href="javascript:void 0" data-act="code" title="Show in code">${esc(f.path)}:${lines}</a>
          ${f.mark === 'fixed' ? '<span class="pill ok">✓ done</span>' : f.mark === 'ignored' ? '<span class="pill">ignored</span>' : ''}
          ${flagged(f) ? '<span class="pill warn">⚠ re-check flagged</span>' : ''}
        </div>
        <h3>${esc(f.title)}</h3>
      </div>
      ${!card && idx >= 0 ? `<div class="nav-mini"><button class="btn small ghost" data-act="prev" ${idx <= 0 ? 'disabled' : ''} title="Previous (k)">↑</button><span class="faint">${idx + 1}/${list.length}</span><button class="btn small ghost" data-act="next" ${idx >= list.length - 1 ? 'disabled' : ''} title="Next (j)">↓</button></div>` : ''}
    </div>
    <div class="detail-actions">${actions.join('')}<span class="grow"></span>
      <button class="btn small ghost" data-act="copy" title="Copy a ready-made prompt for your own Claude Code session">${icon('copy', 13)} Copy for Claude Code</button>
      <button class="btn small ghost" data-act="editor" title="Open in your editor (e)">${icon('open', 13)} Open</button>
      <button class="btn small ghost" data-act="link" title="Copy a link to this finding">#</button>
    </div>
    <div class="md">${md(f.content)}</div>
    ${f.ignoreReason ? `<div class="banner info" style="margin-top:8px">Ignored: ${esc(f.ignoreReason)}${f.learned ? ' <span class="tag">remembered for future reviews</span>' : ''}</div>` : ''}
    ${renderSnippet(f.snippet, f.start_line, f.end_line, f.path)}
    ${f.suggestion_code ? `<div class="code-label">Reviewer's suggested change</div>${renderCode(f.suggestion_code, f.path)}` : ''}
    ${fixBox(f)}
    ${card ? (f.thread?.length ? threadBox(f, RV.drafts[f.id] || '') : `<button class="btn small ghost" data-act="open-ask">${icon('chat', 13)} Ask Claude about this</button>`) : threadBox(f, RV.drafts[f.id] || '')}
  </div>`;
}

export function renderFixProgress() {
  const live = RV.job.findings.filter(inFlight);
  if (!live.length) return '';
  const rounds = new Set(live.map((f) => f.fix.round));
  const fixes = RV.job.findings.filter((f) => f.fix && rounds.has(f.fix.round)).map((f) => f.fix.status);
  const c = (s) => fixes.filter((x) => x === s).length;
  const total = fixes.length;
  const finished = total - c('queued') - c('running') - c('checking');
  return `<div class="card fix-progress">
    <div class="row wrap"><span class="spinner"></span><b>Fixing ${plural(total, 'finding')}</b>
      <span class="muted">${c('applied')} applied · ${c('proposed') + c('rejected')} need you · ${c('running')} editing · ${c('checking')} double-checking · ${c('queued')} waiting</span>
      <span class="grow"></span>${c('queued') ? `<button class="btn small" data-act-global="cancel-fixes">Cancel ${c('queued')} waiting</button>` : ''}</div>
    <div class="progress" style="margin-top:10px"><div style="width:${Math.round((finished / total) * 100)}%"></div></div>
  </div>`;
}

function renderApprovals() {
  const waiting = RV.job.findings.filter(needsYou);
  if (!waiting.length) return '';
  return `<div class="banner info approvals">🛡️ <div class="grow"><b>${plural(waiting.length, 'change')} waiting for your decision.</b> The checker flagged ${waiting.length === 1 ? 'it' : 'them'} as risky or wrong, or you chose “Ask me first”. Your files are unchanged for these.</div>
    <button class="btn small primary" data-act-global="wizard">Review ${waiting.length === 1 ? 'it' : `all ${waiting.length}`}</button></div>`;
}

function renderAudit() {
  const j = RV.job;
  const todo = j.findings.filter(unchecked).length;
  const running = j.findings.filter((f) => ['queued', 'running'].includes(f.fix?.audit?.status)).length;
  const bad = j.findings.filter(flagged);
  const done = j.findings.filter((f) => f.fix?.audit?.status === 'done').length;
  if (!todo && !running && !done) return '';
  if (!todo && !running && !bad.length) return '';
  return `<div class="banner ${bad.length ? 'warn' : 'info'} approvals">🔍 <div class="grow">
      ${running ? `<b>Re-checking applied fixes… ${done} of ${done + running} done.</b> ` : ''}
      ${done && !running ? `<b>Re-check finished: ${bad.length} of ${done} applied fixes flagged.</b> ` : ''}
      ${todo ? `${plural(todo, 'fix was', 'fixes were')} applied before safety checks existed and never had a second look.` : ''}
      ${bad.length ? 'Flagged fixes are still in your code; read each reason and undo the wrong ones.' : ''}</div>
    ${bad.length ? `<button class="btn small" data-act-global="show-flagged">Show ${bad.length} flagged</button>` : ''}
    ${todo && !running ? `<button class="btn small primary" data-act-global="audit">Re-check ${todo}</button>` : ''}
  </div>`;
}

function renderRounds() {
  const j = RV.job;
  const rounds = (j.fixRounds || []).filter((r) => j.findings.some((f) => f.fix?.round === r.id) || r.status === 'undone').slice().reverse();
  if (!rounds.length) return '';
  const failed = rounds.filter((r) => r.check?.status === 'failed' && r.status !== 'undone').length;
  const rows = rounds
    .slice(0, RV.showBatches ? 20 : 3)
    .map((r) => {
      const fs_ = j.findings.filter((f) => f.fix?.round === r.id);
      const c = (s) => fs_.filter((f) => f.fix.status === s).length;
      const running = fs_.some(inFlight);
      const files = Object.keys(r.backups || {}).length;
      const chk = r.check;
      const check = !chk
        ? ''
        : chk.status === 'running'
          ? '<span class="pill run"><span class="spinner"></span> running your check…</span>'
          : chk.status === 'passed'
            ? `<span class="pill ok">✓ check passed</span>`
            : chk.status === 'failed'
              ? `<span class="pill bad">✕ check failed (exit ${chk.code})</span>`
              : `<span class="pill warn">check ${esc(chk.status)}</span>`;
      return `<div class="round">
        <div class="row wrap">
          <b>${new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b>
          <span class="tag">${r.mode === 'ask' ? 'ask me first' : 'auto-apply safe'}</span>
          <span class="muted">${c('applied')} applied · ${c('proposed') + c('rejected')} need you${c('reverted') ? ` · ${c('reverted')} undone` : ''} · ${plural(files, 'file')}</span>
          ${r.status === 'undone' ? '<span class="pill">batch undone</span>' : check}
          <span class="grow"></span>
          ${RV.guard?.checkCommand && !running && r.status !== 'undone' ? `<button class="btn small ghost" data-round-check="${r.id}">Run check</button>` : ''}
          ${!running && r.status !== 'undone' && files ? `<button class="btn small danger" data-round-undo="${r.id}">${icon('undo', 13)} Undo whole batch</button>` : ''}
        </div>
        ${chk && chk.status === 'failed' ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer">Show check output</summary><pre class="code" style="max-height:260px">${esc(chk.output)}</pre></details>` : ''}
      </div>`;
    })
    .join('');
  return `<details class="card rounds" ${RV.showBatches || failed ? 'open' : ''} data-batches>
    <summary class="rounds-head"><b>Fix batches (${rounds.length})</b>${failed ? `<span class="pill bad">${failed} failed check</span>` : ''}<span class="faint">Files are backed up before Claude touches them. “Undo whole batch” restores them exactly.</span></summary>
    ${rows}${rounds.length > 3 && !RV.showBatches ? `<div class="round"><a href="javascript:void 0" data-act-global="all-batches">Show all ${rounds.length} batches</a></div>` : ''}
  </details>`;
}

export function renderSelectionBar() {
  const n = RV.picked.size;
  if (!n || RV.tab !== 'findings') return '';
  return `<div class="startbar selbar">
    <div class="summary"><b>${n} selected</b> <a href="javascript:void 0" data-act-global="pick-clear">clear</a></div>
    <button class="btn" data-act-global="bulk-copy" title="Copy one prompt for all selected findings">${icon('copy', 14)} Copy for Claude Code</button>
    <button class="btn" data-act-global="bulk-ignore">Ignore…</button>
    <button class="btn" data-act-global="bulk-done">${icon('check', 14)} Mark done</button>
    <button class="btn primary big" data-act-global="bulk-fix">${icon('wand', 15)} Fix ${n}…</button>
  </div>`;
}

export const KEY_HELP = [
  ['j / ↓', 'Next finding'],
  ['k / ↑', 'Previous finding'],
  ['x', 'Select for a bulk action'],
  ['f', 'Fix with Claude'],
  ['F', 'Fix with instructions…'],
  ['d', 'Mark done'],
  ['i', 'Ignore with a reason…'],
  ['o', 'Reopen'],
  ['a', 'Review waiting changes'],
  ['q', 'Ask Claude about it'],
  ['c', 'Show in code'],
  ['e', 'Open in editor'],
  ['/', 'Search'],
  ['1 – 5', 'Open · Needs you · Fixed · Ignored · All'],
  ['Esc', 'Clear selection'],
];

export { copyText, openInEditor, ago, isFixed, FIX_IN_FLIGHT };
