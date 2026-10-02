---
title: Agent transcript: activity lines and the files-changed card
tags: [eaon-desktop, chat, design-system, agent]
created: 2026-09-30T14:33:24.220Z
updated: 2026-09-30T14:33:24.220Z
---

The user rejected the old transcript as crowded. It showed every tool call as a bordered card (`.tool` with border and background, a check on each done row), so a turn with a dozen `list_dir`/`load_skill` calls was a wall of boxes. Their reference was a Claude/Cursor-style reply: prose, then one "N Files Changed" card.

## What it is now
- **Runs of calls fold into one line.** `components/agent/Activity.tsx` holds `ActivityGroup` and `activitySummary`. Chat (`ChatView` `segmentParts` → `ToolRun`) and the ADE (`code/Thread` `segmentBlocks` → `CodeRun`) both split a reply into text segments and runs of tool calls. Whitespace-only text does not break a run. In the ADE, thinking blocks between calls join the run.
  - A run of one call renders as that call's own flat row. A run of two or more becomes a summary line ("Used 2 skills, listed 7 folders and looked for a file") that expands into the rows, hung off a hairline.
  - While a call runs, the line shows that call live (orb and shimmer), plus a running command's output under it.
- **Summaries count only successful calls.** Failed and blocked calls are counted beside the summary ("· 1 blocked"). Before this, a denied `write_file` read as "wrote 1 file". Kinds that have targets (files, folders, skills) count distinct targets.
- **Some calls are hidden from the transcript.** `update_plan` and `present_plan` are dropped from Chat's runs, because the Plan panel and the plan card already show them. `spawn_agents` never joins a run, because its live SwarmCard is the point.
- **Edits appear once, at the end.** `FilesChanged.tsx` renders "N files changed" with a file-type glyph, the name, a muted folder and +/− counts, from `diffStats` in `FileDiff.tsx`, which uses the same line-diff as the diff view. Each row opens its diffs, and "Review" opens them all. It shows only after the turn finishes. Because this card is where edits are reviewed, the ADE's `ToolRow` no longer auto-expands small diffs.
- **Flat rows.** `.tool` rows are flat: no border or background, in the reply's muted colour, with the chevron shown only on hover or when open. The ADE's user-run `!` shell commands (`.code-bash`) keep a card, since they are the user's own actions.
- **The Plan panel folds.** `TodoPanel` (above the composer) is one line: "Plan 1/3 · <current step>", expandable.

## Gotcha
When editing CSS with a find-and-replace script, check the match count. `white-space: nowrap; direction: rtl; text-align: left;` also exists in `.diff__file`, and a replace-first hit that rule instead of the intended one.

Related: [[Agent core: one loop, adapters and tool sources]], [[Eaon Desktop architecture]]
