---
title: Work modes: plan, goal and swarm
tags: [eaon-desktop, eaon-work, agent, modes]
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-23T00:00:00.000Z
---

# Work modes: plan, goal and swarm

Three pills in the Work composer. Plan and Swarm are settings that stay on
(`settings.planMode`, `settings.work.swarm`); Goal is armed for the next
message only.

- **Plan**: read-only tools plus `present_plan`. The tool emits a `plan` event
  and sets `ctx.turn.plan`, which ends the turn after that round. The renderer
  shows a PlanCard; Approve calls `approvePlan`, which marks it approved and
  sends "Approved — carry out the plan" with `plan: false` for that one turn —
  plan mode itself stays on for the next task. Revise drops "Change the plan: "
  into the composer.
- **Goal**: the message becomes `chat.goal` and is added to the system
  prompt. When the model stops without calling `goal_complete` or
  `goal_blocked`, the loop appends a short "keep going" user message and
  continues, up to `settings.work.goalMaxIterations` (8) per user message;
  then the goal is marked paused. The goal banner pins above the composer.
- **Swarm**: `spawn_agents` runs 2–6 in-process sub-agents on the same loop
  (depth 1, no spawn_agents, role-scoped tools: scout/researcher/reviewer
  read-only, tester read-only + run_command, implementer full). Only their
  final reports return to the parent; their tool traffic becomes the swarm
  card's activity line; approvals from sub-agents surface in the normal
  dialog. Modelled on Eaon Code's swarm (`~/Downloads/eaon-code-main`,
  `core/swarm.ts`), including putting sub-agents in-process rather than
  spawning processes.

Plan wins over swarm: sub-agents inherit read-only when plan mode is on.

Related: [[Agent core: one loop, adapters and tool sources]], [[Eaon Work mode]].
