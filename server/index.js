import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitPaths, createBranch, fileContent, fileDiff, gitStatus, parseDiffForView, recentFiles, repoInfo, workingTreeMatches } from './git.js';
import { detectEditors, openInEditor } from './editors.js';
import {
  FOCUS_AREAS,
  cancelJob,
  deleteJob,
  getJob,
  listJobs,
  applyProposal,
  auditApplied,
  cancelFixes,
  discardProposal,
  recheckRound,
  undoRound,
  markFinding,
  markFindings,
  previewTarget,
  publicJob,
  requestFix,
  resolveRules,
  revertFix,
  startReview,
  subscribe,
  allJobs,
  askFinding,
  commitReviewChanges,
  compareReviews,
  exportReview,
  ignoreFinding,
  reviewChanges,
  revertHunk,
  startVerification,
} from './review.js';
import { TEMPLATES, listGuards, loadGuard, removeLearned, saveGuard, suggestGuard } from './guard.js';
import { detectTools, installOcr, loadSettings, rememberRepo, saveSettings } from './tools.js';
import { HOME } from './util.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const VENDOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/@highlightjs/cdn-assets/es');
const PORT = Number(process.env.PORT) || 4317;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), { status: 400 });
  }
}

function serveStatic(req, res, pathname) {
  const vendor = pathname.startsWith('/vendor/hljs/');
  const base = vendor ? VENDOR_DIR : PUBLIC_DIR;
  const rel = pathname === '/' ? 'index.html' : vendor ? pathname.slice('/vendor/hljs/'.length) : pathname.slice(1);
  const file = path.resolve(base, rel);
  const missing = !file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory();
  if (missing && path.extname(pathname)) {
    // A missing asset must 404; serving the HTML shell instead breaks module imports confusingly.
    res.writeHead(404).end('not found');
    return;
  }
  if (missing) {
    // Client-side routes (#/...) all land on the shell.
    res.writeHead(200, { 'content-type': MIME['.html'] });
    fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': vendor ? 'max-age=86400' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// Refs and paths become positional git/ocr arguments, so a value starting with
// '-' would be parsed as an option (e.g. git's --output=<file>).
function validateTarget(target) {
  const bad = (v) => v != null && (typeof v !== 'string' || v.startsWith('-') || /[\0\n]/.test(v));
  const t = target || {};
  if (!['workspace', 'range', 'commit', 'scan'].includes(t.kind)) throw Object.assign(new Error('Unknown review target'), { status: 400 });
  if ([t.from, t.to, t.commit, t.mergeBase].some(bad) || (t.paths || []).some(bad)) {
    throw Object.assign(new Error('Invalid branch, commit or path'), { status: 400 });
  }
  return t;
}

async function requireRepo(dir) {
  if (!dir || typeof dir !== 'string') throw Object.assign(new Error('Choose a repository first'), { status: 400 });
  const info = await repoInfo(path.resolve(dir.replace(/^~(?=$|\/)/, HOME)));
  if (!info.ok) throw Object.assign(new Error(`${dir} is not a git repository`), { status: 400 });
  return info;
}

function listDirs(dir) {
  const abs = path.resolve((dir || HOME).replace(/^~(?=$|\/)/, HOME));
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => ({ name: e.name, path: path.join(abs, e.name), isRepo: fs.existsSync(path.join(abs, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), isRepo: fs.existsSync(path.join(abs, '.git')), dirs };
}

function discoverRepos() {
  const roots = ['Projects', 'Developer', 'Code', 'code', 'src', 'repos', 'workspace', 'git', 'GitHub'].map((d) => path.join(HOME, d)).filter((d) => fs.existsSync(d));
  const found = [];
  const walk = (dir, depth) => {
    if (found.length > 200) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (fs.existsSync(path.join(p, '.git'))) found.push(p);
      else if (depth > 0) walk(p, depth - 1);
    }
  };
  for (const r of roots) walk(r, 2);
  return found;
}

function toMarkdown(job) {
  const lines = [`# Code review: ${job.repoName} — ${job.title}`, '', `Reviewer: ${job.engine.type === 'claude' ? `Claude Code (${job.engine.model})` : 'OCR built-in agent'} · ${job.createdAt}`, ''];
  const order = ['critical', 'high', 'medium', 'low'];
  const open = job.findings.filter((f) => f.mark !== 'ignored').sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  lines.push(`**${open.length} finding(s)** across ${job.files.length} file(s).`, '');
  for (const f of open) {
    lines.push(`## [${f.severity.toUpperCase()}] ${f.title}`, '', `\`${f.path}:${f.start_line}${f.end_line !== f.start_line ? `-${f.end_line}` : ''}\` · ${f.category}${f.mark === 'fixed' ? ' · ✅ fixed' : ''}`, '', f.content, '');
    if (f.suggestion_code) lines.push('Suggested fix:', '```', f.suggestion_code, '```', '');
  }
  return lines.join('\n');
}

const routes = [
  ['GET', /^\/api\/health$/, async () => ({ tools: await detectTools(), settings: loadSettings(), focusAreas: FOCUS_AREAS, home: HOME })],
  ['POST', /^\/api\/tools\/refresh$/, async () => ({ tools: await detectTools(true) })],
  [
    'POST',
    /^\/api\/tools\/install-ocr$/,
    async () => {
      const r = await installOcr();
      return { ok: r.code === 0, output: (r.stdout + r.stderr).slice(-3000), tools: await detectTools(true) };
    },
  ],
  [
    'POST',
    /^\/api\/settings$/,
    async (req) => {
      const body = await readBody(req);
      const allowed = ['claudePath', 'ocrPath', 'model', 'effort', 'concurrency', 'filesPerBatch', 'editor'];
      const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
      const settings = saveSettings(patch);
      return { settings, tools: await detectTools(true) };
    },
  ],
  ['GET', /^\/api\/fs\/list$/, async (req, m, url) => listDirs(url.searchParams.get('path'))],
  ['GET', /^\/api\/repos\/discover$/, async () => ({ repos: discoverRepos(), recent: loadSettings().recentRepos })],
  [
    'POST',
    /^\/api\/repo\/info$/,
    async (req) => {
      const { path: dir } = await readBody(req);
      const info = await requireRepo(dir);
      rememberRepo(info.repo);
      return info;
    },
  ],
  [
    'POST',
    /^\/api\/repo\/recent$/,
    async (req) => {
      const body = await readBody(req);
      const info = await requireRepo(body.repo);
      return { files: await recentFiles(info.repo, body.days) };
    },
  ],
  [
    'POST',
    /^\/api\/preview$/,
    async (req) => {
      const body = await readBody(req);
      const info = await requireRepo(body.repo);
      const preview = await previewTarget({ repo: info.repo, target: validateTarget(body.target), exclude: body.exclude });
      let groups = [];
      if (preview.reviewable.length) {
        groups = (await resolveRules(info.repo, preview.reviewable.map((f) => f.path))).map((g) => ({ pattern: g.pattern, source: g.source, files: g.files }));
      }
      return { ...preview, groups };
    },
  ],
  [
    'POST',
    /^\/api\/rules$/,
    async (req) => {
      const body = await readBody(req);
      const info = await requireRepo(body.repo);
      const paths = (body.paths || []).filter(Boolean);
      if (paths.some((p) => typeof p !== 'string' || p.startsWith('-'))) throw Object.assign(new Error('Invalid file path'), { status: 400 });
      if (!paths.length) throw Object.assign(new Error('Enter at least one file path'), { status: 400 });
      const groups = await resolveRules(info.repo, paths);
      const custom = fs.existsSync(path.join(info.repo, '.opencodereview/rule.json'));
      return { groups, customRuleFile: custom ? '.opencodereview/rule.json' : null };
    },
  ],
  [
    'POST',
    /^\/api\/reviews$/,
    async (req) => {
      const body = await readBody(req);
      const info = await requireRepo(body.repo);
      validateTarget(body.target);
      if ((body.files || []).some((f) => typeof f !== 'string' || f.startsWith('-'))) throw Object.assign(new Error('Invalid file path'), { status: 400 });
      return startReview({ ...body, repo: info.repo });
    },
  ],
  ['GET', /^\/api\/reviews$/, async () => ({ reviews: listJobs() })],
  [
    'GET',
    /^\/api\/reviews\/([\w-]+)$/,
    async (req, m) => {
      const job = getJob(m[1]);
      if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
      return { ...publicJob(job), fixesApplyToReviewed: await workingTreeMatches(job.repo, job.target) };
    },
  ],
  [
    'DELETE',
    /^\/api\/reviews\/([\w-]+)$/,
    async (req, m) => {
      deleteJob(m[1]);
      return { ok: true };
    },
  ],
  ['POST', /^\/api\/reviews\/([\w-]+)\/cancel$/, async (req, m) => ({ ok: cancelJob(m[1]) })],
  [
    'POST',
    /^\/api\/reviews\/([\w-]+)\/findings\/(\w+)\/mark$/,
    async (req, m) => {
      const { mark } = await readBody(req);
      const f = markFinding(m[1], m[2], mark);
      if (!f) throw Object.assign(new Error('Finding not found'), { status: 404 });
      return f;
    },
  ],
  [
    'POST',
    /^\/api\/reviews\/([\w-]+)\/fix$/,
    async (req, m) => {
      const { ids, mode, instructions } = await readBody(req);
      return { queued: await requestFix(m[1], ids || [], mode, instructions) };
    },
  ],
  [
    'POST',
    /^\/api\/reviews\/([\w-]+)\/mark$/,
    async (req, m) => {
      const { ids, mark } = await readBody(req);
      return { marked: markFindings(m[1], Array.isArray(ids) ? ids : [], mark) };
    },
  ],
  ['POST', /^\/api\/reviews\/([\w-]+)\/findings\/(\w+)\/apply$/, async (req, m) => applyProposal(m[1], m[2])],
  ['POST', /^\/api\/reviews\/([\w-]+)\/findings\/(\w+)\/discard$/, async (req, m) => discardProposal(m[1], m[2])],
  ['POST', /^\/api\/reviews\/([\w-]+)\/audit-fixes$/, async (req, m) => auditApplied(m[1])],
  ['POST', /^\/api\/reviews\/([\w-]+)\/rounds\/(\w+)\/undo$/, async (req, m) => undoRound(m[1], m[2])],
  ['POST', /^\/api\/reviews\/([\w-]+)\/rounds\/(\w+)\/check$/, async (req, m) => recheckRound(m[1], m[2])],
  [
    'POST',
    /^\/api\/guard$/,
    async (req) => {
      const body = await readBody(req);
      const info = await requireRepo(body.repo);
      return body.save ? saveGuard(info.repo, body) : loadGuard(info.repo);
    },
  ],
  ['POST', /^\/api\/reviews\/([\w-]+)\/fix\/cancel$/, async (req, m) => ({ cancelled: cancelFixes(m[1]) })],
  ['POST', /^\/api\/reviews\/([\w-]+)\/findings\/(\w+)\/revert$/, async (req, m) => revertFix(m[1], m[2])],
  [
    'GET',
    /^\/api\/reviews\/([\w-]+)\/file$/,
    async (req, m, url) => {
      const job = getJob(m[1]);
      if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
      const p = url.searchParams.get('path');
      const file = job.files.find((f) => f.path === p);
      if (!file) throw Object.assign(new Error('File is not part of this review'), { status: 404 });
      if (job.target.kind === 'scan') {
        const content = (await fileContent(job.repo, job.target, p)) || '';
        return { kind: 'file', rows: content.split('\n').map((text, i) => ({ t: 'ctx', n: i + 1, text })) };
      }
      return { kind: 'diff', rows: parseDiffForView(await fileDiff(job.repo, job.target, file)) };
    },
  ],
  [
    'GET',
    /^\/api\/reviews\/([\w-]+)\/export$/,
    async (req, m, url) => {
      const job = getJob(m[1]);
      if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
      const format = url.searchParams.get('format') || 'md';
      if (format === 'md') return { markdown: toMarkdown(job) };
      return exportReview(m[1], format);
    },
  ],
  ...extraRoutes(),
];

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function projectList() {
  const jobs = allJobs();
  const byRepo = new Map();
  const touchRepo = (repo) => {
    if (!byRepo.has(repo)) byRepo.set(repo, { repo, name: path.basename(repo), reviews: 0, lastAt: null, open: 0, needsYou: 0, guarded: false });
    return byRepo.get(repo);
  };
  for (const j of jobs) {
    const p = touchRepo(j.repo);
    p.reviews++;
    if (!p.lastAt || j.createdAt > p.lastAt) p.lastAt = j.createdAt;
    p.open += j.findings.filter((f) => f.mark === 'open').length;
    p.needsYou += j.findings.filter((f) => ['proposed', 'rejected'].includes(f.fix?.status)).length;
  }
  for (const g of listGuards()) {
    const p = touchRepo(g.repo);
    p.guarded = !!(g.notes || g.protected?.length || g.checkCommand || g.learned?.length);
  }
  for (const r of loadSettings().recentRepos || []) touchRepo(r);
  return [...byRepo.values()].filter((p) => fs.existsSync(p.repo)).sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}

function dashboard() {
  const jobs = allJobs();
  const weekAgo = Date.now() - 7 * 86400_000;
  const attention = [];
  for (const j of jobs) {
    const needs = j.findings.filter((f) => ['proposed', 'rejected'].includes(f.fix?.status)).length;
    const flagged = j.findings.filter((f) => f.fix?.status === 'applied' && f.fix.audit?.status === 'done' && f.fix.audit.verdict !== 'safe').length;
    const unchecked = j.findings.filter((f) => f.fix?.status === 'applied' && f.fix.diff && !f.fix.verdict && !f.fix.audit).length;
    const failedChecks = (j.fixRounds || []).filter((r) => r.check?.status === 'failed' && r.status !== 'undone').length;
    if (needs || flagged || unchecked || failedChecks) attention.push({ id: j.id, repoName: j.repoName, title: j.title, needs, flagged, unchecked, failedChecks });
  }
  const weight = (a) => a.needs * 1000 + a.flagged * 1000 + a.failedChecks * 1000 + a.unchecked;
  attention.sort((a, b) => weight(b) - weight(a));
  const running = jobs
    .filter((j) => j.status === 'running' || j.findings.some((f) => ['queued', 'running', 'checking'].includes(f.fix?.status)))
    .map((j) => ({
      id: j.id,
      repoName: j.repoName,
      title: j.title,
      status: j.status,
      files: j.files.length,
      done: j.files.filter((f) => ['reviewed', 'skipped', 'failed'].includes(f.state)).length,
      fixing: j.findings.filter((f) => ['queued', 'running', 'checking'].includes(f.fix?.status)).length,
    }));
  const week = jobs.filter((j) => Date.parse(j.createdAt) >= weekAgo);
  const usage = {
    reviews: week.length,
    findings: week.reduce((a, j) => a + j.findings.length, 0),
    fixesApplied: week.reduce((a, j) => a + j.findings.filter((f) => f.fix?.status === 'applied').length, 0),
    costUsd: week.reduce((a, j) => a + (j.stats?.costUsd || 0), 0),
    tokens: week.reduce((a, j) => a + (j.stats?.inputTokens || 0) + (j.stats?.outputTokens || 0), 0),
    byDay: Array.from({ length: 7 }, (_, i) => {
      const day = new Date(Date.now() - (6 - i) * 86400_000).toISOString().slice(0, 10);
      const js = week.filter((j) => j.createdAt.slice(0, 10) === day);
      return { day, reviews: js.length, costUsd: js.reduce((a, j) => a + (j.stats?.costUsd || 0), 0) };
    }),
  };
  return { attention, running, recent: listJobs().slice(0, 6), usage, projects: projectList().slice(0, 6) };
}

function extraRoutes() {
  return [
    ['GET', /^\/api\/dashboard$/, async () => dashboard()],
    ['GET', /^\/api\/projects$/, async () => ({ projects: projectList() })],
    [
      'POST',
      /^\/api\/project$/,
      async (req) => {
        const body = await readBody(req);
        const info = await requireRepo(body.repo);
        const reviews = listJobs().filter((r) => r.repo === info.repo);
        return { info, guard: loadGuard(info.repo), reviews, git: await gitStatus(info.repo) };
      },
    ],
    ['GET', /^\/api\/guard\/templates$/, async () => ({ templates: TEMPLATES })],
    [
      'POST',
      /^\/api\/guard\/suggest$/,
      async (req) => {
        const info = await requireRepo((await readBody(req)).repo);
        return { suggestions: await suggestGuard(info.repo) };
      },
    ],
    [
      'POST',
      /^\/api\/guard\/learned\/remove$/,
      async (req) => {
        const body = await readBody(req);
        const info = await requireRepo(body.repo);
        return { learned: removeLearned(info.repo, { path: body.path, title: body.title, index: body.index }) };
      },
    ],
    [
      'POST',
      /^\/api\/reviews\/([\w-]+)\/findings\/(\w+)\/ask$/,
      async (req, m) => askFinding(m[1], m[2], (await readBody(req)).question),
    ],
    [
      'POST',
      /^\/api\/reviews\/([\w-]+)\/findings\/(\w+)\/ignore$/,
      async (req, m) => {
        const { reason, remember } = await readBody(req);
        return ignoreFinding(m[1], m[2], reason, !!remember);
      },
    ],
    ['POST', /^\/api\/reviews\/([\w-]+)\/verify$/, async (req, m) => startVerification(m[1])],
    ['GET', /^\/api\/reviews\/([\w-]+)\/compare$/, async (req, m) => compareReviews(m[1])],
    ['GET', /^\/api\/reviews\/([\w-]+)\/changes$/, async (req, m) => reviewChanges(m[1])],
    [
      'POST',
      /^\/api\/reviews\/([\w-]+)\/changes\/revert$/,
      async (req, m) => {
        const { path: p, hunk } = await readBody(req);
        if (typeof p !== 'string' || p.startsWith('-')) throw bad('Invalid path');
        return revertHunk(m[1], p, hunk);
      },
    ],
    [
      'POST',
      /^\/api\/reviews\/([\w-]+)\/commit$/,
      async (req, m) => {
        const { message, paths } = await readBody(req);
        return commitReviewChanges(m[1], message, Array.isArray(paths) ? paths : []);
      },
    ],
    [
      'POST',
      /^\/api\/git\/status$/,
      async (req) => {
        const info = await requireRepo((await readBody(req)).repo);
        return gitStatus(info.repo);
      },
    ],
    [
      'POST',
      /^\/api\/git\/branch$/,
      async (req) => {
        const body = await readBody(req);
        const info = await requireRepo(body.repo);
        return createBranch(info.repo, String(body.name || '').trim());
      },
    ],
    [
      'POST',
      /^\/api\/git\/commit$/,
      async (req) => {
        const body = await readBody(req);
        const info = await requireRepo(body.repo);
        return commitPaths(info.repo, body.message, null);
      },
    ],
    ['GET', /^\/api\/editors$/, async () => ({ editors: await detectEditors(), current: loadSettings().editor || 'auto' })],
    [
      'POST',
      /^\/api\/open$/,
      async (req) => {
        const body = await readBody(req);
        const info = await requireRepo(body.repo);
        if (typeof body.path !== 'string' || body.path.startsWith('-')) throw bad('Invalid path');
        return openInEditor(info.repo, body.path, body.line, body.editor || loadSettings().editor || 'auto');
      },
    ],
  ];
}

const server = http.createServer(async (req, res) => {
  // Reject DNS-rebinding style requests: only loopback Host headers may talk to
  // a server that can run Claude with edit permissions.
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) {
    res.writeHead(403).end('forbidden host');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // A custom header forces a CORS preflight, which this server never approves,
  // so other websites can't drive these endpoints from the user's browser.
  if (req.method !== 'GET' && req.headers['x-ocr-studio'] !== '1') return send(res, 403, { error: 'missing x-ocr-studio header' });

  const sse = pathname.match(/^\/api\/reviews\/([\w-]+)\/events$/);
  if (sse && req.method === 'GET') {
    const job = getJob(sse[1]);
    if (!job) return send(res, 404, { error: 'Review not found' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const push = (snapshot) => res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    push(publicJob(job));
    const off = subscribe(job.id, push);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      off();
      clearInterval(ping);
    });
    return;
  }

  for (const [method, re, handler] of routes) {
    const m = pathname.match(re);
    if (!m || method !== req.method) continue;
    try {
      return send(res, 200, await handler(req, m, url));
    } catch (err) {
      return send(res, err.status || 500, { error: String(err.message || err) });
    }
  }
  send(res, 404, { error: 'Not found' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  OCR Studio already seems to be running → http://localhost:${PORT}\n`);
    if (process.stdout.isTTY && process.platform === 'darwin') spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' });
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  OCR Studio is running →  http://localhost:${PORT}\n`);
  if (process.stdout.isTTY && !process.env.NO_OPEN && process.platform === 'darwin') {
    spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore', detached: true }).unref();
  }
  detectTools().then((t) => {
    console.log(`  git     ${t.git ? t.git.version : 'NOT FOUND'}`);
    console.log(`  ocr     ${t.ocr ? t.ocr.version.split(' ')[1] : 'NOT FOUND (install from Settings)'}`);
    console.log(`  claude  ${t.claude ? `${t.claude.version}  (${t.claude.path})` : 'NOT FOUND'}\n`);
  });
});
