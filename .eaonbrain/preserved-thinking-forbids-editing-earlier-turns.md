---
title: Preserved thinking forbids editing earlier turns
tags: [eaon-desktop, anthropic, gotcha, tokens, caching]
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-23T00:00:00.000Z
---

# Preserved thinking forbids editing earlier turns

Claude Fable 5.1 and Opus 5.5 bind each thinking block's signature to the
conversation prefix that produced it (system prompt, tool set, every earlier
message). If a request replays a thinking block after any earlier message was
edited — including trimming an old tool result — the API rejects it with a
400 for accounts created on or after 2026-08-31, and drops it for older ones.

What that means here:

- Within one turn the Anthropic adapter replays the assistant's raw content
  blocks (thinking signatures included) via `replay`, so the transcript of a
  running turn must be append-only. That is why `pruneInFlight` never runs for
  Anthropic (`adapter.managesContext = true`) and stale tool output is cleared
  server-side instead — server-side context editing does not count as an edit.
- Across turns no thinking block is ever replayed (history is rebuilt from
  text and tool parts), so trimming old turns in `buildHistory` is safe.
- Compaction must be "simple": summary + new message, nothing kept verbatim
  from before. Keeping recent turns next to a summary would replay content
  whose thinking was produced under a different prefix.
- The system prompt and tool list must not change mid-turn. Toggling a Work
  mode (plan/swarm) takes effect on the next turn, which starts clean.

Source: the claude-api skill's migration guide (Fable 5.1, breaking change 3).

Related: [[Token efficiency in the agent loop]].
