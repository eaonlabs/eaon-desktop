---
title: Scheduled runs: stall watchdog, monotonic clocks and windowless memory
tags: [eaon-desktop, scheduler, electron, gotchas]
created: 2026-09-29T14:29:17.638Z
updated: 2026-09-29T14:29:17.638Z
---

Rules added to `features/scheduler/` in the Sep 2026 bug pass. Extends [[Scheduled tasks engine and headless runs]].

- **Stall watchdog (`STALL_MS`, 15 min).** Only one run per task is allowed, and nothing timed out a model stream, so a connection that died while the Mac slept held the task "Running" forever and every later slot was skipped. Any stream event resets the clock; 15 min is above the slowest silent tool (`run_command`'s 10-minute kill).
- **Use `performance.now()` and timers for "no activity for X", not `Date.now()`.** On macOS the monotonic clock and timers do not advance while asleep, so a local model that carries on after wake is not cut off for the time asleep.
- **Check the signal before starting.** Stop/Delete/Quit can land while the run's chat is being written; `runAgent` now checks `signal.aborted` too (see [[Agent loop cancellation and tool robustness]]).
- **Status uses `outcome.cancelled`** as well as the task's own signal: Emergency Stop cancels the loop directly.
- **Windowless runs are not held in memory.** A finished chat with no window at all is already in `chats.json`, so it is dropped from `undelivered`; a window that is still loading keeps it queued (it may have read the file before the write).
- **A one-off whose slot passes during a manual run is used up** (`advance`), not left enabled with no next run.
- **`BrowserWindow.getAllWindows()` includes the computer-use pill and webview popups (and used to include the since-deleted pet window).** `activate` must check the main window, or a Dock click / notification click does nothing in background mode.

Computer use, same pass: the input helper tracks requests and output per process (a killed helper's late exit used to fail its replacement's requests); overlapping `withEaonHidden` calls share one hide (a nested hide saved opacity 0 as the value to restore and left Eaon invisible); a queued action re-checks its signal before acting.
