---
title: Trading workers and broker plugins: Robinhood MCP, approvals and the kill switch
tags: [eaon-desktop, trading, workers, plugins, mcp, security]
created: 2026-10-01T14:00:01.523Z
updated: 2026-10-01T14:00:01.523Z
---

Oct 1, 2026. The user asked for "an option to set the agentic trading up when they are configuring their agent", connecting "via Robinhood MCP and other". "The agent" here is a Worker; see [[Worker autonomy: access levels, routines, memory and approve-once]].

## What exists
- `Worker.trading: WorkerTrading | null` (`shared/workers.ts`): `via` (`'desk'` = the trading desk's simulator/Alpaca account, else an MCP server id such as `plugin-robinhood`), `strategy`, `everyMinutes`, `autoPlace`. Set in the editor's **Trading** section (`WorkerTradingFields.tsx`). That section connects a catalog broker in place by reusing the catalog's own controls (`PluginConnect`, exported from `PluginCatalog.tsx`). In a draft, `undefined` keeps the setting and `null` turns trading off.
- The engine keeps a **"Trading check" routine** (`TRADING_ROUTINE_NAME`) in step with the setting (`syncTradingRoutine`). Routines gained `marketHours`; `routineNextAt` moves a next run that falls outside market hours to 1 minute after the next opening bell, using `trading/marketHours` (holidays included). Workers can also set `market_hours` on `add_routine`.
- The persona gets a trading brief (`tradingBrief` in `workers/prompt.ts`). It covers: which account and whether it is real money; the broker's own caveat (`tradingNote`); which tools to use (`trading_*` on the desk, `<prefix>__…` or `plugin_tools` for a plugin); the risk rules; whether each order needs approval; and "don't trade" when the broker isn't connected. `WorkersDeps.tradingVenue` (in `service.ts`) builds the account description from the trading engine and `mcp.json`.

## Verified broker MCP servers (verifier run 2026-10-01)
| Catalog id | Endpoint | Auth | What it allows |
|---|---|---|---|
| robinhood | https://agent.robinhood.com/mcp/trading | OAuth + DCR (RFC 9728) | Equity orders from a separate "agentic" account |
| ibkr | https://api.ibkr.com/v1/api/mcp-public | OAuth + DCR | Read, plus drafted instructions submitted in IBKR (`/v1/api/mcp` also passes) |
| webull | https://api.webull.com/mcp | OAuth + DCR | Order instructions confirmed in the Webull app (the awesome-broker-mcp directory says read-only; Webull's docs say otherwise) |
| tradier / tradier-paper | https://mcp.tradier.com/mcp | Key in an **`API_KEY` header**, `PAPER_TRADING: true/false` | Orders straight away |

Not added: TradeStation (`unauthorized_client` at authorize), Alpaca's MCP (OAuth with no registration endpoint; Eaon already uses Alpaca directly with keys). Local-only official servers (Alpaca uvx, tastytrade, Public, Kraken, Coinbase) can be added under Settings → MCP Servers and then picked as a worker's account ("your server", treated as real money).
- Catalog entries gained `category: 'trading'`, `tradingNote`, `realMoney` and `tokenHeader`. `mcp.ts` sends `[tokenHeader]: token` instead of `Authorization` when it is set. The verifier now passes a pasted-token server that answers anonymously, provided it lists tools; Tradier checks the key per call.

## Approval rules (the part that protects money)
- `features/trading/access.ts` is a tiny registry: workers register `tradingFor(chatId)`, trading registers the kill switch. `brokerOf(serverId)` is true for a catalog broker, or any server some worker trades through. `writesToBroker` uses the read-only hint when there is one; otherwise lookup-named tools (`get_…`, `…_positions`, `…_quote`…) count as reads. **Tradier annotates nothing**, so the name rule matters.
- `brokerWriteNeedsUser` decides `catastrophic`: a worker set up to trade there follows its own `autoPlace`; anything else waits for the user whenever real money moves. Desk `trading_order` follows the same rule for `via: 'desk'` workers, on practice money too when they are set to ask.
- **Loop change:** `catastrophic` is now never covered by "Allow all MCP tool permissions". In a chat it always prompts (ask, auto or full); for a Careful worker it is refused, which before fell through the `risky && !preApproved` check. For an autonomous worker it needs Approve once. Test: `test/loop.test.ts` "never covers a call that can't be undone".
- The kill switch (`config.halted`) makes broker writes return an error before they reach the server (`pluginTools.call`).

## Gotchas
- **`.modal` had no max height and no scroll container.** The worker editor was already over 797 px tall; with trading on it reached 1,246 px and the Create button was off-screen. Now `.modal` is a flex column with `max-height: calc(100vh - 48px)` and `.modal__body` scrolls. This affects every dialog.
- The account list skips bundled servers (`official`: Filesystem, Memory).
- CDP scripting: a synthetic click on `.select` can open and close the menu in one go. Click the button element itself, then pick from `.menu .menu__item`.

Related: [[Agentic trading: protective exits, the agent's market view and live testing]], [[Plugin catalog verification]], [[MCP OAuth sign-in for plugins]].
