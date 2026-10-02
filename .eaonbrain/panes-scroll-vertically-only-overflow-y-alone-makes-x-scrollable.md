---
title: Panes scroll vertically only: overflow-y alone makes x scrollable
tags: [eaon-desktop, ui, gotchas]
created: 2026-10-01T23:15:49.462Z
updated: 2026-10-01T23:15:49.462Z
---

The co-founder's report (Oct 1 2026): at a narrow window size, the worker page slid left and right under a two-finger trackpad swipe, with text cut off at the left edge.

**Why.**
- **Setting one axis makes the other scrollable too.** CSS computes a lone `overflow-y: auto` with `overflow-x: visible` as `overflow-x: auto`. `.thread` (and every pane with `.scroll`) therefore scrolled sideways whenever anything inside was wider than it.
- **The wide thing was a nowrap pill in a centred row.** `.worker-profile__facts` sits in `.worker-profile` (flex column, `align-items: center`), so it takes a fit-content width, which can't go below its min-content. A `.worker-fact` pill is `white-space: nowrap`, so its min-content is the whole sentence; here, the heartbeat note "Check whether Email Sending has been enabled; …". That widened the row, and so the thread's content, past the window. The pill's own `max-width: 100%` didn't help, because 100% of a row that already sized itself to the pill is no limit at all.
- **Ellipsis doesn't apply to bare text in a flex container.** `text-overflow: ellipsis` on an inline-flex box doesn't truncate the anonymous text item inside it.

**Fix.**
- `.worker-profile__facts { align-self: stretch }`, so the row takes the column's width rather than its content's.
- The pill texts are wrapped in `.worker-fact__text` (`min-width: 0; overflow: hidden; text-overflow: ellipsis`); the full text stays in the `title` tooltip.
- **The guarantee**, in `app.css`: `.thread, .page__scroll, .settings__scroll, .settings__nav-body, .sidebar__body, .code-home, .providers-shell, .pr-list, .modal__body` get `overflow-x: hidden; overscroll-behavior-x: none`.
  - It is deliberately **not** on `.scroll`: the live tool-output `<pre>` uses that class and must keep scrolling sideways.
  - Wide content (code, tables, diffs) scrolls in its own inner box.
- `.header-btn` is `white-space: nowrap; flex: none`; "Check in" had wrapped to two lines at 760 px.

**Checked** with an E2E script: a worker with a long heartbeat note at widths 1270, 900 and 760. The thread's `scrollWidth` equals its `clientWidth`, the pill ends in "…", and a CDP `mouseWheel` with `deltaX: 600` leaves `scrollLeft` at 0.

**Rule for new UI:** a `nowrap` element inside a centred or fit-content flex column needs `min-width: 0` and a width-constrained ancestor (stretch), or it sets the column's width. See [[Popover sizing and overflow rules]] for the popover side of the same idea.
