---
title: Token efficiency in the agent loop
tags: [eaon-desktop, agent, tokens, caching, performance]
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-23T00:00:00.000Z
---

# Token efficiency in the agent loop

The user asked for Chat and Work to be "as token efficient as possible". What
is in place, roughly in order of how much it saves:

1. **Prompt caching stays hot because the prefix is stable.** Tools are
   emitted in a fixed order (`toolsFor` dedups in registration order; MCP
   tools are sorted by server then name — connection order used to vary per
   launch), the system prompt contains nothing that changes within a
   conversation (the date moves once a day at most), and history rendering is
   a pure function of the stored transcript. On Anthropic: a breakpoint on the
   last tool, one on the system prompt, and top-level automatic caching so the
   last breakpoint moves with each round. OpenAI gets `prompt_cache_key` =
   chat id. Every turn shows "in · out · N% cached" under the reply — watch it
   to catch a silent invalidator.
2. **Old tool traffic is trimmed when history is rebuilt** (`buildHistory`):
   output from turns older than `settings.context.keepFullToolTurns` (2) user
   messages is cut to a stub, as are large tool *inputs* (write_file bodies),
   reasoning is never resent, only the newest screenshot is replayed, and
   attachments are inlined only for the last two user messages.
3. **Long loops clear stale output in batches**: server-side on Anthropic
   (`clear_tool_uses_20250919`, trigger 90k, keep 6, clear at least 25k), and
   `pruneInFlight` client-side for everyone else past 55% of the window. Both
   clear big batches rarely rather than a little every round, so the cache is
   rebuilt rarely.
4. **Plugin schemas are deferred.** Past 12 plugin tools, the agent gets
   `plugin_tools` (list / fetch one schema) and `use_plugin_tool` instead of
   every schema on every request. This replaced keyword "smart routing", which
   re-picked tools per turn — changing the tool list is the most expensive
   cache miss there is, since tools are the head of the prefix.
5. **Compaction** near `compactAt` (70%) of the context window: one summary
   request over a flattened transcript, then the summary plus the new message
   is the whole next request ("simple compaction"). The chat stores
   `summary.throughMessageId`; the renderer stops sending anything before it.
6. **Small defaults**: Chat has one tool; plan mode withholds write tools;
   swarm sub-agents keep their exploration in their own context and only
   their final reports come back; `update_plan` returns "Plan updated." rather
   than echoing the list; read-only sub-agent roles are not offered mutating
   tools at all.

Why Anthropic gets server-side clearing but no client-side edits: see
[[Preserved thinking forbids editing earlier turns]].

Related: [[Agent core: one loop, adapters and tool sources]],
[[Streaming performance: where the per-token cost lived]].
