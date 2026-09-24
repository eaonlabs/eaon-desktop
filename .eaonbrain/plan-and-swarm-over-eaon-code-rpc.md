---
title: Plan and swarm over Eaon Code RPC
tags: [eaon-code, rpc, plan-mode, swarm, external-repo]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Plan and swarm over Eaon Code RPC

Eaon Code's `/plan` and `/swarm` existed only in its interactive TUI. For the
Code tab, the Eaon Code repo (`~/Downloads/eaon-code-main`, not a git repo)
gained two RPC commands, `set_plan_mode {enabled}` and `set_swarm_mode
{enabled}`, reported as `planMode`/`swarmMode` by `get_state`.

Implementation: `packages/coding-agent/src/modes/rpc/rpc-session-modes.ts`
(`RpcSessionModes`), wired into `rpc-mode.ts`. It mirrors
`InteractiveMode.enablePlanMode/enableSwarmMode/reapplyModesToSession` with the
same core pieces (`toolsForPlanMode`, `planModeToolBlockedReason`,
`PLAN_MODE_PROMPT`, `createSubagentToolDefinition`, `SWARM_MODE_PROMPT`).
Sub-agent progress goes out as a `setStatus` extension UI request with key
`swarm`.

## Deliberate differences from interactive mode

- **No settings persistence.** Interactive mode reads/writes `planMode` /
  `swarmMode` in settings. RPC does neither: restoring a persisted plan mode
  would silently block writes for a client that never asked (the reason print
  mode skips these too), and persisting would change the next terminal launch.
  The desktop re-sends its toggles on every start.
- No permission gate (RPC has none), so the guard is plan mode alone.
- Modes are re-applied **after** `bindExtensions`, so the plan filter also
  sees extension-registered tools.

## Gotcha: RPC rebinds twice for one new_session

`new_session` runs the runtime's rebind callback and then the command handler
calls `rebindSession()` again. Re-applying plan mode on the second pass would
snapshot the *already filtered* tools as "before plan mode", and turning plan
off would never bring back edit/write. `RpcSessionModes` remembers the session
it last applied to and skips a repeat. The test
`test/suite/rpc-modes.test.ts` fails without that guard (verified).

The published 1.0.1 does not have these commands; the desktop app detects that
from `get_state` and greys the pills. Part of [[Code tab drives Eaon Code over RPC]].
