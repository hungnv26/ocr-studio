// Shared state for the review page and helpers that read it.

import { SEVS, pref } from '../core.js';

export const RV = {
  job: null,
  guard: null,
  tab: 'findings',
  sel: null,
  picked: new Set(),
  q: '',
  status: 'open',
  sev: new Set(),
  cat: null,
  conf: false,
  file: null,
  group: pref('group', 'file'),
  sort: pref('sort', 'severity'),
  layout: pref('layout', 'workbench'),
  collapsed: new Set(),
  showBatches: false,
  allEvents: false,
  diffCache: new Map(),
  changes: null,
  compare: null,
  code: null,
  fileSort: { key: 'open', dir: -1 },
  drafts: {},
  fixWatch: new Set(),
  es: null,
};

export function resetRV() {
  Object.assign(RV, {
    job: null,
    guard: null,
    tab: 'findings',
    sel: null,
    picked: new Set(),
    q: '',
    status: 'open',
    sev: new Set(),
    cat: null,
    conf: false,
    file: null,
    collapsed: new Set(),
    diffCache: new Map(),
    changes: null,
    compare: null,
    code: null,
    drafts: {},
    fixWatch: new Set(),
  });
}

export const FIX_IN_FLIGHT = ['queued', 'running', 'checking'];
export const inFlight = (f) => FIX_IN_FLIGHT.includes(f.fix?.status);
export const needsYou = (f) => ['proposed', 'rejected'].includes(f.fix?.status);
export const flagged = (f) => f.fix?.status === 'applied' && f.fix.audit?.status === 'done' && f.fix.audit.verdict !== 'safe';
export const unchecked = (f) => f.fix?.status === 'applied' && f.fix.diff && !f.fix.verdict && !f.fix.audit;
export const pickable = (f) => f.mark === 'open' && !['queued', 'running', 'checking', 'applied', 'proposed', 'rejected'].includes(f.fix?.status);
export const isFixed = (f) => f.mark === 'fixed' || f.fix?.status === 'applied';

export const STATUS_FILTERS = [
  { id: 'open', label: 'Open', test: (f) => f.mark === 'open' && !needsYou(f) },
  { id: 'needs', label: 'Needs you', test: (f) => needsYou(f) || flagged(f) },
  { id: 'fixed', label: 'Fixed', test: (f) => isFixed(f) && !flagged(f) },
  { id: 'ignored', label: 'Ignored', test: (f) => f.mark === 'ignored' },
  { id: 'all', label: 'All', test: () => true },
];

const CONF_RANK = { high: 0, medium: 1, low: 2 };

export function visibleFindings() {
  const j = RV.job;
  if (!j) return [];
  const st = STATUS_FILTERS.find((s) => s.id === RV.status) || STATUS_FILTERS[4];
  const q = RV.q.trim().toLowerCase();
  const list = j.findings.filter(
    (f) =>
      st.test(f) &&
      (!RV.sev.size || RV.sev.has(f.severity)) &&
      (!RV.cat || f.category === RV.cat) &&
      (!RV.conf || f.confidence === 'high') &&
      (!RV.file || f.path === RV.file || f.path.startsWith(RV.file + '/')) &&
      (!q || `${f.title} ${f.content} ${f.path}`.toLowerCase().includes(q))
  );
  const bySev = (a, b) => SEVS.indexOf(a.severity) - SEVS.indexOf(b.severity);
  const byFile = (a, b) => a.path.localeCompare(b.path) || a.start_line - b.start_line;
  const byConf = (a, b) => (CONF_RANK[a.confidence] ?? 1) - (CONF_RANK[b.confidence] ?? 1);
  const order = RV.sort === 'file' ? [byFile, bySev] : RV.sort === 'confidence' ? [byConf, bySev, byFile] : [bySev, byFile];
  list.sort((a, b) => {
    for (const fn of order) {
      const d = fn(a, b);
      if (d) return d;
    }
    return 0;
  });
  if (RV.group === 'file') list.sort((a, b) => a.path.localeCompare(b.path) || order.reduce((d, fn) => d || fn(a, b), 0));
  if (RV.group === 'severity') list.sort((a, b) => bySev(a, b) || order.reduce((d, fn) => d || fn(a, b), 0));
  return list;
}

export function countBy(test) {
  return (RV.job?.findings || []).filter(test).length;
}
