// Syntax-checks every server and browser module. Run with `npm run check`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['server', 'public/js', 'scripts'];
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
roots.forEach(walk);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✕ ${f}\n${err.stderr}`);
  }
}
console.log(failed ? `${failed} of ${files.length} files failed` : `✓ ${files.length} files OK`);
process.exit(failed ? 1 : 0);
