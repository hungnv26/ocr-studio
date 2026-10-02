// Setup & settings: tools, editor, appearance and review defaults.

import { $, view, api, esc, toast, I, icon, S, loadHealth, renderSideStatus, pref, setPref, applyLook } from '../core.js';

export async function pageSettings() {
  await loadHealth();
  if (!S.editors) S.editors = (await api('/api/editors').catch(() => ({ editors: [] }))).editors;
  const { tools: t, settings: s } = S.health;
  const status = (ok, text) => `<span class="pill ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} ${esc(text)}</span>`;
  view.innerHTML = `
    <div class="page-head"><div><h1>Setup &amp; settings</h1><p>OCR Studio drives two command-line tools for you. Both need to be available.</p></div>
      <div class="actions"><button class="btn" id="recheck">Re-check tools</button></div></div>

    <div class="card section">
      <h2 class="section-title">${icon('spark', 18)} Claude Code ${status(!!t.claude, t.claude ? t.claude.version : 'not found')}</h2>
      <p class="section-sub">Does the reviewing and fixing, using your existing Claude Code login. Reviews run read-only; “Fix with Claude” may edit only files in the reviewed repository.</p>
      <dl class="kv"><dt>Binary</dt><dd class="mono">${esc(t.claude?.path || '—')}</dd></dl>
      <div class="field" style="margin-top:12px"><label>Custom path (optional)</label>
        <div class="row"><input id="claudePath" class="grow mono" placeholder="Auto-detect" value="${esc(s.claudePath)}" /><button class="btn" id="save-claude">Save</button></div>
        <div class="help">Auto-detect checks the Claude desktop app's bundled CLI and your PATH, and skips binaries that cannot run on this Mac.</div></div>
    </div>

    <div class="card section">
      <h2 class="section-title">${icon('rules', 18)} Open Code Review CLI ${status(!!t.ocr, t.ocr ? t.ocr.version.split(' ')[1] : 'not installed')}</h2>
      <p class="section-sub">Picks which files to review and which rules apply. Installed locally inside OCR Studio — no global install needed.</p>
      <dl class="kv"><dt>Binary</dt><dd class="mono">${esc(t.ocr?.path || '—')}</dd><dt>Built-in agent</dt><dd>${t.ocrNative ? `${esc(t.ocrNative.provider)} / ${esc(t.ocrNative.model)}` : 'not configured (optional — only needed for the “OCR built-in agent” reviewer)'}</dd></dl>
      <div class="row" style="margin-top:12px"><button class="btn ${t.ocr ? '' : 'primary'}" id="install-ocr">${t.ocr ? 'Update OCR CLI' : 'Install OCR CLI'}</button><span id="install-out" class="muted"></span></div>
      ${t.ocrNative ? '' : `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">How to set up the OCR built-in agent (optional)</summary><p class="muted">Run this in a terminal and follow the prompts to pick a provider and paste an API key:</p><pre class="code">${esc(t.ocr?.path || 'ocr')} config provider</pre></details>`}
    </div>

    <div class="card section">
      <h2 class="section-title">${icon('git', 18)} Git ${status(!!t.git?.ok, t.git ? t.git.version : 'missing')}</h2>
      <p class="section-sub">Version 2.41 or newer is required by Open Code Review.</p>
    </div>

    <div class="card section">
      <h2 class="section-title">${icon('open', 18)} Editor</h2>
      <p class="section-sub">Where “Open” sends a file. “Automatic” uses Xcode for Swift/Objective-C and Android Studio or IntelliJ for Java/Kotlin when they're installed, otherwise your first editor.</p>
      <div class="row wrap"><select id="editor"><option value="auto">Automatic</option>${(S.editors || [])
        .map((e) => `<option value="${esc(e.id)}" ${s.editor === e.id ? 'selected' : ''}>${esc(e.name)}${e.cli ? '' : e.app ? ' (app)' : ''}</option>`)
        .join('')}</select><button class="btn" id="save-editor">Save</button><span class="faint">Detected: ${(S.editors || []).filter((e) => e.id !== 'system').map((e) => esc(e.name)).join(', ') || 'none'}</span></div>
    </div>

    <div class="card section">
      <h2 class="section-title">${icon('sun', 18)} Appearance</h2>
      <div class="row wrap" style="gap:24px">
        <div class="field"><label>Theme</label><div class="seg" id="theme">${['auto', 'light', 'dark'].map((x) => `<button data-v="${x}" class="${pref('theme', 'auto') === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div></div>
        <div class="field"><label>Density</label><div class="seg" id="density">${['comfortable', 'compact'].map((x) => `<button data-v="${x}" class="${pref('density', 'comfortable') === x ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div></div>
      </div>
    </div>

    <div class="card section">
      <h2 class="section-title">Review defaults</h2>
      <div class="grid2" style="margin-top:10px">
        <div class="field"><label>Parallel Claude runs</label><input id="concurrency" type="number" min="1" max="8" value="${s.concurrency}" /><div class="help">How many batches are reviewed at the same time (1–8).</div></div>
        <div class="field"><label>Files per batch</label><input id="filesPerBatch" type="number" min="1" max="12" value="${s.filesPerBatch}" /><div class="help">Smaller batches = more focused reviews, more Claude runs.</div></div>
      </div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="save-defaults">Save defaults</button>
        <button class="btn" id="notif">Enable desktop notifications</button></div>
    </div>`;
  const save = async (patch) => {
    try {
      const r = await api('/api/settings', { method: 'POST', body: patch });
      S.health.settings = r.settings;
      S.health.tools = r.tools;
      renderSideStatus();
      toast('Saved');
      pageSettings();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#save-editor').addEventListener('click', () => save({ editor: $('#editor').value }));
  $('#editor').value = s.editor || 'auto';
  view.querySelectorAll('#theme button, #density button').forEach((b) =>
    b.addEventListener('click', () => {
      setPref(b.parentElement.id, b.dataset.v);
      applyLook();
      pageSettings();
    })
  );
  $('#recheck').addEventListener('click', async () => {
    S.editors = null;
    await loadHealth(true);
    pageSettings();
    toast('Tools re-checked');
  });
  $('#save-claude').addEventListener('click', () => save({ claudePath: $('#claudePath').value.trim() }));
  $('#save-defaults').addEventListener('click', () => save({ concurrency: $('#concurrency').value, filesPerBatch: $('#filesPerBatch').value }));
  $('#notif').addEventListener('click', async () => {
    if (!('Notification' in window)) return toast('Notifications are not supported in this browser', true);
    const p = await Notification.requestPermission();
    toast(p === 'granted' ? 'You will be notified when a review finishes' : 'Notifications were not allowed');
  });
  $('#install-ocr').addEventListener('click', async (e) => {
    e.target.disabled = true;
    $('#install-out').innerHTML = '<span class="spinner"></span> Installing…';
    try {
      const r = await api('/api/tools/install-ocr', { method: 'POST' });
      S.health.tools = r.tools;
      renderSideStatus();
      toast(r.ok ? 'OCR CLI installed' : 'Install failed — see output', !r.ok);
      pageSettings();
    } catch (err) {
      e.target.disabled = false;
      $('#install-out').textContent = '';
      toast(err.message, true);
    }
  });
}

