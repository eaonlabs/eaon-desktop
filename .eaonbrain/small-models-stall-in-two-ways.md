---
title: Small models stall in two ways
tags: [eaon-desktop, agent, gotcha, local-models]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
---

# Small models stall in two ways

Found by driving the real app with `nemotron-3-nano:4b` through Ollama on the
prompt "Make a folder called notes with a file todo.md…, then show me the
file". Two failure shapes, both of which used to end the Work turn silently:

1. **Thinking-only reply**: reasoning, then no text and no tool call. The
   loop now sends "You only thought about it and did not act…" (at most twice
   per turn) and does not record the empty turn.
2. **Announced plan**: "Steps: 1. Create the folder…" and stop.
   `announcesIntent()` in `agent/loop.ts` spots a reply whose last ~280
   characters state an intention and ask nothing; Work sends it back once
   with "Go ahead and do it now".

Same prompt went from roughly 1-in-2 to 4/4. `test/agent-live-stall.test.ts`
(opt-in, `EAON_LIVE=1`) is the reproduction; the scripted versions are in
`test/loop.test.ts`. Also relevant: small models copy read_file's `N\t`
line-number prefixes into edit_file's `old_text` — `edit_file` strips them
when every line carries one.

The old Swift app hit the same stalls (see its `handoff.md`, "thinking-only
stalls"); this is the Electron equivalent.

Related: [[Agent core: one loop, adapters and tool sources]].
