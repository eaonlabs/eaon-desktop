---
title: Eaon CLI trading: disclaimer gate, talking to the agent, live watch and linked accounts
tags: [eaon-cli, trading, safety]
created: 2026-10-03T21:06:32.842Z
updated: 2026-10-04T00:10:42.065Z
---

Requests made on Oct 3, 2026, on top of [[Eaon CLI agent desk: activity feed, account and mission control]]:
- "an option to talk to the AI which is trading";
- "how long or how many hours you want the agent to be trading";
- "the agent will … get fed info in realtime";
- link "agentic trading accounts like robinhood … via mcp or oauth";
- a disclaimer that "we are not responsible for any lost money", with a checkbox, making it "impossible to start trading without accepting".

## Disclaimer: enforced in the engine, not the screen
- **Text:** `TRADING_DISCLAIMER` and `TRADING_DISCLAIMER_VERSION` in `shared/trading.ts`. Bump the version when the substance changes, and everyone must accept again. The user was told to have the wording reviewed by counsel.
- **Acceptance:** stored as `TradingConfig.disclaimer = { version, acceptedAt }`. Only `engine.acceptDisclaimer(version)` sets it (IPC `trading:accept-disclaimer`); `setConfig` patches can't.
- **Only when asked for:** `TradingDeps.requireDisclaimer`. The CLI calls `requireTradingDisclaimer()` in `startEngines` before registering trading. **The desktop doesn't**, so desktop trading is unchanged and has no disclaimer UI.
- **The gate:** `placeOrder` refuses (a recorded `rejected` order) unless `flatten` is set, so stops, exits and end-of-session sells still protect holdings. `startSession` throws, which also covers schedules.
- **What follows:** every path is gated — desk, ticket, chat, workers, `eaon order`, MCP control. `snapshot.needsDisclaimer` drives the UI. `DisclaimerModal` (`views/trading/disclaimer.ts`): space ticks, ⏎ does nothing until ticked; `afterDisclaimer(view, then)` wraps actions.

## Talking to the agent mid-session
`engine.tellSession(id, text)` (IPC `trading:tell-session`):
- logs a new kind of log entry, `kind: 'message'`; the desktop renderer only uses kind as a data attribute;
- queues the text in `active.inbox`;
- runs a check at once, or, if one is running, `runTurn`'s finally schedules the next check at 0 ms.

The check's brief starts with "MESSAGE FROM THE USER (time): …". The persona says to answer in the final line and act where it fits the limits. A message is read even while the market is closed.

On the desk, T opens an inline box under the feed. With no session running, it goes to the trading chat (`TradingView.askAgent`).

Verified live: "Sell 2 NVDA now" got the agent to sell 2 NVDA and say so.

## Run for
The mission's `until` text is shown as the RUN FOR chip:
- -/+ steps through 30m to 8h or "close";
- `parseRunFor` reads a bare number as hours, since `parseUntil('3')` would mean 3 o'clock;
- a running session shows a time-used bar.

MCP `eaon_session start` takes `hours` or `until`.

## Live watch between checks
`scheduleWatch` / `watchTick` (`deps.watchMs`, default 15 s):
- quotes the holdings, the tickers in the strategy and SPY;
- a move from the last check's baseline wakes the agent early with an ALERT: 1.5% for a holding, 2.5% for a watched ticker, 0.75% for SPY;
- so does a holding within 0.5% of its active stop;
- early checks are at least `alertGapMs` (60 s) after the last check started, and only when orders could fill;
- the alert is also logged as a "⚡ … Checking now." note.

Each check's brief carries "Since your last check …" lines from `basePrices` → `latestPrices`. The **check resets the baseline when it starts**: resetting it in the watcher before the check read it lost the live lines, which a test caught. The snapshot carries `agent.watchedAt` and `agent.watching`.

## Linked accounts
`views/trading/accounts.ts`, the LINKED chip or `/accounts`. It is a terminal UI over the existing plugin catalog and channels: `plugins:sign-in` (OAuth + DCR, browser via the stub's `shell.openExternal`), `plugins:connect` (Tradier keys), `plugins:disconnect`. Brokers come from `BROKER_PLUGINS()`; see [[Trading workers and broker plugins: Robinhood MCP, approvals and the kill switch]]. "Another broker's MCP server" adds a `broker-…` server row by URL or command.

**Sessions still trade only the desk account.** Linked brokers' orders bypass Eaon's limits and are catastrophic real-money writes, which autonomous sessions refuse by design. So linked accounts serve the chat, workers and Claude Code, with approval or in-app confirmation. Letting a session trade a linked broker would need a per-order approval route from the session's approver to the TUI.

Claude Code in a tab with full control is in [[Eaon CLI: Claude Code tab and full-control MCP]].

Related: [[Eaon CLI trading missions: open to close, every market day]]
