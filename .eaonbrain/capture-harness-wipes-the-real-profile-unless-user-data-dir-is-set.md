---
title: Capture harness wipes the real profile unless --user-data-dir is set
tags: [eaon-desktop, capture-harness, screenshots, gotcha, marketing, testing]
created: 2026-09-28T04:05:42.872Z
updated: 2026-09-29T14:29:40.991Z
---

# Capture harness wipes the real profile unless --user-data-dir is set

`EAON_CAPTURE=<dir> npx electron ./out/main/index.js` runs `src/main/capture.ts`,
but **before any step runs, `index.ts` resets the store**: `store.saveChats([])`,
`store.saveProjects([])` and dark mode. Pointed at the default profile that
empties the user's real `~/Library/Application Support/Eaon/store/chats.json`.

Always pass an isolated profile:

```bash
EAON_CAPTURE=/tmp/out EAON_CAPTURE_STEPS=steps.json \
  npx electron ./out/main/index.js --user-data-dir=/tmp/eaon-profile
```

(`app.getPath('userData')` follows `--user-data-dir`; the single-instance lock is
per profile, so this also runs beside a normal Eaon.)

Other things learned while driving it for the 2026.6 launch video:

- **`window.__perfStore` no longer exists.** Steps `34-model-menu-long` etc. in
  `capture.ts` reference it and silently skip seeding. Seed state through the
  preload API instead — `window.api.chats.save([...])`, `window.api.settings.patch`,
  `window.api.workspaces.save` — then `location.reload()`; the capture-mode reset
  only happens at main-process startup, not on reload.
- Offscreen capture comes out at **2x** (2540×1594 for the 1270×797 window) and has
  **no traffic lights** — macOS draws those, not the page. They sit at
  `trafficLightPosition {x:20,y:20}`: 12pt dots, centres 20pt apart.
- `outerHTML` does not serialize typed `<textarea>/<input>` values or scroll
  positions; copy them into `data-value` / `data-scroll-top` attributes before
  snapshotting DOM.

Related: [[Matching the Eaon Desktop Figma frames]], [[Re-hosting real Eaon UI in videos and docs]]

Related: [[Smoke-testing the built app with a fake provider over CDP]]
