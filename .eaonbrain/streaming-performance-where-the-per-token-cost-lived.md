---
title: Streaming performance: where the per-token cost lived
tags: [performance, streaming, zustand, ipc, renderer]
created: 2026-08-22T19:59:58.406Z
updated: 2026-08-22T19:59:58.406Z
---

# Streaming performance: where the per-token cost lived

The app felt laggy during replies. Every cost was on the per-token path; nothing
per-stream mattered (measured: `listProviders()` 0.88ms, `secrets.has()`
0.051ms, `store.getSettings()` 0.056ms — all once per request).

Measured with a standalone Node benchmark (60 chats × 40 messages, 2000-token
reply): **0.165ms → 0.011ms of JS per token, ~15×**. That excludes the React
reconciliation and IPC savings below.

## The seven fixes

1. **IPC batching** (`src/main/index.ts`, `frameBatched`). Providers emit many
   tiny deltas — often several per frame. Each was its own `chat:event` send,
   so each caused a store write and a render. Now buffered 16ms and merged per
   `(type, messageId)`. A verification script showed 23 events → 5 messages with
   text and ordering intact. `done`/`error`/`approval-request` call `flush()`
   before sending so they can never overtake buffered text.

2. **Stream reducer indexes instead of rebuilding** (`state/store.ts`). It used
   to `chats.map()` with a `.some()` per chat. Now `findIndex` → `slice()` only
   the two arrays on the path to the changed message, so every other chat and
   message keeps its identity and `React.memo` can skip it.

3. **`updatedAt` no longer moves per token** — only when the turn ends. Bumping
   it per token re-sorted `visibleChats()` and re-rendered the whole sidebar.

4. **`MessageRow` and `ChatRow` memoised.** `ChatRow` also subscribed to the
   whole `chats` array just to toggle pin; that now reads
   `useApp.getState().chats` lazily.

5. **20 whole-store subscriptions narrowed.** `const { a, b } = useApp()`
   re-renders on *every* store change. All hot-path components (App, ChatView,
   Composer, Sidebar, BrowserPanel) use `useApp(useShallow((s) => ({ … })))`.

6. **Derived selectors cached on input identity.** `availableModels()` keys on
   the `providers` reference, `visibleChats()` on `(chats, workspaceId)`. These
   run on every store change, and returning a stable array lets subscribers bail
   out on reference equality.

7. **`messageText` fast path.** Streaming coalesces consecutive same-type parts,
   so a message usually holds one part — return it directly instead of
   allocating `filter` + `map` + `join` on a growing reply. This was the
   original quadratic: 64ms and 10M chars copied on a 2000-token reply.

## Two correctness bugs found while auditing

- **`init()` was not idempotent.** It binds the `chat:event` listener, and
  StrictMode double-invokes effects in dev — two handlers, the second reading
  already-updated state and appending the same token again, so replies came out
  **doubled**. Guarded with a module-level `listenersBound`.
- **`saveChats` blocked the main process.** `writeFileSync` with
  `JSON.stringify(v, null, 2)` on an unbounded file freezes IPC, input and
  painting for its whole duration. Now `writeJsonAsync`: compact JSON, tmp +
  rename for atomicity, per-file promise chain so writes can't interleave, and
  `store.flushWrites()` on `before-quit` so the last save is never lost. Small
  config files stay pretty-printed.

## Deliberately not "optimised"

`parseThinkingSteps` regex: 0ms over 100KB × 1000 iterations. It was memoised
only to avoid re-running on unrelated renders, not because it was slow.
Shimmer/spin CSS animations only mount while work is in flight. `codeIndex`
already uses async fs throughout.

Related: [[zustand selector identity and React error #185]]
