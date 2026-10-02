---
title: MCP server lifecycle and SDK gotchas
tags: [eaon-desktop, mcp, plugins, gotchas]
created: 2026-09-29T14:28:19.964Z
updated: 2026-09-29T14:28:19.964Z
---

How `src/main/mcp.ts` keeps plugin servers alive and honest, and the MCP SDK behaviour behind it. Complements [[MCP OAuth sign-in for plugins]].

## Lifecycle rules

- **One attempt per server.** Each connect carries a sequence number (`attempts`); a stale attempt that lands after a newer one, or after the server was turned off, closes what it opened. Before this, two reconnects spawned two processes and one was orphaned, and a server switched off mid-start stayed connected with its tools still offered.
- **Edits reconnect.** `syncMcpServers` compares the saved row (command, args, URL, env…) with what is live and reconnects on change.
- **Crash → restart** at most 3 times in 10 minutes (1 s, 5 s, 25 s).
- **A failure after connect still closes the client**, or the stdio process outlives the error.
- **`tools/list_changed`** refreshes the cached tool list; a server with no `tools` capability is "ready, 0 tools", not an error.
- **Remote session 404** (the server restarted) → reconnect once and retry the call.
- **Hand-added HTTP servers fall back to the old SSE transport**; catalog plugins do not.
- **Stop reaches the server**: the turn's signal goes into `callTool`, and the server is told the call was cancelled. The loop also stops waiting on its own (`unlessAborted`, see [[Agent loop cancellation and tool robustness]]).
- **Deleting a hand-added server forgets its OAuth tokens** (`mcp:save` in index.ts calls `forgetServer`). Catalog plugins sign out through `plugins:disconnect` instead — a stale renderer list must never sign a plugin out.

## Results

`isError` goes to the model as an error. Images become real images (only the formats every provider accepts); resources, links and structured content get a one-line description rather than a JSON dump. The deferred call-through tool accepts `arguments` sent as a JSON string.

## SDK gotchas

- **stdio `close()` is slow**: end stdin, wait 2 s, SIGTERM, wait 2 s, SIGKILL. See [[Quitting: held before-quit, will-quit and app.exit]].
- **stderr must be drained** when piped, or a chatty server stalls. Its last lines are what explains a start-up crash ("GITHUB_TOKEN is not set"), so they go into the error.
- **The 401 safeguard (`_hasCompletedAuthFlow`) is per transport**, so parallel calls trip each other. With vendors that rotate refresh tokens, parallel refreshes sign the user out (the SDK drops all tokens on `invalid_grant`). Refreshes are shared per refresh token in `oauthFetch`.
- **The SDK spawns with `cross-spawn`**, which escapes `.cmd` shims on Windows; our `cmd.exe /c` wrapper bypasses that escaping (`&`, `^`, `%` in args) — open, untested on Windows.

## Still open

- No custom headers for hand-added HTTP servers.
- The fixed call timeout ignores progress notifications.
- "Smart MCP tool routing" means "defer schemas past 12 tools"; its "dedicated routing model" settings are read by nothing. See [[Settings that are saved but read by nothing]].
