---
title: window.prompt and friends do nothing in Electron
tags: [eaon-desktop, electron, gotcha, ui]
created: 2026-10-01T02:39:41.829Z
updated: 2026-10-01T02:39:41.829Z
---

Electron does not implement `window.prompt()`: it returns `null` immediately (Chromium logs "prompt() is and will not be supported"), so any UI built on it silently does nothing. That is exactly why the Model providers "Rename" (pencil) button "didn't work": `renameModel` called `window.prompt('Model display name', …)` and bailed on the null. Use an inline field instead. The pencil now swaps the row for `RenameField` in `Providers.tsx`: Enter saves, Esc cancels, empty resets to the catalog name.

`alert()`/`confirm()` do show native dialogs in Electron, but they block the renderer and look foreign; prefer the app's own `Modal` from `components/ui.tsx`. Grep for `window.prompt` before trusting any button that uses it.

Found while fixing [[Model catalog: generated from Pi and models.dev, with user overlays]].
