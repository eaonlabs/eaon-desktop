---
title: Browser extension gotchas
tags: [eaon-desktop, browser, chrome-extension, testing, gotcha]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Browser extension gotchas

Non-obvious things found while building [[Browser extension bridge]].

- **Branded Chrome (137+) ignores `--load-extension`.** To drive the real
  extension in automation, launch Chrome with `--remote-debugging-pipe
  --enable-unsafe-extension-debugging --user-data-dir=<throwaway>` (headless
  works) and call CDP `Extensions.loadUnpacked({path})`. The e2e harness used
  a local test site, paired through the real popup page
  (`chrome-extension://<id>/popup/popup.html`) and ran 34 checks. Headless
  Chrome supports `captureVisibleTab`, tab groups and the SW.
- **`chrome.tabs.goBack` often fails after the agent navigates.** Chrome's
  history-manipulation intervention marks a page left without user activation
  as skippable. Every simulated click lacks activation, so `goBack` skips the
  page or says there is nothing to go back to. `lib/actions.js` falls back to
  the page's own `history.back()`, which the intervention does not affect.
- **Simulated clicks on `target=_blank` links are popup-blocked.** The content
  script returns the href, and the SW opens it in the Eaon group itself.
- **MV3 SW lifetime:** WebSocket traffic keeps the worker alive (Chrome 116+),
  so the extension sends an app-level ping every 20 s. ws-level ping frames do
  not count. While disconnected the worker sleeps, and a 30 s `chrome.alarms`
  alarm wakes it to reconnect. Listeners must be registered synchronously at
  the top level of `background.js`.
- **Load unpacked from an installed app:** the folder ships via
  `electron-builder.yml` `extraResources`, but Settings copies it to
  `userData/browser-extension` before revealing it. Chrome's macOS folder
  picker will not enter an `.app` bundle, and app updates replace the bundle
  under a loaded extension. In development the repo folder is used directly.
- **Approval dialog shows no detail for `browser`.** `ChatView`'s
  ApprovalPrompt only renders run_command/write_file, and the loop never passes
  `AgentTool.describe` through. The tool implements `describe` (e.g.
  `click [2] button "Place order"`); wiring it into the approval event is a
  small cross-cutting change that was left for the agent-core owner.
- **Worktrees for parallel agents were created from `main`, not the feature
  branch.** Check `git log -1` before starting and reset if needed.
