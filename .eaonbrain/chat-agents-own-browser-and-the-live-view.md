---
title: Chat agent's own browser and the live view
tags: [eaon-desktop, browser, betterwright, agent, ui, workers]
created: 2026-10-01T03:26:31.276Z
updated: 2026-10-01T23:46:04.713Z
---

# Chat agent's own browser and the live view

The chat agent has its own browser, the same BetterWright-driven hidden window that workers use ([[Workers' own browser: BetterWright on Electron 33]]). The user can watch any agent's browser live, see its cursor move, and take control of it. Built Sept 30 2026. Reworked Oct 1 2026 to stream frames, draw the agent's cursor and add in-view take control.

## How it fits
- **One class for every agent.** `features/workers/browser.ts` has `WorkerBrowsers({ partition, title })`. Workers use `persist:worker-<id>`; the chat agent uses `persist:eaon-agent`, so it keeps its own logins. `browserTool(browsers, { idOf, signInHint, onStep })` builds `web_browser` for any agent.
- **Targets.** `@shared/agentBrowser` defines `BrowserTarget = 'agent' | 'worker:<id>'`. `features/agentBrowser.ts` resolves a target to `{browsers, id}`: its own `agentBrowsers` for `'agent'`, and the workers service's browsers (registered with `setWorkerBrowsers()`) for `worker:*`. Every IPC call takes an optional target: `agent-browser:watch | status | show | control | input | navigate`. Main pushes `agent-browser:frame | step | status`, each tagged with its target.
- **Who gets `web_browser`.** It goes to the chat agent at depth 0 only. Workers have their own; sub-agents and trading sessions (`chatId` starting `trading:`) get none. The Chrome extension's `browser` tool stays for "use my Chrome".
- **Renderer.** `components/agentBrowser/LiveBrowser.tsx` holds the reusable pieces: `useLiveBrowser(target, active)`, `LiveBrowserStage`, `LiveBrowserControls`, `LiveBrowserAddress` and `LiveBrowserSteps`. Two places use them:
  - `AgentBrowserPanel.tsx` beside the chat. It opens itself on the chat agent's first step, unless the user closed it in that chat.
  - `WorkerBrowserDialog` in `WorkerAutonomy.tsx`, a Modal opened from the worker's Browser card.

  `agentBrowserStore` only tracks whether the panel is open, closed by the user, or used in a chat. The stream lives in the hook, so frames flow only while a view is mounted.

## Frames
- `webContents.beginFrameSubscription(false, cb)` works on a **hidden** window: about 20 fps on Electron 33 on macOS, as long as the window has `backgroundThrottling: false`. `WorkerBrowsers.watchFrames(id, listener)` keeps one subscription per window, reference-counted. It subscribes when a session is created if anyone is already watching.
- Main keeps only the newest frame and sends at most one per `FRAME_MS = 120`. Each is scaled to width ≤1100, encoded as JPEG q70 into a data URL (the CSP allows `img-src data:`), and skipped if identical to the last. A page that isn't repainting sends no frames, so `capture()` sends one as soon as a watch starts.
- Each frame carries `viewport` (from `getContentSize`). The renderer needs it to map a click on the scaled picture back to page CSS pixels.

## The agent's cursor
- Before a click or type, `pointAt(id, locator, mode)` runs `scrollIntoViewIfNeeded` and gets the `boundingBox`. It aims at `x = box.x + min(w/2, 40)`, the vertical middle. It then injects `CURSOR_SCRIPT` with `page.evaluate`.
- `CURSOR_SCRIPT` draws into the page itself: a shadow-root host `#__eaon_agent_cursor` that is `aria-hidden`, `pointer-events:none` and at max z-index. It shows a blue arrow with an "Eaon" tag that glides for 420 ms, a ring around the target and a ripple on click. Because it is in the page, it shows up in the frames with no extra work. Being aria-hidden and pointer-events none, it doesn't change the agent's snapshots or block its clicks.
- Short text (≤80 chars) is typed with `fill('')` and then `pressSequentially(text, {delay: 28})`, so the user sees it typed. Longer text uses `fill`.

## Take control
- `takeControl` / `releaseControl` / `controlled(id)` are on `WorkerBrowsers`. `input()` and `navigate()` refuse unless the browser is controlled, so the renderer can never drive an agent's browser behind its back.
- **The agent waits rather than fights.** At the start of `browserTool.run`, if the browser is controlled, it emits a `wait` step and awaits `waitForUser(id, ctx.signal)`. It then returns: "The user took over your browser and has handed it back. Your <action> was not done… (it is on <url> now)", plus a fresh snapshot. The model re-plans from what is really there instead of replaying a stale click. Aborting the run while it waits rejects with `'aborted'`.
- Closing the last view of a target auto-releases control and pushes status, so an agent is never left waiting on nobody. `close()` releases too.
- **Input mapping** (`sendInputEvent`):
  - Mouse down, up and move. The renderer throttles moves to 33 ms.
  - Wheel. **Electron's wheel `deltaY` has the opposite sign of the DOM's**, so it is negated.
  - Keys: keyDown, then `char` for printable keys without ctrl/meta, then keyUp, with codes from `KEY_CODES`.
  - Text goes through `insertText`. ⌘/Ctrl+V/C/X/A/Z (and Shift+Z) become `edit` commands calling `webContents.paste()` and the like, because a raw ⌘V event doesn't paste.
- **In the renderer**, keys the page takes are stopped from propagating, or Escape would close the worker dialog. Other app shortcuts pass through. The wheel listener has to be non-passive so the panel doesn't scroll as well.
- While controlled, the address bar is an input. Bare words become a DuckDuckGo search; anything else gets `https://` prefixed when it has no scheme.
- The "You're in control" banner sits at the **bottom** of the stage, like the step line. At the top it covered the page's own header and sign-in links.

## Gotchas
- A standalone Electron harness that loads BetterWright must append **both** `disable-quic` **and** `force-webrtc-ip-handling-policy=disable_non_proxied_udp` before app ready. Without them it throws "Call configureElectronNetwork before app.ready." The app already does this in main; a test harness has to as well.
- Checking a DOM node over CDP: `Runtime.evaluate(..., returnByValue: true)` on an expression that returns a node isn't truthy. Wrap it as `!!(expr)`.
- example.com rotates its text between languages, so a later frame can show Arabic. That is the page, not a rendering bug.

## Verified (Oct 1 2026)
- **Harness**, real BetterWright and a local page:
  - Open took 1.6 s. A click landed with the cursor overlay present, and typing worked. 60 frames streamed.
  - The agent waited while the user was in control. Forwarded scroll and click hit a human-only button. The agent was told about the takeover and got a fresh snapshot.
  - Input was refused after hand back, and aborting while waiting rejected.
- **Built app**, with a scripted fake model (an LM Studio provider pointed at a local fake server, approval mode full):
  - The panel opened itself and showed "Clicking button "Add to list"", then "Typing into textbox "Search"", with the cursor visible.
  - Take control: a click in the panel set the page title, and ⌘A, Backspace and typing produced "boots". Hand back restored the state.
  - The worker Browser card dialog showed live frames and Take control.

  The recipe is in [[Building a second copy of the app with electron-vite --outDir]]. Use an isolated `--user-data-dir` only.
- Not tested: real sites with captchas or logins, and Windows.

Related: [[Full autonomy and goals with an end time]]
