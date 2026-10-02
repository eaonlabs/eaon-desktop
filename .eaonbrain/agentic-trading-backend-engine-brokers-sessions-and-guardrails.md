---
title: Agentic trading backend: engine, brokers, sessions and guardrails
tags: [eaon-desktop, trading, agent, workers, gotchas]
created: 2026-10-01T03:40:45.224Z
updated: 2026-10-01T14:00:09.050Z
---

# Agentic trading backend: engine, brokers, sessions and guardrails

The main-process side of agentic stock trading (Sept 30, 2026). Contract: `src/shared/trading.ts`. Code: `src/main/features/trading/` — `marketHours.ts`, `marketData.ts` (Yahoo), `brokers.ts` (the `Broker` interface), `simulator.ts`, `alpaca.ts`, `engine.ts`, `tools.ts`; the feature is `src/main/features/trading.ts` and the bridge is `src/preload/features/trading.ts` (`window.api.trading`). Tests: `EAON_TEST_OUT=t-trading npm run test:main -- trading` (44 tests, about 2 s, no network). Sessions reuse the headless-turn pattern from [[Eaon Workers engine: threads, heartbeats and mail]] and [[Scheduled tasks engine and headless runs]].

## Decisions and why
- **Eaon keeps its own order ledger** (`trading-orders.json`), tagged per broker and tied to the broker's copy by `client_order_id = eaon-<uuid>`. That ledger is how Alpaca orders keep the agent's reason, source and session. FIFO realized P&L is recomputed over the ledger on every refresh. Orders placed outside Eaon show as `source: 'user'` with no reason. Stats and the equity curve are per broker, and a simulator reset wipes the simulator's ledger and curve.
- **Every refusal is a recorded `rejected` order**, never a throw. Only a malformed request throws (no symbol, no size, both qty and notional). The guardrails are pure (`checkSwitches` + `checkLimits`) and unit-tested rule by rule. The end-of-session sell-off (`flatten`) skips size, count and allow-list limits, but never the kill switch or the no-short rule.
- **Orders are serialised** through a promise chain (`orderChain`). Two orders checked in parallel would both see the same room under a limit.
- **Sessions**: one at a time. Each check is one `runAgent` turn with `chatId: trading:<id>`, `unattended: 'autonomous'`, an approver that always says no, and `sessionToolGate` (trading_* tools plus web_search, web_fetch and update_plan). The next check is scheduled only after the current one finishes, so checks never overlap. Only a natural end flattens; a manual stop or the kill switch keeps positions. Any end cancels the session's open orders. Three failed checks in a row end the session as `failed`.
- **Real money**: `trading_order` is `risky` (a chat always asks) and `catastrophic` on alpaca-live unless the chatId starts with `trading:`, so an autonomous worker can't place live orders, but an armed session can. `trading_session` start and schedule are marked catastrophic on live for the same reason. Switching broker or halting stops the running session, so a session started on practice money never continues on real money.
- **Restart**: a session still `running` on disk resumes if its `endsAt` is ahead. Its past `decision` log entries are seeded back in as the conversation history. If the end has passed, it closes as `done` and is not flattened (selling hours later would surprise the user). On quit, `stop()` logs the session as interrupted and leaves it `running`.
- **Schedules** start once per window. A session the user stopped stays stopped until the next window. A start that fails (for example, missing keys) shows up as one failed session, retried every 5 min (in-memory `scheduleTries`). Windows use the local `Date` constructor, never "+24 h".
- Desk refreshes run every 30 s while a session runs or the desk is open, and every 5 min otherwise. The desk counts as open when the renderer calls `trading:desk-open` (extra channel), or for 2 minutes after any `snapshot`/`refresh` call.

## Gotchas
- **Yahoo answers 429 to some User-Agents and serves others.** It refused a full Chrome UA but accepted `Mozilla/5.0` and `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)`. The client tries the next UA on a 429.
- **Yahoo `chartPreviousClose` is the close before the whole range.** For a quote, use `range=1d` and `meta.previousClose`. Over 5d it is five days back. Bar prices are float32 noise (330.79998779296875), so they are rounded to 4 decimals.
- **Alpaca 403 is not always bad keys.** It also refuses orders that way ("insufficient buying power"). Only 401 always means keys; a 403 on `/v2/orders` with a message is reported as an order refusal.
- **An agent stopping its own session from inside its turn would deadlock** (ending the session awaits the very turn making the call). `stopFromInside` sets `stopAfterTurn` instead.
- **A refresh in flight during a simulator reset or a broker switch** could merge stale orders back into the ledger. An `epoch` counter makes `doSync` drop results that belong to an older account.
- At equal fill timestamps, FIFO sorts buys before sells; the ledger is newest-first, so without that a same-millisecond buy and sell would match backwards.
- Tests shrink time with `minuteMs` (a session "minute" = 40 ms) and fake the clock with `now: () => Date.now() + offset`, so the end timers still run in real time.

Related: [[Agentic trading: protective exits, the agent's market view and live testing]]

Related: [[Trading workers and broker plugins: Robinhood MCP, approvals and the kill switch]]
