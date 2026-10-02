---
title: Lining up a list column: shared inset and the scrollbar gutter
tags: [eaon-desktop, ui, css, gotchas]
created: 2026-10-01T13:52:25.427Z
updated: 2026-10-01T13:52:25.427Z
---

# Lining up a list column: shared inset and the scrollbar gutter

Learned fixing the Pull requests page (`PullRequestsPage.tsx`, `.pr-*` in `styles/pages.css`). The co-founder reported that everything on it was misaligned. Three causes, each easy to bring back on other pages:

1. **`.scroll` always takes 10px for its scrollbar** (`::-webkit-scrollbar { width: 10px }`), even though the thumb is invisible. A scrolling list is therefore 10px narrower than the controls above it, so the rows stop short of the search field's right edge. Fix: `scrollbar-gutter: stable` on the list, and a right padding of `inset − 10px`, so it lines up whether it scrolls or not.
2. **A hidden button still takes up its column.** `opacity: 0` keeps the layout space. The row's "Open in GitHub" button sat as an invisible 26px column plus a 10px gap, so every row's date and +/− counts ended 36px early. Fix: position it absolutely over the date (`top/right: 6px`), and hide the date while hovered.
3. **`.manager__tab` used `align-items: baseline` in a fixed 28px pill.** The label sat at the top of the pill, a few pixels above the Chat/Workers/ADE switch beside it. Now `center` (this also fixes Plugins → Manage).

Layout conventions that came out of it:
- A two-column page keeps the list's controls (tabs as a full-width `Segmented`, search, sort) **inside the list column**, on the same inset as its rows.
- That inset is 16px, the top bar's own padding, so the column sits under the page title.
- The detail column starts level with the tabs, not centred vertically in the empty space.

Related: [[ADE terminal view: node-pty, xterm and the pane grid]]
