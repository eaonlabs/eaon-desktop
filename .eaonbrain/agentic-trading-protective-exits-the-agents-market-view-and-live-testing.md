---
title: Agentic trading: protective exits, the agent's market view and live testing
tags: [eaon-desktop, trading, agent, gotchas, testing]
created: 2026-10-01T04:45:02.022Z
updated: 2026-10-01T04:45:02.022Z
---

What was added on top of [[Agentic trading backend: engine, brokers, sessions and guardrails]] on Sept 30, 2026, after the user asked to "check the agentic trading is working and improve it for maximum performance", and what a real model did with it.

## Protective exits (engine-watched, not broker-native)
- `PositionExit` per broker+symbol in `trading-exits.json` (`ExitBook`): `stopPrice`, `targetPrice`, `trailPct` (+ `highWater`, derived `activeStop` = the higher of the fixed and trailing stop). Set with a buy (`OrderRequest.stopLoss/takeProfit/trailPct`, tool params `stop_loss/take_profit/trailing_stop_pct`), with `trading_exits`, or from the desk (shield button → `ExitEditor`, IPC `trading:set-exit`). The ticket also takes a stop and a target.
- **Why the engine watches them rather than Alpaca bracket/stop orders:** brackets need whole shares and reserve the shares (`held_for_orders`), which then blocks the agent's own sells; the simulator has no stop orders; notional/fractional buys can't carry them. Cost: exits only fire **while Eaon runs**. Refresh drops to 15 s (`exitRefreshMs`) while an exit could fire.
- `watchExits` runs after every `doSync` (not awaited inside it; tracked as `exitWork` for `whenIdle`). The sell goes through `placeOrder(..., { flatten: true })`: kill switch still blocks it, size/count/allow-list limits don't (a stop that can't sell protects nothing). A refused exit sale retries after 5 min (`exitRetryAt`). An exit set with a buy waits 2 min (`EXIT_GRACE_MS`) for the holding to show up before it's dropped as orphaned.
- Validation (`buildExit`): stop below the price now, target above, trail 0.5–50%; with a buy it is checked **before** the buy goes in so a bad stop never leaves an unprotected holding. `undefined` keeps a field, `null` (or 0 from the tool) clears it.

## The agent's market view
- `trading_scan` (Yahoo predefined screeners `day_gainers/day_losers/most_actives`, no key/crumb needed; filtered to ≥ $5 and ≥ $2B cap), `trading_news` (per-ticker RSS `feeds.finance.yahoo.com/rss/2.0/headline?s=`; the search API's `news` is **not** about the ticker), `trading_history` for up to 5 symbols with ATR14, MACD histogram (and whether it is strengthening), volume vs 20-bar average and range high/low.
- Each check's message now carries: SPY/QQQ today (+ SPY since the session began), quotes for tickers named in the strategy (`tickersIn`, with a stop-list of look-alike words), each holding's exit or `NO STOP SET`, and a **Buying room** line (the binding cap among per-order, invested %, per-stock %, buying power, plus what 1% of equity is).
- The persona adds risk rules: a stop on every buy (swing low or ~2×ATR), size from the stop to risk ~1% of equity then fit the limits, never average down, raise stops with `trading_exits`. The user's strategy overrides them.
- Sessions record `benchmark` (SPY at start/end); the summary says how SPY moved over the same time.

## Bugs found by running a real model
- **Simulator "fill anytime" + closed market = nothing ever happened.** The turn message said the simulator would fill, but the persona said "When the market is closed, do nothing" — gpt-oss obeyed, 0 tool calls. The persona line now depends on `simulatorAnytime`.
- **Effort bumped to the model's highest level** (`efforts[efforts.length - 1]` when the app's level wasn't offered) in the trading engine, `workers/runner.ts` and `scheduler/runner.ts`, so 5-minute checks could run at Max. Now `clampEffort` (see [[Effort levels: old ids, provider names and clamping]]).
- Without the Buying room line, the agent sized for 1% risk (57 QQQ ≈ $42k) and learned the $2,000 cap from a refusal; with it, every order fit first time.
- The agent asked `range: 1d` and read 5-minute bars as "20/50-day averages"; history output now says `20-day avg` or `20-bar (5-min) avg`.

## Live test
`EAON_LIVE=1 EAON_TEST_OUT=t-live npm run test:main -- trading-live` (`test/trading-live.test.ts`; `EAON_LIVE_MODEL`, `EAON_LIVE_CHECKS`, `EAON_LIVE_STRATEGY`). Real Yahoo prices, simulator with anytime fills, the real loop on an Ollama model; prints tool calls, the session log, orders and tokens. gpt-oss:20b, 3 checks: ~3 min, 11 tool calls, ~127k input tokens (each tool round resends the system prompt + tools, ~9k). gpt-oss often omits `side` on its first `trading_order` and corrects itself from the error.
