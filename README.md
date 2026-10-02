# OCR Studio

A local web app for [Open Code Review](https://github.com/alibaba/open-code-review) (OCR) that uses **Claude Code** as the reviewer. Review a diff or audit whole files, triage the findings, let Claude fix them behind a second safety check, and verify the result, all in your browser. You don't need an API key; it uses your existing Claude Code login.

> OCR Studio is an independent project. It is not affiliated with or endorsed by Alibaba or Anthropic.

```
OCR (deterministic)                Claude Code (judgement)              You
──────────────────                 ───────────────────────              ───
pick reviewable files  ──►  one isolated, read-only Claude run   ──►  triage findings,
match review rules          per rule group, in parallel               "Fix with Claude",
                            returns structured findings               undo, export
```

## Requirements

- **Node.js 20+**
- **Git 2.41+**
- **[Claude Code](https://claude.com/claude-code)**, installed and logged in. OCR Studio finds the `claude` CLI on your `PATH` or the copy bundled with the Claude desktop app, and you can also set a path in Settings.
- macOS or Linux. Windows should work for reviewing but hasn't been tested.

The `ocr` CLI is installed automatically as an npm dependency; you don't need a global install.

## Install and start

```bash
git clone https://github.com/hungnv26/ocr-studio.git
cd ocr-studio
npm install
npm start          # opens http://localhost:4317
```

On macOS you can also double-click **`OCR Studio.command`**.

Then choose a repository and either **Review changes** (uncommitted work, a branch, or one commit) or **Scan files**.

## What you can do

| Page | What it's for |
|---|---|
| **Home** | What needs your decision across all reviews, what's running, recent reviews, projects, and this week's usage. |
| **Review changes** | Review uncommitted work, a branch vs. its base (like a PR), or a single commit. |
| **Scan files** | Audit whole files: pick folders in a tree (or "changed in last 30 days"), choose a goal, and see files, lines and time before starting. |
| **Projects** | One page per repo: guardrails (with templates and suggestions mined from the repo), learned "not a bug" dismissals, default model, history and a findings trend. |
| **History** | Every review, filterable by project, type and text. |
| **Review rules** | Which OCR checklist applies to any file path. |
| **Settings** | Tool health, editor (VS Code, Cursor, Zed, Xcode, Android Studio, JetBrains, Sublime; "Automatic" picks by file type), theme, density, parallelism. |

The sidebar's **project switcher** sets the project for every page.

### The review workbench

- **Two-pane triage**: a compact list on the left, grouped by file or severity, and the full finding on the right. A card view is still available.
- **Filters**: Open, Needs you, Fixed, Ignored or All; severity chips; type; *high confidence only* (the reviewer rates each finding); and full-text search.
- **Triage progress**: "32 / 76 handled", plus ETA while a review runs.
- **Keyboard**: `j`/`k` move · `x` select · `f` fix · `F` fix with instructions · `d` done · `i` ignore · `o` reopen · `a` review waiting changes · `q` ask · `c` code · `e` editor · `/` search · `1`–`5` filters · `?` help.
- **Talk to findings**:
  - **Ask Claude** answers questions read-only, inline, with quick questions like "Could this be a false positive?".
  - **Fix with instructions** tells Claude how you want something fixed.
  - **Ignore with a reason** can remember it, so future reviews of the project stop reporting it.
  - **Copy for Claude Code** gives you a ready prompt for your own session.
- **Tabs**:
  - **Changes**: everything the fixes changed since before the first one, with per-hunk undo (which reopens the finding), committed/uncommitted state, and **Commit fixes** with a generated message.
  - **Files**: a sortable table with per-file verdicts and notes.
  - **Activity**: per-batch summaries and the timeline.
  - **Code**: the highlighted file or diff with findings pinned to their lines.
  - **Compare**: shown on verification runs.
- **Fix dialog**: choose auto-apply-safe or ask-me-first, give instructions, see the git state, create an `ocr-fixes/<date>` branch, or commit your work first.
- **Approval wizard**: step through every waiting change (`a` apply, `d` discard, arrow keys to move).
- **Verify fixes**: re-reviews the fixed files and sorts results into *resolved*, *still there*, *new* and *still open*.
- **Export**: Markdown (copy or download), JSON, SARIF, or the fixes as a `.patch`.
- **Permalinks**: `#/review/<id>/<finding>`.

## Safe fixing

Automatic fixes can be wrong in ways a code review won't catch, such as changing connection lifecycle or certificate handling. So every fix goes through these steps:

1. **Guardrails**: per project, set from the 🛡️ Guardrails button.
   - **Never edit**: path patterns Claude may not touch. Fixes there are *blocked*.
   - **Notes**: facts like "the key in `client.ts` is a public client key". The reviewer won't flag them, and the fixer and checker treat them as rules.
   - **Check command**: your build or tests, run after each batch of fixes.
2. **Careful fixer**: Claude reads comments and callers first, and refuses changes to lifecycle, threading, TLS, auth, keys, endpoints, config or public APIs that it can't fully verify.
3. **Independent checker**: a second, read-only Claude run judges the actual patch as *safe*, *risky* or *wrong*.
   - In **Auto-apply safe** mode, only *safe* patches stay applied.
   - *Risky* patches wait for your approval, and *wrong* ones are rejected. Neither touches your files unless you click Apply.
   - In **Ask me first** mode, every patch waits for approval.
4. **Batches with backups**: every file is backed up before the first edit in a batch. **Undo whole batch** restores those files exactly, even when individual undo is impossible.
5. **Re-check applied fixes**: older reviews show a button that runs the checker over fixes applied without one. It flags the risky ones without changing code.

## Reviewers

- **Claude Code** (default) — uses your existing Claude Code login. Choose Haiku / Sonnet / Opus and thinking effort. Reviews run with `Read`, `Grep`, `Glob` only. Your personal hooks, MCP servers and skills are not loaded, so runs are fast and can't stall.
- **OCR built-in agent** — OCR's own agent with an API key. Optional; enable with `node_modules/.bin/ocr config provider`.

## Privacy and data

- Everything runs on your machine. The server listens on `127.0.0.1` only and rejects requests from other sites.
- Code leaves your machine only through Claude Code, the same way as when you use Claude Code directly.
- Reviews, guardrails, settings and fix backups are stored in `~/.ocr-studio`, never in your repository. Delete that folder to remove them.

## Notes

- Claude Code is auto-detected, including the CLI bundled with the Claude desktop app, and binaries that can't run on this Mac (e.g. old x86 builds) are skipped. Set a path in Settings to override.
- The server listens on `127.0.0.1` only and rejects requests from other sites.
- Per-repo rules: add `.opencodereview/rule.json` ([docs](https://open-codereview.ai/docs/review-rules)).
- Env vars: `PORT` (default 4317), `NO_OPEN=1` to skip opening the browser, `OCR_STUDIO_HOME` to move the data folder.
- Cost figures are the estimates Claude Code reports. On a Claude subscription, usage counts toward your plan's limits rather than producing a bill.

## Development

There is no build step: the server is plain Node (`server/`) and the UI is plain ES modules (`public/js/`).

```bash
npm run check                                   # syntax-check every module
PORT=4318 NO_OPEN=1 OCR_STUDIO_HOME=/tmp/ocr-dev npm start   # a throwaway instance
```

Issues and pull requests are welcome.

## License

[MIT](LICENSE) © 2026 Hung Ngo

Third-party components keep their own licenses:
- Open Code Review ([Apache-2.0](https://github.com/alibaba/open-code-review/blob/main/LICENSE)), used as the `ocr` CLI dependency
- highlight.js (BSD-3-Clause)
