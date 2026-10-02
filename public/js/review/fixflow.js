// Everything that changes code or a finding's state: the pre-fix dialog,
// the approval wizard, ignore-with-reason, questions, and Claude Code prompts.

import { api, esc, toast, icon, modal, confirmDialog, copyText, pref, setPref, plural } from '../core.js';
import { RV, needsYou } from './state.js';
import { renderPatch } from './render.js';

const reload = () => RV.reload?.();
const render = () => RV.render?.();

export function getFixMode() {
  return pref('fixmode', 'auto') === 'ask' ? 'ask' : 'auto';
}

async function sendFix(ids, mode, instructions) {
  await api(`/api/reviews/${RV.job.id}/fix`, { method: 'POST', body: { ids, mode, instructions } });
  for (const id of ids) {
    const f = RV.job.findings.find((x) => x.id === id);
    if (f) f.fix = { status: 'queued', log: [], instructions };
  }
  RV.connect?.();
  render();
}

// Quick path for one finding: same safety pipeline, no dialog.
export async function quickFix(id) {
  try {
    await sendFix([id], getFixMode(), '');
    toast('Claude is fixing it. A second run will double-check the change.');
  } catch (err) {
    toast(err.message, true);
  }
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
let dialogOpen = false;

export async function fixDialog(ids, opts = {}) {
  if (dialogOpen) return;
  dialogOpen = true;
  try {
    await fixDialogInner(ids, opts);
  } finally {
    dialogOpen = false;
  }
}

async function fixDialogInner(ids, { focusInstructions = false } = {}) {
  const j = RV.job;
  const items = ids.map((id) => j.findings.find((f) => f.id === id)).filter(Boolean);
  if (!items.length) return;
  const files = new Set(items.map((f) => f.path));
  let git = null;
  try {
    git = await api('/api/git/status', { method: 'POST', body: { repo: j.repo } });
  } catch {}
  const mainish = git && ['main', 'master', 'develop', 'trunk'].includes(git.branch);
  const branchName = `ocr-fixes/${today()}`;
  const g = RV.guard || {};
  const mode = getFixMode();

  const result = await modal(
    () => `<h2>${icon('wand', 18)} Fix ${plural(items.length, 'finding')} in ${plural(files.size, 'file')}</h2>
      <div class="modal-body">
        <ul class="fix-list">${items
          .slice(0, 6)
          .map((f) => `<li><span class="pill sev ${f.severity}">${f.severity}</span> ${esc(f.title)} <span class="faint mono">${esc(f.path)}:${f.start_line}</span></li>`)
          .join('')}${items.length > 6 ? `<li class="faint">…and ${items.length - 6} more</li>` : ''}</ul>

        <div class="field" style="margin-top:14px"><label>How should changes be applied?</label>
          <div class="seg" data-mode>
            <button data-v="auto" class="${mode === 'auto' ? 'on' : ''}">Auto-apply safe<small>a second Claude run checks each change; risky ones wait</small></button>
            <button data-v="ask" class="${mode === 'ask' ? 'on' : ''}">Ask me first<small>every change waits for your approval</small></button>
          </div></div>

        <div class="field" style="margin-top:14px"><label>Instructions for Claude <span class="faint">(optional, for all of these)</span></label>
          <textarea data-instr rows="${focusInstructions ? 4 : 2}" placeholder="e.g. Keep the public API unchanged. Prefer guard clauses. Don't touch logging.">${esc(RV.drafts.__instr || '')}</textarea></div>

        ${
          git
            ? `<div class="git-box">
                <div class="row wrap">${icon('branch', 14)} <b>${esc(git.branch)}</b>
                  ${git.dirty ? `<span class="pill warn">${plural(git.dirty, 'uncommitted change')}</span>` : '<span class="pill ok">clean</span>'}</div>
                ${
                  git.dirty
                    ? `<div class="muted" style="margin:6px 0">Fixes will mix with your uncommitted work. “Undo whole batch” still restores files exactly, but committing first keeps history clean.</div>
                       <div class="row"><input data-cmsg class="grow" placeholder="Commit message" value="Work in progress before OCR fixes" /><button class="btn small" data-commit>Commit everything now</button></div>`
                    : ''
                }
                <label class="row" style="margin-top:8px;gap:8px"><input type="checkbox" data-branch ${mainish ? 'checked' : ''} /> Work on a new branch <input data-bname class="mono" value="${esc(branchName)}" style="width:220px" /></label>
              </div>`
            : ''
        }
        <div class="muted" style="margin-top:12px;font-size:12.5px">${icon('shield', 13)} ${
          g.protected?.length || g.notes ? `Guardrails on: ${g.protected?.length || 0} protected path(s)${g.checkCommand ? ', check command after the batch' : ''}.` : 'No guardrails for this project yet.'
        } Every touched file is backed up first, so you can undo the whole batch.</div>
      </div>
      <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-go>${icon('wand', 14)} Start fixing</button></div>`,
    (root, close) => {
      let m = mode;
      root.querySelectorAll('[data-mode] button').forEach((b) =>
        b.addEventListener('click', () => {
          m = b.dataset.v;
          root.querySelectorAll('[data-mode] button').forEach((x) => x.classList.toggle('on', x === b));
        })
      );
      const instr = root.querySelector('[data-instr]');
      if (focusInstructions) setTimeout(() => instr.focus(), 0);
      root.querySelector('[data-x]').addEventListener('click', () => close(null));
      root.querySelector('[data-commit]')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const r = await api('/api/git/commit', { method: 'POST', body: { repo: j.repo, message: root.querySelector('[data-cmsg]').value } });
          toast(`Committed ${r.commit}`);
          e.target.closest('.git-box').querySelector('.pill.warn')?.replaceWith(Object.assign(document.createElement('span'), { className: 'pill ok', textContent: 'committed' }));
          e.target.parentElement.remove();
        } catch (err) {
          toast(err.message, true);
          e.target.disabled = false;
        }
      });
      root.querySelector('[data-go]').addEventListener('click', () =>
        close({ mode: m, instructions: instr.value.trim(), branch: root.querySelector('[data-branch]')?.checked ? root.querySelector('[data-bname]').value.trim() : null })
      );
    }
  );
  if (!result) return;
  setPref('fixmode', result.mode);
  RV.drafts.__instr = '';
  try {
    if (result.branch && result.branch !== git?.branch) {
      await api('/api/git/branch', { method: 'POST', body: { repo: j.repo, name: result.branch } });
      toast(`Switched to new branch ${result.branch}`);
    }
    await sendFix(ids, result.mode, result.instructions);
    RV.picked.clear();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

// Steps through every change waiting for a decision, like `git add -p`.
export async function proposalWizard(startId) {
  const queue = RV.job.findings.filter(needsYou).map((f) => f.id);
  if (!queue.length) return toast('Nothing is waiting for your approval');
  let i = Math.max(0, queue.indexOf(startId));
  let decided = 0;
  await modal(
    () => `<div data-wiz></div>`,
    (root, close) => {
      const show = () => {
        const f = RV.job.findings.find((x) => x.id === queue[i]);
        if (!f) return close();
        const v = f.fix?.verdict;
        const done = !needsYou(f);
        root.querySelector('[data-wiz]').innerHTML = `
          <div class="row wrap" style="margin-bottom:6px"><b class="muted">Change ${i + 1} of ${queue.length}</b><span class="grow"></span><span class="faint">${decided} decided · keys: a apply · d discard · → skip · ← back · esc close</span></div>
          <div class="progress"><div style="width:${Math.round(((i + 1) / queue.length) * 100)}%"></div></div>
          <h2 style="margin-top:14px">${esc(f.title)}</h2>
          <div class="row wrap" style="margin-bottom:8px"><span class="pill sev ${f.severity}">${f.severity}</span><span class="tag">${esc(f.category)}</span><span class="mono faint">${esc(f.path)}:${f.start_line}</span>
            ${f.fix?.status === 'rejected' ? '<span class="pill bad">rejected by the checker</span>' : f.fix?.status === 'proposed' ? '<span class="pill warn">needs approval</span>' : `<span class="pill">${esc(f.fix?.status || 'decided')}</span>`}</div>
          ${v ? `<div class="verdict ${v.verdict}"><b>${v.verdict === 'wrong' ? 'Why it was rejected' : v.verdict === 'risky' ? 'Why it needs a look' : 'Checker'}:</b> ${esc(v.reason)}</div>` : '<div class="muted">You chose “Ask me first”, so this waits for you.</div>'}
          ${f.fix?.instructions ? `<div class="muted" style="margin-top:6px">Your instructions: ${esc(f.fix.instructions)}</div>` : ''}
          ${f.fix?.diff ? renderPatch(f.fix.diff, f.path) : ''}
          <div class="modal-actions">
            <button class="btn ghost" data-prev ${i === 0 ? 'disabled' : ''}>← Back</button>
            <span class="grow"></span>
            ${done ? '<span class="muted">Already decided</span>' : `<button class="btn" data-discard>Discard</button><button class="btn ${f.fix?.status === 'rejected' ? '' : 'primary'}" data-apply>${f.fix?.status === 'rejected' ? 'Apply anyway' : `${icon('check', 14)} Apply`}</button>`}
            <button class="btn ghost" data-next>${i === queue.length - 1 ? 'Finish' : 'Skip →'}</button>
          </div>`;
        const act = async (kind) => {
          try {
            const r = await api(`/api/reviews/${RV.job.id}/findings/${f.id}/${kind}`, { method: 'POST' });
            Object.assign(f, r);
            if (kind === 'discard') f.fix = null;
            decided++;
            next();
          } catch (err) {
            toast(err.message, true);
          }
        };
        root.querySelector('[data-apply]')?.addEventListener('click', () => act('apply'));
        root.querySelector('[data-discard]')?.addEventListener('click', () => act('discard'));
        root.querySelector('[data-prev]').addEventListener('click', () => {
          i = Math.max(0, i - 1);
          show();
        });
        root.querySelector('[data-next]').addEventListener('click', next);
        root.wizKeys = { a: () => !done && act('apply'), d: () => !done && act('discard'), ArrowRight: next, ArrowLeft: () => i > 0 && (i--, show()) };
      };
      const next = () => {
        if (i >= queue.length - 1) return close();
        i++;
        show();
      };
      root.addEventListener('keydown', (e) => {
        const fn = root.wizKeys?.[e.key];
        if (fn && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          fn();
        }
      });
      root.tabIndex = -1;
      show();
      setTimeout(() => root.focus(), 0);
    },
    { wide: true }
  );
  await reload();
  if (decided) toast(`${plural(decided, 'change')} decided`);
}

const QUICK_REASONS = ['Intentional, by design', 'False positive', 'Handled elsewhere', "Won't fix"];

export async function ignoreDialog(ids) {
  const items = ids.map((id) => RV.job.findings.find((f) => f.id === id)).filter(Boolean);
  if (!items.length) return;
  const res = await modal(
    () => `<h2>Ignore ${items.length === 1 ? 'this finding' : plural(items.length, 'finding')}</h2>
      <div class="modal-body">
        ${items.length === 1 ? `<div class="muted" style="margin-bottom:8px">${esc(items[0].title)}</div>` : ''}
        <label>Why isn't it a problem? <span class="faint">(optional)</span></label>
        <div class="chips" style="margin:6px 0">${QUICK_REASONS.map((r) => `<button class="chip" data-r="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        <textarea data-v rows="3" placeholder="e.g. This is a public client key by design; the real secret is injected at deploy time."></textarea>
        <label class="row" style="margin-top:10px;gap:8px"><input type="checkbox" data-remember checked /> Remember this: future reviews of this project won't report it again</label>
      </div>
      <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Ignore</button></div>`,
    (root, close) => {
      const ta = root.querySelector('[data-v]');
      root.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => (ta.value = ta.value ? `${ta.value} ${b.dataset.r}` : b.dataset.r)));
      root.querySelector('[data-x]').addEventListener('click', () => close(null));
      const ok = () => close({ reason: ta.value.trim(), remember: root.querySelector('[data-remember]').checked });
      root.querySelector('[data-ok]').addEventListener('click', ok);
      ta.addEventListener('keydown', (e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && ok());
      setTimeout(() => ta.focus(), 0);
    }
  );
  if (!res) return false;
  for (const f of items) {
    try {
      const r = await api(`/api/reviews/${RV.job.id}/findings/${f.id}/ignore`, { method: 'POST', body: { reason: res.reason, remember: res.remember && !!res.reason } });
      Object.assign(f, r);
    } catch (err) {
      toast(err.message, true);
    }
  }
  toast(res.remember && res.reason ? 'Ignored and remembered for future reviews' : 'Ignored');
  return true;
}

export async function markMany(ids, mark) {
  await api(`/api/reviews/${RV.job.id}/mark`, { method: 'POST', body: { ids, mark } });
  for (const f of RV.job.findings) if (ids.includes(f.id)) f.mark = mark;
}

export async function ask(f, question) {
  try {
    const entry = await api(`/api/reviews/${RV.job.id}/findings/${f.id}/ask`, { method: 'POST', body: { question } });
    f.thread = [...(f.thread || []), entry];
    RV.connect?.();
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

export function claudePrompt(findings) {
  const j = RV.job;
  const g = RV.guard || {};
  const body = findings
    .map(
      (f, i) => `${findings.length > 1 ? `## ${i + 1}. ` : ''}${f.title}
File: ${f.path}:${f.start_line}${f.end_line !== f.start_line ? `-${f.end_line}` : ''} (${f.severity}, ${f.category})

${f.content}${f.suggestion_code ? `\n\nReviewer's suggested change (may be wrong):\n\`\`\`\n${f.suggestion_code}\n\`\`\`` : ''}`
    )
    .join('\n\n');
  return `Fix ${findings.length === 1 ? 'this code review finding' : `these ${findings.length} code review findings`} in ${j.repo}.

${body}

Before editing, read the surrounding code and comments and check callers. Make the smallest change that fixes the problem; if a finding is wrong, say so instead of changing code.${
    g.protected?.length ? `\nDo not edit these paths: ${g.protected.join(', ')}.` : ''
  }${g.notes ? `\n\nProject notes:\n${g.notes}` : ''}`;
}

export function copyForClaude(findings) {
  copyText(claudePrompt(findings), `Prompt for ${plural(findings.length, 'finding')} copied. Paste it into Claude Code.`);
}

export async function undoFix(f) {
  try {
    const r = await api(`/api/reviews/${RV.job.id}/findings/${f.id}/revert`, { method: 'POST' });
    Object.assign(f, r);
    toast('Fix undone');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

export async function decide(f, kind) {
  try {
    await api(`/api/reviews/${RV.job.id}/findings/${f.id}/${kind}`, { method: 'POST' });
    toast(kind === 'apply' ? 'Change applied' : 'Discarded');
    await reload();
  } catch (err) {
    toast(err.message, true);
  }
}

export async function undoBatch(roundId) {
  const ok = await confirmDialog({
    title: 'Undo the whole batch?',
    body: 'Every file this batch touched goes back to exactly how it was before the batch. Edits you made to those files since then are lost too.',
    ok: 'Undo batch',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api(`/api/reviews/${RV.job.id}/rounds/${roundId}/undo`, { method: 'POST' });
    toast(`Restored ${plural(r.restored, 'file')}`);
    RV.changes = null;
    await reload();
  } catch (err) {
    toast(err.message, true);
  }
}
