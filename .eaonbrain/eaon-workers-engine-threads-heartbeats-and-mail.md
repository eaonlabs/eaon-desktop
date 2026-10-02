---
title: Eaon Workers engine: threads, heartbeats and mail
tags: [eaon-desktop, workers, agent, scheduler]
created: 2026-09-30T02:29:32.286Z
updated: 2026-10-01T00:07:10.145Z
---

# Eaon Workers engine: threads, heartbeats and mail

Workers are always-on agents (the "Workers" tab). The backend is `src/main/features/workers/` — `engine.ts` (when turns run, every command), `runner.ts` (one headless turn), `tools.ts` (worker tool source), `prompt.ts` (persona), `service.ts` (files, IPC, batching, notifications). Contract and derived helpers (`workerMood`, `describeWorker`) are in `src/shared/workers.ts`; bridge is `window.api.workers` (`src/preload/features/workers.ts`). Built on the same headless-run pattern as [[Scheduled tasks engine and headless runs]] and the one loop in [[Agent core: one loop, adapters and tool sources]]. The UI side (faces, team, worker page) is in [[Worker faces: eyes-only animation and derived moods]]; why the tab exists at all is in [[Chat, Workers and ADE: the three tabs and Chat as the agent]].

## Decisions and why

- **Main owns workers outright.** Unlike chats (renderer owns chats.json), the renderer only displays workers and sends commands, so there is no hand-off of who may write. `workers.json` holds metadata (sync write, small); each thread is `worker-<id>.json` via `store.setJsonAsync` (threads grow forever) and is loaded lazily on first need.
- **Everything a worker is told is mail.** User messages, colleague messages and "Check in" all queue in `inbox`; when the worker is free the whole inbox (plus a due heartbeat) is drained into ONE user message. The model reads a combined text (`[Heartbeat] …`, `[From the user] …`, `[From Nova, a fellow worker] …`); the message also carries `mail[]` / `heartbeat` so the UI can draw each piece as its own bubble. Mail arriving mid-turn simply waits — no interleaving, never two turns at once for one worker.
- **Each turn message opens with the local time** (`[Tue, Sep 29, 7:30 PM]`). The system prompt only carries the date so it stays cached all day; a worker watching something needs the time. Tests strip that line in their `text()` helper.
- **Files:** the user's files go in `attachments` (so images reach vision models via context.ts); a colleague's files are *copied* into `<recipient folder>/from-<sender>/` and listed by path, so each worker only works in its own folder.
- **Heartbeat bookkeeping** at the end of a turn: a repeating beat continues from *the end of the turn* (never catches up in a burst — a beat missed while Eaon was closed runs once); a one-off is spent; anything the worker set with `set_heartbeat` during the turn wins (tracked per turn by `heartbeatSet`). Same idea for `set_status` vs the auto one-line summary (`activitySet`).
- **Budgets against runaway loops:** self-caused turns (heartbeats, colleague mail) are capped at `MAX_TURNS_PER_HOUR` per worker and deferred with a "Resting —" status; the user's mail and Check in always go through. Also 30 sent messages/hour per worker, and at most 2 worker-created workers per 24 h. A created worker inherits its creator's **model and access** (a read-only worker can't mint a writer; and without the model it would fall back to the app default, which may not exist).
- **Unattended policy:** turns run with `unattended: 'safe'` (or 'read-only'), `approver` always false, and `work: {swarm:false, plan:false}` — swarm sub-agents build their own approval gate that ignores the unattended policy, plan mode would stop at a plan nobody approves (same reasons as scheduled runs). The loop's refusal strings were made generic ("This run is read-only…", "this run has nobody to ask") since workers share them.
- **Compaction is forced for workers**: `runAgent` compacts when `settings.context.autoCompact || request.workerId`. A worker's thread never ends, so if it obeyed a user who turned auto-compact off it would eventually outgrow the model and stop working.
- **Persona** travels as `StreamRequest.persona` → `roleBrief`, replacing the normal agent intro ("You are Eaon, the user's assistant…"). It is kept stable per worker (only edits change it) so the prompt prefix stays cached; per-turn facts go in the turn message.
- **New workers are created `idle`, not `asleep`**, so they greet the user awake ("Ready for its first job"); `workerMood` lets them doze after `DOZE_AFTER_MS` with nothing to do. After a turn with nothing scheduled the status does go to `asleep` (the happy face shows first for `HAPPY_FOR_MS`).
- **Stored thread pruning** drops only messages a compaction summary already covers, past 300. Nothing the model still reads is dropped.

## Gotchas

- **Never arm a 0 ms timer for a heartbeat that is due but blocked.** `arm()` used to take the soonest `nextAt` of any non-running worker; a heartbeat already due but unable to start (both `WORKER_CONCURRENCY` slots busy, or over the hourly cap) gave delay 0 → `tick()` skipped it → `arm()` re-armed 0 ms → the main process spun at full CPU until a slot freed (48 ticks in 60 ms in the regression test). `arm()` now skips due-but-blocked heartbeats; `finish()` calls `tick()` when a slot frees and the 30 s interval re-checks the cap. Test: "a due heartbeat that cannot start yet waits quietly instead of spinning the timer".
- The engine has lifecycle `stop()` (quit) *and* a per-turn `stopTurn(id)` — they used to share a name, a duplicate-implementation error.
- `stop()` on quit records running turns as interrupted *synchronously* (seals running tool parts, status idle, "Interrupted when Eaon quit") because the aborted turn may not report back before exit; `finish()` after disposal is ignored. `load()` repairs a crash the same way.
- `clear()` empties the thread **in place** — a turn still winding down holds the thread object and must find its message gone rather than write into a cleared thread.
- The loop's "you said you'd do it — go ahead" continuation fires on replies like "I will pull it in when it lands", so a scripted fake model that says that gets a second turn appended to the same text part. Not a workers bug; phrase fake replies in the past tense.
- Tests (`npm run test:main -- workers`): a held fake agent must remove its own release when aborted, or the test's next `release()` resolves the dead turn and `whenIdle()` hangs forever (the whole file then times out with no output). Workers without a pinned model resolve the app's model, which doesn't exist under the test stub — pin `{providerId:'ollama', modelId:'fake-model'}` like the scheduler tests. `engine.list()` hands out clones; to force a state in a test, reach the engine's private `workers` array.

Related: [[Chat apps: Workers in Discord, Telegram and WhatsApp]]
