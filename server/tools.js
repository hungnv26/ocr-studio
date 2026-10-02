import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, HOME, readJSON, run, writeJSON } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_SETTINGS = {
  claudePath: '',
  ocrPath: '',
  model: 'sonnet',
  effort: 'medium',
  concurrency: 3,
  filesPerBatch: 4,
  editor: 'auto',
  recentRepos: [],
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  next.concurrency = Math.min(8, Math.max(1, Number(next.concurrency) || 3));
  next.filesPerBatch = Math.min(12, Math.max(1, Number(next.filesPerBatch) || 4));
  if (typeof next.editor !== 'string' || next.editor.length > 40) next.editor = 'auto';
  writeJSON(SETTINGS_FILE, next);
  return next;
}

export function rememberRepo(repo) {
  const s = loadSettings();
  const recent = [repo, ...s.recentRepos.filter((r) => r !== repo)].slice(0, 12);
  saveSettings({ recentRepos: recent });
}

function compareVersions(a, b) {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// A `claude` on PATH can be a stale x86_64 build that no longer runs on Apple
// silicon without Rosetta, so every candidate is executed before it is trusted.
function claudeCandidates() {
  const list = [];
  const s = loadSettings();
  if (s.claudePath) list.push(s.claudePath);
  if (process.env.CLAUDE_PATH) list.push(process.env.CLAUDE_PATH);
  const desktop = path.join(HOME, 'Library/Application Support/Claude/claude-code');
  try {
    const versions = fs.readdirSync(desktop).sort(compareVersions).reverse();
    for (const v of versions) {
      const vdir = path.join(desktop, v);
      for (const sub of fs.readdirSync(vdir)) {
        list.push(path.join(vdir, sub, 'claude.app/Contents/MacOS/claude'));
      }
      list.push(path.join(vdir, 'claude'));
    }
  } catch {}
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, 'claude'));
  }
  list.push(path.join(HOME, '.local/bin/claude'), path.join(HOME, '.claude/local/claude'), '/opt/homebrew/bin/claude');
  return [...new Set(list)].filter((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

function ocrCandidates() {
  const s = loadSettings();
  const list = [];
  if (s.ocrPath) list.push(s.ocrPath);
  list.push(path.join(ROOT, 'node_modules/.bin/ocr'));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, 'ocr'));
  }
  return [...new Set(list)].filter((p) => fs.existsSync(p));
}

let cache = null;

export async function detectTools(force = false) {
  if (cache && !force) return cache;
  const result = { claude: null, ocr: null, git: null, ocrNative: null };

  for (const p of claudeCandidates()) {
    const r = await run(p, ['--version'], { timeoutMs: 15_000 });
    if (r.code === 0) {
      result.claude = { path: p, version: r.stdout.trim().split('\n')[0] };
      break;
    }
  }
  for (const p of ocrCandidates()) {
    const r = await run(p, ['--version'], { timeoutMs: 15_000 });
    if (r.code === 0) {
      result.ocr = { path: p, version: r.stdout.trim().split('\n')[0] };
      break;
    }
  }
  const g = await run('git', ['--version']);
  if (g.code === 0) {
    const version = g.stdout.trim().replace(/^git version /, '');
    result.git = { path: 'git', version, ok: compareVersions(version, '2.41') >= 0 };
  }

  const cfg = readJSON(path.join(HOME, '.opencodereview/config.json'), null);
  if (cfg && (cfg.provider || cfg.model)) {
    result.ocrNative = { provider: cfg.provider || '', model: cfg.model || '' };
  }
  cache = result;
  return result;
}

export async function installOcr() {
  const r = await run('npm', ['install', '@alibaba-group/open-code-review@latest'], { cwd: ROOT, timeoutMs: 180_000 });
  cache = null;
  return r;
}
