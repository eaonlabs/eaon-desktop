---
title: Floating curved sidebar
tags: [eaon-desktop, sidebar, layout, vibrancy, css, capture-harness]
created: 2026-08-26T02:42:11.375Z
updated: 2026-08-26T02:42:11.375Z
---

# Floating curved sidebar

The sidebar was a flush, full-height column with a `border-right`. The user
asked for it to be a curved, floating panel instead.

## Structure

`Sidebar.tsx` gained one wrapper, `.sidebar__panel`, around
workspace + body + footer. **The titlebar deliberately stays outside it** so the
macOS traffic lights (fixed at `x: 13, y: 13`) sit in the gutter above the
panel instead of landing on its rounded top-left corner.

    .sidebar          →  the flex slot; now just the gutter around the panel
    .sidebar__content →  unchanged, still owns the collapse slide/fade
      .titlebar       →  outside the panel, on the gutter
      .sidebar__panel →  the rounded card

New tokens: `--sidebar-gap: 8px`, `--r-panel: 14px`. `.sidebar` keeps
`--sidebar-w: 238px` as the total slot and applies `padding: 0 gap gap`, so the
panel is 222px. `.sidebar__content`'s width had to change from `--sidebar-w` to
`calc(var(--sidebar-w) - var(--sidebar-gap) * 2)` to match, since the collapse
animation relies on the content holding its width while the slot eases to zero.

## Two things that needed care

**The panel uses `--surface-1`, not `--sidebar`.** `--sidebar` is tuned for a
panel sitting flush at `--bg`; in the dark theme that is only *three* values off
`--canvas` (11,11,12 vs 14,14,16 measured), which left the curve nearly
invisible. `--surface-1` is the token that already means "one step above the
canvas" — measured 25,25,27 against an 11,11,12 gutter, which reads clearly.
Light mode: gutter 247, panel 239. A 1px `--border-soft` outline defines the
edge in both.

**The collapse leaves a sliver unless the padding animates too.** With
`box-sizing: border-box`, a specified width *below* the horizontal padding still
renders that padding, so easing width to 0 would have left a permanent 16px
stub. `.sidebar[data-open='false']` sets `padding: 0` and `padding` is in the
transition list. Verified: every pixel from x=0..60 is canvas when collapsed.

## Vibrancy interaction — deliberate

`.sidebar` paints `--canvas` (matching `.main`) normally, but goes
**transparent** under `[data-translucent='true']`. That is required, not
incidental: per the comment on `body`, macOS vibrancy only shows where the
rendered frame is transparent all the way down. An opaque gutter would have made
the translucent-sidebar setting a no-op, silently killing the feature in
[[Glass-blur popovers and sidebar vibrancy]].

The consequence is that with translucency on, the gutter shows blurred desktop
framing a mostly-opaque panel. Turning the setting off gives the fully opaque
floating look — so the existing toggle now chooses between the two, and no
separate control was needed.

## The harness gotcha that cost the most time

`index.ts`'s `app.whenReady()` contains:

    if (process.env['EAON_CAPTURE']) {
      store.patchSettings({ appearance: { ...store.getSettings().appearance, mode: 'dark' } })
      store.saveChats([]); store.saveProjects([])
    }

**The screenshot harness force-writes `mode: 'dark'` at startup**, so seeding a
light-mode `settings.json` into a throwaway `--user-data-dir` and capturing
*always* comes back dark. This looks exactly like "saved light mode is ignored at
launch" and sent this session down a long false-bug hunt — traced only by
patching `writeJson` in the *built* `out/main/index.js` to print a stack on every
settings write. There is no theme-loading bug.

To see light mode in a capture, use a step **after** `26-light-theme` (which
clicks Light) — e.g. `27-workspace-menu` — rather than seeding the file. And note
the same block wipes chats and projects, which is the mechanism behind the
"never point the harness at the real user-data dir" warning.

Links: [[Eaon Desktop architecture]], [[Glass-blur popovers and sidebar vibrancy]], [[Sidebar nav layout]]
