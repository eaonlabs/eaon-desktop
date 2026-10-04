---
title: Eaon CLI: Claude Code tab and full-control MCP
tags: [eaon-cli, mcp, policy, claude-code]
created: 2026-10-03T21:06:46.815Z
updated: 2026-10-03T23:04:36.186Z
---

The user asked to "open one claude code session inside of the cli" that "can fully control everything". It was first a fourth tab (F4). On Oct 3, 2026 the user asked to "remove claude code from the tabs".

## The screen (`cli/src/tui/views/claude.ts`, `/claude`)
- **Not a tab:** `MODES` (the tab bar, Tab cycling, F1–F3, ⌥1–⌥3) lists only chat, workers and trading. `claude` is still a `Mode` the app can switch to, but only `/claude` opens it.
- **Getting out:** with the keyboard back in Eaon (⌃]), Esc returns to `app.previousMode`, the tab it was opened from, while Claude Code keeps running. Tab also leaves it, going to Chat.
- **Don't add F4 back by accident:** an F-key index past `MODES.length` would call `switchMode(undefined)`.
- **What runs:** the user's own unmodified `claude`, in a node-pty pane rendered from `@xterm/headless` cells. Both are externals in `build-cli.mjs`, loaded with `createRequire(import.meta.url)`.
- **Policy:** this is the allowed route in [[Claude plan through the user's own Claude Code (headless provider)]] — hosting the real binary, which the user types to and signs in to with its own `/login`. **Eaon never sends it prompts or reads its answers.** Don't add anything that does.
- **Launch:** `claude --append-system-prompt <Eaon context> --mcp-config <cliHome>/claude-code/mcp.json`. Both flags work in interactive mode (checked with `claude --help`, v2.1.x). The config file starts `eaon mcp --control`, using `process.execPath` with the realpath of `process.argv[1]` and passing `EAON_CLI_HOME`. The user's `~/.claude.json` is never written.
- **Keys:** `setRawInput(sink)` in `tui/input.ts` passes stdin through byte for byte while the pane has focus: Esc, Tab, ⌃C and pastes all reach Claude Code. ⌃] (`\x1d`) releases focus; ⏎ or a click takes it again. SGR mouse sequences are stripped from the raw stream, and the wheel scrolls xterm's scrollback.
- **Lifetime:** the pane starts on first draw, at the pane's size, and resizes with it. ⏎ restarts it after it exits. `finish()` kills it when Eaon quits.
- **Visual testing:** set `CLAUDE_CONFIG_DIR` to a scratch folder, so the user's real Claude config isn't touched. It then opens on Claude Code's first-run theme picker, which is enough to check rendering. Slash commands only run from Chat's composer; Workers has no command box, so a test that types `/claude` there does nothing.

## Full control (`cli/src/bus/mcpServer.ts`)
- **Opt-in:** `eaon mcp --control` (and only that) adds `controlTools`. Plain `eaon mcp`, which `eaon connect claude` installs, stays read-only.
- **The tools:**
  - `eaon_order`, `eaon_cancel`, `eaon_close_position`, `eaon_set_exit`;
  - `eaon_session` (start with hours/until, stop, check_now, tell, status);
  - `eaon_limits`, `eaon_broker`, `eaon_kill_switch`, `eaon_worker_message`.
- **How they reach the engine:** `bus.invokeOwner(channel)`, so they need a running Eaon that owns the engines.
- **Guardrails stay in the engine:** limits, the kill switch and the disclaimer still apply; the MCP side can't accept the disclaimer. On top of that:
  - real money (alpaca-live orders, session starts and the broker switch) is refused unless `<cliHome>/store/cli-claude-control.json` says `liveMoney: true`, set by the CLAUDE CODE chip in mission control (with a confirm);
  - orders carry the reason "Claude Code: …", and the desk's trades panel labels them "claude".

Verified Oct 3, 2026: a stand-in MCP client drove a running owner.
- `tell` made the agent sell 2 NVDA.
- Limits, an order, exits and the kill switch on then off all worked; an order refused while it was on.
- A 1-hour session started and stopped.
- `eaon_broker alpaca-live` was refused.

Related: [[Eaon CLI session bus and the Claude Code bridge]], [[Eaon CLI trading: disclaimer gate, talking to the agent, live watch and linked accounts]].

Related: [[Eaon CLI: Claude Code as the trading agent (session driver)]]
