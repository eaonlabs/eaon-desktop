---
title: Worker autonomy: access levels, routines, memory and approve-once
tags: [eaon-desktop, workers, agent, autonomy, security]
created: 2026-10-01T00:18:59.696Z
updated: 2026-10-01T14:00:08.437Z
---

The co-founder wanted Workers "more autonomous, pretty much matching grok bot or OpenAI dots", with no swarm mode because the workers themselves are the swarm. Research (Sept 30, 2026): **xAI Grok Bot** (Aug 2026; Team Bots Sept 28) and **OpenAI dots** (DevDay Sept 29, GPT-6 Astra). The mechanisms they share and Eaon copied: a goal pursued without being prompted, memory kept outside the conversation, schedules the agent sets itself, questions that don't block, stopping to report instead of looping, reaching out first, and per-action rules where money and passwords are always human-only. The engine is described in [[Eaon Workers engine: threads, heartbeats and mail]].

## Access levels (`WorkerAccess`, shown in the editor as "Freedom")
- `autonomous` (the default for new workers) → loop `unattended: 'autonomous'`: every tool runs, **except** calls a tool marks `catastrophic` (new on `AgentTool`):
  - `run_command`: `isCatastrophicCommand` in approvals.ts (sudo, disk erase, `rm -rf /`, `~`, force-push, `curl | sh`, shutdown, package publish, DROP, keychain or credential paths);
  - plugin calls marked destructive;
  - the browser tools: card, password and code fields, spend-money buttons;
  - computer use: `riskReason`.

  The approver returns true, so computer use's own per-click confirm passes.
- `safe` ("Careful"): risky calls are refused, as before.
- `read-only` ("Look only").
- **Plugins "didn't work" in Workers** because the loop refused every non-read-only plugin call when unattended, even with Settings → MCP → "Allow all tool permissions" on. That pre-approval now holds for unattended runs (workers and scheduled tasks); `test/loop.test.ts` was updated on purpose.

## Approve-once
A refused catastrophic call tells the model to `ask_user` with `approve_tool` and `approve_input` set to that exact call. The user's **Approve once** (on the worker page's question card) adds a grant: the tool plus the input as JSON with sorted keys, expiring after 24 h. `engine.allowOnce` consumes it the first time the loop would refuse that exact call. It flows through `RunOptions.allowOnce` → LoopParams.

**Tool names are compared without a namespace** (`toolName()` in engine.ts, applied both when a grant is stored and when a call is checked). On Oct 1 2026 a GPT-5.6 worker asked with `approve_tool: "functions.email_send"`, the way OpenAI-style models name tools as data; Gemini uses `default_api.`. The literal comparison never matched the real call `email_send`, so an email the user had approved was refused again. The worker reported it as "blocked by the email service despite approval". The `approve_tool` description now also says to use the name exactly as called. A grant lives in memory, so restarting Eaon drops any pending approvals.

## Questions, notes, routines
- `ask_user` doesn't block: the question goes into `worker.asks`, shows as a card above the composer (quick options, or Approve once / Decline, plus a free-text field), and sends a notification through `deps.reachOut`. Answering removes it and delivers mail `[Answer to "…"] …`. `notify_user` is for reaching out on its own (notification plus unread).
- `set_goal` and `update_notes` (append one line, or replace all; capped at 600/4000 chars, oldest lines dropped first) live on the Worker and are rendered into the **persona**, so they survive compaction. The persona only changes when they change, which keeps the prompt cache warm.
- Routines (`add_routine` / `remove_routine`, at most 20): every N minutes or daily at a 24-hour HH:MM time. They take part in `nextWake` / `isDue` / `arm`. A due routine adds a `[Routine "name"] task` line to the turn message; `finish()` logs the run (last 20) and schedules the next one, **with no retry on failure** (stop and report). The single heartbeat stays as the one-off slot.
- `set_heartbeat`: `in_minutes: 0` now means "as soon as possible" (1 minute). Before, it threw "Say when…", the bug the co-founder hit when asking a worker to message right away. It also accepts `at` (a clock time or ISO, parsed by `parseWakeTime`).
- Workers no longer get the app `schedule` tool (it creates chats and confused workers into "Updated schedules · 1 failed"). The activity line now says "checked the schedules" for a `list`.

## Tested
`test/workers.test.ts` (29: routines, memory caps, ask/approve-once, notifications, the tool set); `test/loop.test.ts` (autonomous gate: risky runs, catastrophic refused, allowOnce lets that exact call through once). In the packaged app, an autonomous worker on a 2B local model answered its questions, updated its notes and status on its own, and used its own browser. **Watch out:** a small model with autonomous access will wander (it began running read-only `ls`/`find` commands to "do it now"). That's acceptable, but the user should know.

Related: [[Workers' own browser: BetterWright on Electron 33]]

Related: [[Trading workers and broker plugins: Robinhood MCP, approvals and the kill switch]]
