---
title: ADE panes come back after a quit: session watch, records, restore
tags: [eaon-desktop, ade, terminal, gotchas]
created: 2026-10-01T02:28:07.290Z
updated: 2026-10-01T02:28:07.290Z
---

# ADE panes come back after a quit: session watch, records, restore

Built on [[ADE terminal view: node-pty, xterm and the pane grid]]. Two user-facing behaviours share one mechanism:
1. **A pane's logo and label follow the CLI running in it.** Type `claude` into a shell, quit Codex and start `opencode`, and the pane re-marks itself.
2. **Quit and reopen Eaon, and every pane comes back.** An agent reopens its conversation, a shell returns to the folder it had `cd`'d to with its old screen, and a whitelisted TUI (vim, htop, lazygit…) opens again.

Ported and widened from the standalone Eaon ADE's `session-watch.ts`, `pane-sessions.ts` and `sessions.ts`, which only knew Claude Code.

## Where it lives (`src/main/features/terminals/`)
- **`sessionWatch.ts`.** Every 4 s, one `ps -Ao pid=,ppid=,args=`, then a breadth-first walk under each pane's shell pid (`PtyManager.pids()`).
  - Sends `terminal:agent {paneId, agent}` on change; the renderer's `terminalStore.setAgent` rewrites `pane.agent` in the layout.
  - Identifies the conversation, most confident first:
    1. Claude Code's own `sessions/<pid>.json`, re-read every tick so `/resume` and `/clear` are followed.
    2. The command line (`--resume <id>` and kin).
    3. A conversation that **arrives** in the agent's folder after the agent was first seen.
    4. An older conversation **touched** after first sight, used only when exactly one pane could be the toucher.
  - Unix only. `SessionWatch.supported()` is false on Windows.
- **`agentSessions.ts`.** Per-agent knowledge: where conversations are filed, the resume line, a resumable check. `setAgentHome(home, env)` points it all at a scratch home for tests.
- **`paneRecords.ts`.** `userData/terminals/panes.json` holds `{agent, sessionId?, cwd?, program?}` per pane id. `scrollback/<pane>.log` holds the last 256 KB of output. `restoredScreen()` builds the replayed screen.
- **`terminals.ts`** is now a factory, `createTerminals({dir, agents, settleMs})`, so a test can run it twice: quit, then relaunch.
  - `planRestore` turns a pane's **first** spawn in a run into its restore. The record wins over `pane.agent`, because most agents are typed into a shell and the pane spec never learns that.
  - `rememberPanes` runs on shutdown, in this order: a final tick, `watch.stop()` (otherwise the mass exit on quit reads as "every agent closed" and wipes the records), one batched `lsof -a -d cwd -p a,b,c` for the shells' folders, then saves scrollback and flushes.

## Measured CLI facts (Sept 2026)

| Agent | Conversations on disk | Reopen with |
|---|---|---|
| Claude Code 2.1 | `~/.claude/projects/<slug>/<id>.jsonl`, where slug = every non-alphanumeric → `-` | `--resume <id>` |
| Codex 0.159 | `~/.codex/sessions/Y/M/D/rollout-…-<uuid>.jsonl`; the cwd is in the first line's session_meta | `codex resume <id>` (`--last` also works) |
| Gemini CLI 0.62 | `~/.gemini/tmp/<short>/chats/session-*.jsonl` | `--resume <uuid>` |
| OpenCode 1.16 | SQLite `~/.local/share/opencode/opencode.db`, table `session`; `directory` = cwd, times in ms | `--session ses_…` |
| Eaon Code 1.0 | `~/.eaon/agent/sessions/--<cwd minus leading /, / and : → ->--/<iso>_<uuid>.jsonl` | `--session <uuid>` |

Details that matter:
- **Gemini:** `<short>` comes from `~/.gemini/projects.json` `{projects:{path:short}}`; older versions used `sha256(path)`. The first JSONL line holds the `sessionId`. The file is written at startup before anyone types, so the resumable check looks for `"type":"user"`.
- **OpenCode:** read through the `sqlite3` CLI with `-readonly`, because Node 20 has no `node:sqlite`. Sub-agent sessions have a `parent_id`.
- **Eaon Code:** the file is only written after the first reply. `EAON_CODE_CODING_AGENT_DIR` overrides the location.
- **Claude:** `--resume` on a transcript with no user or assistant turn fails with "No conversation found". In that case Claude restarts fresh.

## Gotchas (each cost time here)
- **Process titles hide arguments.** `eaon-code` and `claude` set `process.title`, so `ps` shows `eaon-code` with no args, and `--session <id>` can't be read back. So a restored pane **carries** its recorded sessionId when the same agent reappears, until something better identifies it. Otherwise a second quit forgets the conversation.
- **Wrappers:** `node …/bin/opencode` spawns the real binary. Breadth-first search returns the outer one. Runtimes (node, bun, deno, python) are skipped to the first non-flag word.
- **Settling.** For ~8 s after a pane's launch command is typed (`PtyManager.settling`), a bare shell is not reported. Otherwise the logo flickers to Shell and the record is lost before the agent process exists.
- **Replay echoes.** Replayed bytes include the queries a CLI sent at startup (cursor position, device attributes), and xterm answers them into the *new* shell. The registry sets `rt.replaying` and drops `onData` until `term.write(data, cb)` calls back. This also applies to the reload replay.
- **Two mode resets move the cursor.** `ESC[r` homes the cursor (DECSTBM), and `ESC[?1049l` restores the cursor saved on alt-screen entry: the top-left corner if there was none. Sent blindly after a replay, they made the divider and new prompt overwrite the old screen. Now `?1049l` is sent only when the replay ends inside the alt screen, and the scroll-region reset is wrapped in DECSC/DECRC. The test checks this with `@xterm/headless` (CommonJS: under ESM its `Terminal` is on `.default`).
- **The restored screen must be pushed into the PtyManager history.** Otherwise the next quit saves only the new run's output, and older screens fade out one relaunch at a time.
- **macOS realpath.** lsof reports `/private/var/…` where `os.tmpdir()` says `/var/…`. Tests realpath their scratch home.
- **Prune by layout.** `save-layout` and startup drop records for pane ids not in `ade-terminals.json`. In a test with no layout saved, that wipes everything.

## Verified
Tested in the built app through CDP.
- Real Claude Code was typed into a shell; the logo switched; it answered "pineapple". On quit and relaunch the app typed `claude --resume <id>` and the conversation came back. It still came back on a second relaunch and after a window reload.
- The shell pane returned to `sub folder` with its screen.
- OpenCode and Eaon Code reopened fresh, having had no conversation.
- Closing a pane drops its record.
- Tests: `test/terminal-sessions.test.ts` has 18 tests, including a real-pty round trip with a stand-in `claude`.
