import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJSON, run, writeJSON } from './util.js';

// Per-repository guardrails and project settings live outside the repo so
// OCR Studio never adds files to the user's project.
const DIR = path.join(DATA_DIR, 'repos');
fs.mkdirSync(DIR, { recursive: true });

const EMPTY = { notes: '', protected: [], checkCommand: '', learned: [], defaults: {} };

function fileFor(repo) {
  return path.join(DIR, crypto.createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 16) + '.json');
}

export function loadGuard(repo) {
  return { ...EMPTY, ...readJSON(fileFor(repo), {}) };
}

export function listGuards() {
  const out = [];
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith('.json')) continue;
    const g = readJSON(path.join(DIR, f), null);
    if (g?.repo) out.push({ ...EMPTY, ...g });
  }
  return out;
}

export function saveGuard(repo, patch) {
  const next = { ...loadGuard(repo), repo: path.resolve(repo) };
  if (typeof patch.notes === 'string') next.notes = patch.notes.slice(0, 8000);
  if (Array.isArray(patch.protected)) next.protected = [...new Set(patch.protected.map((p) => String(p).trim()).filter(Boolean))].slice(0, 200);
  if (typeof patch.checkCommand === 'string') next.checkCommand = patch.checkCommand.trim().slice(0, 2000);
  if (patch.defaults && typeof patch.defaults === 'object') {
    const d = {};
    if (['haiku', 'sonnet', 'opus'].includes(patch.defaults.model)) d.model = patch.defaults.model;
    if (['low', 'medium', 'high'].includes(patch.defaults.effort)) d.effort = patch.defaults.effort;
    next.defaults = d;
  }
  writeJSON(fileFor(repo), next);
  return next;
}

// "Not a bug, because…" answers. They are fed back to the reviewer so the same
// false positive isn't reported on the next scan.
export function addLearned(repo, entry) {
  const g = loadGuard(repo);
  const item = {
    path: String(entry.path || '').slice(0, 400),
    title: String(entry.title || '').slice(0, 200),
    category: String(entry.category || ''),
    reason: String(entry.reason || '').slice(0, 1000),
    at: new Date().toISOString(),
  };
  const learned = [item, ...(g.learned || []).filter((l) => !(l.path === item.path && l.title === item.title))].slice(0, 300);
  writeJSON(fileFor(repo), { ...g, repo: path.resolve(repo), learned });
  return item;
}

export function removeLearned(repo, index) {
  const g = loadGuard(repo);
  const learned = (g.learned || []).filter((_, i) => i !== Number(index));
  writeJSON(fileFor(repo), { ...g, repo: path.resolve(repo), learned });
  return learned;
}

export function learnedBlock(guard, paths) {
  const wanted = paths ? new Set(paths) : null;
  const items = (guard.learned || []).filter((l) => !wanted || wanted.has(l.path)).slice(0, 60);
  if (!items.length) return '';
  return `The developer already dismissed these findings as not real problems. Don't report them again unless the code changed so the reason no longer holds:\n${items
    .map((l) => `- ${l.path}: "${l.title}" (developer: ${l.reason || 'not a bug'})`)
    .join('\n')}`;
}

// gitignore-flavoured globs: a pattern without "/" matches at any depth,
// "dir/" covers everything below it, "**" spans directories.
export function globToRegExp(glob) {
  let g = glob.trim().replace(/^\.\//, '');
  const anyDepth = !g.replace(/\/$/, '').includes('/');
  const dirOnly = g.endsWith('/');
  g = g.replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${re}${dirOnly ? '/.*' : '(?:/.*)?'}$`);
}

export function protectedBy(guard, file) {
  for (const p of guard.protected || []) {
    try {
      if (globToRegExp(p).test(file)) return p;
    } catch {}
  }
  return null;
}

export const TEMPLATES = {
  ios: {
    label: 'iOS / Swift app',
    protected: ['**/*.xcconfig', '**/*.entitlements', '**/Info.plist', '*.xcodeproj/', 'Podfile', 'Podfile.lock', 'Package.resolved'],
    notes: `Don't change bundle identifiers, version or build numbers, entitlements, signing, or server addresses.
Networking: a cancelled or replaced URLSession task still delivers delegate callbacks. Don't invalidate sessions or reorder callbacks without asking.
Keep certificate and TLS handling as it is unless a finding is explicitly about it.`,
  },
  android: {
    label: 'Android / Kotlin / Java app',
    protected: ['*.gradle', '*.gradle.kts', 'gradle.properties', '**/AndroidManifest.xml', 'google-services.json', 'proguard-rules.pro'],
    notes: `Don't change applicationId, versionCode/versionName, signing config, permissions or server addresses.
Lifecycle: don't move work between threads or lifecycle callbacks (onCreate/onResume, observers) without asking.`,
  },
  node: {
    label: 'Node / backend service',
    protected: ['package.json', 'package-lock.json', 'pnpm-lock.yaml', '.env*', 'Dockerfile', 'docker-compose*.yml', '.github/workflows/', 'deploy/', 'migrations/'],
    notes: `Don't change environment variable names, ports, public API routes or response shapes, or database migrations.
Keep error messages and status codes stable unless the finding is about them.`,
  },
  web: {
    label: 'Web front end',
    protected: ['package.json', 'package-lock.json', 'vite.config.*', 'webpack.config.*', 'tsconfig.json', '.env*', 'public/'],
    notes: `Don't change API endpoints, routes, build configuration or third-party script loading.
Visual changes (CSS, layout) need my approval.`,
  },
  python: {
    label: 'Python service',
    protected: ['pyproject.toml', 'requirements*.txt', 'setup.py', 'setup.cfg', '.env*', 'Dockerfile', 'alembic/', 'migrations/'],
    notes: `Don't change public function signatures, settings names, or database migrations.
Keep exception types raised to callers stable unless the finding is about them.`,
  },
};

const SENSITIVE_NAME = /(socket|websocket|connection|network|reachab|http|apiclient|api_client|auth|login|session|token|oauth|crypto|keychain|secur|cert|tls|ssl|push|firebase|payment|billing)/i;
const CONFIG_FILE = /(\.(xcconfig|entitlements|plist|gradle|gradle\.kts|properties|env|toml)$|(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|Podfile|AndroidManifest\.xml|google-services\.json|GoogleService-Info\.plist|\.env[^/]*)$)/i;
const SENSITIVE_DIR = /^(deploy|deployment|infra|terraform|k8s|helm|\.github\/workflows|migrations|alembic)\//i;
const SOURCE = /\.(swift|m|mm|java|kt|kts|go|rs|py|js|jsx|ts|tsx|rb|php|cs|c|cc|cpp|h|hpp|dart|scala)$/i;

// Looks for files where an automatic "fix" is most likely to break things the
// reviewer can't see: networking, auth, secrets, build and deploy config.
export async function suggestGuard(repo) {
  const g = loadGuard(repo);
  const r = await run('git', ['ls-files'], { cwd: repo, timeoutMs: 30_000 });
  const files = r.stdout.split('\n').filter(Boolean);
  const out = [];
  const seen = new Set();
  const add = (pattern, reason) => {
    if (seen.has(pattern) || protectedBy(g, pattern.replace(/\/$/, '/x'))) return;
    seen.add(pattern);
    out.push({ pattern, reason });
  };
  for (const f of files) {
    const dir = f.match(SENSITIVE_DIR);
    if (dir) add(dir[0], 'deployment, CI or migrations');
  }
  for (const f of files) {
    if (/(^|\/)(node_modules|Pods|vendor|build|dist)\//.test(f)) continue;
    if (CONFIG_FILE.test(f)) add(f, 'build or app configuration');
  }
  for (const f of files) {
    if (/(^|\/)(node_modules|Pods|vendor|build|dist|test|tests|__tests__)\//.test(f) || /test/i.test(path.basename(f))) continue;
    if (SOURCE.test(f) && SENSITIVE_NAME.test(path.basename(f))) add(f, 'networking, auth or security code');
  }
  return out.slice(0, 60);
}
