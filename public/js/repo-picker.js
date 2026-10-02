// Repository picker: recent repos, discovered repos, and a folder browser.

import { $, esc, api, toast, I, S, selectRepo } from './core.js';
import { renderNew, refreshPreview } from './pages/start.js';


export async function openRepoPicker(onChosen) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="card modal"><h2>Choose a repository</h2>
    <div class="row" style="margin-bottom:12px"><input id="rp-path" class="grow mono" placeholder="/path/to/repo or ~/Projects/app" /><button class="btn primary" id="rp-go">Open</button></div>
    <div id="rp-body"><div class="row muted"><span class="spinner"></span> Looking for git repositories…</div></div></div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', (e) => e.target === back && close());
  const choose = async (p) => {
    try {
      await selectRepo(p);
      close();
      if (typeof onChosen === 'function') return onChosen();
      S.preview = null;
      renderNew();
      refreshPreview();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#rp-go', back).addEventListener('click', () => choose($('#rp-path', back).value.trim()));
  $('#rp-path', back).addEventListener('keydown', (e) => e.key === 'Enter' && choose(e.target.value.trim()));
  $('#rp-path', back).focus();

  const item = (p, sub) => `<div class="repo-item" data-p="${esc(p)}">${I.git.replace('<svg', '<svg width="16" height="16"')}<div class="grow"><div>${esc(p.split('/').pop())}</div><div class="path mono ellipsis">${esc(sub || p)}</div></div></div>`;
  const showList = async () => {
    const { repos, recent } = await api('/api/repos/discover');
    const home = S.health?.home || '';
    const tilde = (p) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);
    $('#rp-body', back).innerHTML = `
      ${recent.length ? `<div class="nav-label" style="padding-left:2px">Recent</div><div class="repo-list">${recent.map((p) => item(p, tilde(p))).join('')}</div>` : ''}
      <div class="row" style="margin-top:8px"><div class="nav-label grow" style="padding-left:2px">Found on this Mac</div><button class="btn small" id="rp-browse">${I.folder} Browse folders…</button></div>
      <div class="repo-list">${repos.filter((p) => !recent.includes(p)).map((p) => item(p, tilde(p))).join('') || '<div class="faint">No repositories found under ~/Projects, ~/Developer or ~/Code.</div>'}</div>`;
    back.querySelectorAll('.repo-item').forEach((el) => el.addEventListener('click', () => choose(el.dataset.p)));
    $('#rp-browse', back).addEventListener('click', () => browse(S.health?.home));
  };
  const browse = async (dir) => {
    let d;
    try {
      d = await api(`/api/fs/list?path=${encodeURIComponent(dir || '')}`);
    } catch (err) {
      return toast(err.message, true);
    }
    $('#rp-body', back).innerHTML = `
      <div class="row" style="margin-bottom:8px">
        <button class="btn small" id="rp-up" ${d.parent ? '' : 'disabled'}>↑ Up</button>
        <span class="mono grow ellipsis faint">${esc(d.path)}</span>
        ${d.isRepo ? `<button class="btn small primary" id="rp-this">Use this repo</button>` : ''}
        <button class="btn small ghost" id="rp-back">Back</button>
      </div>
      <div class="repo-list">${d.dirs
        .map((x) => `<div class="repo-item" data-dir="${esc(x.path)}" data-repo="${x.isRepo ? 1 : ''}">${(x.isRepo ? I.git : I.folder).replace('<svg', '<svg width="16" height="16"')}<div class="grow">${esc(x.name)}</div>${x.isRepo ? '<span class="pill ok">git repo</span>' : ''}</div>`)
        .join('') || '<div class="faint">No sub-folders</div>'}</div>`;
    $('#rp-up', back).addEventListener('click', () => browse(d.parent));
    $('#rp-back', back).addEventListener('click', () => showList().catch((err) => toast(err.message, true)));
    $('#rp-this', back)?.addEventListener('click', () => choose(d.path));
    back.querySelectorAll('[data-dir]').forEach((el) => el.addEventListener('click', () => (el.dataset.repo ? choose(el.dataset.dir) : browse(el.dataset.dir))));
  };
  showList().catch((err) => ($('#rp-body', back).innerHTML = `<div class="banner bad">${esc(err.message)}</div>`));
}

