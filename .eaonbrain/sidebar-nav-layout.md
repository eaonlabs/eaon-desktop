---
title: Sidebar nav layout
tags: [eaon-desktop, sidebar, ui]
created: 2026-08-20T00:00:00.000Z
updated: 2026-08-20T00:00:00.000Z
---

# Sidebar nav layout

> **Current layout (Sept 29 2026)** is per tab — see [[Chat, Workers and ADE: the three tabs and Chat as the agent]]. Chat: New chat, Models, Library, Plugins, Settings, then Projects and Recents. Workers: New worker, Team, Scheduled, Plugins, Settings, then the workers. ADE: New session, Pull requests, Models, Plugins, Settings, then sessions and folders. The footer holds only Help. The history below explains how Settings ended up in the top group.

`Sidebar.tsx` (see [[Eaon Desktop architecture]]) has two nav groups: the
scrollable `.sidebar__body` (New chat, Scheduled, Plugins, Projects, Recents)
and the pinned `.sidebar__footer` at the very bottom.

Settings was originally in `.sidebar__footer`, matching the source Figma
frames. The user asked to move it — deliberately, by sketching an arrow on a
screenshot — up into the top `.sidebar__body` group, directly after Plugins,
instead of pinned at the bottom. This was a live UI opinion, not a frame
mismatch, so don't "fix" it back to match Figma if that's ever audited again.

The footer now holds only the Help (`?`) icon-button, right-aligned via
`justify-content: flex-end` in `app.css` — it used to be `space-between`
against the two-item row, which would otherwise leave one lone icon stranded
on the left.
