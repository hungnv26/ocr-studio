import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, run } from './util.js';

// Each editor can be reached through a CLI on PATH, a URL scheme, or the macOS
// app bundle. Detection only checks that something usable exists.
const EDITORS = [
  { id: 'vscode', name: 'VS Code', apps: ['Visual Studio Code'], cli: 'code', open: (p, l, cli) => (cli ? [cli, ['-g', `${p}:${l}`]] : ['open', [`vscode://file${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}:${l}`]]) },
  { id: 'cursor', name: 'Cursor', apps: ['Cursor'], cli: 'cursor', open: (p, l, cli) => (cli ? [cli, ['-g', `${p}:${l}`]] : ['open', [`cursor://file${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}:${l}`]]) },
  { id: 'zed', name: 'Zed', apps: ['Zed'], cli: 'zed', open: (p, l, cli) => (cli ? [cli, [`${p}:${l}`]] : ['open', ['-a', 'Zed', p]]) },
  { id: 'xcode', name: 'Xcode', apps: ['Xcode'], cli: 'xed', open: (p, l, cli) => (cli ? [cli, ['--line', String(l), p]] : ['open', ['-a', 'Xcode', p]]) },
  { id: 'androidstudio', name: 'Android Studio', apps: ['Android Studio'], cli: 'studio', open: (p, l, cli, app) => (cli ? [cli, ['--line', String(l), p]] : ['open', ['-na', app, '--args', '--line', String(l), p]]) },
  { id: 'idea', name: 'IntelliJ IDEA', apps: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'], cli: 'idea', open: (p, l, cli, app) => (cli ? [cli, ['--line', String(l), p]] : ['open', ['-na', app, '--args', '--line', String(l), p]]) },
  { id: 'webstorm', name: 'WebStorm', apps: ['WebStorm'], cli: 'webstorm', open: (p, l, cli, app) => (cli ? [cli, ['--line', String(l), p]] : ['open', ['-na', app, '--args', '--line', String(l), p]]) },
  { id: 'sublime', name: 'Sublime Text', apps: ['Sublime Text'], cli: 'subl', open: (p, l, cli, app) => [cli || path.join('/Applications', `${app}.app`, 'Contents/SharedSupport/bin/subl'), [`${p}:${l}`]] },
  { id: 'system', name: 'Default app', apps: [], cli: null, open: (p) => ['open', [p]] },
];

// "auto" picks the native IDE for the file type when it is installed.
const AUTO_BY_EXT = [
  [/\.(swift|m|mm|h|xib|storyboard|xcconfig|plist|entitlements)$/i, ['xcode']],
  [/\.(java|kt|kts|gradle|xml)$/i, ['androidstudio', 'idea']],
];

let cache = null;

function findApp(names) {
  for (const n of names) {
    for (const dir of ['/Applications', path.join(HOME, 'Applications'), '/Applications/Setapp']) {
      const p = path.join(dir, `${n}.app`);
      if (fs.existsSync(p)) return n;
    }
  }
  return null;
}

async function findCli(name) {
  if (!name) return null;
  const r = await run('/bin/sh', ['-lc', `command -v ${name}`], { timeoutMs: 5000 });
  const p = r.stdout.trim().split('\n')[0];
  if (r.code !== 0 || !p) return null;
  // xed exists as a stub even without Xcode; only trust it with Xcode present.
  if (name === 'xed' && !findApp(['Xcode'])) return null;
  return p;
}

export async function detectEditors(force = false) {
  if (cache && !force) return cache;
  const out = [];
  for (const e of EDITORS) {
    const app = findApp(e.apps);
    const cli = await findCli(e.cli);
    if (e.id === 'system' || app || cli) out.push({ id: e.id, name: e.name, app, cli });
  }
  cache = out;
  return out;
}

export async function openInEditor(repo, rel, line, editorId) {
  const abs = path.resolve(repo, rel);
  if (!abs.startsWith(path.resolve(repo) + path.sep)) throw Object.assign(new Error('Path is outside the repository'), { status: 400 });
  const available = await detectEditors();
  let id = editorId || 'auto';
  if (id === 'auto') {
    const rule = AUTO_BY_EXT.find(([re]) => re.test(rel));
    id = rule?.[1].find((x) => available.some((a) => a.id === x)) || available.find((a) => a.id !== 'system')?.id || 'system';
  }
  const found = available.find((a) => a.id === id) || available.find((a) => a.id === 'system');
  const def = EDITORS.find((e) => e.id === found.id);
  const [cmd, args] = def.open(abs, Math.max(1, Number(line) || 1), found.cli, found.app);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
  return { editor: found.name };
}
