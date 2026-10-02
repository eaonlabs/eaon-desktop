---
title: Scheduled tasks engine and headless runs
tags: [eaon-desktop, scheduler, agent, electron, chats, gotchas]
created: 2026-09-23T21:30:00.000Z
updated: 2026-09-29T14:29:37.547Z
---

# Scheduled tasks engine and headless runs

The Scheduled page used to save tasks to localStorage, and nothing ever ran
them. Now `src/main/features/scheduler/` runs them in the main process,
whether or not a window is open. See [[Eaon Desktop architecture]] and
[[Eaon Work mode]].

## Layout

- `src/shared/scheduler.ts`: types plus the pure schedule math
  (`nextRunAfter`, `latestDue`, `describeSchedule`, `mergeRunChat`). It's
  shared so the editor can preview "Next run" with the same code the engine uses.
- `engine.ts`: when tasks run. It arms one timer for the soonest task, adds a
  60 s heartbeat, and ticks again on `powerMonitor` resume. The actual run is
  injected (`execute`), so tests can drive it without Electron.
- `runner.ts`: builds the chat, calls `runAgent`, and hands the chat to a `ChatSink`.
- `service.ts`: storage (`scheduled-tasks.json` via `store.getJson`), chat
  delivery, notifications and IPC. `tool.ts` is the `schedule` Work tool.

## Decisions and why

- **Daily/weekly times are built day by day with the local Date constructor,
  never "+24 h".** Across DST a day is 23 or 25 h. On spring-forward, a time
  inside the skipped hour (02:30) runs at 03:30. On fall-back, a repeated time
  runs once, at its first occurrence. Tests pin `TZ=America/New_York` (Node
  applies a runtime TZ change) and write expected instants with explicit offsets.
- **Intervals sit on a grid** (`startAt + k·period`), not "period after the last
  run", so late timers never cause drift. Editing only the name keeps the grid.
  Changing every/unit starts a new grid.
- **Catch-up uses the *latest* missed slot.** If it is under 24 h old, the task
  runs once; if older, a `missed` entry is recorded. It never bursts through
  every slot it missed. The same `tick()` handles launch, sleep and clock
  changes. A stored `nextRunAt` later than `nextRunAfter(now)` means the clock
  went backwards, so the run is pulled in.
- **At launch, catch-up waits for the renderer's `scheduler:ready`**, with a
  10 s grace, so catch-up chats go straight to the renderer.
- A run left as `running` in the file (quit or crash) loads as `failed`.

## Gotcha: who may write chats.json

While a window is open, the renderer owns chats.json. It rewrites the whole
file from memory, so any write from main would be lost. The rules:
- **Renderer ready** → send the whole chat on `scheduler:chat` at run start and
  run end. The store listener inserts it, or merges it with `mergeRunChat`,
  which keeps renames, pins and follow-ups. Events stream through
  `ctx.emitStream` as usual.
- **No renderer** → main merges into chats.json itself, through a promise lock
  with `flushWrites()` before reading. It also keeps the *live* chat object in
  `undelivered`, so a window that opens mid-run gets the current state when it
  says ready.
- The runner applies every event to its own copy (`transcript.ts`, a port of
  the store's reducer). That copy is authoritative. Delivering it at the end
  repairs anything the renderer missed.
- `ready()` in the preload bridge **retries**. Feature IPC registers after the
  window is created, so a fast renderer can invoke before the handler exists.
  An unanswered ready would leave main writing chats.json under a live renderer.

## Approvals with nobody watching

`RunOptions.unattended` (added to `agent/loop.ts`) replaces the approval
gate. `'read-only'` refuses every mutating call; `'safe'` refuses only risky
ones. Neither asks anyone. Scheduled runs force `swarm: false`, because swarm
sub-agents build their own `LoopParams` and would bypass the policy. They also
force `plan: false`. The `approver` passed to headless runs always returns
false; only a tool's own `ctx.confirm` (computer use) reaches it.

Consequence: `run_command` is mutating, so a read-only Work task can't even
run `gh`. Tell users (and the `schedule` tool tells the model) to set
`allow_changes` for anything that needs the shell.

The `schedule` tool isn't offered inside a scheduled run. The check is the
last history message's `scheduledTaskId`.

## Verifying

- `npm run test:main -- scheduler` covers the math, the engine with a mocked
  `runAgent`, and the real loop against `sseServer` as a fake model, which proves
  the policy.
- `EAON_LIVE=1 npm run test:main -- scheduler-live` runs on Ollama.
- The capture harness can seed tasks through `window.api.scheduler.save`.
  `location.reload()` inside a step works; the next step runs on the reloaded page.

Related: [[Scheduled runs: stall watchdog, monotonic clocks and windowless memory]]
