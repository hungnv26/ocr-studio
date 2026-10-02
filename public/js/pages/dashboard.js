// Home: what needs attention, what is running, recent work, weekly usage.

import { view, api, esc, icon, ago, money, kfmt, plural, S, SEVS, sparkline, onLeave, toolsMissingBanner } from '../core.js';
import { openRepoPicker } from '../repo-picker.js';

export async function pageDashboard() {
  let left = false;
  let pending = false;
  const load = async () => {
    const d = await api('/api/dashboard');
    if (!left) render(d);
    return d;
  };
  let d = await load();
  // Keep running jobs fresh without a socket per job.
  const timer = setInterval(async () => {
    if (left || pending || !d.running.length) return;
    pending = true;
    try {
      d = await load().catch(() => d);
    } finally {
      pending = false;
    }
  }, 4000);
  onLeave(() => {
    left = true;
    clearInterval(timer);
  });
}

function render(d) {
  const last = S.repo || (S.lastRepo ? { repo: S.lastRepo, name: S.lastRepo.split('/').pop() } : null);
  const u = d.usage;
  const attention = d.attention
    .map((a) => {
      const parts = [];
      if (a.needs) parts.push(`<a href="#/review/${a.id}" class="att-item"><span class="pill warn">${a.needs}</span> fix${a.needs === 1 ? '' : 'es'} waiting for your decision</a>`);
      if (a.flagged) parts.push(`<a href="#/review/${a.id}" class="att-item"><span class="pill bad">${a.flagged}</span> applied fix${a.flagged === 1 ? '' : 'es'} flagged by the re-check</a>`);
      if (a.failedChecks) parts.push(`<a href="#/review/${a.id}" class="att-item"><span class="pill bad">${a.failedChecks}</span> fix batch${a.failedChecks === 1 ? '' : 'es'} failed your check command</a>`);
      if (a.unchecked) parts.push(`<a href="#/review/${a.id}" class="att-item"><span class="pill">${a.unchecked}</span> applied fix${a.unchecked === 1 ? '' : 'es'} never double-checked</a>`);
      return `<div class="att"><div class="att-title"><b>${esc(a.repoName)}</b> <span class="muted">${esc(a.title)}</span></div>${parts.join('')}</div>`;
    })
    .join('');
  view.innerHTML = `
    <div class="page-head"><div><h1>Home</h1><p>What needs you, what's running, and where you left off.</p></div>
      <div class="actions"><button class="btn" data-pick>${icon('folder', 14)} Choose a project</button></div></div>
    ${toolsMissingBanner()}

    ${
      last
        ? `<div class="quick">
            <a class="quick-card" href="#/new"><div class="ico">${icon('review', 18)}</div><div><b>Review changes</b><span>in ${esc(last.name)}: uncommitted work, a branch or a commit</span></div></a>
            <a class="quick-card" href="#/scan"><div class="ico scanc">${icon('scan', 18)}</div><div><b>Scan & audit</b><span>read whole files or folders in ${esc(last.name)}</span></div></a>
            <a class="quick-card" href="#/project/${encodeURIComponent(last.repo)}"><div class="ico">${icon('shield', 18)}</div><div><b>Project settings</b><span>guardrails, history and defaults for ${esc(last.name)}</span></div></a>
          </div>`
        : `<div class="card section empty"><div class="big">👋</div><b>Pick a project to get started.</b><p><button class="btn primary" data-pick>${icon('folder', 14)} Choose a repository</button></p></div>`
    }

    <div class="dash-grid">
      <div class="dash-main">
        ${
          d.running.length
            ? `<div class="card section" data-live><h2 class="section-title"><span class="spinner"></span> Running now</h2>${d.running
                .map(
                  (r) => `<a class="run-item" href="#/review/${r.id}"><div class="grow"><b>${esc(r.repoName)}</b> <span class="muted">${esc(r.title)}</span>
                    <div class="progress" style="margin-top:6px"><div style="width:${r.status === 'running' ? Math.max(4, Math.round((r.done / Math.max(1, r.files)) * 100)) : 100}%"></div></div></div>
                    <span class="muted">${r.status === 'running' ? `${r.done}/${r.files} files` : ''}${r.fixing ? ` · fixing ${r.fixing}` : ''}</span></a>`
                )
                .join('')}</div>`
            : ''
        }
        <div class="card section">
          <h2 class="section-title">${icon('shield', 16)} Needs your attention</h2>
          ${attention || '<div class="muted">Nothing waiting. Every fix has been decided and checked.</div>'}
        </div>
        <div class="card section">
          <div class="row"><h2 class="section-title grow">${icon('history', 16)} Recent reviews</h2><a href="#/history">All history →</a></div>
          ${
            d.recent.length
              ? d.recent
                  .map(
                    (r) => `<a class="recent-item" href="#/review/${r.id}">
                      <div class="grow" style="min-width:0"><div class="ellipsis"><b>${esc(r.repoName)}</b> <span class="muted">${esc(r.title)}</span></div>
                      <div class="faint" style="font-size:12px">${ago(r.createdAt)} · ${plural(r.fileCount, 'file')} · ${r.handled}/${r.findingCount} handled</div></div>
                      <div class="row" style="gap:4px">${SEVS.filter((s) => r.openCounts[s]).map((s) => `<span class="sevdot ${s}">${r.openCounts[s]}</span>`).join('') || (r.status === 'done' ? '<span class="pill ok">clear</span>' : `<span class="pill">${esc(r.status)}</span>`)}</div></a>`
                  )
                  .join('')
              : '<div class="muted">No reviews yet.</div>'
          }
        </div>
      </div>
      <div class="dash-side">
        <div class="card section">
          <h2 class="section-title">This week</h2>
          <div class="usage">
            <div><div class="n">${u.reviews}</div><div class="l">reviews</div></div>
            <div><div class="n">${u.findings}</div><div class="l">findings</div></div>
            <div><div class="n">${u.fixesApplied}</div><div class="l">fixes applied</div></div>
            <div><div class="n">${kfmt(u.tokens)}</div><div class="l">tokens</div></div>
          </div>
          <div class="spark-wrap">${sparkline(u.byDay.map((x) => x.reviews), { w: 240, h: 40 })}<div class="row faint" style="font-size:11px;justify-content:space-between"><span>${u.byDay[0].day.slice(5)}</span><span>reviews per day</span><span>today</span></div></div>
          <div class="faint" style="font-size:12px;margin-top:8px">${money(u.costUsd)} as reported by Claude Code. On a Claude subscription this counts toward your usage limits rather than a bill.</div>
        </div>
        <div class="card section">
          <div class="row"><h2 class="section-title grow">${icon('project', 16)} Projects</h2><a href="#/projects">All →</a></div>
          ${d.projects
            .map(
              (p) => `<a class="proj-mini" href="#/project/${encodeURIComponent(p.repo)}"><div class="grow" style="min-width:0"><b>${esc(p.name)}</b><div class="faint ellipsis" style="font-size:12px">${p.lastAt ? `last review ${ago(p.lastAt)}` : 'no reviews yet'}</div></div>
                ${p.needsYou ? `<span class="pill warn">${p.needsYou}</span>` : ''}${p.open ? `<span class="pill">${p.open} open</span>` : ''}${p.guarded ? `<span title="Guardrails set">${icon('shield', 14)}</span>` : ''}</a>`
            )
            .join('') || '<div class="muted">No projects yet.</div>'}
        </div>
      </div>
    </div>`;
  view.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => openRepoPicker(() => (location.hash = '#/new'))));
}
