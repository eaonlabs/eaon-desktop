---
title: Chat Markdown renderer: what it covers and the streaming rule
tags: [eaon-desktop, chat, markdown, streaming, gotcha]
created: 2026-10-02T22:48:49.156Z
updated: 2026-10-02T22:48:49.156Z
---

Replies, thoughts and worker questions render through Eaon's own small Markdown renderer: `components/agent/Markdown.tsx` (inline and React) and `markdownBlocks.ts` (the block parser, free of React so tests can run it). It isn't a library on purpose: there's no HTML injection, and every node is a React element.

## What it covers (since Oct 2 2026)
The co-founder reported "Markdown kinda never renders", in Chat as well as Workers. The old parser only knew flat lists, so models' usual output broke:
- **Numbered lists spaced with blank lines** came out as separate lists, each restarting at "1.".
- **Sub-bullets and continuation lines** fell out of their item.
- **Tables** showed as raw pipes.
- `_x_`, `__x__`, `~~x~~`, task lists and bare URLs stayed as typed.

Now:
- Lists nest by indentation. An item's indented lines are parsed as blocks of their own, which is how nesting works (`ListItem = { text, checked, children }`). Blank lines between items keep one list, `start` is kept (`4.` starts at 4), and `- [ ]` / `- [x]` become task boxes.
- GFM pipe tables, with `:--` / `--:` / `:-:` alignment. A table needs a rule line with as many cells as the header. It scrolls in its own `.md__table-wrap`.
- Inline: code spans first, then `**`/`__` bold, `~~` strike, `*`/`_` italic (`_` only at word edges, so snake_case survives), `[text](url)`, `<url>`, and bare `https://` links without trailing punctuation. Links open with `openExternal`, and **only http(s) and mailto**; anything else shows as text.
- Reasoning (`TurnSteps.tsx`, through `thoughtBody`) and a worker's question card (`WorkerAutonomy.tsx`) use the same renderer. A worker's notes panel is deliberately a raw file view.

## The streaming rule
A reply is re-parsed from its last *settled* point, not from the top, and the result must equal a whole parse at every prefix. `test/markdownBlocks.test.ts` checks this against 150 random documents. Before lists could span blank lines, every top-level blank line settled. Now a blank line after a **list** settles only once the next line plainly isn't more of it: not indented, not an item start, and not a bare `1`/`-` that could still become one (`couldContinueList`). Any new block type that can continue past a blank line needs the same care.

`test/markdownRender.test.ts` renders a typical reply with `react-dom/server` and checks the HTML. For that, `scripts/test-main.mjs` builds with `jsx: 'automatic'`, as the app does; without it, a test importing a component fails with "React is not defined".

Links: [[Streaming UI: per-token work that remained, and one reply at a time]], [[Agent transcript: activity lines and the files-changed card]]
