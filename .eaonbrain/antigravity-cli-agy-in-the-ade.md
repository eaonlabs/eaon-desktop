---
title: Antigravity CLI (agy) in the ADE
tags: [eaon-desktop, ade, terminal, agents]
created: 2026-10-02T03:06:56.094Z
updated: 2026-10-02T03:06:56.094Z
---

Since Oct 2 2026 the ADE offers **Antigravity** (Google's terminal agent) in place of Gemini CLI, which the co-founder asked to drop. `TerminalAgentId` is `'antigravity'`. A pane saved as `gemini` by an older version comes back as a plain shell: `knownAgent()` in `shared/terminals.ts`, applied when `paneRecords.ts` reads records and in `terminal:layout`.

Measured against the real binary (agy 1.2.14, installed into a scratch `HOME` from https://antigravity.google/cli/install.sh, which only writes under `$HOME`):
- Binary `agy`, installed to `~/.local/bin/agy`. Windows: `irm https://antigravity.google/cli/install.ps1 | iex`, binary in `%LOCALAPPDATA%\agy\bin`. That is the ADE's `installHint`.
- Flags: `--continue` / `-c` carries on the folder's latest conversation, and `--conversation <id>` reopens one. So `resume` is `agy --conversation <id>` and `continueLatest` is `agy --continue`. Other flags include `--model`, `--effort`, `--mode plan|accept-edits`, `--print`, `--dangerously-skip-permissions`.
- State lives under `~/.gemini/antigravity-cli/`: `settings.json`, `cache/last_conversations.json` (each folder's absolute path → its latest conversation id) and `cache/projects.json`. Conversations are filed by id alone, as `brain/<conversation-id>/` (transcripts in `.system_generated/logs/transcript.jsonl`, per strings in the binary).
- Because conversations aren't filed by folder, the ADE only knows each folder's **latest** conversation. `conversations(cwd)` reads that map, and the id counts only if `brain/<id>` exists. That's what restoring a pane needs. The map file's exact shape wasn't seen (it needs a signed-in session), so the parser accepts a plain id or an object holding one.
- Logo: `assets/providers/antigravity.png`, 128px from the official `antigravity.google/assets/image/antigravity-logo.svg`, which wraps a 1600px PNG and weighs 900 KB.

Model providers' "Open … in the ADE" button (`planInAde`) allows `'antigravity'` instead of `'gemini'`. Only Anthropic uses the button. See [[ADE terminal view: node-pty, xterm and the pane grid]] and [[Restoring agent sessions across a restart]].
