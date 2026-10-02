---
title: Browser extension bridge
tags: [eaon-desktop, eaon-work, browser, chrome-extension, agent-tools, security]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-30T14:58:30.488Z
---

# Browser extension bridge

Browser control for the agent. An MV3 Chrome extension (`extension/`, plain JS, no build step) connects to a WebSocket the app serves on `127.0.0.1:<settings.browserExtension.port>` (default 47821). The agent gets **one** `browser` tool with an `action` enum: one schema instead of 21 keeps the cached tool prefix small. Chat turns now run in `mode: 'work'`, so the `mode === 'work' && depth === 0` gate offers the tool in Chat too.

## Where things live

- `src/main/features/browser/server.ts`: `BrowserBridge`, pure Node with no Electron import, so tests use it directly. It handles the ws server, pairing, auth, the serial call queue, feature negotiation and self-update requests.
- `src/main/features/browser/tool.ts`: the `browser` tool, risk rules, and per-tab snapshot memory.
- `src/main/features/browser/legacy.ts`: detects the Swift-era extension. See [[Swift-era Eaon browser extension (HTTP on 8823)]].
- `src/main/features/browserBridge.ts`: feature glue. It covers IPC `browser-bridge:*`, settings → start/stop, the extension folder, "Open extensions page" (`open -a <Browser> chrome://extensions`), and delivering right-click "Ask Eaon" to the window.
- `src/shared/browserBridge.ts`: protocol types, `BRIDGE_PROTOCOL` (still 1), `BROWSER_ACTIONS`, `V1_ACTIONS`, `isNewerVersion`, and `CHROME_WEB_STORE_URL` (empty until the extension is published).
- Extension: `background.js` (SW), `lib/{connection,tabs,actions,state}.js`, and `content/agent.js`, which is injected on demand and never declared as a content script. Also `popup/`. The publishing kit is `extension/STORE_LISTING.md` and `scripts/pack-extension.mjs` → `dist/eaon-browser-extension-<version>.zip`.
- `src/renderer/src/components/browser/BrowserAsk.tsx`: turns a right-click "Ask Eaon" into a new chat with a composer **draft**, never auto-sent.

## Versions and compatibility (extension 1.1.0, Sep 2026)

- **Add to the protocol; don't bump it.** A bump strands every installed extension until someone reloads it by hand. Since 1.1.0 the hello carries `features` (supported actions, plus `self-update` and `ask`) and `installType` (`development` = unpacked). `bridge.supports(action)` falls back to `V1_ACTIONS` for 1.0.0, which sends no features. The tool then tells the agent "too old for X" instead of failing oddly.
- **Self-update.** The welcome carries `latestExtension`. For an unpacked install with `self-update`, the app sends `{type:'update'}` once per version per app run. The extension hands its session off (see gotchas) and calls `chrome.runtime.reload()`, which re-reads the folder, then reports `update-status` (`reloading` / `stuck` / `store`). Store installs only call `requestUpdateCheck()`. The packaged app refreshes `userData/browser-extension` at startup so the reload finds new files; dev uses the repo folder directly. Settings shows an "Update now" button, and the popup has one too.
- 1.1.0 actions: `read` (Markdown of the main content, paged by `offset`, no refs), `find` (text + control matches with refs; the SW records the docId like snapshot does), `fill` (several `{ref,text}` fields, routing selects to select), `reload`. `navigate` also resolves `/path` against the current tab.
- Tab groups are optional: `GROUPS_SUPPORTED` is checked, and if grouping fails the tab goes into `session.ownedTabIds`. The top-level `chrome.tabGroups.onRemoved` listener is guarded; unguarded, it crashed the SW in browsers without the API.
- The right-click menu (`contextMenus`) sends `{type:'ask'}`; "Ask about this page" also shares that tab. Keyboard commands: Alt+Shift+E opens the popup and Alt+Shift+S stops the agent. The badge shows ! when unpaired or on error, ↑ when an update is available, and ON/OFF.

## Auth, and why each layer exists

1. Bound to 127.0.0.1.
2. The handshake needs `Origin: chrome-extension://<32 a-p>` **and** a loopback Host. Web pages cannot fake Origin, so this blocks every website.
3. The first message must carry a token issued at pairing, **bound to the origin that paired**. Other installed extensions pass check 2, so the token is what keeps a rogue extension from feeding the agent fabricated pages.

Only a SHA-256 of the token is stored (`store/browser-pairing.json`). Pairing codes are 6 characters (no 0/O/1/I/L), last 10 minutes, are single-use, and are discarded after 5 wrong guesses. Only one browser is paired at a time. Right-click "ask" text is bounded (20k characters) and only ever becomes a draft, because page text can contain instructions.

## Decisions

- **No `chrome.debugger`.** It puts a "started debugging this browser" bar on every tab and is a high-risk permission in store review. Simulated events plus `execCommand('insertText')` are used instead.
- **Refs are guarded twice**: per-document `docId`, plus `expectName`, so what was approved is what gets clicked. `fill` passes `expectName` for each field. Ref numbers keep counting across a tab's pages (`nextRefs`).
- **Calls are serialised** in the bridge.
- scroll/hover/switch_tab/wait/read/find count as read-only (no approval). `fill` is risky if any field is unknown or sensitive.

Gotchas are in [[Browser extension gotchas]].
