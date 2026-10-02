---
title: A dev app whose main process is older than its page
tags: [eaon-desktop, gotchas, process]
created: 2026-10-01T12:40:11.492Z
updated: 2026-10-01T12:40:11.492Z
---

The symptom: a settings page shows its heading and nothing else. On Oct 1 2026 it was Settings → Email. Nothing was wrong with the feature itself; the running app was made of two different builds.

## How it happens
- `npm run dev` runs `electron-vite dev` **without `--watch`**. The renderer hot-reloads from the Vite dev server, but the main process stays exactly as it was built at launch, no matter how many main-process features are added afterwards.
- The **preload is read from `out/preload/index.mjs` every time a page loads**. Anything that builds into the default `out/` while the dev app runs (a plain `npx electron-vite build`, or another session's build) replaces that file. The next reload (or full-page HMR reload) gives the old main process a new preload.
- The new page calls `window.api.<feature>.x()`, and the invoke rejects with `Error invoking remote method 'email:state': Error: No handler registered for 'email:state'`. A page that does `void api.state().then(setState)` and renders `null` until state arrives then stays empty forever, without an error anywhere.

## How to tell
- `ps -axo pid,lstart,command | grep 'Electron \.'` gives the dev app's start time.
- Compare it with `stat -f %SB` (creation time) of the feature's `src/main/features/<x>.ts`. If the feature is newer than the process, the process cannot have it.
- Pages that appear in a fresh build but not in the running app (e.g. Settings → Browser, Code index) are the same tell.

## What to do
- **Fix:** restart `npm run dev`.
- **Second app copies:** build into a separate folder (`--outDir out-e2e`, see [[Building a second copy of the app with electron-vite --outDir]]), never into `out/` while someone's dev app runs.
- **Page code:** a page that loads its state must show load failures. Settings → Email now shows "Email couldn't load" with Try again, and turns "No handler registered" into "Eaon was updated while it was running… Quit Eaon and open it again". Many older settings pages still use the silent `.then(setX)` pattern; they work only because their handlers have existed for a long time.

Related: [[Agent email through AgentMail: backend, decisions and API gotchas]], [[llama-server crash on quit and the crash guard]].
