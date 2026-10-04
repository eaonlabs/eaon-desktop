---
title: Eaon CLI: watching the agent work (scanner, scrolling, spinning logo)
tags: [eaon-cli, ui, testing]
created: 2026-10-03T17:35:51.081Z
updated: 2026-10-03T17:35:51.081Z
---

The user wanted to *see* the CLI agent working: "a thing that moves side to side just like the one opencode has", to be able to scroll back through everything the agent did, and a rotating dot-matrix Eaon logo like the one OpenAI Devs posted for Codex. This builds on [[Eaon CLI coding layer: what was taken from opencode and why]].

## The scanner (`scanner()` in `cli/src/tui/widgets.ts`)
This is a port of opencode's knight-rider indicator (`packages/tui/src/ui/spinner.ts`, `createFrames`/`createColors`, style "blocks"):
- Eight cells: lit cells are `■`, the track is `⬝`.
- It moves bidirectionally with a 6-step tail. Alphas are 1, 0.9 (a bloom at 1.15× brightness), then 0.65^n.
- The track is the accent at 0.6 alpha, and fades to 30% while resting.
- Alpha is done by mixing with the background (`mix()` in `theme.ts`), because terminals have no alpha.

Two deliberate deviations from opencode:
- A frame is 50 ms rather than 40, since every frame redraws the whole app.
- The rest at the start is 16 frames, not 30. At 30, the bar shows only the dim track for more than half of each cycle and reads as stalled, and the user asked for something that *moves*.

The app tick is `SCANNER_FRAME_MS` while anything animates. The bar sits under the composer: scanner, then what the agent is doing (from the running message's last part: tool verb and target, "Thinking", "Writing", "Waiting for your approval"), then elapsed time measured from the **user's** message (the assistant message's `createdAt` moves when the stream starts), then an estimate of tokens streamed. Workers use the same bar in the worker's colour.

## Scrolling back
- **The mouse is on by default.** With it off, the wheel did nothing (the alternate screen has no scrollback), which was the user's "can't scroll up" complaint. Mouse mode is 1002 (button-motion), so drags arrive.
- **The app selects and copies text itself**, because a terminal can't select while it reports the mouse. `App.select()` handles it: drag highlights, release copies `Screen.textBetween()` from the last frame through pbcopy, wl-copy, xclip, xsel or clip, falling back to OSC 52. `--no-mouse` and `/mouse` give the mouse back to the terminal.
- **The view stays put while scrolled up.** `scrollBack` counts lines from the bottom, so new lines arriving would push the view. The chat view remembers the last line count (per chat and width) and adds the growth to `scrollBack`.
- Also: a scrollbar in the gutter, ⌃Home for the top and ⌃End to follow.
- **Thoughts show by default.** Each finished thought folds to one dim `∴` line, and the live thought shows its last three lines. ⌃O ("details") expands every thought and all tool output; ⌃T was already taken for switching tabs.

## The spinning logo (`cli/src/tui/logo3d.ts`)
- **Shape:** the app icon (`resources/icon.png`) as geometry. A rounded square (corner 0.54) is extruded to a slab 0.32 thick, with the arrow cut through it: a triangle minus a circle under its base, from SDFs. The mark is drawn 1.55× its icon size, because at about 20 dots across the icon proportions are unreadable.
- **Rendering:** each dot is an orthographic ray against the slab, solved analytically for the slab and marched for the side walls. Lighting is Lambert from a close point light with falloff, plus a specular term and a little fixed grain. The cut-out's walls are coral.
- **Dot layout:** one dot is `■ ` (two columns), which makes the grid square on tall cells.
- **Speed:** the spin eases (u − 0.3·sin 2u) so the arrow lingers face-on. Frames are cached per angle index and shades are quantised to 20 levels, so the screen's interned style table stays small.
- **Size:** it is shown on the empty-chat screen only when there is room for 16 rows or more; below that it is unreadable and the block letters are used instead.
- **CPU:** about 6% of a core while it spins.

## Testing UI states without a real model
Point a scratch profile's provider at a scripted mock. Ollama's adapter only needs `/api/tags`, `/api/show` and NDJSON from `/api/chat`, and a mock that streams `message.thinking` words and `tool_calls` with sleeps reproduces any mid-turn state. Set `providers.json → ollama.baseUrl` in the scratch profile to the mock's port rather than taking 11434.

`eaon --snapshot chat --keys '…\r' --wait N --html out.html` captures the frame about N/2 ms after the keys. Rendering that HTML with headless Chrome (`--screenshot`) gives a colour image.
