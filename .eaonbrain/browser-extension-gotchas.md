---
title: Browser extension gotchas
tags: [eaon-desktop, browser, chrome-extension, testing, gotcha]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-30T14:58:43.239Z
---

# Browser extension gotchas

Non-obvious things found while building [[Browser extension bridge]].

## Updating an unpacked extension (found Sep 2026, extension 1.1.0)
- **Chrome disables a reloaded unpacked extension when Developer mode is off.** It shows `unsupportedDeveloperExtension` in `chrome.developerPrivate.getExtensionsInfo`, and the SW and popup are simply gone. A real "Load unpacked" install always has Developer mode on, so `chrome.runtime.reload()` works for users. With it on, the worker came back in about 1 s as the new version. **Tests must install the way a user does**: Chrome for Testing with `--remote-debugging-pipe --enable-unsafe-extension-debugging`, then open `chrome://extensions` and call `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})`, then CDP `Extensions.loadUnpacked({path})` over the pipe. A `--load-extension` install loses the extension on reload. See `test/browser-extension-live.test.ts`.
- **`storage.session` is wiped by an extension reload**, and a self-update is a reload. The agent's group ids, current tab, shared tabs and "stopped" state would all be lost mid-task. `state.js` `handOffSession()` copies the session to `storage.local` just before reloading, and `getSession()` restores it once, if it is under 2 minutes old.
- **Alarms are cleared by a reload too.** `background.js` recreates the reconnect alarm at top level, so that is fine. Don't rely on an alarm surviving an update.
- **Version the content script's global.** A page keeps whatever script it was injected with, so after an update a tab the old version touched would keep answering from old code ("Unknown page action"). `content/agent.js` installs `globalThis['__eaonAgent@<version>']`, and `setIndicator` removes stale indicator hosts.
- **Test pages must send `charset=utf-8`.** Without it Chrome decodes "—" as "â€”", which looks like an extension bug.
- `open -a "Google Chrome" chrome://extensions` does open the page. Browsers refuse `chrome://` from links, but accept it through the Apple Event. Verified with Chrome for Testing.

## Earlier findings
- **Branded Chrome (137+) ignores `--load-extension`.** Chrome for Testing still honours it, but see above for why the new tests use `Extensions.loadUnpacked`.
- **`chrome.tabs.goBack` often fails after the agent navigates.** This is Chrome's history-manipulation intervention; `lib/actions.js` falls back to `history.back()`.
- **Simulated clicks on `target=_blank` links are popup-blocked.** The SW opens the href itself.
- **MV3 SW lifetime:** WebSocket traffic keeps the worker alive (Chrome 116+), and there is an app-level ping every 20 s. While disconnected, a 30 s alarm wakes the worker. Listeners must be registered synchronously at the top level, and must be guarded for APIs a browser may lack (`chrome.tabGroups`, `chrome.contextMenus`, `chrome.commands`).
- **Load unpacked from an installed app:** Settings copies the folder to `userData/browser-extension`, because Chrome's macOS picker won't enter an `.app`. That copy is now also refreshed at startup, so self-updates find the new files.
- **The approval dialog shows no detail for `browser`** (it lacks `describe` wiring). The agent-core owner still needs to wire this.
- **macOS blocks reading Chrome's profile folder** ("Operation not permitted"), so you can't inspect installed extensions from a shell. Claude in Chrome can't open `chrome://` pages either. To find out what an extension is doing, listen on its port.
- **Worktrees for parallel agents were created from `main`, not the feature branch.** Check `git log -1`.

Links to: [[Swift-era Eaon browser extension (HTTP on 8823)]]
