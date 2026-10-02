import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotateDiff, fileContent, fileDiff } from './git.js';
import { addLearned, learnedBlock, loadGuard, protectedBy } from './guard.js';
import { detectTools, loadSettings } from './tools.js';
import { DATA_DIR, chunk, newId, readJSON, run, writeJSON } from './util.js';

const REVIEWS_DIR = path.join(DATA_DIR, 'reviews');
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const CATEGORIES = ['bug', 'security', 'performance', 'maintainability', 'test', 'style', 'documentation', 'other'];
const MAX_LINES_PER_BATCH = 1500;

export const FOCUS_AREAS = {
  bugs: 'Correctness bugs: wrong logic, off-by-one, null/undefined handling, broken edge cases, wrong API usage',
  security: 'Security: injection, unsafe shell/exec, path traversal, secrets in code, authz/authn mistakes, unsafe deserialization',
  performance: 'Performance: needless O(n^2) work, repeated I/O in loops, unbounded memory, blocking calls on hot paths',
  errors: 'Error handling: swallowed errors, missing failure paths, resources not released, unhandled promise rejections',
  concurrency: 'Concurrency: races, shared mutable state, missing locks, async ordering bugs',
  maintainability: 'Maintainability: dead code, duplication, misleading names, confusing control flow',
  tests: 'Tests: missing or incorrect tests for the changed behaviour',
  style: 'Style and readability nits (report sparingly, only when clearly valuable)',
};

const jobs = new Map();
const listeners = new Map();

// ---------------------------------------------------------------- persistence

function jobFile(id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('bad id');
  return path.join(REVIEWS_DIR, `${id}.json`);
}

function persist(job) {
  if (job._deleted) return;
  writeJSON(jobFile(job.id), publicJob(job));
}

export function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  try {
    const job = readJSON(jobFile(id), null);
    if (job && job.status === 'running') job.status = 'interrupted';
    for (const f of job?.findings || []) {
      if (f.fix?.status === 'queued') f.fix = null;
      else if (f.fix?.status === 'running' || f.fix?.status === 'checking') Object.assign(f.fix, { status: 'failed', error: 'Interrupted: OCR Studio was restarted. If the file was edited, use “Undo whole batch”.' });
    }
    for (const f of job?.findings || []) if (['queued', 'running'].includes(f.fix?.audit?.status)) delete f.fix.audit;
    for (const f of job?.findings || []) for (const t of f.thread || []) if (t.status === 'running') Object.assign(t, { status: 'failed', a: 'Interrupted: OCR Studio was restarted.' });
    for (const r of job?.fixRounds || []) {
      if (r.status === 'running') r.status = 'done';
      if (r.check?.status === 'running') r.check.status = 'interrupted';
    }
    if (job) jobs.set(id, job);
    return job;
  } catch {
    return null;
  }
}

export function listJobs() {
  const out = [];
  for (const f of fs.readdirSync(REVIEWS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    let job = jobs.get(id);
    if (!job) {
      job = readJSON(path.join(REVIEWS_DIR, f), null);
      if (job?.status === 'running') job.status = 'interrupted';
    }
    if (!job) continue;
    out.push(summarize(job));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function deleteJob(id) {
  const job = jobs.get(id);
  if (job?.status === 'running') cancelJob(id);
  if (job) job._deleted = true;
  jobs.delete(id);
  fs.rmSync(jobFile(id), { force: true });
}

function summarize(job) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of job.findings || []) if (!f.mark || f.mark === 'open') counts[f.severity] = (counts[f.severity] || 0) + 1;
  return {
    id: job.id,
    title: job.title,
    repo: job.repo,
    repoName: job.repoName,
    target: job.target,
    engine: job.engine,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    fileCount: job.files.length,
    findingCount: (job.findings || []).length,
    openCounts: counts,
    costUsd: job.stats?.costUsd || 0,
    tokens: (job.stats?.inputTokens || 0) + (job.stats?.outputTokens || 0),
    label: job.label || '',
    verifies: job.verifies || null,
    handled: (job.findings || []).filter((f) => f.mark !== 'open').length,
    needsYou: (job.findings || []).filter((f) => ['proposed', 'rejected'].includes(f.fix?.status)).length,
    flagged: (job.findings || []).filter((f) => f.fix?.status === 'applied' && f.fix.audit?.status === 'done' && f.fix.audit.verdict !== 'safe').length,
    fixesApplied: (job.findings || []).filter((f) => f.fix?.status === 'applied').length,
    fixing: (job.findings || []).filter((f) => ['queued', 'running', 'checking'].includes(f.fix?.status)).length,
  };
}

// ---------------------------------------------------------------- live updates

export function subscribe(id, fn) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id).add(fn);
  return () => listeners.get(id)?.delete(fn);
}

function touch(job, { save = false } = {}) {
  job.updatedAt = new Date().toISOString();
  if (save) persist(job);
  if (job._timer) return;
  job._timer = setTimeout(() => {
    job._timer = null;
    const snapshot = publicJob(job);
    for (const fn of listeners.get(job.id) || []) fn(snapshot);
  }, 250);
}

export function publicJob(job) {
  const { _children, _timer, _deleted, _fixLocks, ...rest } = job;
  return rest;
}

function activity(job, batch, kind, text) {
  const entry = { at: Date.now(), kind, text: String(text).slice(0, 400) };
  if (batch) {
    batch.activity.push(entry);
    if (batch.activity.length > 300) batch.activity.splice(0, batch.activity.length - 300);
  }
  job.timeline.push({ ...entry, batch: batch?.id ?? null });
  if (job.timeline.length > 600) job.timeline.splice(0, job.timeline.length - 600);
  touch(job);
}

// ---------------------------------------------------------------- ocr helpers

function targetArgs(target) {
  if (target.kind === 'range') return ['--from', target.from, '--to', target.to];
  if (target.kind === 'commit') return ['--commit', target.commit];
  return [];
}

export async function previewTarget({ repo, target, exclude }) {
  const tools = await detectTools();
  if (!tools.ocr) throw new Error('The ocr CLI is not installed. Open Settings to install it.');
  let args;
  if (target.kind === 'scan') {
    args = ['scan', '--preview', '--format', 'json', '--repo', repo];
    if (target.paths?.length) args.push('--path', target.paths.join(','));
  } else {
    args = ['delegate', 'preview', '--format', 'json', '--repo', repo, ...targetArgs(target)];
  }
  if (exclude) args.push('--exclude', exclude);
  const r = await run(tools.ocr.path, args, { cwd: repo, timeoutMs: 120_000 });
  const text = r.stdout.trim();
  if (r.code !== 0 || !text.startsWith('{')) {
    throw new Error((r.stderr || r.stdout || 'ocr preview failed').trim().split('\n').slice(-6).join('\n'));
  }
  const data = JSON.parse(text);
  if (target.kind === 'scan') {
    return {
      mode: 'scan',
      reviewable: data.files.filter((f) => f.will_review).map((f) => ({ path: f.path, status: 'scan', insertions: f.insertions, deletions: 0 })),
      excluded: data.files.filter((f) => !f.will_review).map((f) => ({ path: f.path, reason: f.exclude_reason || 'excluded' })),
    };
  }
  return {
    mode: data.mode,
    mergeBase: data.merge_base,
    from: data.from,
    to: data.to,
    commit: data.commit,
    reviewable: data.reviewable_files || [],
    excluded: (data.excluded_files || []).map((f) => ({ path: f.path, reason: f.reason || f.exclude_reason || 'excluded', status: f.status })),
  };
}

export async function resolveRules(repo, paths) {
  const tools = await detectTools();
  const groups = [];
  for (const part of chunk(paths, 200)) {
    const r = await run(tools.ocr.path, ['delegate', 'rule', '--format', 'json', '--repo', repo, ...part], { cwd: repo, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error((r.stderr || 'ocr delegate rule failed').trim());
    for (const g of JSON.parse(r.stdout).groups || []) {
      const same = groups.find((x) => x.rule === g.rule);
      if (same) same.files.push(...g.files);
      else groups.push({ pattern: g.pattern, source: g.source, rule: g.rule, files: [...g.files] });
    }
  }
  return groups;
}

// ---------------------------------------------------------------- job lifecycle

function describeTarget(t) {
  if (t.kind === 'range') return `${t.from} → ${t.to}`;
  if (t.kind === 'commit') return `commit ${t.commit.slice(0, 10)}`;
  if (t.kind === 'scan') return t.paths?.length ? `scan ${t.paths.join(', ')}` : 'full scan';
  return 'uncommitted changes';
}

export async function startReview(opts) {
  const settings = loadSettings();
  const tools = await detectTools();
  if (!tools.ocr) throw new Error('The ocr CLI is not installed.');
  if (opts.engine.type === 'claude' && !tools.claude) throw new Error('Claude Code was not found. Set its path in Settings.');
  if (opts.engine.type === 'ocr' && !tools.ocrNative) throw new Error('The OCR built-in agent has no LLM provider configured.');

  const preview = await previewTarget(opts);
  const wanted = opts.files?.length ? new Set(opts.files) : null;
  const files = preview.reviewable
    .filter((f) => !wanted || wanted.has(f.path))
    .map((f) => ({ ...f, state: 'queued', reason: '', batch: null }));
  if (!files.length) throw new Error('Nothing to review: no reviewable files were selected.');

  const target = { ...opts.target, mergeBase: preview.mergeBase || opts.target.mergeBase };
  const job = {
    id: newId(),
    title: opts.label ? `${String(opts.label).slice(0, 40)} · ${describeTarget(target)}` : describeTarget(target),
    repo: opts.repo,
    repoName: path.basename(opts.repo),
    label: opts.label || '',
    verifies: opts.verifies || null,
    target,
    engine: {
      type: opts.engine.type,
      model: opts.engine.model || settings.model,
      effort: opts.engine.effort || settings.effort,
      concurrency: settings.concurrency,
    },
    focus: opts.focus || Object.keys(FOCUS_AREAS).filter((k) => k !== 'style'),
    background: (opts.background || '').slice(0, 8000),
    exclude: opts.exclude || '',
    status: 'running',
    phase: 'Preparing',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    files,
    excluded: preview.excluded,
    batches: [],
    findings: [],
    timeline: [],
    stats: { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
    error: null,
    _children: new Set(),
  };
  jobs.set(job.id, job);
  persist(job);

  const runner = job.engine.type === 'ocr' ? runOcrNative : runClaude;
  runner(job)
    .catch((err) => {
      job.error = String(err.message || err);
      activity(job, null, 'error', job.error);
      if (job.status === 'running') job.status = 'failed';
    })
    .finally(() => {
      if (job.status === 'running') job.status = 'done';
      job.phase = job.status === 'done' ? 'Finished' : job.status === 'cancelled' ? 'Cancelled' : 'Failed';
      job.finishedAt = new Date().toISOString();
      job.stats.durationMs = Date.parse(job.finishedAt) - Date.parse(job.createdAt);
      for (const f of job.files) if (f.state === 'queued' || f.state === 'reviewing') f.state = job.status === 'done' ? 'skipped' : 'failed';
      for (const b of job.batches) if (b.state === 'running' || b.state === 'queued') b.state = job.status === 'cancelled' ? 'cancelled' : 'failed';
      touch(job, { save: true });
    });
  return publicJob(job);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  job.status = 'cancelled';
  for (const child of job._children || []) child.kill('SIGTERM');
  activity(job, null, 'warn', 'Review cancelled');
  return true;
}

// ---------------------------------------------------------------- Claude Code engine

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      description: 'One entry for every file in this batch.',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['reviewed', 'skipped'] },
          reason: { type: 'string', description: 'Why it was skipped, or a one-line note on what was checked.' },
        },
        required: ['path', 'status'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', description: 'First line in the NEW version of the file.' },
          end_line: { type: 'integer' },
          severity: { type: 'string', enum: SEVERITIES },
          category: { type: 'string', enum: CATEGORIES },
          title: { type: 'string', description: 'Short headline, under 80 characters.' },
          content: { type: 'string', description: 'What is wrong, why it matters, and how to fix it. Markdown allowed.' },
          existing_code: { type: 'string', description: 'The exact problematic lines copied from the file.' },
          suggestion_code: { type: 'string', description: 'Replacement code for existing_code, when a concrete fix exists.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'How sure you are that this is a real defect after checking the surrounding code.' },
        },
        required: ['path', 'start_line', 'end_line', 'severity', 'category', 'title', 'content', 'confidence'],
      },
    },
  },
  required: ['files', 'findings'],
};

function planBatches(files, groups, perBatch) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const batches = [];
  const covered = new Set();
  for (const g of groups) {
    const members = g.files.map((p) => byPath.get(p)).filter(Boolean);
    let current = [];
    let lines = 0;
    for (const f of members) {
      const size = (f.insertions || 0) + (f.deletions || 0);
      if (current.length && (current.length >= perBatch || lines + size > MAX_LINES_PER_BATCH)) {
        batches.push({ files: current, rule: g.rule, pattern: g.pattern });
        current = [];
        lines = 0;
      }
      current.push(f);
      lines += size;
      covered.add(f.path);
    }
    if (current.length) batches.push({ files: current, rule: g.rule, pattern: g.pattern });
  }
  const rest = files.filter((f) => !covered.has(f.path));
  for (const part of chunk(rest, perBatch)) batches.push({ files: part, rule: '', pattern: '(no specific rule)' });
  return batches;
}

async function buildPrompt(job, batch) {
  const t = job.target;
  const parts = [];
  parts.push(`You are a senior engineer doing a careful code review. Review ONLY the files listed below.
Work in the repository at the current working directory. You may use Read, Grep and Glob to look at surrounding code, callers and definitions before deciding something is a defect. Do not modify any files.

Precision matters more than recall: report a finding only when you are confident it is a real problem in the ${t.kind === 'scan' ? 'file' : 'changed code'}. Do not report things the diff does not touch unless the change breaks them. Skip praise and summaries.`);

  if (t.kind === 'scan') parts.push('This is a FULL-FILE SCAN: review the whole content of each file (read it with the Read tool). Line numbers are the file\'s own line numbers.');
  else
    parts.push(`Review target: ${describeTarget(t)}.
Each diff line is prefixed with its line number in the NEW version of the file ("+" = added, "-" = removed, blank = context). Use those numbers for start_line/end_line. Only comment on added or modified lines (and on removed lines only if their removal breaks something).${
      t.kind !== 'workspace' ? `\nNote: the working tree may not be at the reviewed revision. If you Read a file, prefer the diff when they disagree.` : ''
    }`);

  parts.push(`Focus on:\n${job.focus.map((k) => `- ${FOCUS_AREAS[k] || k}`).join('\n')}`);
  if (job.background) parts.push(`Business context / requirements from the author:\n<background>\n${job.background}\n</background>\nAlso check that the change actually implements these requirements.`);
  const guard = loadGuard(job.repo);
  if (guard.notes) parts.push(`Project notes from the developer. Do not report anything these notes say is intentional:\n<notes>\n${guard.notes}\n</notes>`);
  const learned = learnedBlock(guard, batch.files.map((f) => (typeof f === 'string' ? f : f.path)));
  if (learned) parts.push(learned);
  if (batch.rule) parts.push(`Project review rules for these files (from Open Code Review, pattern ${batch.pattern}):\n<rules>\n${batch.rule}\n</rules>`);

  for (const f of batch.files) {
    if (t.kind === 'scan') {
      parts.push(`<file path="${f.path}" />`);
      continue;
    }
    const raw = await fileDiff(job.repo, t, f);
    let annotated = raw ? annotateDiff(raw) : '';
    if (annotated.length > 60_000) annotated = annotated.slice(0, 60_000) + '\n... (diff truncated; use Read for the rest)';
    parts.push(`<file path="${f.path}" status="${f.status}" added="${f.insertions}" removed="${f.deletions}">\n${annotated || '(binary or empty diff)'}\n</file>`);
  }

  parts.push(`Severity guide: critical = exploitable security hole or data loss; high = definite bug that will misbehave in normal use; medium = likely bug, risky edge case, or clear maintainability problem; low = minor but clearly worth fixing.
When done, return the structured result: one "files" entry per listed file (reviewed or skipped with reason), and every finding. An empty findings list is a perfectly good answer.`);
  return parts.join('\n\n');
}

function describeToolUse(name, input = {}) {
  const rel = (p) => (p ? String(p).replace(/^.*?\/(?=[^/]+\/[^/]+$)/, '') : '');
  switch (name) {
    case 'Read':
      return `Reading ${rel(input.file_path)}${input.offset ? ` from line ${input.offset}` : ''}`;
    case 'Grep':
      return `Searching for "${input.pattern}"${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Glob':
      return `Listing files matching ${input.pattern}`;
    case 'StructuredOutput':
      return `Submitting ${(input.findings || []).length} finding(s)`;
    default:
      return `${name}`;
  }
}

function spawnClaude(job, args, prompt, onEvent) {
  return new Promise((resolve) => {
    const child = spawn(args.bin, args.argv, {
      cwd: job.repo,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'ocr-studio' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    job._children?.add(child);
    let buf = '';
    let stderr = '';
    let result = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'result') result = ev;
        onEvent(ev);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      job._children?.delete(child);
      resolve({ result: null, error: String(err.message || err) });
    });
    child.on('close', (code) => {
      job._children?.delete(child);
      resolve({ result, error: result ? null : (stderr.trim() || `claude exited with code ${code}`).slice(-2000) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function claudeArgs(tools, job, { schema, toolList, permissionMode, allowedTools }) {
  const argv = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', job.engine.model,
    '--tools', toolList,
    '--permission-mode', permissionMode,
    '--no-session-persistence',
    // Isolate runs from the user's personal hooks, MCP servers and skills: they
    // add latency and can stall a headless run waiting on something interactive.
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--disable-slash-commands',
  ];
  if (job.engine.effort) argv.push('--effort', job.engine.effort);
  if (schema) argv.push('--json-schema', JSON.stringify(schema));
  if (allowedTools?.length) argv.push('--allowedTools', ...allowedTools);
  return { bin: tools.claude.path, argv };
}

function trackUsage(job, batch, ev) {
  if (ev.type !== 'result') return;
  const u = ev.usage || {};
  const cost = ev.total_cost_usd || 0;
  job.stats.costUsd += cost;
  job.stats.inputTokens += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  job.stats.outputTokens += u.output_tokens || 0;
  if (batch) {
    batch.costUsd = cost;
    batch.durationMs = ev.duration_ms || 0;
    batch.turns = ev.num_turns || 0;
  }
}

function handleStreamEvent(job, batch, ev) {
  if (ev.type === 'assistant') {
    for (const block of ev.message?.content || []) {
      if (block.type === 'tool_use') activity(job, batch, 'tool', describeToolUse(block.name, block.input));
      else if (block.type === 'text' && block.text.trim()) activity(job, batch, 'say', block.text.trim().split('\n')[0]);
    }
  } else if (ev.type === 'system' && ev.subtype === 'task_summary' && ev.detail) {
    activity(job, batch, 'note', ev.detail);
  } else if (ev.type === 'result') {
    trackUsage(job, batch, ev);
  }
}

async function snippetFor(job, filePath, start, end) {
  const content = await fileContent(job.repo, job.target, filePath);
  if (content == null) return null;
  const lines = content.split('\n');
  const from = Math.max(1, start - 3);
  const to = Math.min(lines.length, end + 3);
  return { from, lines: lines.slice(from - 1, to), total: lines.length };
}

async function acceptFindings(job, batch, structured) {
  const batchPaths = batch.files.map((f) => (typeof f === 'string' ? f : f.path));
  const allowed = new Set(batchPaths);
  for (const raw of structured.findings || []) {
    let p = String(raw.path || '').replace(/^\.\//, '');
    if (!allowed.has(p)) {
      const match = [...allowed].find((a) => a.endsWith('/' + p) || p.endsWith('/' + a));
      if (!match) continue;
      p = match;
    }
    let start = Math.max(1, Number(raw.start_line) || 1);
    let end = Math.max(start, Number(raw.end_line) || start);
    const snip = await snippetFor(job, p, start, end);
    if (snip) {
      start = Math.min(start, snip.total);
      end = Math.min(end, snip.total);
    }
    job.findings.push({
      id: `f${job.findings.length + 1}`,
      path: p,
      start_line: start,
      end_line: end,
      severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'medium',
      category: CATEGORIES.includes(raw.category) ? raw.category : 'other',
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : null,
      title: String(raw.title || '').slice(0, 160) || String(raw.content || '').split('\n')[0].slice(0, 120),
      content: String(raw.content || ''),
      existing_code: raw.existing_code || '',
      suggestion_code: raw.suggestion_code || '',
      snippet: snip ? { from: snip.from, lines: snip.lines } : null,
      mark: 'open',
      fix: null,
      batch: batch.id,
    });
  }
  const reported = new Map((structured.files || []).map((f) => [String(f.path).replace(/^\.\//, ''), f]));
  for (const p of batchPaths) {
    const f = job.files.find((x) => x.path === p);
    if (!f) continue;
    const r = reported.get(p);
    f.state = r?.status === 'skipped' ? 'skipped' : 'reviewed';
    f.reason = r?.reason || '';
  }
}

async function runClaude(job) {
  const tools = await detectTools();
  const settings = loadSettings();

  job.phase = 'Matching review rules';
  activity(job, null, 'step', `Matching Open Code Review rules for ${job.files.length} file(s)`);
  const groups = await resolveRules(job.repo, job.files.map((f) => f.path));
  const planned = planBatches(job.files, groups, settings.filesPerBatch);
  job.batches = planned.map((b, i) => ({
    id: i + 1,
    files: b.files.map((f) => f.path),
    pattern: b.pattern,
    state: 'queued',
    activity: [],
    costUsd: 0,
    durationMs: 0,
    error: null,
  }));
  for (const b of job.batches) for (const p of b.files) job.files.find((f) => f.path === p).batch = b.id;
  activity(job, null, 'step', `Split into ${job.batches.length} review batch(es) by rule group; running ${job.engine.concurrency} at a time with Claude ${job.engine.model}`);
  job.phase = 'Reviewing';
  touch(job, { save: true });

  let next = 0;
  const worker = async () => {
    while (job.status === 'running' && next < job.batches.length) {
      const batch = job.batches[next];
      const plan = planned[next];
      next++;
      batch.state = 'running';
      batch.startedAt = Date.now();
      for (const p of batch.files) job.files.find((f) => f.path === p).state = 'reviewing';
      activity(job, batch, 'step', `Batch ${batch.id}: reviewing ${batch.files.join(', ')}`);
      try {
        const prompt = await buildPrompt(job, { ...batch, files: plan.files, rule: plan.rule });
        const args = claudeArgs(tools, job, { schema: FINDINGS_SCHEMA, toolList: 'Read,Grep,Glob', permissionMode: 'dontAsk' });
        const { result, error } = await spawnClaude(job, args, prompt, (ev) => handleStreamEvent(job, batch, ev));
        if (job.status !== 'running') {
          batch.state = 'cancelled';
          break;
        }
        const structured = result?.structured_output || tryParse(result?.result);
        if (!structured || result?.is_error) throw new Error(error || result?.result || 'Claude did not return a structured result');
        await acceptFindings(job, batch, structured);
        batch.state = 'done';
        const n = job.findings.filter((f) => f.batch === batch.id).length;
        activity(job, batch, 'done', `Batch ${batch.id} finished: ${n} finding(s)`);
      } catch (err) {
        batch.state = 'failed';
        batch.error = String(err.message || err);
        for (const p of batch.files) {
          const f = job.files.find((x) => x.path === p);
          f.state = 'failed';
          f.reason = batch.error.slice(0, 200);
        }
        activity(job, batch, 'error', `Batch ${batch.id} failed: ${batch.error.split('\n')[0]}`);
      }
      touch(job, { save: true });
    }
  };
  await Promise.all(Array.from({ length: Math.min(job.engine.concurrency, job.batches.length) }, worker));
  if (job.status === 'running' && job.batches.every((b) => b.state === 'failed')) {
    job.status = 'failed';
    job.error = job.batches[0]?.error || 'All batches failed';
  }
  activity(job, null, 'step', `Review complete: ${job.findings.length} finding(s)`);
}

function tryParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------- OCR built-in engine

async function runOcrNative(job) {
  const tools = await detectTools();
  const t = job.target;
  const args = t.kind === 'scan' ? ['scan'] : ['review'];
  args.push('--format', 'json', '--audience', 'human', '--repo', job.repo, '--color', 'never');
  if (t.kind === 'scan') args.push('--path', job.files.map((f) => f.path).join(','));
  else args.push(...targetArgs(t));
  const excluded = [];
  if (t.kind !== 'scan') {
    const selected = new Set(job.files.map((f) => f.path));
    const preview = await previewTarget({ repo: job.repo, target: t, exclude: job.exclude });
    for (const f of preview.reviewable) if (!selected.has(f.path)) excluded.push(f.path);
  }
  const ex = [job.exclude, ...excluded].filter(Boolean).join(',');
  if (ex) args.push('--exclude', ex);
  if (job.background) args.push('--background', job.background);
  if (job.engine.effort && t.kind !== 'scan' && ['low', 'medium', 'high'].includes(job.engine.effort)) args.push('--effort', job.engine.effort);

  job.batches = [{ id: 1, files: job.files.map((f) => f.path), pattern: 'OCR agent', state: 'running', activity: [], costUsd: 0, durationMs: 0, error: null, startedAt: Date.now() }];
  for (const f of job.files) {
    f.state = 'reviewing';
    f.batch = 1;
  }
  job.phase = 'Reviewing';
  const batch = job.batches[0];
  activity(job, batch, 'step', `Running: ocr ${args.slice(0, 2).join(' ')} …`);

  const out = await new Promise((resolve) => {
    const child = spawn(tools.ocr.path, args, { cwd: job.repo, env: { ...process.env, NO_COLOR: '1' } });
    job._children.add(child);
    let stdout = '';
    let errBuf = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      errBuf += d;
      let i;
      while ((i = errBuf.search(/[\r\n]/)) >= 0) {
        const line = errBuf.slice(0, i).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
        errBuf = errBuf.slice(i + 1);
        if (line) activity(job, batch, 'tool', line);
      }
    });
    child.on('error', (err) => {
      job._children.delete(child);
      resolve({ code: -1, stdout: '', error: String(err.message || err) });
    });
    child.on('close', (code) => {
      job._children.delete(child);
      resolve({ code, stdout });
    });
  });
  if (job.status !== 'running') return;
  const data = tryParse(out.stdout);
  if (!data) throw new Error(out.error || 'ocr did not return JSON output');
  if (data.summary) {
    job.stats.inputTokens = data.summary.input_tokens || 0;
    job.stats.outputTokens = data.summary.output_tokens || 0;
  }
  await acceptFindings(job, batch, {
    findings: (data.comments || []).map((c) => ({ ...c, title: '' })),
    files: [],
  });
  batch.state = data.status === 'failed' ? 'failed' : 'done';
  if (data.status === 'failed') throw new Error(data.message || 'ocr review failed');
}

// ---------------------------------------------------------------- marks and fixes

export function markFinding(jobId, findingId, mark) {
  const job = getJob(jobId);
  const f = job?.findings.find((x) => x.id === findingId);
  if (!f) return null;
  f.mark = ['open', 'fixed', 'ignored'].includes(mark) ? mark : 'open';
  touch(job, { save: true });
  return f;
}

// ---------------------------------------------------------------- safe fixing
//
// Every fix goes through: guardrail check → Claude edits → an independent
// read-only Claude verifies the patch → applied only if judged safe (or the
// user approves it). Each request is a "round" whose touched files are backed
// up first, so a whole round can be rolled back exactly.

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const IN_FLIGHT = ['queued', 'running', 'checking'];

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['safe', 'risky', 'wrong'] },
    reason: { type: 'string', description: 'One or two sentences a developer can act on.' },
  },
  required: ['verdict', 'reason'],
};

// mode "auto": apply fixes the verifier calls safe, hold risky ones for approval.
// mode "ask": hold every fix for approval.
export async function requestFix(jobId, findingIds, mode = 'auto', instructions = '') {
  const job = getJob(jobId);
  if (!job) throw new Error('Review not found');
  const tools = await detectTools();
  if (!tools.claude) throw new Error('Claude Code was not found.');
  const round = { id: `r${Date.now()}`, at: new Date().toISOString(), mode: mode === 'ask' ? 'ask' : 'auto', backups: {}, check: null, status: 'running' };
  const queued = [];
  for (const id of findingIds) {
    const f = job.findings.find((x) => x.id === id);
    if (!f || IN_FLIGHT.includes(f.fix?.status)) continue;
    f.fix = { status: 'queued', log: [], diff: '', error: null, round: round.id, mode: round.mode, instructions: String(instructions || '').slice(0, 2000) };
    queued.push(f);
  }
  if (!queued.length) return [];
  if (!job.fixRounds) job.fixRounds = [];
  job.fixRounds.push(round);
  if (!job._fixLocks) job._fixLocks = new Set();
  touch(job, { save: true });
  pumpFixes(job, tools);
  return queued.map((f) => f.id);
}

// Parallel across files, strictly sequential within one file, so edits never
// race and each fix's before/after patch stays exact.
function pumpFixes(job, tools) {
  const limit = loadSettings().concurrency;
  for (const f of job.findings) {
    if (job._fixLocks.size >= limit) break;
    if (f.fix?.status !== 'queued' || job._fixLocks.has(f.path)) continue;
    job._fixLocks.add(f.path);
    runFix(job, tools, f)
      .catch((err) => {
        f.fix.status = 'failed';
        f.fix.error = String(err.message || err);
      })
      .finally(() => {
        job._fixLocks.delete(f.path);
        touch(job, { save: true });
        finishRoundIfDone(job, f.fix.round).catch((err) => console.error('finishRoundIfDone failed:', err));
        pumpFixes(job, tools);
      });
  }
}

export function cancelFixes(jobId) {
  const job = getJob(jobId);
  if (!job) return 0;
  let n = 0;
  for (const f of job.findings) {
    if (f.fix?.status === 'queued') {
      f.fix = null;
      n++;
    }
  }
  for (const r of job.fixRounds || []) if (r.status === 'running') finishRoundIfDone(job, r.id);
  touch(job, { save: true });
  return n;
}

export function markFindings(jobId, ids, mark) {
  const job = getJob(jobId);
  if (!job) return 0;
  const m = ['open', 'fixed', 'ignored'].includes(mark) ? mark : 'open';
  let n = 0;
  for (const f of job.findings) {
    if (ids.includes(f.id)) {
      f.mark = m;
      n++;
    }
  }
  touch(job, { save: true });
  return n;
}

function readOrNull(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function backupFile(job, round, rel) {
  if (round.backups[rel]) return;
  const dir = path.join(BACKUP_DIR, job.id, round.id);
  fs.mkdirSync(dir, { recursive: true });
  const content = readOrNull(path.join(job.repo, rel));
  const name = `${Object.keys(round.backups).length}.orig`;
  if (content != null) fs.writeFileSync(path.join(dir, name), content);
  round.backups[rel] = content == null ? { missing: true } : { file: name };
}

async function makePatch(before, after, rel) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-studio-'));
  try {
    fs.writeFileSync(path.join(dir, 'before'), before ?? '');
    fs.writeFileSync(path.join(dir, 'after'), after ?? '');
    const d = await run('git', ['diff', '--no-index', '--no-color', '-U3', 'before', 'after'], { cwd: dir });
    return d.stdout
      .replace(/^diff --git .*$/m, `diff --git a/${rel} b/${rel}`)
      .replace(/^--- a\/before$/m, `--- a/${rel}`)
      .replace(/^\+\+\+ b\/after$/m, `+++ b/${rel}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function applyPatch(job, patch, reverse, check = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-studio-'));
  try {
    const file = path.join(dir, 'fix.patch');
    fs.writeFileSync(file, patch.endsWith('\n') ? patch : patch + '\n');
    return await run('git', ['apply', ...(reverse ? ['-R'] : []), ...(check ? ['--check'] : []), '--whitespace=nowarn', file], { cwd: job.repo });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function findingBrief(f) {
  return `File: ${f.path} (lines ${f.start_line}-${f.end_line})
Severity: ${f.severity} · Category: ${f.category}
Finding: ${f.title}
${f.content}${f.existing_code ? `\n\nProblematic code:\n\`\`\`\n${f.existing_code}\n\`\`\`` : ''}${f.suggestion_code ? `\n\nSuggested replacement (from the reviewer, may be wrong):\n\`\`\`\n${f.suggestion_code}\n\`\`\`` : ''}${
    f.fix?.instructions ? `\n\nThe developer's instructions for this fix. Follow them; they override the reviewer's suggestion:\n<instructions>\n${f.fix.instructions}\n</instructions>` : ''
  }`;
}

function notesBlock(guard) {
  return guard.notes ? `\n\nProject notes from the developer. These override the finding when they conflict:\n<notes>\n${guard.notes}\n</notes>` : '';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SNAPSHOT_MAX_FILES = 2000;
const SNAPSHOT_MAX_BYTES = 2_000_000;

// Contents of every file that already differs from HEAD, so an edit the fixer
// makes outside its target can be put back exactly. Clean files need no copy:
// HEAD has them.
async function dirtySnapshot(repo) {
  const r = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo, timeoutMs: 30_000 });
  const snap = new Map();
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length && snap.size < SNAPSHOT_MAX_FILES; i++) {
    const e = parts[i];
    if (!e) continue;
    const code = e.slice(0, 2);
    const rel = e.slice(3);
    // Renames and copies are followed by their source path as a separate entry.
    if (code[0] === 'R' || code[0] === 'C') i++;
    try {
      const abs = path.join(repo, rel);
      snap.set(rel, fs.existsSync(abs) && fs.statSync(abs).size > SNAPSHOT_MAX_BYTES ? undefined : readOrNull(abs));
    } catch {
      snap.set(rel, undefined);
    }
  }
  return snap;
}

async function baselineFor(repo, snap, rel) {
  if (snap.has(rel)) return snap.get(rel);
  const r = await run('git', ['show', `HEAD:${rel}`], { cwd: repo, timeoutMs: 15_000 });
  return r.code === 0 ? r.stdout : null;
}

const relInRepo = (repo, p) => {
  const abs = path.resolve(repo, String(p || ''));
  return abs.startsWith(path.resolve(repo) + path.sep) ? path.relative(repo, abs) : null;
};

async function runFix(job, tools, f) {
  if (!job._children) job._children = new Set();
  const round = (job.fixRounds || []).find((r) => r.id === f.fix.round);
  const guard = loadGuard(job.repo);
  const log = (kind, text) => {
    f.fix.log.push({ at: Date.now(), kind, text: String(text).slice(0, 400) });
    touch(job);
  };

  const rule = protectedBy(guard, f.path);
  if (rule) {
    f.fix.status = 'blocked';
    f.fix.error = `${f.path} is protected by your guardrail "${rule}". Fix it by hand if it really needs changing.`;
    return;
  }

  f.fix.status = 'running';
  touch(job);
  const abs = path.join(job.repo, f.path);
  const before = readOrNull(abs);
  if (round) backupFile(job, round, f.path);
  const snapshot = await dirtySnapshot(job.repo);

  const prompt = `Apply a minimal, safe fix for this code review finding. Edit only ${f.path} (edits to any other file are denied), and only what the finding needs; keep the existing style. Do not refactor, rename, reorder or "tidy" anything else, do not add comments that narrate the change, and do not run commands.

${findingBrief(f)}${notesBlock(guard)}

Before editing:
1. Read the file and the code around the lines, including comments. If a comment explains why the code is the way it is, or warns against changing it, respect it.
2. Use Grep to check how the code is used. Make sure your change keeps every caller working.
3. Leave the code unchanged and explain why in one sentence if any of these is true:
   - the finding is wrong, or already fixed
   - a correct fix needs changes in other files
   - fixing it would change connection or session lifecycle, callback or delegate ordering, threading, TLS or certificate handling, authentication, keys or tokens, server addresses, persistence, build or deploy configuration, or a public API, and you can't fully verify the effect from the code

Finish with a one-sentence summary of what you changed.`;
  // Claude Code itself only allows editing the target file. Permission rules
  // are glob patterns, so a path with glob characters can't be expressed
  // literally; those runs fall back to accepting edits and rely on the
  // stray-edit check below.
  const literal = !/[*?[\]{}()!\\]/.test(f.path);
  const args = claudeArgs(tools, job, {
    schema: null,
    toolList: 'Read,Edit,Grep,Glob',
    permissionMode: literal ? 'dontAsk' : 'acceptEdits',
    allowedTools: literal ? ['Read', 'Grep', 'Glob', `Edit(./${f.path})`] : null,
  });
  const edited = new Set();
  const { result, error } = await spawnClaude(job, args, prompt, (ev) => {
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'tool_use') {
          if (EDIT_TOOLS.has(block.name)) {
            const rel = relInRepo(job.repo, block.input?.file_path || block.input?.notebook_path);
            if (rel) edited.add(rel);
          }
          log('tool', block.name === 'Edit' ? `Editing ${relInRepo(job.repo, block.input?.file_path) || f.path}` : describeToolUse(block.name, block.input));
        } else if (block.type === 'text' && block.text.trim()) log('say', block.text.trim());
      }
    } else if (ev.type === 'result') {
      job.stats.costUsd += ev.total_cost_usd || 0;
    }
  });
  f.fix.summary = result?.result || '';
  await undoStrayEdits(job, f, edited, snapshot, result, log);
  const after = readOrNull(abs);
  if (error && !result) {
    if (after !== before && before != null) fs.writeFileSync(abs, before);
    f.fix.status = 'failed';
    f.fix.error = error;
    return;
  }
  if (after === before) {
    f.fix.status = 'unchanged';
    return;
  }
  f.fix.diff = await makePatch(before, after, f.path);

  // Independent second opinion on the actual patch, while it is on disk so
  // the checker can read the result in context.
  f.fix.status = 'checking';
  log('step', 'Double-checking the change with a separate Claude run…');
  f.fix.verdict = await verifyPatch(job, tools, f, guard, log, false);

  const keep = f.fix.verdict.verdict === 'safe' && f.fix.mode === 'auto';
  if (keep) {
    f.fix.status = 'applied';
    f.mark = 'fixed';
    return;
  }
  // Take the edit back out; it stays available as a proposal.
  if (readOrNull(abs) === after) {
    if (before == null) fs.rmSync(abs, { force: true });
    else fs.writeFileSync(abs, before);
  } else {
    const r = await applyPatch(job, f.fix.diff, true);
    if (r.code !== 0) {
      // The file changed again while the checker ran. The edit is still on
      // disk, so say so rather than presenting it as an untouched proposal.
      f.fix.status = 'failed';
      f.fix.error = `The ${f.fix.verdict.verdict === 'wrong' ? 'rejected' : 'unapproved'} change could not be taken back out because ${f.path} changed in the meantime, so it is still in the file. Use “Undo whole batch” to restore it. (${r.stderr.trim().split('\n')[0]})`;
      return;
    }
  }
  f.fix.status = f.fix.verdict.verdict === 'wrong' ? 'rejected' : 'proposed';
}

// Puts back any file the fixer edited other than its target. Edits Claude
// Code denied never reached the disk and need nothing.
async function undoStrayEdits(job, f, edited, snapshot, result, log) {
  const denied = new Set((result?.permission_denials || []).map((d) => relInRepo(job.repo, d.tool_input?.file_path || d.tool_input?.notebook_path)).filter(Boolean));
  const strays = [];
  for (const rel of edited) {
    if (rel === f.path || denied.has(rel)) continue;
    const abs = path.join(job.repo, rel);
    // Another fix in this review owns that file right now; reverting would
    // destroy its work, so only report it.
    if (job._fixLocks?.has(rel)) {
      strays.push({ path: rel, restored: false });
      continue;
    }
    const base = await baselineFor(job.repo, snapshot, rel);
    if (base === undefined) {
      strays.push({ path: rel, restored: false });
      continue;
    }
    if (readOrNull(abs) === base) continue;
    if (base == null) fs.rmSync(abs, { force: true });
    else fs.writeFileSync(abs, base);
    strays.push({ path: rel, restored: true });
  }
  if (!strays.length) return;
  f.fix.strays = strays;
  const restored = strays.filter((s) => s.restored).map((s) => s.path);
  const kept = strays.filter((s) => !s.restored).map((s) => s.path);
  log('step', `Claude also edited ${strays.map((s) => s.path).join(', ')}${restored.length ? `; put back ${restored.join(', ')}` : ''}`);
  f.fix.warning = [
    restored.length ? `Claude also edited ${restored.join(', ')}. Only ${f.path} may change, so ${restored.length === 1 ? 'that edit was' : 'those edits were'} undone.` : '',
    kept.length ? `Claude also edited ${kept.join(', ')} and it could not be restored automatically; check ${kept.length === 1 ? 'it' : 'them'} by hand.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function verifyPatch(job, tools, f, guard, log, alreadyApplied) {
  const vPrompt = `You are checking an automatic code change ${alreadyApplied ? 'that was applied earlier without review. The file may have changed since, and later commits may already have corrected it.' : 'before it is kept.'} Be skeptical: a wrong "safe" verdict can break the product, while "risky" only means a person looks at it.

The change was meant to fix this review finding:
${findingBrief(f)}${notesBlock(guard)}

The patch, already applied to ${f.path} on disk:
\`\`\`diff
${f.fix.diff.slice(0, 20000)}
\`\`\`

Read the changed file and use Grep to check callers, delegates and related code. Then give one verdict:
- "wrong": the patch doesn't fix the finding, introduces a bug, wouldn't compile, or the finding was a false positive.
- "risky": the patch could change behavior beyond the finding (for example connection, session or socket lifecycle; callback or delegate ordering; threading; TLS or certificate handling; authentication, tokens or keys; server addresses; persistence; build or deploy settings; a public API), or it goes against a comment in the code, or you can't confirm it is safe.
- "safe": a local change whose effect you checked, and it only fixes the finding.`;
  const vArgs = claudeArgs(tools, job, { schema: VERDICT_SCHEMA, toolList: 'Read,Grep,Glob', permissionMode: 'dontAsk' });
  const v = await spawnClaude(job, vArgs, vPrompt, (ev) => {
    if (ev.type === 'assistant') for (const b of ev.message?.content || []) if (b.type === 'tool_use') log('tool', `Checker: ${describeToolUse(b.name, b.input)}`);
    if (ev.type === 'result') job.stats.costUsd += ev.total_cost_usd || 0;
  });
  const verdict = v.result?.structured_output || tryParse(v.result?.result) || { verdict: 'risky', reason: `The checker didn't answer (${(v.error || 'no result').split('\n')[0]}), so this needs a person to look.` };
  return { verdict: ['safe', 'risky', 'wrong'].includes(verdict.verdict) ? verdict.verdict : 'risky', reason: String(verdict.reason || '') };
}

// Second-opinion pass over fixes that were applied without one (older
// reviews). Read-only: it only records a verdict on each fix.
export async function auditApplied(jobId) {
  const job = getJob(jobId);
  if (!job) throw new Error('Review not found');
  const tools = await detectTools();
  if (!tools.claude) throw new Error('Claude Code was not found.');
  const todo = job.findings.filter((f) => f.fix?.status === 'applied' && f.fix.diff && !f.fix.verdict && !['queued', 'running'].includes(f.fix.audit?.status));
  for (const f of todo) f.fix.audit = { status: 'queued' };
  touch(job, { save: true });
  const guard = loadGuard(job.repo);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++];
      if (f.fix?.audit?.status !== 'queued') continue;
      f.fix.audit.status = 'running';
      touch(job);
      try {
        const v = await verifyPatch(job, tools, f, guard, () => {}, true);
        f.fix.audit = { status: 'done', ...v };
      } catch (err) {
        f.fix.audit = { status: 'done', verdict: 'risky', reason: `Check failed: ${err.message}` };
      }
      touch(job, { save: true });
    }
  };
  Promise.all(Array.from({ length: Math.min(loadSettings().concurrency, todo.length) }, worker)).catch((err) => console.error('auditApplied failed:', err));
  return { queued: todo.length };
}

async function finishRoundIfDone(job, roundId) {
  const round = (job.fixRounds || []).find((r) => r.id === roundId);
  if (!round || round.status !== 'running') return;
  if (job.findings.some((f) => f.fix?.round === roundId && IN_FLIGHT.includes(f.fix.status))) return;
  const applied = job.findings.filter((f) => f.fix?.round === roundId && f.fix.status === 'applied').length;
  round.status = 'done';
  const guard = loadGuard(job.repo);
  if (applied && guard.checkCommand) await runCheck(job, round, guard.checkCommand);
  touch(job, { save: true });
}

// Runs the developer's own build/test command after a round of fixes.
async function runCheck(job, round, command) {
  round.check = { status: 'running', command, output: '', startedAt: Date.now() };
  touch(job, { save: true });
  const r = await run('/bin/sh', ['-lc', command], { cwd: job.repo, timeoutMs: 20 * 60_000 });
  round.check.status = r.code === 0 ? 'passed' : 'failed';
  round.check.code = r.code;
  round.check.output = (r.stdout + '\n' + r.stderr).trim().slice(-6000);
  round.check.durationMs = Date.now() - round.check.startedAt;
  touch(job, { save: true });
}

export async function recheckRound(jobId, roundId) {
  const job = getJob(jobId);
  const round = job?.fixRounds?.find((r) => r.id === roundId);
  const guard = job && loadGuard(job.repo);
  if (!round || !guard?.checkCommand) throw new Error('Set a check command in this project’s guardrails first');
  runCheck(job, round, guard.checkCommand).catch((err) => console.error('recheckRound failed:', err));
  return { ok: true };
}

export async function applyProposal(jobId, findingId) {
  const job = getJob(jobId);
  const f = job?.findings.find((x) => x.id === findingId);
  if (!f?.fix?.diff || !['proposed', 'rejected'].includes(f.fix.status)) throw new Error('No proposed change to apply');
  const round = job.fixRounds?.find((r) => r.id === f.fix.round);
  if (round) backupFile(job, round, f.path);
  const r = await applyPatch(job, f.fix.diff, false);
  if (r.code !== 0) throw new Error(`The file changed since this fix was proposed, so it no longer applies. Run “Fix with Claude” again. (${r.stderr.trim().split('\n')[0]})`);
  f.fix.status = 'applied';
  f.fix.approved = true;
  f.mark = 'fixed';
  touch(job, { save: true });
  return f;
}

export function discardProposal(jobId, findingId) {
  const job = getJob(jobId);
  const f = job?.findings.find((x) => x.id === findingId);
  if (!f?.fix || !['proposed', 'rejected', 'blocked', 'unchanged', 'failed'].includes(f.fix.status)) throw new Error('Nothing to discard');
  f.fix = null;
  touch(job, { save: true });
  return f;
}

export async function revertFix(jobId, findingId) {
  const job = getJob(jobId);
  const f = job?.findings.find((x) => x.id === findingId);
  if (!f?.fix?.diff || f.fix.status !== 'applied') throw new Error('No applied fix to undo');
  // Older reviews stored the patch with before/after file names.
  const patch = f.fix.diff
    .replace(/^diff --git a\/before b\/after$/m, `diff --git a/${f.path} b/${f.path}`)
    .replace(/^--- a\/before$/m, `--- a/${f.path}`)
    .replace(/^\+\+\+ b\/after$/m, `+++ b/${f.path}`);
  const r = await applyPatch(job, patch, true);
  if (r.code !== 0) throw new Error(`Could not undo this one fix on its own (a later change touched the same lines). Use “Undo whole batch” instead. ${r.stderr.trim().split('\n')[0]}`);
  f.fix.status = 'reverted';
  f.mark = 'open';
  touch(job, { save: true });
  return f;
}

// Restores every file the round touched to its exact content from before the
// round, regardless of how the individual patches overlap.
export function undoRound(jobId, roundId) {
  const job = getJob(jobId);
  const round = job?.fixRounds?.find((r) => r.id === roundId);
  if (!round) throw new Error('Batch not found');
  if (job.findings.some((f) => f.fix?.round === roundId && IN_FLIGHT.includes(f.fix.status))) throw new Error('Wait for this batch to finish first');
  const dir = path.join(BACKUP_DIR, job.id, round.id);
  let restored = 0;
  for (const [rel, b] of Object.entries(round.backups || {})) {
    const abs = path.join(job.repo, rel);
    if (b.missing) fs.rmSync(abs, { force: true });
    else fs.writeFileSync(abs, fs.readFileSync(path.join(dir, b.file), 'utf8'));
    restored++;
  }
  for (const f of job.findings) {
    if (f.fix?.round === roundId && f.fix.status === 'applied') {
      f.fix.status = 'reverted';
      f.mark = 'open';
    }
  }
  round.status = 'undone';
  touch(job, { save: true });
  return { restored };
}

// ---------------------------------------------------------------- talk to findings

// Read-only question about one finding. The answer is stored on the finding so
// the conversation survives reloads.
export async function askFinding(jobId, findingId, question) {
  const job = getJob(jobId);
  const f = job?.findings.find((x) => x.id === findingId);
  if (!f) throw Object.assign(new Error('Finding not found'), { status: 404 });
  const q = String(question || '').trim().slice(0, 2000);
  if (!q) throw Object.assign(new Error('Type a question first'), { status: 400 });
  const tools = await detectTools();
  if (!tools.claude) throw new Error('Claude Code was not found.');
  if (!job._children) job._children = new Set();
  const entry = { id: `q${Date.now()}`, q, a: '', status: 'running', at: new Date().toISOString(), steps: [] };
  f.thread = [...(f.thread || []), entry];
  touch(job, { save: true });

  const guard = loadGuard(job.repo);
  const earlier = (f.thread || [])
    .filter((t) => t !== entry && t.status === 'done')
    .slice(-4)
    .map((t) => `Q: ${t.q}\nA: ${t.a}`)
    .join('\n\n');
  const prompt = `A developer is triaging a code review finding and has a question. Answer it directly and concisely in Markdown (a few short paragraphs or bullets at most). Cite code as path:line. You may Read, Grep and Glob the repository; do not modify anything.

${findingBrief(f)}${notesBlock(guard)}${earlier ? `\n\nEarlier questions about this finding:\n${earlier}` : ''}

Question: ${q}`;
  const args = claudeArgs(tools, job, { schema: null, toolList: 'Read,Grep,Glob', permissionMode: 'dontAsk' });
  spawnClaude(job, args, prompt, (ev) => {
    if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) if (b.type === 'tool_use') entry.steps.push(describeToolUse(b.name, b.input));
      touch(job);
    } else if (ev.type === 'result') job.stats.costUsd += ev.total_cost_usd || 0;
  }).then(({ result, error }) => {
    entry.a = result?.result || '';
    entry.status = result && !result.is_error ? 'done' : 'failed';
    if (entry.status === 'failed') entry.a = entry.a || (error || 'No answer').slice(0, 600);
    touch(job, { save: true });
  });
  return entry;
}

export function ignoreFinding(jobId, findingId, reason, remember) {
  const job = getJob(jobId);
  const f = job?.findings.find((x) => x.id === findingId);
  if (!f) throw Object.assign(new Error('Finding not found'), { status: 404 });
  f.mark = 'ignored';
  f.ignoreReason = String(reason || '').slice(0, 1000);
  if (remember && f.ignoreReason) {
    addLearned(job.repo, { path: f.path, title: f.title, category: f.category, reason: f.ignoreReason });
    f.learned = true;
  }
  touch(job, { save: true });
  return f;
}

// ---------------------------------------------------------------- verify & compare

export async function startVerification(jobId) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
  const fixed = [...new Set(job.findings.filter((f) => f.fix?.status === 'applied' || f.mark === 'fixed').map((f) => f.path))];
  if (!fixed.length) throw Object.assign(new Error('No fixed findings to verify yet'), { status: 400 });
  return startReview({
    repo: job.repo,
    target: { kind: 'scan', paths: fixed },
    files: fixed,
    engine: job.engine,
    focus: job.focus,
    background: job.background,
    label: 'Verify fixes',
    verifies: job.id,
  });
}

const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
const jaccard = (a, b) => {
  const inter = [...a].filter((w) => b.has(w)).length;
  return inter / Math.max(1, new Set([...a, ...b]).size);
};

// Score how likely two findings describe the same problem. Line numbers move
// when fixes land, so wording carries most of the weight.
function matchScore(a, b) {
  if (a.path !== b.path) return 0;
  const title = jaccard(words(a.title), words(b.title));
  const text = jaccard(words(`${a.title} ${a.content}`), words(`${b.title} ${b.content}`));
  const dist = Math.abs((a.start_line || 0) - (b.start_line || 0));
  const sameCat = a.category === b.category;
  const ok = title >= 0.4 || text >= 0.3 || (dist <= 3 && sameCat && text >= 0.15);
  return ok ? title + text + (dist <= 3 ? 0.2 : 0) + (sameCat ? 0.1 : 0) : 0;
}

// Pairs findings across two reviews of the same code, best matches first.
export function compareReviews(afterId) {
  const after = getJob(afterId);
  if (!after?.verifies) throw Object.assign(new Error('This review is not a verification run'), { status: 400 });
  const before = getJob(after.verifies);
  if (!before) throw Object.assign(new Error('The original review was deleted'), { status: 404 });
  const reviewed = new Set(after.files.filter((f) => f.state === 'reviewed').map((f) => f.path));
  const candidates = before.findings.filter((f) => reviewed.has(f.path) && f.mark !== 'ignored');
  const pairs = [];
  for (const b of candidates) for (const a of after.findings) {
    const score = matchScore(b, a);
    if (score > 0) pairs.push({ b, a, score });
  }
  pairs.sort((x, y) => y.score - x.score);
  const matchOf = new Map();
  const used = new Set();
  for (const p of pairs) {
    if (matchOf.has(p.b.id) || used.has(p.a.id)) continue;
    matchOf.set(p.b.id, p.a);
    used.add(p.a.id);
  }
  const fixedish = (f) => f.fix?.status === 'applied' || f.mark === 'fixed';
  const resolved = [];
  const persisting = [];
  const stillOpen = [];
  for (const f of candidates) {
    const m = matchOf.get(f.id);
    if (fixedish(f)) (m ? persisting : resolved).push(m ? { before: brief(f), after: brief(m) } : { before: brief(f) });
    else if (m) stillOpen.push({ before: brief(f), after: brief(m) });
  }
  const fresh = after.findings.filter((a) => !used.has(a.id)).map((a) => ({ after: brief(a) }));
  return { before: { id: before.id, title: before.title }, resolved, persisting, stillOpen, new: fresh, done: after.status !== 'running' };
}

const brief = (f) => ({ id: f.id, path: f.path, start_line: f.start_line, title: f.title, severity: f.severity, category: f.category });

// ---------------------------------------------------------------- changes since the first fix

function originalsFor(job) {
  const originals = new Map();
  for (const r of job.fixRounds || []) {
    for (const [rel, b] of Object.entries(r.backups || {})) {
      if (originals.has(rel)) continue;
      const file = b.file ? path.join(BACKUP_DIR, job.id, r.id, b.file) : null;
      originals.set(rel, b.missing ? null : readOrNull(file));
    }
  }
  return originals;
}

function splitHunks(patch) {
  const lines = patch.split('\n');
  const hunks = [];
  let cur = null;
  for (const l of lines) {
    if (l.startsWith('@@')) {
      cur = { header: l, lines: [] };
      hunks.push(cur);
    } else if (cur && (l.startsWith('+') || l.startsWith('-') || l.startsWith(' ') || l.startsWith('\\'))) cur.lines.push(l);
  }
  return hunks.map((h) => ({ header: h.header, text: [h.header, ...h.lines].join('\n'), added: h.lines.filter((l) => l.startsWith('+')).length, removed: h.lines.filter((l) => l.startsWith('-')).length }));
}

export async function reviewChanges(jobId) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
  const originals = originalsFor(job);
  const files = [];
  for (const [rel, orig] of originals) {
    const cur = readOrNull(path.join(job.repo, rel));
    if (cur === orig) continue;
    const patch = await makePatch(orig, cur, rel);
    if (!patch.trim()) continue;
    const hunks = splitHunks(patch);
    const fixedHere = job.findings.filter((f) => f.path === rel && f.fix?.status === 'applied').map((f) => ({ id: f.id, title: f.title }));
    const committed = (await run('git', ['diff', '--quiet', 'HEAD', '--', rel], { cwd: job.repo })).code === 0;
    files.push({ path: rel, committed, patch, hunks, added: hunks.reduce((a, h) => a + h.added, 0), removed: hunks.reduce((a, h) => a + h.removed, 0), findings: fixedHere, deleted: cur == null, created: orig == null });
  }
  // Reviews fixed before backups existed only have the individual patches.
  const legacy = originals.size
    ? []
    : job.findings.filter((f) => f.fix?.status === 'applied' && f.fix.diff).map((f) => ({ id: f.id, path: f.path, title: f.title, patch: f.fix.diff }));
  return { files, legacy };
}

export async function revertHunk(jobId, rel, index) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
  const originals = originalsFor(job);
  if (!originals.has(rel)) throw Object.assign(new Error('That file was not changed by a fix'), { status: 400 });
  const cur = readOrNull(path.join(job.repo, rel));
  const patch = await makePatch(originals.get(rel), cur, rel);
  const hunks = splitHunks(patch);
  const h = hunks[Number(index)];
  if (!h) throw Object.assign(new Error('That change no longer exists. Refresh the list.'), { status: 409 });
  const lines = patch.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  const header = lines.slice(0, firstHunk < 0 ? lines.length : firstHunk).filter((l) => /^(diff --git|--- |\+\+\+ )/.test(l)).join('\n');
  const r = await applyPatch(job, `${header}\n${h.text}\n`, true);
  if (r.code !== 0) throw new Error(`Could not undo that change: ${r.stderr.trim().split('\n')[0]}`);
  // A fix whose patch can be applied again (but not reversed) is no longer in
  // the file, so its finding is open again.
  const reopened = [];
  for (const f of job.findings) {
    if (f.path !== rel || f.fix?.status !== 'applied' || !f.fix.diff) continue;
    const stillThere = (await applyPatch(job, f.fix.diff, true, true)).code === 0;
    const gone = !stillThere && (await applyPatch(job, f.fix.diff, false, true)).code === 0;
    if (gone) {
      f.fix.status = 'reverted';
      f.mark = 'open';
      reopened.push(f.id);
    }
  }
  touch(job, { save: true });
  return { ok: true, reopened };
}

export async function commitReviewChanges(jobId, message, paths) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
  const { commitPaths } = await import('./git.js');
  const res = await commitPaths(job.repo, message, paths);
  job.commits = [...(job.commits || []), { ...res, at: new Date().toISOString(), paths, message: String(message).split('\n')[0] }];
  touch(job, { save: true });
  return res;
}

// ---------------------------------------------------------------- exports

export async function exportReview(jobId, format) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('Review not found'), { status: 404 });
  const open = job.findings.filter((f) => f.mark !== 'ignored');
  if (format === 'json') {
    return {
      name: `${job.repoName}-${job.id}.json`,
      type: 'application/json',
      body: JSON.stringify(
        { review: { id: job.id, repo: job.repo, title: job.title, createdAt: job.createdAt, engine: job.engine }, findings: job.findings.map(({ snippet, fix, thread, ...f }) => ({ ...f, fix: fix ? { status: fix.status, verdict: fix.verdict, diff: fix.diff } : null })) },
        null,
        2
      ),
    };
  }
  if (format === 'sarif') {
    const level = { critical: 'error', high: 'error', medium: 'warning', low: 'note' };
    const rules = [...new Set(open.map((f) => f.category))];
    return {
      name: `${job.repoName}-${job.id}.sarif`,
      type: 'application/sarif+json',
      body: JSON.stringify(
        {
          $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
          version: '2.1.0',
          runs: [
            {
              tool: { driver: { name: 'OCR Studio', informationUri: 'https://github.com/alibaba/open-code-review', rules: rules.map((r) => ({ id: r, name: r })) } },
              results: open.map((f) => ({
                ruleId: f.category,
                level: level[f.severity] || 'warning',
                message: { text: `${f.title}\n\n${f.content}` },
                locations: [{ physicalLocation: { artifactLocation: { uri: f.path }, region: { startLine: f.start_line, endLine: f.end_line } } }],
                properties: { severity: f.severity, confidence: f.confidence || undefined, status: f.mark },
              })),
            },
          ],
        },
        null,
        2
      ),
    };
  }
  if (format === 'patch') {
    const { files, legacy } = await reviewChanges(jobId);
    const body = files.length ? files.map((f) => f.patch).join('') : legacy.map((l) => l.patch).join('');
    if (!body.trim()) throw Object.assign(new Error('No fixes have changed any files yet'), { status: 400 });
    return { name: `${job.repoName}-${job.id}.patch`, type: 'text/x-diff', body };
  }
  throw Object.assign(new Error('Unknown export format'), { status: 400 });
}

// ---------------------------------------------------------------- dashboard

export function allJobs() {
  const out = [];
  for (const f of fs.readdirSync(REVIEWS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const job = getJob(f.slice(0, -5));
    if (job) out.push(job);
  }
  return out;
}
