---
title: Streaming UI: per-token work that remained, and one reply at a time
tags: [performance, streaming, renderer, zustand, eaon-desktop]
created: 2026-09-29T14:28:41.220Z
updated: 2026-09-29T14:28:41.220Z
---

Follow-up to [[Streaming performance: where the per-token cost lived]]. What still scaled with conversation length after that pass, what fixed it, and the behavioural rules that came with it (`state/store.ts`, `components/agent/`, `main/store.ts`).

## Per-batch work removed

- **Markdown** is split into blocks (`agent/markdownBlocks.ts`) and a streaming reply is re-parsed only from its last blank line outside a code fence; earlier blocks keep identity and skip re-render. A blank line at the very end does not count — more text can still join that paragraph. Randomised test compares against a full parse at every step.
- **Sidebar** reads `chatList()`, which keeps its identity while only message text changes, so it does not re-render during streaming. `updatedAt` moves only when a turn ends (it re-sorted the sidebar per token before).
- **Stream target lookup** is cached (`streamTargets`: messageId → chatId) and searched from the end, instead of scanning every message of every chat per batch.
- Tool cards, file diffs, thinking steps and the composer (with its menus) are memoised. Chat search only runs while search is open.
- **Popover position runs on every window scroll** — which happens per token while the view follows the reply — so anything added there is per-token work.
- **Main-process saves collapse**: saves that arrive during a write keep only the newest value, stringified when its turn comes (`writeJsonAsync`). `chats:save` returns nothing — it used to clone the whole history back over IPC.
- The "Task finished" notification gets its title from `StreamRequest.chatTitle`; it used to read and parse all of `chats.json` synchronously.

## Rules that came with the fixes

- **One reply streams at a time.** `send()` refuses while `streamingMessageId` is set, and Stop only shows in the replying chat (`streamingChatId`); elsewhere Send is disabled. A second send used to orphan the first run with nothing able to stop it.
- **Deleting or archiving the streaming chat stops it.**
- **Approvals queue** (`approvalQueue`): swarm sub-agents ask in parallel, and replacing the open request left it unanswered forever. Stop and turn end clear a run's requests.
- **Closing the window or reloading cancels the run** (`pagehide`) and saves the partial reply; main also cancels if the renderer dies. Main never saved chat turns itself, so a run left going had nowhere to write.
- **Tool calls left `running` at load are sealed as stopped** (`sealInterrupted`). Seeding a "running" tool and reloading — as the capture harness does — now shows it stopped; produce live states with events after Send (see [[Driving the capture harness over CDP for scripted app states]]).

## Still open

Each ThinkingOrb spinner runs its own rAF loop even off-screen; a long streaming code block re-renders in full per batch; the conversation view still visits every row per batch; a renderer crash mid-turn loses the turn (no periodic save).
