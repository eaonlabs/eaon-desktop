---
title: App icon (Dock, DMG, bundle)
tags: [eaon-desktop, branding, icon, electron-builder]
created: 2026-08-27T00:00:00.000Z
updated: 2026-08-27T00:00:00.000Z
---

# App icon

`resources/icon.png` (1024×1024, RGBA) and `resources/icon.icns` (full
iconset, generated with `sips` + `iconutil`) are the real app icon — an
orange rounded-square with a white triangle mark. Before this there was no
icon anywhere in the repo at all (`resources/` had only the entitlements
plist), so the packaged app and every dev run showed the generic Electron
icon.

The source the user supplied was a flat JPEG with a **pure black background**
outside the rounded-square shape, not transparency (JPEG can't carry alpha).
Used as-is, that background paints as an opaque black square around the icon
in the Dock/Finder — had to chroma-key it to transparent first (PIL, alpha
ramped smoothly between two luminance thresholds rather than a hard cutoff,
so JPEG compression noise right at the shape's edge doesn't leave a visible
ring). If a future logo update arrives as another flat JPEG/PNG-on-black,
expect to redo this step — check `getpixel` at a corner before trusting a
supplied asset is already transparent.

`electron-builder.yml` points `mac.icon` at `resources/icon.icns` explicitly
(this actually matches electron-builder's own default lookup path given
`buildResources: resources`, so the explicit line is redundant but
self-documenting, matching how thoroughly commented the rest of that file
already is).

## Gotcha: `app.getAppPath()` is not the project root here

Packaged builds get their icon for free from the `.icns` baked into the
bundle — no runtime code needed. Dev runs (`npm run dev`, or `electron
out/main/index.js` directly) don't get that, so `src/main/index.ts` calls
`app.dock?.setIcon(...)` once at startup, guarded on `!app.isPackaged`.

First attempt used `app.getAppPath()` to locate `resources/icon.png` and
failed with "Failed to load image from path
'.../out/main/resources/icon.png'". `getAppPath()` resolves to the directory
of the nearest `package.json` *above the entry script* — for `electron .` (a
directory with its own package.json) that's the project root, but this repo's
dev workflow launches `electron out/main/index.js` directly, and there's no
package.json in `out/main/`, so it fell back to that script's own directory
instead. Fixed by reusing `here` (already defined at the top of
`index.ts` as the running script's own directory, e.g. via
`fileURLToPath(import.meta.url)`) and going up two levels
(`join(here, '../../resources/icon.png')`) — the same pattern the preload
path on the next line already uses to reach a sibling of `out/`. Don't reach
for `app.getAppPath()` for anything else in this codebase without checking
which of the two dev launch shapes is actually in play.
