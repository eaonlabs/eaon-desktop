---
title: Loop guards: repeated failures, duplicate observations, goal evidence
tags: [eaon-desktop, agent, eaon-work, goal-mode, tokens, loop]
created: 2026-09-28T01:16:07.783Z
updated: 2026-09-28T01:16:07.783Z
---

# Loop guards: repeated failures, duplicate observations, goal evidence

`src/main/agent/guards.ts` (`CallGuard`, one per `runLoop`) plus bookkeeping in `runTool` (`loop.ts`).

## Repeated failing calls
Keyed by `callSignature(name, input)`, which is JSON with sorted keys.
- The 2nd identical failure gets a note appended: "failed twice… change the approach".
- From the 4th attempt (`MAX_IDENTICAL_FAILURES = 3` failures already) the call is refused **without running**.
- Any successful mutating call clears all counts: an edit can make a failed call succeed.
- Only `status: 'error'` counts. Denials never count, and `run_command` with a non-zero exit is `done`, not error — a failing test run is information, not a broken call.

## Duplicate observations (token saving)
A successful read-only call with no images and output ≥ 400 chars, identical to the previous identical call's output, is sent to the **model** as a pointer: "(Same result as your earlier identical X call…)". The **user** still sees the full output (`finish(output, …, forModel)`).
- The earlier copy must be among the last 5 tool results and still unpruned in `params.messages`. `pruneInFlight` keeps the last 4 tool messages and Anthropic context editing keeps 6 tool uses, so the pointer never points at a cleared result.
- Output is compared *after* running, so it is correct by construction (a log that changed is sent in full).
- `test/token-budget.test.ts` measures it. Re-reading an unchanged 300-line file: the final request is ≈6,471 tokens with dedupe vs ≈11,120 without, so 4,649 (42%) saved.

## Goal evidence
`TurnState.evidence` tracks the sequence number of the last successful change (mutating, not `run_command`) and of the last check (anything else, including every `run_command`). `WORKFLOW_TOOLS` count as neither.
- `goal_complete` called with change > check is sent back **once** to verify.
- The second call is accepted, so a goal that genuinely can't be checked still ends.

## Goal budgets and pause
- `settings.work.goalMaxMinutes` (60) and `goalMaxTokens` (2M, input + output), per reply, beside `goalMaxIterations`. Set in Settings → Code index → Agent (Work-only page).
- The banner shows which limit paused the goal.
- Pausing mid-run goes through `chat:pause-goal` → `pauseGoal(messageId)`. Before, the banner changed but the loop's next `goal` event set it back to active.

Links: [[Work modes: plan, goal and swarm]], [[Token efficiency in the agent loop]], [[Agent core: one loop, adapters and tool sources]].
