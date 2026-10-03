---
title: Driving the capture harness over CDP for scripted app states
tags: [eaon-desktop, capture-harness, screenshots, gotchas, electron, marketing]
created: 2026-09-28T04:07:40.363Z
updated: 2026-10-01T00:07:11.456Z
---

# Driving the capture harness over CDP for scripted app states

Used to produce real rendered states (PNG + DOM) for a marketing video without touching source or the real profile. Complements [[Matching the Eaon Desktop Figma frames]] and [[Floating curved sidebar]] (harness gotchas).

## Recipe
- Launch capture mode with a steps file whose only step sleeps for an hour, plus debug ports:
  `EAON_CAPTURE=<dir> EAON_CAPTURE_STEPS=hold.json npx electron --inspect=9229 ./out/main/index.js --user-data-dir=<isolated> --remote-debugging-port=9333`.
  Capture mode gives the offscreen 1270×797 window (dpr 2) and skips the single-instance lock. It still wipes chats/projects and forces dark at startup — only ever with an isolated `--user-data-dir`.
- Renderer: CDP page target on 9333 (`Runtime.evaluate`, `Input.dispatchMouseEvent` for real `:hover`).
- Main: Node inspector on 9229, `Runtime.evaluate` with `includeCommandLineAPI: true` gives `require('electron')`. `ipcMain._invokeHandlers` (Electron 33) is a Map of the raw handler fns, so any IPC can be wrapped or replaced live and the originals called directly.
- `window.__perfStore` is gone and `useApp` is not exposed; seed through the app's own IPC (`chats:apply` — `window.api.chats.apply(upserts, removed)`; `chats:save` is gone —, `projects:save`, `settings:patch`) then `location.reload()`.
- Live/streaming UI: replace `chat:stream` with a pending promise, click Send (so `store.send()` sets `streamingMessageId`), then `webContents.send('chat:event', …)` with the agent's own event types (`delta`, `reasoning`, `tool-call`, `tool-progress`, `tool-result` (+`images`), `subagent`, `todos`, `plan`, `goal`, `usage`, `approval-request`, `done`). The approval dialog only exists via `approval-request` (`pendingApproval`).
- Other pushed events that drive live UI: `models:download-progress` (library card bar + sidebar Downloads ring/panel; key is `library/<model name>::<pullRef>`), `scheduler:tasks` (task cards: a `history[0]` with `status:'running'` shows Stop + "Running").
- Useful overrides: `providers:list` (set `hasKey` — avoids safeStorage/keychain), `index:status`, `scheduler:list`, `skills:list` (real one reads ~/.claude/skills), `modelLibrary:state`/`modelLibrary:get`, `browser-bridge:status`, `computer-use:status`, and all `eaon-code:*` (Code tab is purely IPC-fed: status/recents/process/sessions/command get_state|get_messages…; messages use `{role:'assistant', content:[{type:'toolCall', id, name, arguments}]}` + `{role:'toolResult', toolCallId}`).

## Gotchas found
- **A never-settling IPC handler must keep its promise referenced** (push the resolver onto a global array). An unreferenced `new Promise(() => {})` gets collected and Electron rejects the renderer's `invoke` with "reply was never sent" — the model library then shows that text as a red error under the card and clears the progress row.
- **Dock bug:** `.composer-dock` is `display:flex` row, so `.composer-dock__pinned` (Work checklist / goal banner) renders *beside* the composer. Present since the pinned area was added; fix is `flex-direction: column; align-items: center` on `.composer-dock`.
- `TodoPanel` unmounts when every item is done, so a "5/5" pinned checklist never renders.
- Tool rows for `browser`/`computer` summarise to just the action ("Browser click"), since `summarise()` in ToolCall.tsx only looks at path/query/pattern/name/url/action/title.
- Work home composer (552px) truncates the model chip to "Opus… High" with the approval chip + 3 mode pills; ~11px short.
- Settings nav differs by tab: from the Work tab it also lists Browser and Code index.
- Re-hosting `outerHTML`: the app's CSP meta (`script-src 'self'`) silently blocks inline scripts; the module script must be stripped or React wipes `#root`; provider logos are absolute `file://…/out/renderer/assets/` URLs; tool screenshots are `eaon-file://<abs path>`; ThinkingOrb is a canvas (blank when re-hosted); `.msg__actions` is hover-only.

Links to: matching-figma-frames-pixel-work, floating-curved-sidebar

Related: [[Building a second copy of the app with electron-vite --outDir]]
