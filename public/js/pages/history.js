// History: every review, filterable by project, type and text.

import { view, api, esc, icon, ago, money, plural, SEVS } from '../core.js';

const H = { project: '', kind: '', q: '' };
const KIND = { workspace: 'Uncommitted', range: 'Branch', commit: 'Commit', scan: 'Scan' };

export async function pageHistory() {
  const { reviews } = await api('/api/reviews');
  const projects = [...new Set(reviews.map((r) => r.repo))];
  const render = () => {
    const q = H.q.trim().toLowerCase();
    const list = reviews.filter((r) => (!H.project || r.repo === H.project) && (!H.kind || r.target.kind === H.kind || (H.kind === 'verify' && r.verifies)) && (!q || `${r.repoName} ${r.title}`.toLowerCase().includes(q)));
    view.innerHTML = `
      <div class="page-head"><div><h1>History</h1><p>Every review you have run, newest first.</p></div>
        <div class="actions"><a class="btn primary" href="#/new">${icon('spark', 14)} New review</a></div></div>
      <div class="row wrap" style="margin-bottom:12px">
        <input data-q placeholder="Search reviews…" value="${esc(H.q)}" style="width:240px" />
        <select data-project><option value="">All projects</option>${projects.map((p) => `<option value="${esc(p)}" ${H.project === p ? 'selected' : ''}>${esc(p.split('/').pop())}</option>`).join('')}</select>
        <select data-kind><option value="">All types</option>${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${H.kind === k ? 'selected' : ''}>${v}</option>`).join('')}<option value="verify" ${H.kind === 'verify' ? 'selected' : ''}>Verification</option></select>
        <span class="faint">${list.length} of ${plural(reviews.length, 'review')}</span>
      </div>
      ${
        list.length
          ? `<div class="card">${list
              .map(
                (r) => `<a class="history-item" href="#/review/${r.id}">
                  <div style="min-width:0">
                    <div class="row wrap"><b>${esc(r.repoName)}</b><span class="tag">${r.verifies ? 'Verification' : KIND[r.target.kind] || r.target.kind}</span><span class="muted ellipsis">${esc(r.title)}</span></div>
                    <div class="faint" style="font-size:12.5px;margin-top:3px">${ago(r.createdAt)} · ${plural(r.fileCount, 'file')} · ${r.engine.type === 'claude' ? `Claude ${esc(r.engine.model)}` : 'OCR agent'} · ${r.handled}/${r.findingCount} handled${r.fixesApplied ? ` · ${r.fixesApplied} fixed` : ''}${r.costUsd ? ` · ${money(r.costUsd)}` : ''}</div>
                  </div>
                  <div class="row wrap" style="justify-content:flex-end;gap:4px">
                    ${r.status === 'running' ? '<span class="pill run"><i class="dot run"></i> running</span>' : r.status !== 'done' ? `<span class="pill warn">${esc(r.status)}</span>` : ''}
                    ${r.fixing ? `<span class="pill run">fixing ${r.fixing}</span>` : ''}
                    ${r.needsYou ? `<span class="pill warn">${r.needsYou} need you</span>` : ''}
                    ${r.flagged ? `<span class="pill bad">${r.flagged} flagged</span>` : ''}
                    ${SEVS.filter((s) => r.openCounts[s]).map((s) => `<span class="sevdot ${s}" title="${r.openCounts[s]} open ${s}">${r.openCounts[s]}</span>`).join('') || (r.status === 'done' ? '<span class="pill ok">no open issues</span>' : '')}
                  </div>
                </a>`
              )
              .join('')}</div>`
          : `<div class="card empty"><div class="big">📭</div><b>${reviews.length ? 'No reviews match.' : 'No reviews yet.'}</b><p><a href="#/new">Start a review →</a></p></div>`
      }`;
    const qEl = view.querySelector('[data-q]');
    qEl.addEventListener('input', (e) => {
      H.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = view.querySelector('[data-q]');
      el.focus();
      el.setSelectionRange(pos, pos);
    });
    view.querySelector('[data-project]').addEventListener('change', (e) => ((H.project = e.target.value), render()));
    view.querySelector('[data-kind]').addEventListener('change', (e) => ((H.kind = e.target.value), render()));
  };
  render();
}
