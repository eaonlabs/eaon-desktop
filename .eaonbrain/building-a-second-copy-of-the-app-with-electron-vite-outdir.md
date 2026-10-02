---
title: Building a second copy of the app with electron-vite --outDir
tags: [eaon-desktop, build, testing, gotcha, capture-harness]
created: 2026-10-01T00:07:06.223Z
updated: 2026-10-01T00:07:06.223Z
---

# Building a second copy of the app with electron-vite --outDir

Several sessions often work in this checkout at once, so building into `out/` can clobber someone else's run. `npx electron-vite build --outDir <dir>` builds a separate copy, but two traps make it look broken:

- **The renderer lands somewhere else.** `outDir` is resolved per build target, and the renderer's root is `src/renderer`. So `--outDir out-x` writes main and preload to `./out-x/` but the renderer to `./src/renderer/out-x/renderer`. The window then loads `out-x/renderer/index.html`, gets ERR_FILE_NOT_FOUND, and shows a blank white page. After building, move the renderer next to the others (`mv src/renderer/out-x/renderer out-x/`) and delete the stray folder.
- **Keep it exactly one level below the repo root** (`out-x`, not `out/x`). In dev, `index.ts` calls `app.dock.setIcon(join(here, '../../resources/icon.png'))`. From `out/x/main` that path doesn't exist, the call throws inside `whenReady`, and the window is never created. There is no clear error, just an empty `/json/list` on the debug port.

Then run it offscreen against an isolated profile, as in [[Capture harness wipes the real profile unless --user-data-dir is set]] and [[Driving the capture harness over CDP for scripted app states]]:
`EAON_CAPTURE=<shots> EAON_CAPTURE_STEPS=hold.json electron --inspect=<p1> ./out-x/main/index.js --user-data-dir=<tmp> --remote-debugging-port=<p2>`. You can push fake states from main with `BrowserWindow.getAllWindows()[0].webContents.send('<channel>', …)`. That is how the "Connected" look of [[Chat apps: Workers in Discord, Telegram and WhatsApp]] was checked without a real bot token. Delete `out-x` when done; it is not gitignored.
