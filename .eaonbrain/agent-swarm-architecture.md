---
title: Agent Swarm architecture
tags: [desktop-app, agent, architecture]
created: 2026-08-07T23:25:04.082Z
updated: 2026-08-07T23:25:04.082Z
---

`Eaon-desktop/Services/AgentSwarm.swift`. Replaced the old hosted-only `/reasoning` debate panel.

## How it runs today

1. **Creator** invents a roster for the specific task (3–10 `SwarmPersona`, each with a one-line `role` that becomes its system prompt). Strict JSON asked for, parsed leniently — an unparseable roster returns empty and the caller answers normally rather than staging a discussion between nobody.
2. **Discussion**, up to `maxRounds = 3`, one sequential call per persona per round. Each remark carries the persona's `wantsToEnd` vote on the same turn — the vote rides along rather than costing a second round of calls. `votesToEnd = 3` ends it.
3. **Handoff.** The swarm does **not** synthesize. `SwarmPanelExtractor.synthesisInstruction` is injected as system context and the app's **normal generation pipeline** writes the reply.

That last step is the load-bearing design decision. Keeping the final pass on the normal path is why a swarm still streams, still uses the typewriter, and still runs the agent tool loop that writes real files. The swarm decides *what* to build; the normal pipeline builds it.

## Everything routes through BackgroundCompletion

So a swarm runs on whatever model the user picked — hosted, BYOK, or local Ollama. Deliberate: a feature that silently needs an account isn't a mode you can offer next to "Agent", which is exactly what killed `/reasoning`.

`BackgroundCompletion` is `@MainActor` but `async`, so the actor is released at each suspension — **concurrent calls genuinely overlap on the network**. Parallel fan-out with `withTaskGroup` works and is not merely cosmetic.

## Persistence

The finished `SwarmTranscript` is base64-JSON embedded in the reply's own `content` between `<eaon-swarm-panel>` tags, stripped back out by `SwarmPanelExtractor.extract`. No `ChatMessage` schema change was needed, and a saved conversation redisplays the card exactly like anything else. It is prepended *before* streaming starts, so the card is complete from the first render rather than being partially streamed the way `<think>` is.

## Prompt-injection fencing

Persona remarks are untrusted data. `synthesisInstruction` wraps the transcript in a long, unguessable marker (`<<<SWARM_DISCUSSION_BEGIN — UNTRUSTED DATA>>>`) — a short one like `---` is something a persona could plausibly emit and so close the region early, putting the rest of its remark back into instruction position. Tool fences inside remarks are neutralised. Covered by `SecurityHardeningTests`.

## Rework in progress (not yet implemented)

Requested direction: keep the discussion, but the synthesizer should stop building. Instead it becomes a **lead** that splits the settled approach into parallel subtasks, fans them out to sub-agents, waits, and then assembles. `SwarmSubtask` / `SwarmSubtaskResult` and `SwarmTranscript.subtasks` have been added; the runner phases and the rewritten `synthesisInstruction` have not.

Open design question worth settling before building it: **sub-agents should produce output, not hold tools.** Parallel agents with write access to the same project clobber each other, and the final assembling pass already has the tool loop.
