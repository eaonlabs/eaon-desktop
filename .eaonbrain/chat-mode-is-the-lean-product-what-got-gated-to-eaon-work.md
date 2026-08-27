---
title: Chat mode is the lean product: what got gated to Eaon Work
tags: [eaon-desktop, eaon-work, sidebar, composer, layout, ui]
created: 2026-08-26T12:49:01.902Z
updated: 2026-08-26T12:49:01.902Z
---

# Chat mode is the lean product: what got gated to Eaon Work

A run of user requests all pushing the same direction: strip the chat home down
to a sidebar and a composer, and move everything else behind Eaon Work.

## Now Eaon Work only

| Affordance | Where | Was |
|---|---|---|
| Plugin/browser tray under the composer | `Composer.tsx` | `variant === 'home' && !isWork` — the exact inverse |
| Browser panel + its `PanelRight` toggles | `App.tsx`, both `ChatView` headers | always available |
| "Ask for approval" chip | `Composer.tsx` | always shown |

The tray gating is a **deliberate reversal** of the decision in
[[Eaon Work mode]], which hid the tray in Eaon Work because Codex's reference
home had no plugin tray. The user wants the opposite now: plugins belong to the
coding product, chat home stays clean.

The approval chip is the one that was arguably a bug before — approvals gate
`write_file` / `run_command` in `localTools.ts`, which only exist when `cwd` is
set, i.e. only in Eaon Work. Chat mode was showing a control over nothing.

**Consequence to remember:** Eaon Work is currently hidden
([[Eaon Work hidden and the workspace switcher removed]]), so `isWork` is
permanently false and *all three of these are invisible right now*. They return
together when Eaon Work does. Do not "fix" their absence.

## `useIsWork()`

Four components each had their own copy of
`workspaces.find((w) => w.id === settings?.activeWorkspaceId)?.kind === 'work'`.
That is exactly how gates drift apart, so it is now one hook exported from
`state/store.ts`. Removing the last local copy also let `Sidebar` drop
`settings` and `workspaces` from its store subscription — see
[[Streaming performance: where the per-token cost lived]] for why narrowing
those matters.

## Sidebar header collapsed to one row

The workspace name ("Eaon") went, then the whole `.workspace` row went, with
search and the bell folded up into the panel's titlebar. `.workspace` /
`.workspace__actions` / `.workspace__title` are all deleted.

That row now holds download, search, bell, hide-sidebar and back — plus forward
**only when `canGoForward`**, copying `CollapsedNav`'s trick. Six controls at the
shared 26px do not fit beside the traffic lights in a 236pt panel (166pt needed
vs 154pt available) and, being right-aligned, the overflow would have slid the
leftmost button *under* the traffic lights. So `.sidebar__panel .titlebar
.icon-btn` is 24px with a 1px gap: 149pt for six, 124pt for five. **If a seventh
control is ever added to this row, it will not fit — drop one or widen the
sidebar.**

## One background, one baseline

Two structural fixes worth keeping:

- **`body` is the window's only background.** `.sidebar`, `.main` and
  `.settings` each used to paint their own `--canvas`; the translucent state
  mixed 18% vibrancy into the sidebar gutter and not into `.main`, so a seam ran
  down the sidebar edge that no amount of tuning could close. Painting once on
  `body` makes a seam structurally impossible, and vibrancy still reaches
  through because `body` is the bottom of the rendered frame. The translucent
  setting now frosts the whole window uniformly. This also fixed a latent bug:
  the per-component check was `mode === 'light' ? light : dark`, which got
  **system** mode wrong by always falling through to dark; it is now taken from
  the palette `useTheme` has already resolved.
- **Every top row shares one baseline.** `.chat-header`, `.page__bar` and
  `.settings__titlebar` are offset by `--sidebar-gap` *unconditionally*, so they
  land on the floating panel's titlebar row (centre 26pt) instead of sitting 8px
  higher against the window edge. Side benefit: the icons no longer jump
  vertically when the sidebar is toggled.

The settings nav is now the same floating panel as the app sidebar
(`.settings__nav-panel`), which also solved the traffic lights crowding "Back to
app" — see [[Traffic light position and the --traffic-clear token]].

Links: [[Floating curved sidebar]], [[Eaon Work mode]], [[Eaon Work hidden and the workspace switcher removed]]
