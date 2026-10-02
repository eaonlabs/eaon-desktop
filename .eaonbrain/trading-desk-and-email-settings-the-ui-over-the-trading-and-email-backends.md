---
title: Trading desk and email settings: the UI over the trading and email backends
tags: [eaon-desktop, trading, email, ui, ade]
created: 2026-10-01T03:47:09.605Z
updated: 2026-10-01T04:45:05.585Z
---

# Trading desk and email settings: the UI over the trading and email backends

The co-founder's Sept 30 2026 request: agentic stock trading "with an interface which shows you the money increase and everything and the trades and all the statistics", trading that "stays on from a certain time to another time", and the agent having "its own email … with your own custom domain". Backends: [[Agentic trading backend: engine, brokers, sessions and guardrails]] and [[Agent email through AgentMail: backend, decisions and API gotchas]].

## Trading desk (ADE → Trading, view `trading`)
- `components/trading/`: TradingDesk.tsx (hero, active session, chart, KPI row, holdings, trades), EquityChart.tsx, TradeTicket.tsx, TradingSessions.tsx (start now until a time, schedules, past sessions and the agent's log), TradingSetup.tsx (broker cards, Alpaca keys, typed real-money confirmation, limits), tradingStore.ts (snapshot mirror and formatting). Styles in styles/trading.css. It lives in the ADE sidebar under Pull requests. `setDeskOpen(true/false)` on mount and unmount makes main refresh every 30 s while the desk is on screen.
- **Chart, per the dataviz skill:** one series, so one line in the accent colour with a 10% wash, a hairline baseline at the start of the range (above it is a gain, below a loss), a direct label on the last value only, a crosshair that snaps to the nearest point plus ← → from the keyboard, and a Table toggle with the same numbers. Red and green appear only in delta text, always with a sign and an arrow, never as series colour. One hero figure (52 px). Every KPI tile has a label, a value and a note.
- **The chat agent "talks with the ADE"** through the trading tools: `trading_session start` from a chat starts a session the desk shows (verified end to end). The desk's "Start trading" and schedules drive the same engine.
- `signedUsd`/`signedPct` show values that round to zero as "0.00%" / "$0.00", never "−0.00%".

## Email settings (Settings → Integrations → Email)
- `settings/pages/Email.tsx` plus styles/email.css. Sign-up form (address @agentmail.to, display name, the user's own email for the code), or an existing AgentMail key. Then the code entry, the inbox preview (click to read), domains (a records table with copy buttons and per-record status, Check again), "an address on this domain" once a domain is verified, and options (notify, check interval, daily cap).
- **The DNS table must use `table-layout: fixed`** with set column widths and ellipsised cells. A long DKIM value otherwise pushed the Status column off the card.

## Verified end to end (built app, scripted model, isolated profile)
- Simulator: $100k, a live AAPL quote from Yahoo, buy $1,000, sell $300 (realised P&L shown on the sell), a $5,000 order refused by the $2,000 limit and listed as Refused with the reason.
- The chat agent bought 1 MSFT through `trading_order` (source "Eaon").
- The chat agent started a session; its check placed an order (source "Session"); a shell command was refused inside it; it was stopped from the desk.
- Email page: sign-up form, ready state, inbox and domain records.
- Not verified live: real Alpaca keys, a real AgentMail sign-up (it would email the user), and the equity curve with many points (one point per minute at most, so a short run shows the empty state).

Related: [[Full autonomy and goals with an end time]], [[Chat agent's own browser and the live view]], [[Building a second copy of the app with electron-vite --outDir]]

Related: [[Agentic trading: protective exits, the agent's market view and live testing]]
