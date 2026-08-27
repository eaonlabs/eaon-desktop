---
title: Downloads panel and update-ready toast
tags: [eaon-desktop, models, updater, downloads, ui]
created: 2026-08-25T00:00:00.000Z
updated: 2026-08-25T00:00:00.000Z
---

# Downloads panel and update-ready toast

A global "Downloads" button (header, both the chat view and the Models page)
opens a popover showing every download in flight — Hugging Face model
downloads and app-update downloads together — plus a separate floating toast
that appears only once an app update has finished downloading. See
[[Local model hub (Models page)]] and the updater notes for the two backends
this unifies.

## Why progress moved into the global store

Model-download progress used to live in `ModelsPage`'s own local state
(`useState` + its own `onDownloadProgress` listener). That's invisible to
anything outside that component — a header button on the Models page can see
it, but a header button on the *chat* view can't, and the whole point here was
one Downloads surface reachable from anywhere. Moved it into the zustand store
instead: `modelDownloads: Record<string, ModelDownloadProgress>` (keyed
`repoId::filename`) and a `downloadModel(repoId, filename)` action that wraps
`window.api.models.download`, updates the map via the *existing* single
`onDownloadProgress` listener bound once in `init()`, and clears its own entry
in a `finally` block when the promise settles (success or failure) — so
completion doesn't depend on a separate 'done' IPC event existing at all.

`updateStatus` (the auto-updater's state machine) made the same move, for the
same reason — `General.tsx`'s settings page used to poll+listen locally; it
now just reads `useApp((s) => s.updateStatus)`. One listener per concern,
bound once, in `init()`'s existing `listenersBound` guard.

`ModelsPage` itself now reads `progress` from the store instead of local
state, and its own `handleDownload` calls the store's `downloadModel` action
rather than `window.api.models.download` directly — same external behavior
(still tracks `downloadedModels`/`downloadErrors` locally for its own inline
UI), just sourcing the live-percent part from one shared place instead of a
page-local duplicate.

## Two different UI treatments for one signal

- **Downloads panel** (`DownloadsPanel.tsx`, `<DownloadsButton />`): ambient,
  check-when-curious. Shows in-progress model downloads and an update row
  whenever `updateStatus.state` is `available`, `downloading`, or
  `downloaded`. Empty state is the one the user handed over as a design
  reference — icon + "Your download progress will appear here" — deliberately
  roomy and quiet, matching `.menu`'s frosted-glass popover styling already
  used everywhere else (`--menu-bg` + `backdrop-filter`).
- **Update toast** (`UpdateToast.tsx`): only appears for `state === 'downloaded'`
  — the one moment worth interrupting the user for, since it's the point they
  can act on it (restart) and the app will otherwise just sit on it silently.
  Checking and mid-download stay ambient/panel-only on purpose. Dismissal is
  tracked by version in local component state (not persisted) — dismissing
  hides it until a *newer* version reaches 'downloaded', not forever.

Both are rendered high enough to be visible regardless of view:
`<UpdateToast />` sits in `App.tsx` outside the `view === 'settings'` branch
(that branch used to `return <SettingsShell />` early, which would have
skipped anything rendered only inside the normal `.app` tree — restructured
the conditional so the toast is a sibling of both branches instead). The
Downloads button, by contrast, is NOT a single global fixed element — it's
inlined into each page's own header (`ChatView`'s two `.chat-header` blocks,
`ModelsPage`'s two `.page__bar` blocks) via a shared `<DownloadsButton />`,
matching the user's reference image (inline in the toolbar, not floating).
**Gotcha caught by testing, not by reasoning about it up front:** it only got
added to ChatView at first — the natural place to check on a model download
right after starting one (the Models page) had no way to open the panel at
all. If another page gains a reason to show it, add the same one-line import
+ JSX there rather than assuming the chat header is sufficient.

## Verifying without a real app update

`updater.ts` only runs real checks in a packaged build (`app.isPackaged`), so
there is no way to naturally drive `updateStatus` through `available` →
`downloading` → `downloaded` in this dev sandbox. Verified the toast's actual
layout/CSS anyway by temporarily hardcoding
`const status = { state: 'downloaded', version: '1.6.0' }` in place of the
store read, rebuilding, screenshotting, then reverting — exercises the exact
same JSX and CSS the real flow would hit without touching the (already
carefully verified) updater plumbing at all. The empty Downloads panel and a
real small-model download's "complete" transition were both verified for
real; the actual mid-download progress-bar frame was not — the test file
downloads too fast in this environment to reliably land a screenshot between
0% and 100%, and it isn't worth chasing further given the bar/store plumbing
already type-checks and reuses proven `.menu` styling patterns.
