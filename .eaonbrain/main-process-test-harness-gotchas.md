---
title: Main-process test harness gotchas
tags: [eaon-desktop, testing, gotchas]
created: 2026-09-29T14:28:05.857Z
updated: 2026-09-29T14:28:05.857Z
---

`npm run test:main` (scripts/test-main.mjs) bundles `test/*.test.ts` with esbuild, aliases `electron` to `test/stubs/electron.ts`, and runs `node --test`. Things that cost time:

- **The filter is a substring.** `ollama` also runs `ollama-live`, `modelLibrary` runs `modelLibrary-live`, `scheduler` runs `scheduler-live`, `eaon-code` runs `eaon-code-live` (which is NOT gated on `EAON_LIVE` — it runs whenever Ollama is up). Use `ollama.test`, `modelLibrary.test`, `eaon-code.test`.
- **Parallel runs clobber each other** unless each sets `EAON_TEST_OUT=<name>` (a folder under `out/`).
- **Tests are not typechecked.** `test/` is outside `tsconfig.node.json`; `npm run typecheck` never sees it. To check them, a throwaway tsconfig extending `tsconfig.node.json` with `test/**/*` included works; expect ~25 pre-existing errors from partial settings patches and stub-only members (`Notification.supported`, `.shown`).
- **A leaked handle hangs the whole file forever** — an open server, a live child process (a stdio MCP fixture, a fake Eaon Code). Stop bridges/servers in `finally`, and pass `{ timeout }` to tests that can hang. Fixtures that spawn should write pid files so a test can assert they died.
- **Keychain states are testable** by swapping `safeStorage` functions on the stub (see `platform-secrets.test.ts`).
- `t.mock.timers` works alongside a real child process.
- `utimesSync` sets whole milliseconds while `mtimeMs` has sub-ms precision; round when comparing.
- Tests that stall an upstream must `closeAllConnections()` before stopping the Local API Server.
- `npm run test:main -- skills` hits GitHub unless `EAON_OFFLINE=1`.

Related: [[Agent core: one loop, adapters and tool sources]] (what the harness drives), [[Smoke-testing the built app with a fake provider over CDP]] (what it cannot catch).
