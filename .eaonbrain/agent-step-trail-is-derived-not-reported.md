---
title: Agent step trail is derived, not reported
tags: [desktop-app, agent, architecture]
created: 2026-08-07T23:24:42.495Z
updated: 2026-08-07T23:24:42.495Z
---

`ThinkingSteps` shows what the agent has been doing this turn. The non-obvious part is where the data comes from.

**Nothing appends to it.** Every tool path in `ChatViewModel` already sets `agentActivityText` (a single live status string). `GenerationSession.agentActivityText` has a `didSet` that turns each *transition* into an `AgentStep`, marking the previous one `.done`. `task`'s own `didSet` clears the trail when a new turn starts.

That was the design decision worth recording: a step log each tool had to remember to append to goes stale the first time somebody adds a tool and forgets. Hooking the two properties means every existing and future tool path is covered by construction. There are three call sites that start a generation today; hooking `task` means a fourth cannot skip the reset.

`GenerationSession` is a **`final class`**, not a struct — `mutating` on those helpers does not compile.

## AgentStep parses rather than receives

`AgentStep(title:)` takes the raw status line and derives an icon `Kind`, a headline, and chips: `Searching the web for "swift concurrency"…` becomes title `Searching the web` + chip `swift concurrency`. Trailing ellipses are stripped (the row's dimming already says "in progress").

Same reasoning as above — it degrades to a plain untyped row rather than breaking. Covered by `Tests/EaonDesktopAgentTests/AgentStepTests.swift`, whose inputs are strings the app really emits. A regression test exists for classifying `Browsing …`: the matcher originally looked for the noun `browser` and missed the participle.

## Reasoning is split for presentation only

`AgentStep.reasoningSteps(from:isInProgress:)` splits a `<think>` trace on blank lines, taking the first sentence of each paragraph as a label and the rest as a description, so it can render as dot-mode steps instead of one wall of text behind a disclosure. **This is a presentation split, not a claim about the model's structure.** Prose with no blank lines yields a single step, which is the old behaviour exactly. `ThinkingDisclosure` was deleted once this replaced it.

## Still fragmented

The transcript still renders a tool-call chip and its `Tool results` card as separate blocks. They are **different messages** — the chip is a fence inside the assistant's message, the results card is a separate injected message — so merging them needs transcript-level grouping in `ChatHomeView`, not a pass inside `AssistantMessageContentView`. Hoisting just the chips reorders them relative to surrounding prose, which is worse than the fragmentation. Unfinished on purpose.

See [[Agent Swarm architecture]] for the other half of the agent UI.
