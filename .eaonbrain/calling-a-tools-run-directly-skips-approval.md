---
title: Calling a tool's run() directly skips approval
tags: [eaon-desktop, agent, testing, approvals, computer-use, gotcha]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Calling a tool's run() directly skips approval

Approval is the loop's job (`runTool` in `src/main/agent/loop.ts`): in "Ask
for approval" it asks before *any* mutating call, and `tool.run()` assumes
that has already happened. The `computer` tool, for example, only calls
`ctx.confirm` itself when the loop didn't ask (auto mode + Confirm each
action), so the user is never asked twice.

So a harness that calls `computerTool.run({action: 'click', …}, ctx)`
directly with the default `approvalMode: 'ask'` **performs the click without
asking anybody**. A verification script did exactly that on the dev Mac
(2026-09-24). It typed a stray "x" into the frontmost app and clicked the
top-left corner of the menu bar, because it expected a fake `ctx.confirm` to
be asked.

How to test approval paths safely:

- Drive them through `runAgent` with a scripted provider and an `approver`,
  like `test/computerApprovals.test.ts` does.
- Swap in a recording input backend with `setInputBackend()`
  (`src/main/features/computer/backend.ts`), so nothing reaches the real
  pointer or keyboard.
- Live checks on a real machine: only `move`, `cursor_position` and
  `screenshot`.

See [[Computer use: how the computer tool sees and drives the screen]] and
[[Agent core: one loop, adapters and tool sources]].
