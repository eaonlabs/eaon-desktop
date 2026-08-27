---
title: Glass-blur popovers and sidebar vibrancy
tags: [eaon-desktop, ui, css, vibrancy, electron, screenshots, gotchas]
created: 2026-08-21T00:00:00.000Z
updated: 2026-08-21T00:00:00.000Z
---

# Glass-blur popovers and sidebar vibrancy

## Popovers (Model/Effort selector, etc.)

Every floating menu in the app (`Popover` in `ui.tsx`) shares one `.menu` class
in `controls.css`. To match a frosted-glass look, it's now:
`background: var(--menu-bg)` + `backdrop-filter: blur(28px) saturate(180%)`.
`--menu-bg` is a new token per theme in `tokens.css`
(`color-mix(in srgb, var(--surface-3), transparent 24%)` dark, `18%` light) —
kept as a token rather than hardcoded so it stays consistent with the
"everything derives from accent/background/foreground/contrast" system in
[[Eaon Desktop architecture]]. Because it's one shared class, every popover
(model picker, plugins, project search, context menus...) got the glass look
in one place — no per-menu changes needed.

## Sidebar translucency

`translucentSidebar` (per-theme, in Appearance settings) already drove real
macOS vibrancy (`vibrancy: 'sidebar'` on the BrowserWindow, see
`src/main/index.ts` `createWindow()`) — the plumbing pre-dates this session.
It just defaulted to `false` for dark mode (`true` for light), which is why
the sidebar looked flat by default even though the feature existed. Flipped
the dark default to `true` in `src/main/store.ts`.

**That default flip alone did not make it visible — found and fixed the real
bug after the user reported it was still flat.** Two opaque layers were
sitting behind `.sidebar`'s own `background: transparent`, each fully hiding
whatever vibrancy would otherwise show through:

1. `body` and `.app` in `app.css` both painted `background: var(--canvas)` —
   opaque — across the *entire* window, underneath `.sidebar` and `.main`
   alike. A child's `background: transparent` only means "don't paint another
   layer here"; the opaque ancestor paint in that same screen region, one
   level down, was still there. Fix: removed both — safe because `.main`
   (and `.browser`, and `.settings`) already paint their own explicit opaque
   background over their own rect, so `.sidebar`+`.main`(+`.browser`) still
   fully tile the window in the non-translucent case. Added
   `.app:empty { background: var(--canvas) }` to cover the one real gap: the
   brief `if (!ready) return <div className="app" />` loading placeholder in
   `App.tsx`, which has no children to paint anything.
2. `BrowserWindow`'s own `backgroundColor` was hardcoded to an opaque theme
   hex even when vibrancy was active — the identical problem one layer lower,
   at the native window level instead of CSS. Fix: `backgroundColor:
   '#00000000'` specifically when vibrant (dark mode + translucentSidebar +
   darwin), keeping the opaque per-theme flash-color otherwise.

**How this got diagnosed without a real screenshot:** confirmed via a
temporary `console.log` in a capture step that `.sidebar` had
`data-translucent="true"` and computed `background-color: rgba(0,0,0,0)` —
so the settings/CSS *selector* logic was already correct before touching
anything. That ruled out the settings layer and pointed straight at the
paint-order question above, which is answerable by just reading the
stylesheet cascade — no live vibrancy screenshot needed to find or fix it.

**How the fix was confirmed working, still without a real OS screenshot:**
re-ran the onscreen `capturePage()` before and after. Before: sidebar
rendered as flat, uniform black — consistent with vibrancy being fully
blocked. After: it rendered as a position-dependent gradient (bright in one
region, dark in another) — exactly the signature of real vibrancy, since it
dynamically blurs+tints whatever is actually behind the window on that
machine's desktop at capture time. A flat, uniform result would have meant
still-blocked; a content-dependent, non-uniform result is what "it's now
sampling the real desktop" looks like, even without being able to judge the
final aesthetic on a screen this environment can't screenshot for real.

**This default only affects fresh installs.** Existing `settings.json` files
under `app.getPath('userData')/store/settings.json` already had
`translucentSidebar: false` persisted explicitly (the whole settings object
gets rewritten on every `patchSettings` call), so the new code default won't
retroactively reach a machine that already ran the app. If translucency looks
off after a change like this, check the persisted file, not just
`defaultSettings`.

## Gotcha: you cannot screenshot real macOS vibrancy from inside the app

`webContents.capturePage()` — the mechanism the `EAON_CAPTURE` harness uses
(see [[Matching the Eaon Desktop Figma frames]]) — only captures Chromium's
own compositor surface. Native vibrancy (`NSVisualEffectView`) is a separate
layer the OS window server composites in, outside anything Chromium hands to
`capturePage()`. A transparent CSS region will just show as the
`BrowserWindow`'s own `backgroundColor` in a capture, vibrancy or not — this
is true even with `offscreen` painting turned off. There is no in-app way to
verify vibrancy visually; you need a real OS-level screenshot
(`screencapture`), which requires the Screen Recording permission that this
sandboxed dev environment doesn't have granted.

What you *can* still verify from inside the app, in increasing order of how
deep it checks:

1. **DOM/CSS state.** Temporarily add a `console.log` to a capture step
   (forwarded to stdout via the `console-message` listener already wired for
   `EAON_CAPTURE`), rebuild, run
   `EAON_CAPTURE=<dir> npx electron out/main/index.js`, read the log, then
   revert. Checks `data-translucent` and computed `background-color` on
   `.sidebar` — confirms the settings/CSS selector logic, nothing about
   whether anything opaque is still hiding behind it.
2. **Whether something is genuinely blocking vibrancy vs. just an unhelpful
   test-environment desktop.** Compare an onscreen (non-offscreen)
   `capturePage()` before and after a fix. Toggle offscreen off for a one-off
   run: temporarily change the `EAON_CAPTURE` gate in `index.ts` to something
   like `process.env['EAON_CAPTURE'] && !process.env['EAON_CAPTURE_ONSCREEN']`,
   rebuild, run with `EAON_CAPTURE_ONSCREEN=1` set alongside `EAON_CAPTURE`,
   then revert both the flag and the rebuild after. A **flat, uniform** sidebar
   color means vibrancy is still fully blocked (nothing behind the window can
   look perfectly uniform once genuinely blurred/sampled). A **position-
   dependent, non-uniform** result — even one that looks aesthetically wrong,
   e.g. unexpectedly bright — means vibrancy is active and just reflecting
   whatever happens to be behind the window on that particular desktop, which
   this sandboxed environment doesn't control and can't judge for looks. Do
   NOT use the fully-offscreen `EAON_CAPTURE` pipeline for this check — see
   above, it can't render vibrancy at all and always looks flat/washed
   regardless of whether the underlying bug is fixed.
3. **The real OS-composited pixels**, for actually judging the aesthetic —
   genuinely needs a live screenshot (`screencapture`), which needs macOS
   Screen Recording permission this sandboxed terminal doesn't have. This is
   the one thing to just ask the user to eyeball, once (1) and (2) both check
   out.

## Unrelated fix bundled in

`tsconfig.web.json` was missing `"types": ["vite/client"]`, so real asset
imports (`import logo from '../assets/x.png'`) failed `tsc --noEmit` with
"Cannot find module" even though Vite itself bundles them fine. This wasn't
caught before because `brand.tsx` only recently started importing real image
files instead of inline icons. One-line fix, unrelated to the blur/vibrancy
work but was blocking `npm run typecheck` / `npm run build` entirely.
