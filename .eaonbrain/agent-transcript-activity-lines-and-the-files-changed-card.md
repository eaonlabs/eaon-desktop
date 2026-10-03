---
title: Agent transcript: activity lines and the files-changed card
tags: [eaon-desktop, chat, design-system, agent]
created: 2026-09-30T14:33:24.220Z
updated: 2026-10-03T00:20:12.919Z
---

The user rejected the old transcript as crowded. It showed every tool call as a bordered card (`.tool` with border and background, a check on each done row), so a turn with a dozen `list_dir`/`load_skill` calls was a wall of boxes. Their reference was a Claude/Cursor-style reply: prose, then one "N Files Changed" card. On Oct 2 2026 they asked for it to look like **Cursor's agentic coding UI**, using two component libraries as the source of the elements — see [[Step cards, loaders and the Cursor-style transcript]] for that layer.

## What it is now
- **A turn reads in the order it happened.** `components/agent/turnItems.ts` (`turnItems`) splits `message.parts` into text items and *runs* of steps, where a step is a thought (a reasoning part) or a tool call, interleaved as they arrived. The parts are already chronological: `appendPart` only coalesces into a same-type part at the end, so a tool call closes the reasoning before it. Until Oct 2026 the transcript joined every reasoning part into one "Thinking" block at the top (`ThinkingSteps.tsx`, deleted). The user called that out ("all thinking is shoved on top, should be a list of all agents actions - thinking, tools, tools, thinking").
- **Some calls keep a card of their own** (`OWN_ROW` in turnItems.ts) and split runs around them: `spawn_agents` (live SwarmCard), `generate_image`, and since Oct 2 2026 `edit_file`, `write_file` and `run_command` (edit and command cards, `StepCards.tsx`). So a coding turn reads: run line (reads/searches/thoughts) → prose → edit card → command card → run line → …
- **Runs fold into one line.** `components/agent/TurnSteps.tsx` renders a run (`StepRun`) through `ActivityGroup` in `Activity.tsx`. Chat and Workers share it, since `WorkersView` uses `ChatView`'s `MessageRow`.
  - A run of one step is that step's own row. Two or more steps become a summary line ("Thought, read 3 files and ran a command", from `runSummary`) that opens into the steps, hung off a hairline.
  - While the run is the turn's latest and the turn is streaming (`active`), it opens itself, its line is the step in progress (spinner + shimmer label, or pixel grid + "Thinking"/"Working"), and a clock (`RunClock`, its own component so the 1 s tick re-renders only it) shows elapsed time. Past 4 steps the open list becomes a 172 px window that follows the newest step, masked at the top, unless the reader scrolled up in it. Once done it folds, unless the user opened or closed it (`chosen` state, null = automatic). Opened later, its rows stagger in (`--i` on each `.step` wrapper; 0 while live).
- **Thoughts are rows like tool calls** (`ThoughtRow`, `.tool.thought`): "Thought" plus a title, collapsible, with the reasoning rendered as Markdown in a 175 px window that follows the stream while live.
  - The title is the first `**Title**` (the latest one while streaming), else the first line.
  - A thought opens only if it holds more than the title its folded row shows (`thoughtHasBody`). The open body drops a leading title that the head already shows (`thoughtBody`).
- **Rows**: icon, label, then a mono **chip** for the detail (path tools show the basename, full path in the tooltip; `read_file` adds `L12–80` from `start_line`/`end_line`). Worker "prose" tools keep plain text. The icon turns into the chevron on hover/open; a running call (spinner) and a live thought (pixel grid) keep their mark.
- **Summaries count only successful calls.** Failed and blocked calls are counted beside the summary ("· 1 blocked"). Kinds that have targets (files, folders, skills) count distinct targets.
- **Hidden from the transcript**: `update_plan` and `present_plan` (the Plan panel and plan card show them).
- **Files changed at the end.** `FilesChanged.tsx` renders "N files changed +X −Y · Review" from `diffStats`, once the turn finishes. It's the per-file review of all the turn's edits; each edit also has its inline card.
- **Empty worker turns are hidden.** `MessageRow quietWhenEmpty` (used by Workers) renders nothing for a finished turn with no parts. Chat still says "No response".

## Gotchas
- **Case-insensitive file names.** `turnSteps.ts` next to `TurnSteps.tsx` breaks on macOS: tsc errors with "differs only in casing". So the pure modules are `turnItems.ts` and `commandText.ts` (not `stepCards.ts` beside `StepCards.tsx`).
- When editing CSS with a find-and-replace script, check the match count. `white-space: nowrap; direction: rtl; text-align: left;` also exists in `.diff__file`.
- Live states can be checked without a model: for Chat see [[Step cards, loaders and the Cursor-style transcript]] (fake provider + held `chat:stream`); for Workers seed `workers.json` and `worker-<id>.json` in an isolated profile's `store/`, then push `workers:changed`, `workers:message` and `workers:event` from main. See [[Driving the capture harness over CDP for scripted app states]].

Related: [[Agent core: one loop, adapters and tool sources]], [[Eaon Desktop architecture]], [[Thread spacing under the top bar and the worker ask card]]
