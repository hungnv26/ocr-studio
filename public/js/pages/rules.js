// Review rules: which OCR checklist applies to a file.

import { $, view, api, esc, toast, I, icon, md, S, selectRepo, loadHealth, renderSideStatus, pref, setPref, applyLook } from '../core.js';
import { openRepoPicker } from '../repo-picker.js';

export async function pageRules() {
  if (!S.repo && S.lastRepo) {
    try {
      await selectRepo(S.lastRepo);
    } catch {}
  }
  view.innerHTML = `
    <div class="page-head"><div><h1>Review rules</h1><p>See which Open Code Review checklist applies to a file. Reviewers get these rules for every file in a batch.</p></div></div>
    <div class="card section">
      <div class="field"><label>Repository</label><div class="row"><span class="mono grow ellipsis">${esc(S.repo?.repo || 'none selected')}</span><button class="btn small" id="pick">${I.folder} Change</button></div></div>
      <div class="field" style="margin-top:12px"><label>File paths (comma separated, repo-relative)</label>
        <div class="row"><input id="paths" class="grow mono" placeholder="src/server.ts, app/models/user.py" value="${esc(S.rulesPaths || '')}" /><button class="btn primary" id="check">Check rules</button></div>
        <div class="help">Customize rules by adding <code>.opencodereview/rule.json</code> to the repository — see the <a href="https://open-codereview.ai/docs/review-rules" target="_blank" rel="noreferrer">rules docs</a>.</div>
      </div>
    </div>
    <div id="rules-out"></div>`;
  $('#pick').addEventListener('click', () => openRepoPicker(pageRules));
  const check = async () => {
    S.rulesPaths = $('#paths').value;
    const out = $('#rules-out');
    out.innerHTML = '<div class="row muted"><span class="spinner"></span> Resolving…</div>';
    try {
      const r = await api('/api/rules', { method: 'POST', body: { repo: S.repo?.repo, paths: S.rulesPaths.split(',').map((s) => s.trim()).filter(Boolean) } });
      out.innerHTML =
        (r.customRuleFile ? `<div class="banner info">This repo has its own rules in <code>${esc(r.customRuleFile)}</code>.</div>` : '') +
        r.groups
          .map(
            (g) => `<div class="card section"><div class="row wrap" style="margin-bottom:8px"><span class="pill">${esc(g.source)}</span><code>${esc(g.pattern)}</code><span class="muted">${g.files.map(esc).join(', ')}</span></div><div class="md">${md(g.rule.replace(/^#### (.*)$/gm, '**$1**'))}</div></div>`
          )
          .join('');
    } catch (err) {
      out.innerHTML = `<div class="banner bad">${esc(err.message)}</div>`;
    }
  };
  $('#check').addEventListener('click', check);
  $('#paths').addEventListener('keydown', (e) => e.key === 'Enter' && check());
}

