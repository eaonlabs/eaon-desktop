---
title: Eaon CLI trading missions: open to close, every market day
tags: [eaon-cli, trading, claude-code]
created: 2026-10-04T00:10:39.838Z
updated: 2026-10-04T00:10:39.838Z
---

The user's model of trading (Oct 3, 2026): "You link a account to the eaon cli. then you enter the trading tab. You give claude code or the in built agent a goal and it should run until the market closes. After it opens it should start again". The desk is built around that flow, and RUN FOR defaults to **every market day**.

## A mission is a schedule, not a new concept
G with RUN FOR = `market` saves a `TradingSchedule` through `trading:save-schedule`:
- `marketHours: true`, plus `driver` ('claude-code', or absent for Eaon's agent);
- days Mon–Fri and 09:30–16:00, kept only for display. With `marketHours`, `scheduleWindow` ignores them and uses `sessionOn(marketDate(now))`, so holidays and half days come from `marketHours.ts`;
- the window ends `CLOSE_MARGIN_MS` (5 min) before the close, so flatten-at-end orders still fill.

`tickSchedules` (every 30 s) starts the day's session with the schedule's driver, so restarting at each open needs nothing new. An open window starts its session at once. The desk keeps the schedule id in the mission file (`missionId`). A later G updates that schedule rather than adding another.

**X stops the mission:** it disables the schedule (`enabled: false`) and stops today's session, after a confirm that says both. Stopping only the session would let the next open start it again. Stopping today's session by hand also keeps it stopped for the rest of the day: `nextScheduledStart` and `tickSchedules` skip a window that already had a non-failed session.

## Claude Code across days
Claude Code only takes the mission when the user types `/mcp__eaon__trade` (policy: [[Eaon CLI: Claude Code as the trading agent (session driver)]]). So it has to wait between sessions itself:
- `tradePrompt` builds a mission prompt when an enabled claude-code schedule exists (`claudeMission`, which prefers `marketHours`). It loops "until Eaon says the mission is over".
- With no session, `eaon_wait_for_check` calls `trading:wait-session` → `engine.waitForSession(4h)`, which polls `nextScheduledStart('claude-code')` every 30 s. It returns:
  - `session`: today's session has started;
  - `waiting`: still before the next session, so call again;
  - `none`: the mission was disabled. The tool then says "The mission … is over: the user stopped it", and Claude Code stops.
- While a `waitForSession` is pending (and for 2 minutes after one returns, to cover the gap between calls), the snapshot has `claudeWaiting: true`. The desk ("✻ Claude Code is waiting for it") and the Claude Code screen's banner ("Holding Eaon's mission…") use it.

## Desk wording
- GOAL, not STRATEGY: the user's word. The field is still `strategy` in the data.
- ACCOUNT, not BROKER: it cycles the simulator and Alpaca accounts that have keys. Live still goes through the typed confirmation in the setup.
- The ◷ MISSION ARMED badge and the "Next session at the open, Mon 06:30" header show local time.
- The empty desk shows a 4-step guide (link · agent · goal · G), with ✓ on the steps already done.
- LINKED now lists Alpaca paper and live first ("the agent trades it"), then MCP brokers. MCP brokers (Robinhood and others) are deliberately **not** traded by autonomous sessions: Eaon can't put its limits in front of their orders. They stay with the chat, workers and Claude Code, and each order asks the user.

## Gotchas
- **Eaon must be running at the open.** There is no daemon: only the engine owner (an open `eaon` TUI) ticks schedules. Closing every terminal pauses the mission until Eaon reopens. If it reopens mid-window, the session starts then.
- **Don't make G wait on the snapshot before switching to Claude Code.** That made G look dead for 1–3 s in the live run. `armMission` puts the saved schedule into the local snapshot, switches and toasts at once, and refreshes in the background. "Open now" is computed as `isOpen && nextClose - now > 5 min`.
- `waitForSession`'s timer must not be `unref`'d. A test (and a real waiter) needs the loop kept alive.

Tests:
- "missions: …" in `test/trading.test.ts`: the Mon session ends at 15:55 ET; a hand stop waits until Tue; Tue restarts; Saturday has nothing; disabled gives `none`; `claudeWaiting` is set.
- "mission: G with every market day…" and the mission prompt and mission-over cases in `test/cli-desk.test.ts`.
- Verified live (Saturday, market closed) with a stand-in MCP client: arm, then the banner, then "waiting for it", then X, then the wait returned `none` within 30 s.
