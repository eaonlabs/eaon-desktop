---
title: Smoke-testing the built app with a fake provider over CDP
tags: [eaon-desktop, testing, electron, gotchas]
created: 2026-09-29T14:27:58.609Z
updated: 2026-09-29T14:27:58.609Z
---

A repeatable end-to-end check of the real built app — startup, a chat through the UI, Stop, quit, persistence — with no API key, no keychain prompt and no real model. It caught a quit hang that 446 unit tests did not (see [[Quitting: held before-quit, will-quit and app.exit]]).

## Recipe

1. `npm run build`.
2. Start a tiny OpenAI-compatible SSE server on 127.0.0.1 (`/v1/models` + `/v1/chat/completions` streaming `choices[0].delta.content`, then `finish_reason`, then `[DONE]`).
3. Spawn the **real binary** — `require('electron')` from the repo, not `node_modules/.bin/electron` (killing that wrapper leaves the real Electron running) — with `out/main/index.js --user-data-dir=<scratch profile> --remote-debugging-port=<free> --inspect=<free>`. Never the default profile.
4. In the page target: point the **LM Studio** built-in provider (`lm-studio`, local, keyless) at the fake server with `window.api.providers.update(...)`, select it with `window.api.settings.patch({selectedModelId, selectedProviderId})`, `location.reload()`. A custom provider would need a key, and `keys:set` goes through `safeStorage` → a keychain prompt on the user's Mac. A fresh profile has no `keys.dat`, so nothing touches the keychain.
5. Type with `Input.insertText` into `.composer__input` and send with `Input.dispatchKeyEvent` Enter. Done = last `.msg--assistant` without `data-streaming`. Stop is `[aria-label="Stop"]`.
6. Quit via the main inspector: `Runtime.evaluate` with `includeCommandLineAPI: true` gives `require('electron')`; call `app.quit()`, then **close the inspector socket** — `--inspect` keeps the process alive ("Waiting for the debugger to disconnect...") while a debugger is attached, which looks exactly like a quit hang.
7. Read `<profile>/store/chats.json` for what was saved.

## Gotchas

- Port 9333 is often taken by another local Electron project; pick free ports and check `lsof -iTCP:<port> -sTCP:LISTEN`.
- **An `npm run dev` Electron ignored SIGTERM** for over 10 s (Sept 30, cause not investigated). `app.quit()` over the inspector exits in about 0.5 s, so prefer that; otherwise kill the PID you started with `-9`, and check its child processes (Eaon Code, terminal shells) for orphans.
- **Relaunching: kill with `-9`.** A capture instance started with `--inspect` survives a plain `pkill` (the held quit plus the attached inspector), so the next launch fails with "address already in use" on both debug ports and `/json` lists no page target. `pkill -9 -f <profile dir>` before each relaunch.
- **Tool calls from the fake server**: stream `choices[0].delta.tool_calls` = `[{index:0, id, type:'function', function:{name, arguments: JSON string}}]`, then `finish_reason: 'tool_calls'`. Count the `role:'tool'` messages since the last user message to know which step of a scripted turn you are on. Scripting per worker: match `You are (\w+), one of the user's Eaon Workers` in the system prompt.
- Relaunching the capture harness wipes chats again (see [[Capture harness wipes the real profile unless --user-data-dir is set]]); seed through `window.api.chats.apply(chats, [])` after every relaunch, `location.reload()` does not wipe.
- A fake server that switches behaviour on message text must look at the **last** user message: the history of the next request still contains it.
- Reference numbers (Sep 2026, M-series Mac): composer visible ≈0.5 s after spawn; quit ≈180 ms.

Builds on [[Driving the capture harness over CDP for scripted app states]] and [[Capture harness wipes the real profile unless --user-data-dir is set]].
