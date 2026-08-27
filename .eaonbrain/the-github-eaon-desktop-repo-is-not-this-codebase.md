---
title: The GitHub eaon-desktop repo is not this codebase
tags: [eaon-desktop, github, swift, tauri, cli, readme, gotcha]
created: 2026-08-26T02:28:24.147Z
updated: 2026-08-26T02:28:24.147Z
---

# The GitHub eaon-desktop repo is not this codebase

`https://github.com/sanscreates/eaon-desktop` and this local
`~/Downloads/Eaon Desktop` folder are two different products that happen to
share a name. Worth knowing before you go looking for a file that isn't there.

- **This folder** is the Electron + React + TypeScript client described in
  [[Eaon Desktop architecture]]. It has no git remote and, as of Aug 2026, no
  commits (it sits inside a home-directory git repo, which is why `git status`
  from here dumps `~/.antigravity` and friends).
- **The GitHub repo** is a monorepo of three other surfaces:
  - `Eaon-desktop/` — native macOS app, SwiftUI, Swift 5.9, macOS 14+, ~115
    Swift files. One SPM dependency (SwiftTerm, for the embedded terminal).
    GPL-3.0.
  - `eaon-tauri/` — the Windows and Linux app. Rust core + React UI on Tauri 2.
    Strict CSP means the webview has zero network access; every request, file
    write and spawn goes through Rust.
  - `eaon-cli/` — `eaon`, a Node 18.17+ / Ink terminal agent. Also what the Mac
    app's Code mode runs inside an embedded terminal.

Releases are tagged differently per pipeline: Mac builds are `mac-v*` and cut
by hand, Windows/Linux are `v*` and built by GitHub Actions on real
windows-latest / ubuntu runners.

Some architecture choices there run opposite to the Electron app's, so don't
carry conclusions across:

- API keys live in **UserDefaults, not the Keychain**. The Swift app is ad-hoc
  signed, so every rebuild reads as a new app and macOS throws the scary
  "wants to use your confidential information" prompt, on every self-update.
  (The Electron app does the opposite: `safeStorage` via the OS keychain.)
- Conversations and settings are also UserDefaults. Only downloaded models and
  attachments are real files, under `~/Library/Application Support/Eaon`.

## README rewrite, Aug 2026

Opened https://github.com/sanscreates/eaon-desktop/pull/5 rewriting that
repo's README: added downloads, the provider/mode/shortcut tables, tools,
data locations, repo layout, and build steps for all three surfaces.

The prose was run through the `humanize` skill. Its `sloplint` CLI lives at
`~/.claude/skills/humanize/bin/sloplint.js` and is not on PATH, so invoke it
with `node`. `score <file>` works on a single file; `scan` wants a directory
and crashes with ENOTDIR if you hand it a file. The old README scored 70/100
("moderate AI"), the rewrite 0/100.
