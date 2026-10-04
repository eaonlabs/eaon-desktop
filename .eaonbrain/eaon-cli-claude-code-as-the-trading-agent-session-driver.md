---
title: Eaon CLI: Claude Code as the trading agent (session driver)
tags: [eaon-cli, trading, claude-code, policy]
created: 2026-10-03T23:04:33.414Z
updated: 2026-10-04T00:10:23.372Z
---

The user asked for an option to replace the trading agent "with a claude code session which has a full control over the account and all the trading". Built on [[Eaon CLI: Claude Code tab and full-control MCP]] and [[Eaon CLI trading: disclaimer gate, talking to the agent, live watch and linked accounts]]. For the every-market-day version (Claude Code waits overnight between sessions), see [[Eaon CLI trading missions: open to close, every market day]].

## Policy shapes the design
Eaon may not start Claude Code's work: no `claude -p`, no prompt passed on launch, no keystrokes written into its PTY. See [[Claude plan through the user's own Claude Code (headless provider)]]. So **the user hands the session over**, by typing `/mcp__eaon__trade` in the embedded Claude Code. That is an MCP *prompt* that Eaon's server offers (`ListPrompts`/`GetPrompt`, only with `--control`), and Claude Code shows MCP prompts as `/mcp__<server>__<prompt>` commands. From there Claude Code runs a loop the prompt describes. Eaon only answers its tool calls.

## Engine (`driver: 'claude-code'` on the session and the start request)
- `armSession` schedules no turns for these sessions; `nextTurnAt` = due now. The watch, the end timer (and flatten), alerts and the inbox all still run.
- `waitForCheck(id, maxWaitMs)` (IPC `trading:wait-check`):
  - parks on `active.waiters` until a check is due: the interval, `tellSession`, a watch alert, `checkNow`, or the end;
  - then builds the same brief as Eaon's agent (`externalBrief`: turnMessage plus live lines, MESSAGE FROM THE USER, ALERT), counts the check, and sets `externalMessageId = claude-code:<session>:<n>`;
  - returns `waiting` if nothing came due by the deadline, and `ended` after the session ends (`endSession` wakes the waiters);
  - a closed market without a message just pushes `nextTurnAt` forward.
- `logDecision` (`trading:log-decision`) logs the decision and closes the check.
- `sessionOrder` (`trading:session-order`) places orders with source `session`, so session counts, limits and the end-of-session cancel apply.
- `recordExternalTool` (`trading:external-tool`) re-emits Claude Code's calls as `onAgentEvent` stream events under `externalMessageId`. The desk's recorder and feed then show them like Eaon's agent's steps. The MCP side maps its tool names to the trading agent's (`eaon_history` → `trading_history`, `eaon_order` → `trading_order`, …) so the feed's parsers read them.
- The snapshot carries `agent.driver` and `agent.connected` (a waiter is attached, or it took a check within the interval + 2 min).

Test: "sessions run by Claude Code…" in `test/trading.test.ts`. Eaon's `runAgent` must never be called.

## CLI
- `trading:research` (`core/tradingResearch.ts`, owner only) runs the agent's read-only trading tools by name, so Claude Code's `eaon_history`, `eaon_scan`, `eaon_news`, `eaon_account` and `eaon_quote` return identical text.
- **Timeouts:**
  - The MCP's `eaon_wait_for_check` waits up to **4 hours per call** (the bus call gets 4 h + 1 min). It still returns as soon as a check is due; the long cap is for overnight waits.
  - The embedded Claude Code is launched with `MCP_TOOL_TIMEOUT` = 5 h, unless the user set one. A Claude Code started outside Eaon has its own default tool timeout; if that is shorter, the call just times out and the prompt tells Claude Code to call again.
- Mission control: the AGENT chip (Eaon / ✻ Claude Code); with Claude Code, MODEL reads "Claude Code's own". G arms the mission (or starts the session) and opens the Claude Code screen, which shows an amber banner until Claude Code takes it.
- The feed shows "⚠ Waiting for Claude Code to take the session" until then, and a ✻ CLAUDE CODE badge.
- **Check numbers:** for Claude Code checks the recorder takes the number from the id. The `activeSession().checks + 1` rule for Eaon's agent was off by one here, because the engine counts external checks when it hands out the brief.

## Verified Oct 3, 2026 (stand-in MCP client in Claude Code's place, real Yahoo data, simulator)
- G opened Claude Code with the banner.
- The client fetched the `trade` prompt and took check 1: scan, quote, history, then buy 3 NVDA with a 4% trailing stop, then logged its decision.
- T on the desk ("Sell 1 NVDA now please") woke its waiting `eaon_wait_for_check` at once with MESSAGE FROM THE USER; it sold 1 and logged that.
- The feed and trades panel showed all of it, labelled "claude". X stopped the session.

**Not verified with the real Claude Code** (it would use the user's account): the first `eaon_*` call will ask for permission, and the README tells the user to choose "don't ask again".
