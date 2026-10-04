---
title: Eaon CLI session bus and the Claude Code bridge
tags: [eaon-cli, agents, mcp, policy]
created: 2026-10-03T15:27:24.368Z
updated: 2026-10-03T21:06:59.789Z
---

The user wanted the CLI to "talk to other cli sessions like claude code, codex or another eaon cli session". Code: `cli/src/bus/` (`bus.ts`, `mcpServer.ts`, `peerTools.ts`, `external.ts`) and `cli/src/runtime/engines.ts`.

## The bus
- Each session writes `<profile>/bus/<id>.json` and listens on `<id>.sock` (a named pipe on Windows). The profile folder is chmod 700, so only the user's processes can join. `listPeers()` removes registrations whose pid is dead. A socket path over 100 bytes falls back to a private tmp folder, because macOS caps socket paths at 104.
- The protocol is NDJSON with an `rid` per request: `message`, `invoke`, `channels`, `tools`, `tool`, `subscribe`. A reply is just a message carrying `replyTo`, so `send(…, { waitMs })` can wait for it.
- **Engine ownership:** `engines.lock` is created with `wx`. A lock counts only if its pid is alive **and** that peer is registered on the bus, after a 15 s grace (pids are reused). The owner runs workers, trading and email and serves them. An attached session registers stand-in IPC handlers that forward `trading:*`, `workers:*` and `email:*` to the owner, re-emits the owner's events, and offers the owner's trading tools to its own agent as stand-ins. Those count as mutating unless the name reads as a lookup, are always risky, and are catastrophic on alpaca-live. When the owner goes, the next session takes the lock (`takeOverIfFree`).
- Any event the owner emits on a `trading:`, `workers:` or `email:` channel reaches every attached terminal. The agent desk's `trading:activity` feed relies on this.
- **Peer messages** land in a chat of their own per peer (`ChatController.receivePeer`), never in the chat the user is typing in. The agent answers on its own, at most 8 times per peer per 10 minutes, so two agents can't talk in circles.

## Claude Code and Codex: policy
[[Claude plan through the user's own Claude Code (headless provider)]] still holds. Nothing here runs `claude -p`, `codex exec`, the Agent SDK or a PTY scraper to get answers. Claude Code and Codex join the bus **themselves**, by loading `eaon mcp` as an MCP server.

- **`eaon connect claude|codex`** installs plain `eaon mcp`, which is read-only. It offers `eaon_sessions`, `eaon_send`, `eaon_reply`, `eaon_inbox`, `eaon_wait`, `eaon_trading`, `eaon_quote` and `eaon_workers`, and none of them place orders.
- **`eaon mcp --control`** adds full-control tools (orders, sessions, limits, kill switch, workers). It is used by the Claude Code tab inside the TUI; see [[Eaon CLI: Claude Code tab and full-control MCP]]. That tab hosts the real interactive binary, which the user types to; Eaon never feeds it prompts.
- `openInTerminal` may start the real interactive CLI in a new window with no prompt passed in.

## Verified Oct 3, 2026
- Two TUIs on one profile: the second showed "⇄ attached" and the same desk. It also followed the owner's agent activity feed live.
- `eaon send` to the owner: its agent (gpt-oss:20b on Ollama) answered from the live desk in about 8 s.
- An MCP client over stdio played Claude Code: it read the desk and quotes, messaged the owner, and got the answer back. With `--control`, it also traded and ran sessions.
- On a clean exit (Ctrl+C twice) the registration and lock are removed.

Related: [[Eaon CLI: the desktop's main process in a terminal]]
