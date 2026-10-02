import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.js';

export async function repoInfo(dir) {
  const root = await run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (root.code !== 0) return { ok: false, error: 'Not a git repository' };
  const repo = root.stdout.trim();
  const [branch, branches, log, status] = await Promise.all([
    run('git', ['branch', '--show-current'], { cwd: repo }),
    run('git', ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { cwd: repo }),
    run('git', ['log', '-n', '40', '--date=relative', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad'], { cwd: repo }),
    run('git', ['status', '--porcelain'], { cwd: repo }),
  ]);
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, subject, author, date] = line.split('\x1f');
      return { hash, short, subject, author, date };
    });
  const allBranches = branches.stdout.split('\n').filter((b) => b && !b.endsWith('/HEAD'));
  const defaultBranch = ['main', 'master', 'develop', 'origin/main', 'origin/master'].find((b) => allBranches.includes(b)) || allBranches[0] || '';
  return {
    ok: true,
    repo,
    name: path.basename(repo),
    branch: branch.stdout.trim() || '(detached)',
    branches: allBranches,
    defaultBranch,
    commits,
    dirtyCount: status.stdout.split('\n').filter(Boolean).length,
  };
}

// Returns the raw unified diff for one file under the selected review target.
export async function fileDiff(repo, target, file) {
  if (target.kind === 'scan') return null;
  if (target.kind === 'commit') {
    const r = await run('git', ['show', '--format=', '--no-color', '-U5', target.commit, '--', file.path], { cwd: repo });
    return r.stdout;
  }
  if (target.kind === 'range') {
    const r = await run('git', ['diff', '--no-color', '-U5', `${target.mergeBase || target.from}..${target.to}`, '--', file.path], { cwd: repo });
    return r.stdout;
  }
  const tracked = await run('git', ['diff', '--no-color', '-U5', 'HEAD', '--', file.path], { cwd: repo });
  if (tracked.stdout.trim()) return tracked.stdout;
  // Untracked files have no HEAD diff; diffing against /dev/null shows the
  // whole file as added. Exit code 1 here just means "files differ".
  const untracked = await run('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path], { cwd: repo });
  return untracked.stdout;
}

// Prefixes every diff line with its new-file line number so the reviewer can
// cite exact lines instead of counting hunks itself, which is where position
// drift comes from.
// File headers (index, ---, +++, mode lines) only appear before a file's first
// hunk. Inside a hunk every line is content, even a removed "-- comment" that
// shows up as "--- comment".
export function annotateDiff(diff) {
  const out = [];
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      newLine = Number(m[1]);
      inHunk = true;
      out.push(line);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) out.push(`${String(newLine++).padStart(5)} + ${line.slice(1)}`);
    else if (line.startsWith('-')) out.push(`      - ${line.slice(1)}`);
    else if (line.startsWith(' ')) out.push(`${String(newLine++).padStart(5)}   ${line.slice(1)}`);
    else if (line.startsWith('\\')) continue;
  }
  return out.join('\n');
}

export function parseDiffForView(diff) {
  if (!diff) return [];
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
      inHunk = true;
      rows.push({ t: 'hunk', text: line });
      continue;
    }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) rows.push({ t: 'add', n: newLine++, text: line.slice(1) });
    else if (line.startsWith('-')) rows.push({ t: 'del', o: oldLine++, text: line.slice(1) });
    else if (line.startsWith(' ')) rows.push({ t: 'ctx', o: oldLine++, n: newLine++, text: line.slice(1) });
  }
  return rows;
}

// Reads a file as it exists in the target revision: the `to` ref or commit for
// historical targets, the working tree otherwise.
export async function fileContent(repo, target, filePath) {
  let rev = null;
  if (target?.kind === 'commit') rev = target.commit;
  if (target?.kind === 'range') rev = target.to;
  if (rev) {
    const r = await run('git', ['show', `${rev}:${filePath}`], { cwd: repo, timeoutMs: 15_000 });
    if (r.code === 0) return r.stdout;
  }
  const abs = path.resolve(repo, filePath);
  if (!abs.startsWith(path.resolve(repo) + path.sep)) return null;
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// Fixes are applied to the working tree, which only matches the reviewed code
// when the target revision is what is checked out.
export async function workingTreeMatches(repo, target) {
  if (!target || target.kind === 'workspace' || target.kind === 'scan') return true;
  const rev = target.kind === 'commit' ? target.commit : target.to;
  const [a, b] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: repo }),
    run('git', ['rev-parse', rev], { cwd: repo }),
  ]);
  return a.stdout.trim() && a.stdout.trim() === b.stdout.trim();
}

// Files touched by recent commits: a quick way to aim a scan at active code.
export async function recentFiles(repo, days) {
  const r = await run('git', ['log', `--since=${Number(days) || 30} days ago`, '--name-only', '--pretty=format:'], { cwd: repo, timeoutMs: 30_000 });
  // A file edited and later deleted in the window still appears in older
  // commits, so keep only paths that exist now.
  return [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))].filter((f) => fs.existsSync(path.join(repo, f)));
}

export async function gitStatus(repo) {
  const [branch, status, head] = await Promise.all([
    run('git', ['branch', '--show-current'], { cwd: repo }),
    run('git', ['status', '--porcelain', '-z'], { cwd: repo }),
    run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo }),
  ]);
  const changed = [];
  const entries = status.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const l = entries[i];
    if (!l) continue;
    changed.push({ code: l.slice(0, 2), path: l.slice(3) });
    // Renames and copies are followed by an extra entry holding the old path.
    if (/[RC]/.test(l.slice(0, 2))) i++;
  }
  return { branch: branch.stdout.trim() || '(detached)', head: head.stdout.trim(), changed, dirty: changed.length };
}

export async function createBranch(repo, name) {
  const check = await run('git', ['check-ref-format', '--branch', name], { cwd: repo });
  if (check.code !== 0 || name.startsWith('-')) throw Object.assign(new Error(`“${name}” is not a valid branch name`), { status: 400 });
  // switch -c carries uncommitted changes over to the new branch.
  const r = await run('git', ['switch', '-c', name], { cwd: repo });
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'Could not create the branch');
  return gitStatus(repo);
}

export async function commitPaths(repo, message, paths) {
  const msg = String(message || '').trim();
  if (!msg) throw Object.assign(new Error('Write a commit message first'), { status: 400 });
  const list = (paths || []).filter((p) => typeof p === 'string' && p && !p.startsWith('-'));
  if (paths && !list.length) throw Object.assign(new Error('Nothing to commit'), { status: 400 });
  const add = await run('git', list.length ? ['add', '--', ...list] : ['add', '-A'], { cwd: repo });
  if (add.code !== 0) throw new Error(add.stderr.trim());
  const r = await run('git', list.length ? ['commit', '-m', msg, '--', ...list] : ['commit', '-m', msg], { cwd: repo });
  if (r.code !== 0) throw new Error((r.stdout + r.stderr).trim().split('\n').slice(-3).join('\n') || 'git commit failed');
  const head = await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo });
  return { commit: head.stdout.trim() };
}
