---
title: Agent core: one loop, adapters and tool sources
tags: [eaon-desktop, agent, architecture, tools, providers]
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-29T14:29:38.766Z
---

# Agent core: one loop, adapters and tool sources

Replaced the two per-format loops that lived inside `providers.ts` (see
[[What Eaon Work still lacks to match Claude Code / Cursor]] for why they were
a problem). Everything an agent turn does now runs through
`src/main/agent/loop.ts`.

## Three layers

- **Adapters** (`src/main/providers/adapters/`) translate one request between
  the neutral transcript (`NeutralMessage`: user / assistant+calls / tool
  results, with images) and a wire format. `adapterFor(provider)` picks by
  `provider.kind`; more register with `registerAdapter(kind, adapter)`. An
  adapter never loops and never runs tools.
- **Tool sources** (`src/main/agent/tools.ts`) are how capabilities arrive.
  `registerToolSource({id, tools(query), guidance?})` — files/shell
  (`localTools.ts`), web (`webSearch.ts`), plugins (`agent/pluginTools.ts`),
  workflow tools (`agent/workflowTools.ts`: update_plan, present_plan,
  goal_complete/blocked), swarm (`agent/swarm.ts`), and each feature module
  under `src/main/features/`. `agent/sources.ts` imports the built-ins; feature
  modules register themselves. Adding a capability never touches the loop.
- **The loop** builds the transcript (`agent/context.ts`), calls the model
  through the adapter with credential fallbacks and visible retries, runs the
  tools (read-only calls in parallel, mutating ones in order, approvals on the
  way), and repeats.

## Contracts worth knowing

- A tool's `mutating` may be a function of its input — `run_command` is
  mutating unless `isReadOnlyCommand()` says the command only looks. Plan mode
  (`query.readOnly`) drops tools whose `mutating === true` outright and denies
  mutating calls of the rest.
- `risky` decides whether "Approve for me" still asks. Approval policy is in
  `runTool`: ask mode asks for every mutating call; auto asks only for risky.
- Tools talk back to the loop through `ctx.turn` (`TurnState`): a presented
  plan ends the turn, a goal resolution stops goal continuation, sub-agent
  token usage is folded into the turn's usage.
- Images a tool returns are saved under `userData/attachments` and served to
  the renderer through the `eaon-file://` protocol (images only).
- Features get a `FeatureContext` (`features/types.ts`) with `emitStream`, so a
  headless run (scheduled task) streams into the renderer exactly like a chat.
- Chat mode's only tool is web search; everything else is Work-only.
  `StreamRequest.rawSystem` (Local API Server) turns all tools off.

## Testing

`npm run test:main` bundles `test/*.test.ts` with esbuild, aliasing `electron`
to `test/stubs/electron.ts`, and runs `node --test`. `test/loop.test.ts`
drives the whole loop against a scripted fake provider (plan, goal, swarm,
approvals, retries); `test/agent-live.test.ts` (opt-in, `EAON_LIVE=1`) runs a
real local model through Ollama.

See [[Token efficiency in the agent loop]] for the cost side, and
[[Preserved thinking forbids editing earlier turns]] for the constraint that
shaped where context is trimmed.

Related: [[Agent loop cancellation and tool robustness]]
