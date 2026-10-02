---
title: Agent loop cancellation and tool robustness
tags: [eaon-desktop, agent, tools, approvals, gotchas]
created: 2026-09-29T14:28:31.017Z
updated: 2026-09-29T14:28:31.017Z
---

Contracts in `src/main/agent/loop.ts`, `approvals.ts` and `localTools.ts` that are easy to break. Builds on [[Agent core: one loop, adapters and tool sources]].

## Cancellation

- **`runAgent` checks `signal.aborted` up front.** An abort that already happened never reaches an `'abort'` listener; a Stop pressed during set-up used to be missed and the whole turn ran.
- **`RunOutcome.cancelled`** is true whenever the run was stopped (Stop, Emergency Stop, `cancelRun`, the caller's signal). Callers must use it — `scheduler/runner.ts` recorded Emergency-Stopped runs as "Succeeded" because only its own signal was checked.
- **Tool runs race the abort** (`unlessAborted`). A tool that ignores the signal (a hung plugin call, a slow fetch) is left to finish on its own and its result is dropped; the card closes as "Stopped by the user".
- **An aborted run asks for no approval**: a tool still finishing after Stop (computer use's own confirm) would otherwise open a dialog nothing answers.

## Transcript invariants

- **Call ids are made unique across the transcript.** Ollama and several OpenAI-compatible servers mint deterministic ids (`call_0`, or `sha1(name+index+input)` in our own adapters), so repeating `npm test` reused an id: the second result landed on the first card and the next turn replayed a phantom "interrupted" call.
- Usage accumulates into `LoopParams.usage` as it goes, so a sub-agent that throws and the compaction request still count.
- A final answer cut off by `max_tokens` ends as done, not "Stopped after 40 tool rounds".

## Approvals

`isReadOnlyCommand` must see through `\n`, `&`, process substitution `<(...)`, and write flags of "read" tools (`fd -x`, `rg --pre`, `sort -o`, `uniq in out`, `tree -o`). Commands that name credential folders (`~/.ssh`, …) always ask. `settings.mcp.allowAllToolPermissions` skips the prompt only for tools whose source id is literally `'plugins'` (`toolSourceOf`) — renaming that source silently disables the setting. Plan mode and unattended runs still gate plugin tools.

## run_command

stdin is closed (bare `cat`/`read` used to hang to the timeout); UTF-8 is decoded across chunks; huge output keeps head and tail with an exact omitted count; after a kill it gives up 2 s later even if a `setsid`/daemon child holds stdout open.

## Files and search

`edit_file` matches CRLF files and keeps them CRLF. `grep`/`find_file` use a fresh `.gitignore`-aware listing (`listProjectFiles`, 20k cap, real globs), not the index — the index misses new files and non-code names. The code index's manifest and vectors are cached on mtime+size (re-parsing a 50 MB manifest cost ~120 ms of main thread per turn); a superseded build must never publish status or clear the newer run's controller.

## Still open

`resolveWorkPath` does not resolve symlinks (a link inside the Work folder can point out of it); grep's regex runs synchronously (a pathological pattern freezes main); Windows `run_command` kills only the shell. See [[Loop guards: repeated failures, duplicate observations, goal evidence]] for the other loop safety rails.
