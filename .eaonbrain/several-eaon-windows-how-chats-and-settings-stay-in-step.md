---
title: Several Eaon windows: how chats and settings stay in step
tags: [eaon-desktop, electron, chats, ipc, architecture, gotcha]
created: 2026-10-02T03:06:32.514Z
updated: 2026-10-02T03:06:32.514Z
---

Since Oct 2 2026 Eaon can have several windows: File → New Window (⌥⌘N, as in Mail; ⌘N is New Chat), the Dock menu, or `window.api.window.open()`. Each window runs its own renderer with its own zustand store, so anything the store keeps had to stop assuming it is the only copy.

## Main (`src/main/index.ts`)
- `appWindows` (a Set) plus `lastFocused`. `currentWindow()` returns the focused Eaon window, else the last one in front, else the newest. `FeatureContext.getWindow` is that, and there's also `getWindows()`. Features that only show, focus or check `isFocused()` on `getWindow()` work unchanged. The computer-use pill and the agent browser are not app windows.
- `broadcast(channel, payload, except?)` sends to every page. `featureContext.send`, MCP, local server, index status, providers:changed and the updater all go to every window.
- A new window cascades 28px from the one in front, at the same size. `activate` creates a window only when there are none.

## Chats: one list, edits per chat
The renderer used to save **the whole chat list** on every change (`chats:save`). With two windows that is last-writer-wins on stale copies, so:
- `store.ts` (main) keeps `chatsCache` (lazy, from chats.json). `getChats()` returns a copy, `saveChats` replaces the list, and `applyChats(upserts, removed)` merges by id, with new chats on top.
- The renderer keeps `synced: Map<id, Chat>`, each chat as main last has it. `saveChatsNow()` sends only chats whose **object identity** differs (`chatChanges()` in `state/chatSync.ts`) and the ids that are gone, via `chats:apply`. Main merges and broadcasts `chats:changed` to the *other* windows. `receiveChats()` takes those in and updates `synced`, so nothing echoes back. It leaves alone the chat this window is streaming into (`streamingChatId`).
- A reply is saved by **the window that started it**. `chat:stream` sends every event to the sender, and every event except `approval-request` to the others, so they can watch it live. In `applyStreamEvent`, a non-owned event (another window's, or a scheduled run's) only updates `synced`, never persists. `send()` saves immediately (not debounced) so other windows have the new messages before the first delta arrives.
- On load, `sealInterrupted` skips messages in `chat:active-runs` (`activeRunIds()` in agent/loop.ts). Otherwise a new window would mark another window's live reply as interrupted.

## Settings, projects, workspaces
`settings:patch`, `projects:save` and `workspaces:save` broadcast the new value to the other windows. **`settings.activeWorkspaceId` is per window**: incoming settings keep the window's own value, and `patchSettings` keeps it too unless the patch is the tab switch. Otherwise switching tabs in one window switched them in every window, including through a later unrelated patch's response.

## Scheduler
`scheduler/service.ts` tracks `readySenders` (one per window) instead of one `readySender`, and `rendererReady()` asks whether any open window is ready. A window that becomes ready mid-run is sent the live run chats directly. Main's `writeChat` stores a `structuredClone`, because the runner mutates its chat in place and the store cache would otherwise alias it.

## Gotchas met
- The Chat tab's workspace id is **`work`** (kind `chat`). A test chat with `workspaceId: 'chat'` doesn't show in the sidebar.
- With the cache, `store.getChats()` sees a run's chat before its first delta streams, so a test waiting on `getChats().length` raced ahead. It now waits for the delta.

Verified: `test/chatSync.test.ts`, `chatPersistence.test.ts` (applyChats), scheduler tests, and an E2E run with two windows (chat saved in one shows in the other's sidebar; settings reach the other; tabs stay per window). Links: [[Traffic light position and the --traffic-clear token]], [[Background mode: LaunchAgent, tray and single instance]], [[Scheduled tasks engine and headless runs]].
