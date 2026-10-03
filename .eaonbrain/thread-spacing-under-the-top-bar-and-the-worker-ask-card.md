---
title: Thread spacing under the top bar and the worker ask card
tags: [eaon-desktop, layout, workers, chat]
created: 2026-10-02T02:56:58.708Z
updated: 2026-10-02T02:56:58.708Z
---

Two layout rules the user asked for in Oct 2026, both measured in the running app.

- **The thread starts as far below the top bar as the bar is below the window's top edge.** The top bar row (`.chat-header`/`.page__bar`) is `--titlebar-h + --sidebar-gap` tall with `padding-top: --sidebar-gap`, and the Chat/Workers/ADE switch fills its 36px exactly. So the bar sits at 8..44px and `.thread` has `margin-top: var(--sidebar-gap)`, which puts its edge at 52px. Scrolled-up messages disappear 8px below the bar instead of jammed against it, which cut the first bubble in half. `.thread`'s top padding was trimmed by the same 8px, so the first message starts where it did. The geometry is symmetric about the row's centre, so this holds whatever the switch's height.
- **The worker ask card lives in the composer's column.** `.composer-dock` centres its children, and `.worker-asks` had no width. A long question therefore grew the card to the whole pane, wider than the thread and the composer. It now has the composer stack's width (`var(--composer-chat-w)`, max `100% - 48px`), the composer's radius, an 8px gap above the composer, and chips that wrap long answers. The reply input takes its own line when the chips leave it too little room.

Checked with the capture harness: the switch at 8..44, the thread top at 52, and the asks card at 640px with the same left edge as the composer. See [[Agent transcript: activity lines and the files-changed card]] for the transcript side, and [[Floating curved sidebar]] for the gutter tokens.
