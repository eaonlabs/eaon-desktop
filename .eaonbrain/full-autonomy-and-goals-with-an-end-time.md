---
title: Full autonomy and goals with an end time
tags: [eaon-desktop, agent, approvals, goal-mode, autonomy]
created: 2026-10-01T03:26:20.992Z
updated: 2026-10-01T03:26:20.992Z
---

# Full autonomy and goals with an end time

The co-founder asked (Sept 30 2026) for the chat agent to "run all types of commands on your computer to get to the task, and of course they have to be safe", and for a time the agent "will run till".

## Full autonomy (`approvalMode: 'full'`)
- `ApprovalMode` is now `'ask' | 'auto' | 'full'` (shared/types.ts). In the loop's interactive branch (`executeTool` in agent/loop.ts), `full` runs every tool, risky or not, and only calls the approver when the tool says the call is `catastrophic`. That covers sudo, erasing disks, `rm -rf /` or `~`, force-push, `curl | sh`, credential paths and keychain (approvals.ts `isCatastrophicCommand`), destructive plugin calls, browser card, password and spend-money fields, and computer use's `riskReason`. It is the same rule an autonomous worker runs by. The difference is that the user is present, so a catastrophic call asks them instead of being refused.
- Plugin pre-approval ("Allow all MCP tool permissions") does not skip that question in `full`, on purpose.
- Plan mode and the unattended branch (workers, scheduled runs) come first and are unchanged.
- The system prompt gets one line when `full` is on and the run is interactive (`WorkPromptOptions.autonomy`), so the model stops asking permission in text.
- Composer: Permissions → "Full autonomy" (lucide `Zap`), plus a chip that switches it back to Ask. Computer use's own "confirm each action" setting still applies, because that is the user's explicit choice.
- Verified in the built app: in Full autonomy, `echo … > file` and `rm -rf ./dir` ran without a dialog, and `sudo -n true` raised "Run this command?" (test/autonomy.test.ts, plus E2E).

## Goals with an end time (`GoalState.until`)
- The composer's Goal chip gets a second chip, `GoalEndChip`: until it's done (the old behaviour), for 30 min / 1 / 3 / 8 h, or until a clock time (a time already past means tomorrow). `send(text, { goal, until })` stores `until` on the chat's goal.
- In the loop, a goal with `until` ignores `goalMaxIterations` and `goalMaxMinutes` and stops at the end time (`goalBudgetExceeded(…, until)`). **It keeps `goalMaxTokens`**: the user picked a time, not an unlimited bill, and the banner says "token limit reached" so they can raise it. The per-reply round cap becomes 10 000 while the end time is ahead, because the usual 40–200 rounds would end a multi-hour run early. Continuations say how much time is left.
- `wait` (agent/workflowTools.ts) is offered only while an until-goal is active: it pauses 1–120 min, never past the end time, and Stop aborts it. Without it, a long goal either stopped and was sent straight back, or polled in a tight loop and paid for a model call each time. `wait` is in `WORKFLOW_TOOLS`, so it doesn't count as goal evidence.
- Until-runs keep the computer awake whatever Settings → Prevent sleep says (`untilRuns` in loop.ts `holdAwake`), since sleep would end them early.
- The goal banner shows "Working toward goal · until 8:54 PM".

Related: [[Work modes: plan, goal and swarm]], [[Worker autonomy: access levels, routines, memory and approve-once]], [[Loop guards: repeated failures, duplicate observations, goal evidence]]
