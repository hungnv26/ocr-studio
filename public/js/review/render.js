// Pure render helpers shared by the review page tabs.

import { esc, md, icon, ago } from '../core.js';
import { highlightLines, highlightBlock } from '../highlight.js';
import { needsYou, flagged, inFlight } from './state.js';

export function renderSnippet(snip, start, end, path) {
  if (!snip?.lines?.length) return '';
  const html = highlightLines(snip.lines, path);
  return `<div class="snippet hl-code">${snip.lines
    .map((_, i) => {
      const n = snip.from + i;
      return `<div class="ln ${n >= start && n <= end ? 'hl' : ''}"><span class="num">${n}</span><span class="txt">${html[i] || ' '}</span></div>`;
    })
    .join('')}</div>`;
}

export function renderCode(code, path) {
  return `<pre class="code hl-code">${highlightBlock(code, path)}</pre>`;
}

// Unified diff with syntax colour on both sides and real line numbers.
export function renderPatch(diff, path, { hunkActions = null } = {}) {
  const lines = String(diff || '').split('\n');
  const oldSide = [];
  const newSide = [];
  const rows = [];
  let o = 0;
  let n = 0;
  let hunk = -1;
  let inHunk = false;
  for (const line of lines) {
    // Headers only come before a file's first hunk; inside one, a line like
    // "--- x" is a removed "-- x", not a header.
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      o = Number(m[1]);
      n = Number(m[2]);
      hunk++;
      inHunk = true;
      rows.push({ t: 'hunk', text: line, hunk });
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (!line && rows.length && lines[lines.length - 1] === line) continue;
    if (line.startsWith('+')) {
      rows.push({ t: 'add', n: n++, side: 'new', i: newSide.length });
      newSide.push(line.slice(1));
    } else if (line.startsWith('-')) {
      rows.push({ t: 'del', o: o++, side: 'old', i: oldSide.length });
      oldSide.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      rows.push({ t: 'ctx', o: o++, n: n++, side: 'new', i: newSide.length });
      newSide.push(line.slice(1));
    }
  }
  const hNew = highlightLines(newSide, path);
  const hOld = highlightLines(oldSide, path);
  return `<div class="snippet diff hl-code">${rows
    .map((r) => {
      if (r.t === 'hunk')
        return `<div class="ln hunk"><span class="num"></span><span class="num"></span><span class="txt">${esc(r.text)}</span>${hunkActions ? hunkActions(r.hunk) : ''}</div>`;
      const txt = r.side === 'old' ? hOld[r.i] : hNew[r.i];
      return `<div class="ln ${r.t}"><span class="num">${r.o ?? ''}</span><span class="num">${r.n ?? ''}</span><span class="sign">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' '}</span><span class="txt">${txt || ' '}</span></div>`;
    })
    .join('')}</div>`;
}

export function statusBadge(f) {
  const s = f.fix?.status;
  if (inFlight(f)) return `<span class="st st-run" title="Fix in progress"><span class="spinner"></span></span>`;
  if (needsYou(f)) return `<span class="st st-needs" title="Waiting for your decision">!</span>`;
  if (flagged(f)) return `<span class="st st-flag" title="Applied fix flagged by the re-check">⚠</span>`;
  if (s === 'applied' || f.mark === 'fixed') return `<span class="st st-ok" title="Fixed">${icon('check', 11)}</span>`;
  if (f.mark === 'ignored') return `<span class="st st-ign" title="Ignored">–</span>`;
  return '';
}

export const confBadge = (f) => (f.confidence ? `<span class="conf conf-${f.confidence}" title="Reviewer's confidence that this is a real defect">${f.confidence}</span>` : '');

export function fixBox(f) {
  const fx = f.fix;
  if (!fx) return '';
  const v = fx.verdict;
  const a = fx.audit;
  const label = {
    queued: '<span class="pill">Queued</span> Waiting for a free slot…',
    running: '<span class="spinner"></span> <b>Claude is writing a fix…</b>',
    checking: '<span class="spinner"></span> <b>A second Claude run is double-checking the change…</b>',
    applied: `<span class="pill ok">✓ Fix applied</span> ${fx.approved ? '<span class="tag">approved by you</span>' : v ? '<span class="tag">checked: safe</span>' : a?.verdict === 'safe' ? '<span class="tag">re-checked: safe</span>' : !a ? '<span class="tag">not double-checked</span>' : ''}`,
    proposed: '<span class="pill warn">Needs your approval</span> <span class="muted">Not applied yet; your files are unchanged.</span>',
    rejected: '<span class="pill bad">Rejected by the checker</span> <span class="muted">Not applied.</span>',
    blocked: '<span class="pill">Blocked by guardrails</span>',
    unchanged: '<span class="pill warn">No change made</span>',
    failed: '<span class="pill bad">Fix failed</span>',
    reverted: '<span class="pill">Fix undone</span>',
  }[fx.status] || esc(fx.status);
  const log = fx.log?.length ? `<div class="log">${fx.log.slice(-8).map((l) => `<div>${l.kind === 'tool' ? '▸ ' : ''}${esc(l.text)}</div>`).join('')}</div>` : '';
  const verdictBox =
    v && ['proposed', 'rejected'].includes(fx.status)
      ? `<div class="verdict ${v.verdict}"><b>${v.verdict === 'wrong' ? 'Why it was rejected' : 'Why it needs a look'}:</b> ${esc(v.reason)}</div>`
      : fx.status === 'applied' && a?.status === 'done' && a.verdict !== 'safe'
        ? `<div class="verdict ${a.verdict}"><b>⚠️ Re-check: ${a.verdict === 'wrong' ? 'this fix looks wrong' : 'this fix is risky'}.</b> ${esc(a.reason)}</div>`
        : fx.status === 'applied' && a && a.status !== 'done'
          ? '<div class="muted" style="margin-top:6px"><span class="spinner"></span> Re-checking this fix…</div>'
          : '';
  const actions =
    fx.status === 'applied'
      ? `<button class="btn small" data-act="undo">${icon('undo', 13)} Undo fix</button>`
      : fx.status === 'proposed'
        ? `<button class="btn small" data-act="discard">Discard</button><button class="btn small primary" data-act="apply">${icon('check', 13)} Apply this change</button>`
        : fx.status === 'rejected'
          ? `<button class="btn small" data-act="discard">Discard</button><button class="btn small" data-act="apply">Apply anyway</button>`
          : ['blocked', 'unchanged', 'failed'].includes(fx.status)
            ? `<button class="btn small ghost" data-act="discard">Dismiss</button>`
            : '';
  return `<div class="fixbox ${fx.status}"><div class="row wrap">${label}<span class="grow"></span>${actions}</div>
    ${fx.instructions ? `<div class="muted" style="margin-top:6px">${icon('chat', 12)} Your instructions: ${esc(fx.instructions)}</div>` : ''}
    ${fx.warning ? `<div class="verdict risky"><b>⚠️ Outside its file:</b> ${esc(fx.warning)}</div>` : ''}
    ${verdictBox}
    ${['running', 'checking', 'unchanged', 'failed'].includes(fx.status) ? log : ''}
    ${fx.error ? `<div class="muted" style="margin-top:6px">${esc(fx.error.slice(0, 400))}</div>` : ''}
    ${fx.summary && ['unchanged'].includes(fx.status) ? `<div class="muted" style="margin-top:6px">${esc(fx.summary.slice(0, 500))}</div>` : ''}
    ${fx.diff && ['applied', 'proposed', 'rejected'].includes(fx.status) ? renderPatch(fx.diff, f.path) : ''}</div>`;
}

export const QUICK_QUESTIONS = ['Why is this a problem?', 'Could this be a false positive?', 'What calls this code?', 'How risky is fixing it?'];

export function threadBox(f, draft = '') {
  const t = f.thread || [];
  return `<div class="thread">
    ${t
      .map(
        (e) => `<div class="qa">
          <div class="q">${icon('chat', 13)} ${esc(e.q)} <span class="faint">${ago(e.at)}</span></div>
          ${
            e.status === 'running'
              ? `<div class="a muted"><span class="spinner"></span> Claude is looking${e.steps?.length ? `: ${esc(e.steps[e.steps.length - 1])}` : '…'}</div>`
              : `<div class="a md ${e.status === 'failed' ? 'failed' : ''}">${md(e.a)}</div>`
          }
        </div>`
      )
      .join('')}
    <div class="ask">
      <div class="chips">${QUICK_QUESTIONS.map((q) => `<button class="chip" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <div class="row" style="margin-top:6px"><input class="grow" data-keep="ask-${f.id}" data-ask placeholder="Ask Claude about this finding… (read-only, nothing is changed)" value="${esc(draft)}" /><button class="btn small" data-ask-go>${icon('chat', 13)} Ask</button></div>
    </div>
  </div>`;
}
