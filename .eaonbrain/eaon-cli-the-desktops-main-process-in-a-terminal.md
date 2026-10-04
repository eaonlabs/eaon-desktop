---
title: Eaon CLI: the desktop's main process in a terminal
tags: [eaon-cli, architecture, trading, tui]
created: 2026-10-03T15:27:13.960Z
updated: 2026-10-03T17:35:53.044Z
---

Oct 3, 2026, branch `eaon-cli`. The user asked for "a cli for this app" with "all the features in the app but mainly focused on agentic trading": the same tabs, with the ADE replaced by a trading desk. They supplied three reference screenshots: a NEPSE "LIVE TMS" Bloomberg-style desk, a futu-style watchlist/quote/chart screen, and an "OMH · Model chains" table. Code: `cli/` (usage in `cli/README.md`), built by `scripts/build-cli.mjs` into `out/cli/eaon.mjs`; `bin/eaon.mjs` runs the bundle. The command is **`eaon`**. It started as `eaon-cli` because `~/.local/bin/eaon` was an unrelated Bun-built opencode fork; on Oct 3, 2026 the user asked for `eaon` and for the other CLI to be disabled. That binary is now `~/.local/bin/eaon.disabled` with its execute bit removed (rename it back to restore it), and `~/.local/bin/eaon` is a symlink to `bin/eaon.mjs`. `~/.eaon/cli` belongs to the old Ink eaon-cli and is untouched. Internal names still say eaon-cli: the Linux profile folder and the socket and pipe names.

## How it reuses the app
- **It runs `src/main` as-is under Node.** esbuild aliases `electron` to `cli/src/runtime/electron.ts`, the same trick as the test harness (see [[Agent core: one loop, adapters and tool sources]]). In the stand-in, `userData` is the CLI profile, `safeStorage` is a real keychain-backed vault, `shell.trashItem` moves files to the real Trash (the agent's `delete_file` uses it), `powerSaveBlocker` runs `caffeinate`, and `Notification` turns into TUI toasts. Window APIs are inert.
- **Features are registered one by one, never through `features/index.ts`.** Importing the index loads `computerUse.ts`, which registers the computer tool at import time. The CLI registers providerAuth, plugins and skills always, and workers, trading and email only in the session that owns the engines (`runtime/boot.ts`). The `worker-browser` tool source is re-registered empty, because BetterWright needs Electron.
- **The TUI is the renderer.** `runtime/ipc.ts` is a fake `ipcMain`: features register their handlers there, the TUI calls `invoke(channel)` and listens on `events`. So the desk drives the trading engine through exactly the desktop's `trading:*` channels, with the same guardrails and ledger, and workers through `workers:*`. Chat turns call `runAgent` directly; `core/chat.ts` ports the renderer's `send()` and `applyStreamEvent`.
- **Its own profile, never the desktop's.** Two processes running the engines on one ledger would double every order and every worker turn. The desktop folder is only read. `core/desktop.ts` imports keys, providers, settings, MCP servers and the trading setup; imported schedules come in switched off and the real-money confirmation is cleared. Desktop chats can be continued as a copy.
- **Chats are one file per chat** (`<profile>/chats/<id>.json`, `core/chats.ts`). Several CLI sessions share a profile, and the desktop's whole-list `chats.json` saves would erase each other's chats.
- **One engine owner per profile**, chosen with `engines.lock`; other sessions attach over the bus. See [[Eaon CLI session bus and the Claude Code bridge]].

## The TUI
`cli/src/tui/` is a small home-made renderer, not Ink. It keeps a cell grid, diffs each frame row by row (only the changed span is rewritten, inside synchronized-update markers), measures East Asian wide characters, and falls back to 256 colours on Terminal.app. `form.ts` (data entry) and `modals.ts` (pickers, the "model chains" table) are shared by every screen. Views: `views/chat.ts`, `views/workers.ts`, and `views/trading/` (header, pages, detail, forms). `--snapshot <mode:page> --size WxH [--html f] [--keys …]` renders one frame without a terminal; that's how layouts were checked against the screenshots (headless Chrome turns the HTML into a PNG).

Gotchas are in [[Eaon CLI gotchas]]. The trading engine itself is in [[Agentic trading backend: engine, brokers, sessions and guardrails]].

Related: [[Eaon CLI coding layer: what was taken from opencode and why]]

Related: [[Eaon CLI: watching the agent work (scanner, scrolling, spinning logo)]]
