---
title: Browser extension bridge
tags: [eaon-desktop, eaon-work, browser, chrome-extension, agent-tools, security]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Browser extension bridge

Browser control for [[Eaon Work mode]]: an MV3 Chrome extension (`extension/`,
plain JS, no build step) connects to a WebSocket the app serves on
`127.0.0.1:<settings.browserExtension.port>` (default 47821), and the agent
gets **one** `browser` tool with an `action` enum (one schema instead of 17
keeps the cached tool prefix small).

## Where things live

- `src/main/features/browser/server.ts`: `BrowserBridge`, which is pure Node
  and has no Electron import, so tests use it directly. It handles the ws server,
  pairing, auth and the serial call queue.
- `src/main/features/browser/tool.ts`: the `browser` tool, risk rules, and
  per-tab snapshot memory.
- `src/main/features/browserBridge.ts`: feature glue (IPC `browser-bridge:*`,
  settings → start/stop via `browser-bridge:apply`, extension folder).
- `src/shared/browserBridge.ts`: protocol types, `BRIDGE_PROTOCOL`, and
  `CHROME_WEB_STORE_URL` (empty until published; fill it in after approval).
- Extension: `background.js` (SW), `lib/{connection,tabs,actions,state}.js`,
  `content/agent.js` (injected on demand, never declared as a content script),
  `popup/`. The publishing kit is `extension/STORE_LISTING.md` and
  `scripts/pack-extension.mjs`.

## Auth, and why each layer exists

1. Bound to 127.0.0.1.
2. Handshake needs `Origin: chrome-extension://<32 a-p>` **and** a loopback
   Host. Web pages cannot fake Origin, so this blocks every website.
3. First message must carry a token issued at pairing, **bound to the origin
   that paired**. Other installed extensions pass check 2, so the token is what
   keeps a rogue extension from feeding the agent fabricated pages.

Only a SHA-256 of the token is stored (`store/browser-pairing.json`). Pairing
codes are 6 chars (no 0/O/1/I/L), last 10 minutes, are single-use, and are
discarded after 5 wrong guesses. One paired browser at a time: pairing
another rejects the old one with reason `unpaired`.

## Decisions

- **No `chrome.debugger`.** Trusted input would need it, but it puts a
  "started debugging this browser" bar on every tab and is a high-risk
  permission in store review. Simulated pointer/keyboard events plus
  `execCommand('insertText')` work on forms, React inputs, contenteditable and
  legacy `keyCode` listeners (verified in Chrome 153).
- **Refs are guarded twice.** Each document has a `docId`, and the SW refuses
  refs if the page changed since the last snapshot. The bridge also sends
  `expectName` (the element's name in the cached snapshot), and the content
  script refuses if the name changed. So what was approved or risk-checked
  ("Next") cannot turn into something else ("Place order").
- **Ref numbers keep counting across a tab's pages** (`nextRefs` in
  storage.session). A ref from an old page is "no longer on the page" instead
  of pointing at whatever element holds the same number on the new page.
- **Calls are serialised** in the bridge. The loop runs read-only calls
  concurrently, and "scroll then snapshot" answered out of order is wrong.
- scroll/hover/switch_tab/wait count as read-only, so they need no approval.
- The tool is offered only when `mode === 'work' && depth === 0 && enabled`.
  Sub-agents sharing one tab would trample each other.

Gotchas are in [[Browser extension gotchas]].
