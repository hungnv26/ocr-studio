// Guardrails editor: protected paths, notes, check command, learned
// dismissals and project defaults. Used inline (project page) and as a modal.

import { $, api, esc, toast, ago, icon, modal, MODELS, EFFORTS } from './core.js';

let templatesCache = null;
async function templates() {
  if (!templatesCache) templatesCache = (await api('/api/guard/templates')).templates;
  return templatesCache;
}

export function guardForm(g, tpl) {
  const learned = g.learned || [];
  return `<div class="guard-form">
    <div class="guard-row">
      <div class="field grow"><label>${icon('shield', 13)} Never edit these paths</label>
        <textarea data-g="protected" rows="6" class="mono" placeholder="src/net/socket.ts&#10;**/auth/**&#10;deploy/&#10;*.xcconfig">${esc((g.protected || []).join('\n'))}</textarea>
        <div class="help">One gitignore-style pattern per line. Claude won't fix findings in these files; you still can, by hand.</div>
      </div>
      <div class="guard-side">
        <div class="field"><label>Start from a template</label>
          <select data-g="template"><option value="">Choose…</option>${Object.entries(tpl)
            .map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`)
            .join('')}</select>
          <div class="help">Adds its paths and notes to yours.</div></div>
        <button class="btn small" data-g="suggest" style="margin-top:10px">${icon('spark', 13)} Suggest from this repo</button>
        <div data-g="suggestions"></div>
      </div>
    </div>

    <div class="field" style="margin-top:14px"><label>Things the reviewer and fixer must know</label>
      <textarea data-g="notes" rows="5" placeholder="e.g. The key in src/config/client.ts is a public client key, not a secret.&#10;Production builds only talk to api.example.com.">${esc(g.notes || '')}</textarea>
      <div class="help">The reviewer won't flag what you call intentional; the fixer and the checker follow these as rules.</div></div>

    <div class="guard-row" style="margin-top:14px">
      <div class="field grow"><label>Check command after each batch of fixes</label>
        <input data-g="check" class="mono" placeholder="e.g. npm test   or   ./gradlew :app:compileDebugJavaWithJavac" value="${esc(g.checkCommand || '')}" />
        <div class="help">Runs in the repo with your shell. If it fails you get the output and an “Undo whole batch” button.</div></div>
      <div class="field"><label>Default reviewer for this project</label>
        <div class="row">
          <select data-g="model"><option value="">Model: app default</option>${MODELS.map((m) => `<option value="${m.id}" ${g.defaults?.model === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
          <select data-g="effort"><option value="">Effort: default</option>${EFFORTS.map((x) => `<option value="${x}" ${g.defaults?.effort === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
        </div></div>
    </div>

    <div class="field" style="margin-top:16px"><label>Dismissed as “not a bug” (${learned.length})</label>
      ${
        learned.length
          ? `<div class="learned">${learned
              .map(
                (l, i) => `<div class="learned-item"><div class="grow"><b>${esc(l.title)}</b> <span class="faint mono">${esc(l.path)}</span><div class="muted">${esc(l.reason)}</div></div>
                  <span class="faint" style="white-space:nowrap">${ago(l.at)}</span><button class="btn small ghost" data-unlearn="${i}" data-path="${esc(l.path)}" data-title="${esc(l.title)}" title="Let the reviewer report this again">Forget</button></div>`
              )
              .join('')}</div>`
          : '<div class="help">When you ignore a finding with a reason and “remember”, it shows up here and future reviews stop reporting it.</div>'
      }
    </div>
  </div>`;
}

export function bindGuardForm(root, repo) {
  const val = (k) => $(`[data-g="${k}"]`, root);
  const merge = (lines, add) => [...new Set([...lines.split('\n').map((s) => s.trim()).filter(Boolean), ...add])].join('\n');
  val('template').addEventListener('change', async (e) => {
    let t;
    try {
      t = (await templates())[e.target.value];
    } catch (err) {
      e.target.value = '';
      return toast(err.message, true);
    }
    if (!t) return;
    val('protected').value = merge(val('protected').value, t.protected);
    val('notes').value = [val('notes').value.trim(), t.notes].filter(Boolean).join('\n');
    e.target.value = '';
    toast(`Added the ${t.label} template. Review it, then save.`);
  });
  val('suggest').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    val('suggestions').innerHTML = '<div class="muted" style="margin-top:8px"><span class="spinner"></span> Looking for sensitive files…</div>';
    try {
      const { suggestions } = await api('/api/guard/suggest', { method: 'POST', body: { repo } });
      val('suggestions').innerHTML = suggestions.length
        ? `<div class="suggest-list">${suggestions
            .map((s, i) => `<label class="suggest-item" title="${esc(s.reason)}"><input type="checkbox" data-sug="${i}" /> <span class="mono ellipsis">${esc(s.pattern)}</span><span class="faint">${esc(s.reason)}</span></label>`)
            .join('')}</div><button class="btn small" data-g="add-sug" style="margin-top:6px">Add selected</button>`
        : '<div class="help" style="margin-top:8px">Nothing obviously sensitive found that isn’t already protected.</div>';
      $('[data-g="add-sug"]', root)?.addEventListener('click', () => {
        const picked = [...root.querySelectorAll('[data-sug]:checked')].map((c) => suggestions[Number(c.dataset.sug)].pattern);
        val('protected').value = merge(val('protected').value, picked);
        val('suggestions').innerHTML = `<div class="help" style="margin-top:8px">Added ${picked.length}. Save to apply.</div>`;
      });
    } catch (err) {
      val('suggestions').innerHTML = `<div class="banner bad" style="margin-top:8px">${esc(err.message)}</div>`;
    }
    btn.disabled = false;
  });
  // Forgetting updates the list in place so unsaved edits elsewhere in the
  // form survive; items are identified by path and title, not position.
  root.querySelectorAll('[data-unlearn]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/api/guard/learned/remove', { method: 'POST', body: { repo, path: b.dataset.path, title: b.dataset.title } });
        const item = b.closest('.learned-item');
        const list = item.parentElement;
        item.remove();
        if (!list.children.length) list.outerHTML = '<div class="help">Nothing dismissed any more.</div>';
        toast('Forgotten. The reviewer may report it again.');
      } catch (err) {
        b.disabled = false;
        toast(err.message, true);
      }
    })
  );
  return async function save() {
    const saved = await api('/api/guard', {
      method: 'POST',
      body: {
        repo,
        save: true,
        notes: val('notes').value,
        protected: val('protected').value.split('\n'),
        checkCommand: val('check').value,
        defaults: { model: val('model').value, effort: val('effort').value },
      },
    });
    toast('Guardrails saved');
    return saved;
  };
}

export async function openGuardrails(repo, onSaved) {
  let g, tpl;
  try {
    [g, tpl] = await Promise.all([api('/api/guard', { method: 'POST', body: { repo } }), templates()]);
  } catch (err) {
    return toast(err.message, true);
  }
  await modal(
    () => `<h2>${icon('shield', 18)} Guardrails for ${esc(repo.split('/').pop())}</h2>
      <p class="muted" style="margin-top:-4px">Rules for every review and fix in this project. Stored in <code>~/.ocr-studio</code>, never in your repository. <a href="#/project/${encodeURIComponent(repo)}" data-x>Open project page</a></p>
      ${guardForm(g, tpl)}
      <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-save>Save guardrails</button></div>`,
    (root, close) => {
      const save = bindGuardForm(root, repo);
      root.querySelectorAll('[data-x]').forEach((b) => b.addEventListener('click', () => close()));
      root.querySelector('[data-save]').addEventListener('click', async () => {
        try {
          await save();
          close();
          onSaved?.();
        } catch (err) {
          toast(err.message, true);
        }
      });
    },
    { wide: true }
  );
}
