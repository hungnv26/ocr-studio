// OCR Studio shell: sidebar, project switcher, router and boot.

import { $, view, esc, api, icon, S, toast, restorePrefs, loadHealth, selectRepo, runCleanups, applyLook, pref, setPref } from './core.js';
import { loadHighlighter } from './highlight.js';
import { openRepoPicker } from './repo-picker.js';
import { pageDashboard } from './pages/dashboard.js';
import { pageNew } from './pages/start.js';
import { pageReview } from './pages/review.js';
import { pageHistory } from './pages/history.js';
import { pageProjects, pageProject } from './pages/projects.js';
import { pageRules } from './pages/rules.js';
import { pageSettings } from './pages/settings.js';

const NAV = [
  { href: '#/', icon: 'home', label: 'Home', match: (h) => h === '#/' || h === '' || h === '#/home' },
  { href: '#/new', icon: 'review', label: 'Review changes', hint: 'diff' },
  { href: '#/scan', icon: 'scan', label: 'Scan files', hint: 'audit' },
  { href: '#/projects', icon: 'project', label: 'Projects', match: (h) => h.startsWith('#/project') },
  { href: '#/history', icon: 'history', label: 'History', match: (h) => h.startsWith('#/history') || h.startsWith('#/review/') },
  { href: '#/rules', icon: 'rules', label: 'Review rules' },
  { href: '#/settings', icon: 'settings', label: 'Settings' },
];

function renderNav() {
  const h = location.hash || '#/';
  $('#nav').innerHTML = NAV.map((n) => `<a href="${n.href}" class="${(n.match ? n.match(h) : h.startsWith(n.href)) ? 'active' : ''}">${icon(n.icon, 17)}${n.label}${n.hint ? `<span class="hint">${n.hint}</span>` : ''}</a>`).join('');
}

let projects = [];
async function renderSwitcher() {
  try {
    projects = (await api('/api/projects')).projects;
  } catch {
    projects = [];
  }
  const cur = S.repo?.repo || S.lastRepo || '';
  const list = projects.some((p) => p.repo === cur) || !cur ? projects : [{ repo: cur, name: cur.split('/').pop() }, ...projects];
  $('#switcher').innerHTML = `<label class="nav-label" for="proj-select">Project</label>
    <div class="switch-row"><select id="proj-select" title="Current project">${cur ? '' : '<option value="" selected disabled>Choose a project…</option>'}${list
      .map((p) => `<option value="${esc(p.repo)}" ${p.repo === cur ? 'selected' : ''}>${esc(p.name)}</option>`)
      .join('')}<option value="__add">+ Add another…</option></select></div>`;
  $('#proj-select').addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v === '__add') {
      e.target.value = cur;
      return openRepoPicker(() => {
        renderSwitcher();
        route();
      });
    }
    try {
      await selectRepo(v);
      toast(`Switched to ${v.split('/').pop()}`);
      const h = location.hash;
      if (h.startsWith('#/project/')) location.hash = `#/project/${encodeURIComponent(v)}`;
      else if (!h.startsWith('#/review/')) route();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function renderLook() {
  const theme = pref('theme', 'auto');
  const next = { auto: 'light', light: 'dark', dark: 'auto' }[theme];
  $('#look').innerHTML = `<button class="btn small ghost" data-theme-next title="Theme: ${theme} (click for ${next})">${icon(theme === 'dark' ? 'moon' : 'sun', 14)} ${theme}</button>
    <button class="btn small ghost" data-density-toggle title="Toggle compact layout">${pref('density', 'comfortable') === 'compact' ? 'compact' : 'comfy'}</button>`;
  $('[data-theme-next]').onclick = () => {
    setPref('theme', next);
    applyLook();
    renderLook();
  };
  $("[data-density-toggle]").onclick = () => {
    setPref('density', pref('density', 'comfortable') === 'compact' ? 'comfortable' : 'compact');
    applyLook();
    renderLook();
  };
}

let routing = 0;
async function route() {
  const my = ++routing;
  runCleanups();
  renderNav();
  const h = location.hash || '#/';
  window.scrollTo(0, 0);
  try {
    if (h.startsWith('#/review/')) {
      const [, , id, fid] = h.split('/');
      return await pageReview(id, fid);
    }
    if (h.startsWith('#/new')) return await pageNew('diff');
    if (h.startsWith('#/scan')) return await pageNew('scan');
    if (h.startsWith('#/history')) return await pageHistory();
    if (h.startsWith('#/projects')) return await pageProjects();
    if (h.startsWith('#/project/')) return await pageProject(decodeURIComponent(h.slice('#/project/'.length)));
    if (h.startsWith('#/rules')) return await pageRules();
    if (h.startsWith('#/settings')) return await pageSettings();
    return await pageDashboard();
  } catch (err) {
    if (my === routing) view.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);
document.addEventListener('repo-changed', () => renderSwitcher());
// Close open dropdown menus when clicking elsewhere.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((d) => {
    if (!d.contains(e.target)) d.removeAttribute('open');
  });
});

applyLook();
restorePrefs();
renderLook();
Promise.all([loadHealth().catch((err) => toast(err.message, true)), loadHighlighter()])
  .then(async () => {
    if (!S.repo && S.lastRepo) await selectRepo(S.lastRepo).catch(() => {});
    renderSwitcher();
  })
  .finally(route);
