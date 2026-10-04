---
title: Eaon CLI agent desk: activity feed, account and mission control
tags: [eaon-cli, trading, tui]
created: 2026-10-03T20:47:25.506Z
updated: 2026-10-03T20:47:25.506Z
---

The user asked for a refined agentic-trading screen with three parts:
- on the left, "a box with all the steps … that the agent is making, what it bought, what it sold";
- "on the bottom … a mission control with all the settings";
- "on the top/middle … the account balance and a chart showing the increase/decrease";
- overall, "mostly everything that an agentic trader would need".

(They wrote "agentic coding" but described trading.) It is page 1 of the trading tab, `cli/src/tui/views/trading/command.ts` (`CommandDesk`). It builds on [[Eaon CLI: the desktop's main process in a terminal]] and the engine in [[Agentic trading backend: engine, brokers, sessions and guardrails]].

## Pages were renumbered
1 is the agent desk (page id `agent`). The old chat page is now `chat` on key 0; HOME and the rest moved up one. `eaon trading agent` opens the desk. On the desk, X stops the session and E edits a holding's exit; elsewhere X is still the exit editor. Unknown page ids passed to `setPage` are ignored.

## Where the steps come from
The engine kept only a session's decisions, orders and notes. Its `runWatched` passed the agent's stream events to nothing but the stall watchdog.

Three small optional app changes:
- `TradingDeps.onAgentEvent(sessionId, event)`, exposed by the feature as `onTradingAgentEvent()`. The desktop sets no listener.
- `engine.checkNow(id)` and the `trading:check-now` channel.
- `TradingSnapshot.agent = { checking, checkStartedAt, nextCheckAt }`, from `turnStartedAt` / `nextTurnAt` on the active session. `scheduleTurn` and `runTurn` call `changed()` so desks see it.

All three are covered by a test in `test/trading.test.ts`.

`cli/src/core/tradingActivity.ts` records steps in the session that owns the engines. One step per check (keyed by the check's `messageId`), plus thoughts, tool calls with their results, and the answer.
- Saved to `<cliHome>/trading-activity.json`, newest 12 sessions.
- Changes are published on `trading:activity`, which the bus forwards because it starts with `trading:`.
- Other terminals call `trading:activity` once to backfill a session.
- **Step ids need a namespace per kind** (`:thought:n`, `:answer:n`, `:tool:<toolId>`). A test caught a provider tool id `t1` colliding with thought `t1`.

## The feed merges two sources
Activity steps plus the engine's `session.log`:
- Log `order` entries cover stops firing between checks and end-of-session sells.
- Log `decision` entries cover checks this terminal didn't see.

Gotchas:
- The engine logs an agent order as "…($1,871.97). Protected: … Why: …", while the tool output says "…($1,871.97). Order id: …". De-duplicate by the **parsed fill** (verb, qty, symbol, price), not by text prefix.
- Show the protection the engine reports ("Protected: stop $220.00, trailing 4% (stop now $224.59), target $260.00"), not what the agent asked for. An earlier exit on the same symbol merges into it.
- Skip the engine's "Started on …" note; the feed's first item already shows the start, with the strategy.
- After `trading:start-session`, fetch `trading:snapshot` straight away. Otherwise the desk shows the previous session until a push arrives.

## Look
- **Balance digits:** 3 rows tall, from `tui/bigtext.ts` (3×5 pixel digits in half blocks). A 2-row 3×4 font made 8 unreadable.
- **Equity chart:** buys ▲ and sells ▼ sit on a row under the curve, at the nearest equity point's x (`lineChart` maps by index, not time). Range is session / 1h / 1d / 1w / all; session is the default while running.
- **Mission control:** settings are chips, with ←→ to select, ⏎ to edit and -/+ to step. The running session's mission is shown but locked. Gauges show orders, day loss and invested against their limits. The mission draft is saved as `cli-trading-mission.json` in the store.
- **Panel badges:** `panel()` now keeps a badge's own background in the title bar; it used to force the bar colour, which hid it.
- **Responsive:** from 120 columns there are two columns, and the right column gives space to account+chart, then holdings, then trades. Below 120 it stacks. Tight panels drop the blank rows around the stats strip before they drop the chart.

## Testing it live
`ptyhtml.cjs` (a PTY harness that writes each dump as colour HTML from xterm's cells) plus a scripted mock trading agent behind Ollama's API. Point a scratch profile's `providers.json → ollama.baseUrl` at the mock, and seed the mission file so G starts it. The method is in [[Eaon CLI: watching the agent work (scanner, scrolling, spinning logo)]].

A first-run "bring your setup over" dialog swallows keys in a fresh profile; send Esc first.
