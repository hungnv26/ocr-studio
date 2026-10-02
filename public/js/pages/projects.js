// Projects: every repository OCR Studio knows, and a page per project with
// guardrails, defaults, history and a findings trend.

import { view, api, esc, icon, ago, plural, S, SEVS, sparkline, selectRepo, toast } from '../core.js';
import { openRepoPicker } from '../repo-picker.js';
import { guardForm, bindGuardForm } from '../guardrails.js';

export async function pageProjects() {
  const { projects } = await api('/api/projects');
  view.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p>Each project keeps its own guardrails, defaults and review history.</p></div>
      <div class="actions"><button class="btn primary" data-add>${icon('folder', 14)} Add a project</button></div></div>
    ${
      projects.length
        ? `<div class="proj-grid">${projects
            .map(
              (p) => `<a class="card proj-card" href="#/project/${encodeURIComponent(p.repo)}">
                <div class="row"><div class="ico-sq">${icon('git', 17)}</div><div class="grow" style="min-width:0"><b>${esc(p.name)}</b><div class="faint mono ellipsis" style="font-size:11.5px">${esc(p.repo)}</div></div></div>
                <div class="row wrap" style="margin-top:12px;gap:6px">
                  <span class="pill">${plural(p.reviews, 'review')}</span>
                  ${p.open ? `<span class="pill">${p.open} open</span>` : ''}
                  ${p.needsYou ? `<span class="pill warn">${p.needsYou} need you</span>` : ''}
                  ${p.guarded ? `<span class="pill ok">${icon('shield', 11)} guardrails</span>` : '<span class="pill warn">no guardrails</span>'}
                </div>
                <div class="faint" style="font-size:12px;margin-top:8px">${p.lastAt ? `Last review ${ago(p.lastAt)}` : 'Not reviewed yet'}</div>
              </a>`
            )
            .join('')}</div>`
        : `<div class="card empty"><div class="big">🗂️</div><b>No projects yet.</b><p>Add a repository to start reviewing it.</p></div>`
    }`;
  view.querySelector('[data-add]').addEventListener('click', () =>
    openRepoPicker(() => {
      location.hash = `#/project/${encodeURIComponent(S.repo.repo)}`;
    })
  );
}

export async function pageProject(repo) {
  const d = await api('/api/project', { method: 'POST', body: { repo } });
  const { info, guard, reviews, git } = d;
  if (S.repo?.repo !== info.repo) selectRepo(info.repo).catch(() => {});
  const tpl = (await api('/api/guard/templates')).templates;
  const chrono = reviews.slice().reverse();
  const trend = chrono.map((r) => r.findingCount);
  const open = reviews.reduce((a, r) => a + SEVS.reduce((x, s) => x + (r.openCounts[s] || 0), 0), 0);
  view.innerHTML = `
    <div class="page-head">
      <div class="grow" style="min-width:0">
        <div class="crumbs"><a href="#/projects">Projects</a> ›</div>
        <div class="row wrap"><h1 style="margin:0">${esc(info.name)}</h1><span class="pill">${icon('branch', 12)} ${esc(git.branch)}</span>${git.dirty ? `<span class="pill warn">${git.dirty} uncommitted</span>` : '<span class="pill ok">clean</span>'}</div>
        <p class="mono">${esc(info.repo)}</p>
      </div>
      <div class="actions">
        <a class="btn primary" href="#/new">${icon('review', 14)} Review changes</a>
        <a class="btn" href="#/scan">${icon('scan', 14)} Scan files</a>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="n">${reviews.length}</div><div class="l">reviews</div></div>
      <div class="stat"><div class="n">${open}</div><div class="l">open findings</div></div>
      <div class="stat"><div class="n">${reviews.reduce((a, r) => a + r.fixesApplied, 0)}</div><div class="l">fixes applied</div></div>
      <div class="stat"><div class="n">${(guard.learned || []).length}</div><div class="l">learned dismissals</div></div>
      <div class="stat trend"><div class="l">findings per review</div>${trend.length > 1 ? sparkline(trend, { w: 150, h: 34 }) : '<div class="faint">needs 2+ reviews</div>'}</div>
    </div>

    <div class="card section">
      <div class="row"><h2 class="section-title grow">${icon('shield', 16)} Guardrails</h2><button class="btn primary" data-save>Save guardrails</button></div>
      <p class="section-sub">Rules every review and fix in this project follows. They're stored in <code>~/.ocr-studio</code>, never in the repository.</p>
      <div data-guard>${guardForm(guard, tpl)}</div>
    </div>

    <div class="card section">
      <h2 class="section-title">${icon('history', 16)} Reviews</h2>
      ${
        reviews.length
          ? reviews
              .map(
                (r) => `<a class="recent-item" href="#/review/${r.id}">
                  <div class="grow" style="min-width:0"><div class="ellipsis"><b>${esc(r.title)}</b> ${r.verifies ? '<span class="tag">verification</span>' : ''}</div>
                  <div class="faint" style="font-size:12px">${ago(r.createdAt)} · ${plural(r.fileCount, 'file')} · ${r.findingCount} findings · ${r.handled} handled${r.fixesApplied ? ` · ${r.fixesApplied} fixed` : ''}</div></div>
                  <div class="row" style="gap:4px">${r.needsYou ? `<span class="pill warn">${r.needsYou} need you</span>` : ''}${SEVS.filter((s) => r.openCounts[s]).map((s) => `<span class="sevdot ${s}">${r.openCounts[s]}</span>`).join('')}</div></a>`
              )
              .join('')
          : '<div class="muted">No reviews yet. Start one from the buttons above.</div>'
      }
    </div>`;
  const root = view.querySelector('[data-guard]');
  const save = bindGuardForm(root, info.repo);
  view.querySelector('[data-save]').addEventListener('click', async () => {
    try {
      await save();
      pageProject(repo);
    } catch (err) {
      toast(err.message, true);
    }
  });
}
