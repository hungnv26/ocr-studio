// Secondary review tabs: Changes, Files, Activity, Compare and Code.

import { api, esc, icon, SEVS, plural, money, dur, clock, toast } from '../core.js';
import { highlightLines } from '../highlight.js';
import { RV } from './state.js';
import { renderPatch } from './render.js';

const render = () => RV.render?.();

// ------------------------------------------------------------------ changes

export function renderChangesTab() {
  const c = RV.changes;
  if (!c) {
    loadChanges();
    return `<div class="row muted"><span class="spinner"></span> Collecting what the fixes changed…</div>`;
  }
  if (c.error) return `<div class="banner bad">${esc(c.error)}</div>`;
  if (!c.files.length && !c.legacy.length)
    return `<div class="empty"><div class="big">🧾</div><b>No changes from fixes yet.</b><div>When Claude fixes findings, every changed line shows up here. You can undo single changes and commit them.</div></div>`;
  if (!c.files.length) {
    return `<div class="banner info">These fixes were applied before change tracking existed, so you see each fix's own patch. Undo works per fix while the lines are unchanged since.</div>
      ${c.legacy
        .map((l) => `<div class="card change-file"><div class="change-head"><b class="mono">${esc(l.path)}</b><span class="muted ellipsis">${esc(l.title)}</span><span class="grow"></span><button class="btn small" data-legacy-undo="${l.id}">${icon('undo', 13)} Undo fix</button></div>${renderPatch(l.patch, l.path)}</div>`)
        .join('')}`;
  }
  const added = c.files.reduce((a, f) => a + f.added, 0);
  const removed = c.files.reduce((a, f) => a + f.removed, 0);
  const pending = c.files.filter((f) => !f.committed);
  const fixed = pending.flatMap((f) => f.findings);
  const msg =
    RV.drafts.__commit ??
    `Fix ${plural(fixed.length, 'issue')} found by OCR Studio\n\n${fixed
      .slice(0, 30)
      .map((f) => `- ${f.title}`)
      .join('\n')}${fixed.length > 30 ? `\n- …and ${fixed.length - 30} more` : ''}`;
  const commits = RV.job.commits || [];
  const commitUi = pending.length
    ? `<textarea data-keep="commit-msg" data-commitmsg rows="4" class="mono">${esc(msg)}</textarea>
      <div class="row wrap" style="margin-top:8px">
        <span class="muted">Commits only the ${plural(pending.length, 'uncommitted file')} below; other changes in your working tree stay uncommitted.</span><span class="grow"></span>
        <button class="btn primary" data-act-global="commit">${icon('commit', 14)} Commit fixes</button>
      </div>`
    : `<div class="banner info" style="margin:0">${icon('check', 14)} Everything here is committed.</div>`;
  return `<div class="card section commit-box">
      <div class="row wrap"><b>${plural(c.files.length, 'file')} changed by fixes</b><span class="add">+${added}</span><span class="del">−${removed}</span>
        ${c.git ? `<span class="pill">${icon('branch', 12)} ${esc(c.git.branch)}</span>` : ''}
        <span class="grow"></span><button class="btn small ghost" data-act-global="refresh-changes">Refresh</button><a class="btn small ghost" href="javascript:void 0" data-export="patch">${icon('download', 13)} .patch</a></div>
      <p class="muted" style="margin:6px 0 10px">Compared with each file as it was before Claude's first fix. Undo any single change below, then commit what you keep.</p>
      ${commitUi}
      ${commits.length ? `<div class="faint" style="margin-top:8px">Committed from here: ${commits.map((x) => `<code>${esc(x.commit)}</code> ${esc(x.message)}`).join(' · ')}</div>` : ''}
    </div>
    ${c.files
      .map(
        (f) => `<div class="card change-file">
          <div class="change-head"><b class="mono">${esc(f.path)}</b><span class="add">+${f.added}</span><span class="del">−${f.removed}</span>${f.committed ? '<span class="pill ok">committed</span>' : '<span class="pill warn">uncommitted</span>'}
            ${f.findings.length ? `<span class="muted ellipsis" title="${esc(f.findings.map((x) => x.title).join('\n'))}">fixes ${plural(f.findings.length, 'finding')}</span>` : '<span class="muted">changed after the fixes</span>'}
            <span class="grow"></span><button class="btn small ghost" data-open-file="${esc(f.path)}">${icon('open', 13)} Open</button></div>
          ${renderPatch(f.patch, f.path, { hunkActions: (i) => `<button class="hunk-undo" data-hunk-undo="${esc(f.path)}" data-hunk="${i}" title="Undo just this change">${icon('undo', 12)} undo</button>` })}
        </div>`
      )
      .join('')}`;
}

export async function loadChanges() {
  if (RV._loadingChanges) return;
  RV._loadingChanges = true;
  const jobId = RV.job.id;
  let result;
  try {
    const [c, git] = await Promise.all([api(`/api/reviews/${jobId}/changes`), api('/api/git/status', { method: 'POST', body: { repo: RV.job.repo } }).catch(() => null)]);
    result = { ...c, git };
  } catch (err) {
    result = { error: err.message, files: [], legacy: [] };
  }
  RV._loadingChanges = false;
  if (RV.job?.id === jobId) RV.changes = result;
  if (RV.tab === 'changes') render();
}

export async function undoHunk(path, hunk) {
  try {
    const r = await api(`/api/reviews/${RV.job.id}/changes/revert`, { method: 'POST', body: { path, hunk } });
    toast(r.reopened?.length ? `Change undone; ${r.reopened.length === 1 ? 'its finding is' : `${r.reopened.length} findings are`} open again` : 'Change undone');
    RV.changes = null;
    await RV.reload?.();
  } catch (err) {
    toast(err.message, true);
  }
}

export async function commitChanges(message) {
  const paths = RV.changes?.files.filter((f) => !f.committed).map((f) => f.path) || [];
  try {
    const r = await api(`/api/reviews/${RV.job.id}/commit`, { method: 'POST', body: { message, paths } });
    toast(`Committed ${r.commit}`);
    RV.drafts.__commit = undefined;
    RV.changes = null;
    await RV.reload?.();
  } catch (err) {
    toast(err.message, true);
  }
}

// ------------------------------------------------------------------ files

export function renderFilesTab() {
  const j = RV.job;
  const ruleOf = new Map();
  for (const b of j.batches || []) for (const p of b.files) ruleOf.set(p, { pattern: b.pattern, batch: b.id });
  const rows = j.files.map((f) => {
    const fs_ = j.findings.filter((x) => x.path === f.path);
    return { f, counts: SEVS.map((s) => fs_.filter((x) => x.severity === s).length), open: fs_.filter((x) => x.mark === 'open').length, total: fs_.length, rule: ruleOf.get(f.path) };
  });
  const { key, dir } = RV.fileSort;
  const val = (r) => (key === 'path' ? r.f.path : key === 'state' ? r.f.state : key === 'total' ? r.total : key === 'sev' ? r.counts[0] * 1000 + r.counts[1] * 100 + r.counts[2] * 10 + r.counts[3] : r.open);
  rows.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : a.f.path.localeCompare(b.f.path)) * dir);
  const th = (k, label) => `<th data-fsort="${k}" class="${key === k ? 'sorted' : ''}">${label}${key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  const states = { reviewed: 0, skipped: 0, failed: 0 };
  for (const f of j.files) if (states[f.state] != null) states[f.state]++;
  const excluded = j.excluded || [];
  return `<div class="row wrap" style="margin-bottom:10px"><span class="pill ok">${states.reviewed} reviewed</span>${states.skipped ? `<span class="pill">${states.skipped} skipped</span>` : ''}${states.failed ? `<span class="pill bad">${states.failed} failed</span>` : ''}${excluded.length ? `<span class="pill">${excluded.length} excluded by OCR</span>` : ''}<span class="faint">Click a row to see its findings.</span></div>
    <div class="card table-wrap"><table class="table">
      <thead><tr>${th('path', 'File')}${th('state', 'Status')}${th('sev', 'Findings')}${th('open', 'Open')}<th>Rule / batch</th><th>Reviewer's note</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr data-file-row="${esc(r.f.path)}">
            <td class="mono">${esc(r.f.path)}</td>
            <td><span class="pill ${r.f.state === 'reviewed' ? 'ok' : r.f.state === 'failed' ? 'bad' : r.f.state === 'reviewing' ? 'run' : ''}">${esc(r.f.state)}</span></td>
            <td>${r.counts.map((n, i) => (n ? `<span class="sevdot ${SEVS[i]}">${n}</span>` : '')).join('') || '<span class="faint">none</span>'}</td>
            <td>${r.open || ''}</td>
            <td class="faint mono">${r.rule ? `${esc(r.rule.pattern)} · #${r.rule.batch}` : ''}</td>
            <td class="muted">${esc(r.f.reason || '')}</td></tr>`
        )
        .join('')}</tbody></table></div>
    ${
      excluded.length
        ? `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">${plural(excluded.length, 'file')} OCR excluded before review</summary><div class="card table-wrap" style="margin-top:8px"><table class="table"><tbody>${excluded
            .map((f) => `<tr><td class="mono">${esc(f.path)}</td><td class="muted">${esc(String(f.reason).replace(/_/g, ' '))}</td></tr>`)
            .join('')}</tbody></table></div></details>`
        : ''
    }`;
}

// ------------------------------------------------------------------ activity

const kindOf = (t) => (/^Reading/.test(t) ? 'reads' : /^Searching/.test(t) ? 'searches' : /^Listing/.test(t) ? 'listings' : null);

export function renderActivityTab() {
  const j = RV.job;
  const batches = j.batches || [];
  const cards = batches.length
    ? `<div class="batch-cards">${batches
        .map((b) => {
          const last = b.activity?.[b.activity.length - 1];
          const n = j.findings.filter((f) => f.batch === b.id).length;
          const counts = {};
          for (const a of b.activity || []) {
            const k = kindOf(a.text);
            if (k) counts[k] = (counts[k] || 0) + 1;
          }
          const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ');
          const st = { queued: '<span class="pill">waiting</span>', running: '<span class="pill run"><i class="dot run"></i> reviewing</span>', done: `<span class="pill ok">✓ ${plural(n, 'finding')}</span>`, failed: '<span class="pill bad">failed</span>', cancelled: '<span class="pill warn">stopped</span>' }[b.state] || '';
          return `<div class="batch"><div class="row"><b>Batch ${b.id}</b><span class="grow"></span>${st}</div>
            <div class="files-mini ellipsis" title="${esc(b.files.join(', '))}">${esc(b.files.map((p) => p.split('/').pop()).join(', '))}</div>
            <div class="faint mono ellipsis" style="font-size:11px">rule: ${esc(b.pattern)}</div>
            ${summary ? `<div class="faint" style="margin-top:4px">${summary}</div>` : ''}
            ${b.state === 'running' && last ? `<div class="now"><span class="spinner"></span><span class="ellipsis">${esc(last.text)}</span></div>` : ''}
            ${b.state === 'done' && b.durationMs ? `<div class="faint" style="margin-top:4px">${dur(b.durationMs)} · ${b.turns || 0} turns · ${money(b.costUsd)}</div>` : ''}
            ${b.error ? `<div style="color:var(--bad);margin-top:4px" class="ellipsis" title="${esc(b.error)}">${esc(b.error.split('\n')[0])}</div>` : ''}
          </div>`;
        })
        .join('')}</div>`
    : '';
  const collapse = batches.length > 12;
  const stateCount = (st) => batches.filter((b) => b.state === st).length;
  const wrapped = collapse
    ? `<details class="card batch-fold" ${j.status === 'running' ? 'open' : ''}><summary><b>${plural(batches.length, 'batch', 'batches')}</b> <span class="muted">${stateCount('done')} done${stateCount('running') ? ` · ${stateCount('running')} running` : ''}${stateCount('failed') ? ` · ${stateCount('failed')} failed` : ''}${stateCount('queued') ? ` · ${stateCount('queued')} waiting` : ''}</span></summary>${cards}</details>`
    : cards;
  const all = (j.timeline || []).slice().reverse();
  const tl = RV.allEvents ? all : all.filter((e) => e.kind !== 'tool' && e.kind !== 'say');
  return `${wrapped}<div class="row" style="margin-bottom:8px"><b>Timeline</b><span class="grow"></span><label class="row toggle"><input type="checkbox" data-allevents ${RV.allEvents ? 'checked' : ''}/> Show every tool call (${all.length})</label></div>
    <div class="card section activity">${
      tl.length
        ? tl.map((e) => `<div class="ev ${e.kind}"><time>${clock(e.at)}</time><span class="b">${e.batch ? `#${e.batch}` : ''}</span><span class="t">${e.kind === 'tool' ? '▸ ' : ''}${esc(e.text)}</span></div>`).join('')
        : '<div class="muted">Waiting for the first event…</div>'
    }</div>`;
}

// ------------------------------------------------------------------ compare

export function renderCompareTab() {
  const c = RV.compare;
  if (!c) {
    const jobId = RV.job.id;
    if (RV._loadingCompare === jobId) return `<div class="row muted"><span class="spinner"></span> Comparing with the original review…</div>`;
    RV._loadingCompare = jobId;
    api(`/api/reviews/${jobId}/compare`)
      .then((r) => ({ r }), (err) => ({ r: { error: err.message } }))
      .then(({ r }) => {
        if (RV._loadingCompare === jobId) RV._loadingCompare = null;
        // The reviewer may have moved to another review meanwhile.
        if (RV.job?.id !== jobId) return;
        RV.compare = r;
        if (RV.tab === 'compare') render();
      });
    return `<div class="row muted"><span class="spinner"></span> Comparing with the original review…</div>`;
  }
  if (c.error) return `<div class="banner bad">${esc(c.error)}</div>`;
  const item = (x, side) => {
    const f = x[side];
    const link = side === 'before' ? `#/review/${c.before.id}/${f.id}` : `#/review/${RV.job.id}/${f.id}`;
    return `<a class="cmp-item" href="${link}"><span class="pill sev ${f.severity}">${f.severity}</span><span class="grow ellipsis">${esc(f.title)}</span><span class="faint mono">${esc(f.path.split('/').pop())}:${f.start_line}</span></a>`;
  };
  const bucket = (title, cls, list, side, help) => `<div class="card cmp-bucket ${cls}"><div class="cmp-head"><b>${title}</b><span class="count">${list.length}</span><span class="faint">${help}</span></div>${list.length ? list.map((x) => item(x, side)).join('') : '<div class="faint" style="padding:10px 14px">None</div>'}</div>`;
  return `<div class="banner info">Re-review of the files fixed in <a href="#/review/${c.before.id}">${esc(c.before.title)}</a>.${c.done ? '' : ' Still running; results fill in as batches finish.'}</div>
    <div class="cmp-grid">
      ${bucket('Resolved', 'ok', c.resolved, 'before', 'fixed and no longer reported')}
      ${bucket('Still there', 'bad', c.persisting, 'after', 'marked fixed, but reported again')}
      ${bucket('New', 'warn', c.new, 'after', 'not in the original review; may come from a fix')}
      ${bucket('Still open', '', c.stillOpen, 'after', 'left open in the original, still present')}
    </div>`;
}

// ------------------------------------------------------------------ code viewer

export function renderCodeTab() {
  const j = RV.job;
  const p = RV.code?.path || RV.file || j.files[0]?.path;
  if (!p) return '<div class="empty">No files.</div>';
  const cached = RV.diffCache.get(p);
  if (!cached) {
    api(`/api/reviews/${j.id}/file?path=${encodeURIComponent(p)}`)
      .then((d) => {
        RV.diffCache.set(p, d);
        if (RV.tab === 'code') render();
      })
      .catch((err) => toast(err.message, true));
    return `<div class="row muted"><span class="spinner"></span> Loading ${esc(p)}…</div>`;
  }
  const marks = new Map();
  for (const f of j.findings.filter((x) => x.path === p)) for (let n = f.start_line; n <= f.end_line; n++) if (!marks.has(n)) marks.set(n, f);
  const newRows = cached.rows.filter((r) => r.t !== 'del' && r.t !== 'hunk');
  const delRows = cached.rows.filter((r) => r.t === 'del');
  const hNew = highlightLines(newRows.map((r) => r.text), p);
  const hDel = highlightLines(delRows.map((r) => r.text), p);
  let ni = 0;
  let di = 0;
  const rows = cached.rows
    .map((r) => {
      const html = r.t === 'del' ? hDel[di++] : r.t === 'hunk' ? esc(r.text) : hNew[ni++];
      const f = r.n != null && r.t !== 'del' ? marks.get(r.n) : null;
      const cls = r.t === 'hunk' ? 'hunk' : r.t === 'add' ? 'add' : r.t === 'del' ? 'del' : '';
      const line = `<div class="ln ${cls} ${f ? 'hl' : ''} ${RV.code?.line === r.n && r.t !== 'del' ? 'target' : ''}" ${r.n != null && r.t !== 'del' ? `id="L${r.n}"` : ''}><span class="num">${r.t === 'del' ? '' : r.n ?? ''}</span><span class="sign">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''}</span><span class="txt">${html || ' '}</span></div>`;
      const note = f && r.n === f.end_line && r.t !== 'del' ? `<div class="code-note ${f.severity}" data-jump="${f.id}"><span class="pill sev ${f.severity}">${f.severity}</span> <b>${esc(f.title)}</b> <span class="faint">open finding →</span></div>` : '';
      return line + note;
    })
    .join('');
  const files = j.files.map((f) => f.path);
  return `<div class="row wrap" style="margin-bottom:8px">
      <select data-codefile class="mono" style="max-width:60%">${files.map((x) => `<option ${x === p ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <span class="muted">${cached.kind === 'diff' ? 'Changes under review' : 'Whole file'} · ${plural(j.findings.filter((f) => f.path === p).length, 'finding')}</span>
      <span class="grow"></span><button class="btn small ghost" data-open-file="${esc(p)}">${icon('open', 13)} Open in editor</button>
    </div>
    <div class="snippet hl-code codeview">${rows || '<div class="ln"><span class="num"></span>(no textual content)</div>'}</div>`;
}
