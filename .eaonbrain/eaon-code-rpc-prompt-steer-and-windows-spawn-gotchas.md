---
title: Eaon Code RPC: prompt, steer and Windows spawn gotchas
tags: [eaon-code, code-tab, rpc, windows, gotcha]
created: 2026-09-29T14:29:11.138Z
updated: 2026-09-29T14:29:11.138Z
---

Behaviour of `eaon-code --mode rpc` that the Code tab (`features/eaonCode/`, `components/code/`) depends on. Extends [[Code tab drives Eaon Code over RPC]].

- **`prompt`'s response means "preflight passed", not "received".** Preflight can run a whole compaction or an extension command first and take minutes, so `prompt` has no timeout (a 120 s one reported failures for prompts that went on to run). A crash still rejects it.
- **`steer`/`follow_up` refuse extension commands**; `prompt` with `streamingBehavior` handles everything. A steer sent before the run starts is queued and delivered to that run — so a message sent while waiting for the first reply goes as steer, not as a second `prompt` (refused during preflight).
- An idle extension command gets no `agent_start`, so `awaiting` must clear on the command's answer or the tab shows "Starting" and Stop forever.
- **Eaon Code shuts down on stdin EOF**; SIGTERM also kills its tracked detached children.
- **A process that dies or goes idle mid-turn** must run `interruptTranscript`: running tools become "Interrupted" (partial output kept), dialogs and statuses clear, queued messages return to the composer. Sending after a crash resumes the crashed session rather than starting a blank one.
- **JSONL framing searches only the new chunk** for newlines; rescanning the growing buffer made a 20 MB record (a resumed session's `get_messages`) quadratic — ~0.6 s of main-thread block.
- Session summaries are cached on mtime+size; the list is re-read after every turn.
- A failed start clears the cached "ready" status so "Try again" looks for the binary afresh (nvm/npm updates move it).
- **Windows: with `shell: true`, Node never quotes the command or its arguments.** npm lives in `C:\Program Files\nodejs\npm.cmd` by default, which ran `C:\Program`. `spawnSpec()` in `locate.ts` quotes for cmd.exe; use it for every `.cmd`/`.bat` spawn.
- `RpcChild` finishes on `exit`, which can fire before stdio drains (seen with ~580 KB of stderr), so the last stderr lines of a crash can be cut.

Still open (Windows, untested): "Continue in Terminal" quoting (`cmd /k` with more than two quotes strips the outer pair); stop/kill reaches only `cmd.exe` — needs `taskkill /T /F`.
