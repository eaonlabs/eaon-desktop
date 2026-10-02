---
title: Computer use: how the computer tool sees and drives the screen
tags: [eaon-desktop, agent, tools, computer-use, macos, permissions]
created: 2026-09-24T00:00:00.000Z
updated: 2026-10-01T02:34:38.327Z
---

# Computer use: how the computer tool sees and drives the screen

One Work tool, `computer`, with an `action` enum (screenshot, click, move,
drag, type, key, scroll, wait, cursor_position, open_app). Offered only when
`settings.computerUse.enabled`, only in Work, only at depth 0 (swarm
sub-agents sharing one pointer would undo each other). Code:
`src/main/features/computerUse.ts` (tool source + IPC) and
`src/main/features/computer/` (`actions.ts` pure parsing/risk, `tool.ts`
orchestration, `geometry.ts`, `keys.ts`, `capture.ts`, `session.ts`, and one
backend per OS behind `input.ts`). It plugs in as a tool source, see
[[Agent core: one loop, adapters and tool sources]].

## Decisions and why

- **Input without native modules.** macOS: one long-lived `osascript -l
  JavaScript` process posting CoreGraphics events through the ObjC bridge,
  spoken to over JSON lines. A fresh osascript costs ~51–84 ms; a request to
  the running helper ~0.4 ms. Windows: persistent PowerShell with a C# shim
  over `user32` via `Add-Type` (not yet run on real Windows). Linux: `xdotool`
  per call, or "unavailable". Bridge gotchas are in the comment on `mac.ts`.
- **Screenshots via `/usr/sbin/screencapture`** on macOS, not
  desktopCapturer: no window needed, and it fails loudly ("could not create
  image from display") without Screen Recording rather than returning a
  wallpaper-only image. Downscaled to 1280 (balanced) / 1600 (sharp) long
  edge, JPEG q70.
- **Coordinates** are screenshot pixels, mapped through the captured
  display's bounds (points), never an assumed scale factor. The frame the
  model last saw is kept per chat, so a later quality change doesn't shift
  clicks. Multi-display: one display per screenshot (`display: N`, 0 = main,
  then left to right). If a display is unplugged or changes resolution, the
  tool refuses until the model takes a new screenshot.
- **Every action returns a fresh screenshot** (`screenshot: false` opts out
  when chaining). It saves a model round trip per step and adds no image the
  model wouldn't have asked for. Caveat: only history *rebuilt for a new
  turn* keeps just the newest image. Within one turn images pile up until
  server-side clearing (Anthropic) or `pruneInFlight` (others) kicks in; see
  [[Token efficiency in the agent loop]].
- **Eaon's own windows are made transparent and click-through for the
  length of each action** (`withEaonHidden`), not hidden for the whole turn.
  Otherwise screenshots show Eaon and clicks could land on Eaon, including
  its own Approve button. Hiding the window for the whole turn would bury the
  approval prompts, and content protection would blank Eaon in the user's
  screen shares while doing nothing about clicks. Cost: a short blink per
  step.
- **Focus hand-back.** After the user clicks Approve, Eaon has focus, and its
  modal answers to Return. Before `type`/`key`, the tool re-activates the
  last non-Eaon frontmost app, or refuses.
- **Confirmation layering.** In "Ask for approval" the loop's gate asks; in
  "Approve for me" with Confirm each action on, the tool calls `ctx.confirm`
  itself for click/drag/type/key/open_app (not move/scroll). Dangerous
  combos (cmd+q, cmd+shift+q…) and typed text that `isRiskyCommand` flags are
  `risky`, so they always ask. The tool never double-prompts.
- **Safety while driving** (`session.ts`): ⌃⌥⌘. (Ctrl+Alt+Shift+. elsewhere)
  is registered only while a turn is driving. It cancels the run and kills
  the input helper mid-`type`. An always-on-top, non-focusable pill says
  "Eaon is using your computer". Input is refused while the Mac is locked
  (posted events reach the lock screen).

Related gotcha: [[Calling a tool's run() directly skips approval]].

Related: [[Computer use setup: macOS permissions, who owns them, and relaunch]]
