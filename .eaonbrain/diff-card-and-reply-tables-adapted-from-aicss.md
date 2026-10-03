---
title: Diff card and reply tables (adapted from AICSS)
tags: [eaon-desktop, chat, markdown, agent]
created: 2026-10-02T23:18:13.514Z
updated: 2026-10-03T00:20:44.553Z
---

The diff view and Markdown tables in replies are adapted from three free AICSS components (MIT; the license text is in `components/aicss/LICENSE`, and each adapted file carries a one-line header pointing at it. There is no visible credit; none is needed).

## File diff: `components/agent/FileDiff.tsx`, `agent.css` (Diff section)
A raised card with the file (code icon) and `+N -N` on top. Below that: two line-number gutters split from the code by a hairline, a sign column, light token colouring (`tokenize()`: keywords, strings, numbers, called names, `//`/`#`/`/* */` comments; `#fff` isn't a comment), and an accent bar per changed line (solid for additions, hatched for deletions). The props are still `{ file, before, after }`, so ToolCall, FilesChanged and the approval dialog didn't change.
- **Line numbers only when true.** `write_file` (before = '') numbers from 1. An `edit_file` change is a snippet the tool matches by content, and it never reports where it landed, so its gutters fold away (`data-numbered` absent sets `--diff-ln: 0`). Optional `oldStart`/`newStart` props light them up. If `edit_file` in `localTools.ts` ever reports the line it edited, pass it through to get real numbers.
- Colours: add/del use the theme's `--diff-add-*`/`--diff-del-*`. The syntax palette is GitHub dark by default, with light values under `[data-theme='light'] .diff`. In light mode the card is `--bg` (white), as in the original.
- Long diffs: the LCS falls back to all-del/all-add above 600 lines; the body caps at 340px and scrolls.

## Tables: `components/agent/MarkdownTables.tsx` and `tableKind.ts`
A Markdown `table` block becomes a card. The muted header band sits on `--tbl-bg`, and the rows sit on an inset sheet (`--tbl-body-bg`, 12px top corners) with hairlines. All colours are mixed from `--bg`/`--fg`, so every theme works.
- `tableKind(header, rows)` (pure, tested in `test/tableKind.test.ts`) returns **comparison** when the first header cell is blank, or when ≥60% of the cells right of the first column are marks (`cellMark`: ✓ ✔ ✅ yes true included / ✗ ❌ no false — – - none, with Markdown emphasis stripped). Otherwise it returns **data**. In a comparison, yes becomes a green ✓ and no becomes a muted —.
- Rows are flex rows of equal-width cells, as in the original, so header and body align without a `<table>`. Cell text sits in its own `.tbl__text` span; a flex cell would split "a **b** c" into items and drop the spaces. Body cells wrap, while header labels ellipsize (full text in `title`).
- Each column has a minimum of 100px (`minWidth` on `.tbl`). Wider tables scroll inside `.md__table-wrap`; the reply column is 640px, so six columns fit.
- `renderCell` is passed in from Markdown.tsx (its `renderInline`) to avoid an import cycle.

See [[Chat Markdown renderer: what it covers and the streaming rule]] and [[Agent transcript: activity lines and the files-changed card]].

Related: [[Step cards, loaders and the Cursor-style transcript]]
