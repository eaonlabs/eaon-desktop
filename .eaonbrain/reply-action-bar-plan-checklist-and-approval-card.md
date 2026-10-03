---
title: Reply action bar, plan checklist and approval card
tags: [eaon-desktop, chat, workers, ui, approvals]
created: 2026-10-02T23:25:47.905Z
updated: 2026-10-02T23:25:47.905Z
---

Three transcript pieces rebuilt on Oct 2 2026.

## Reply action bar (adapted from AICSS Message Actions, MIT)
`components/agent/MessageActions.tsx` with `MessageActions.module.css`, `messageActionIcons.tsx` and `emojis.ts`. These are the free AICSS component kept one to one: same sizes, glyphs, tooltip, reaction popover, emoji search and roll-over timestamp. Each file carries a header pointing at `components/aicss/LICENSE`, and nothing in the UI credits it. What changed from theirs:
- **Colours come from Eaon tokens** (`--text`, `--hover`, `--surface-1`, `--border-strong`, `--diff-add-fg`, `--danger`), with their light/dark shadow stacks kept as they were.
- **Thumbs and emoji are the message's own:** `ChatMessage.feedback { vote?, reaction? }`, through `setMessageFeedback`. The component is controlled by those props, so the choice survives a reload and syncs to other windows.
- **The "…" menu is Read aloud** (`speechSynthesis`; one voice app-wide), **Try again** (only on the chat's last reply: `retryReply` re-asks the question in place of the pair) and **Fork chat** (`forkChat`, which copies up to that reply and drops the goal and any summary past the fork point). Their "Report" was dropped because nothing would receive it. Reply quotes the reply (or the selected part of it) into the composer via `setComposerDraft`.
- **An action without a handler isn't shown.** Worker replies get copy, read aloud and the time only, because a worker thread lives in main and has nowhere to keep feedback.
- **The 1 s clock only ticks while the bar is hovered** (`onLive`), since every reply has a bar.
- **The bar hides while the reply is unfinished:** streaming, or any tool part still `running`, which covers runs from other windows and scheduled tasks. `retryPlan` also refuses a reply with a running tool.
- It shows on hover, and stays shown for the last reply and for replies with feedback (`data-pinned`).

The pure logic is in `state/chatEdits.ts` (`withFeedback`, `retryPlan`, `forkedChat`) and tested in `test/chatEdits.test.ts`.

## Plan checklist (original design)
`WorkBits.tsx` TodoPanel plus `styles/tasklist.css`. Folded, it's a progress ring, the count ticking over, and the current step sliding in. Open, it's a timeline rail that fills behind done steps, an orbiting arc on the step in progress, and a done step that fills its dot, draws its check and sweeps a strike through the text. Each mark is drawn in every state at once and CSS **transitions** between them, so only a step changing state animates; one that was already done when the panel opens doesn't replay.

## Approval card (original design)
`components/agent/ApprovalCard.tsx` plus `styles/approval.css`. One card serves both the Chat dialog (`ChatView.tsx` ApprovalPrompt, variant `dialog`) and the worker's "needs your OK" card (`WorkerAutonomy.tsx`, variant `inline`).
- Risk comes from the tool (`approvalRisk`): sending and money are **high** (danger), commands, clicks and plugins are **medium** (amber), file edits are **low** (accent). It colours the tile, the "what it does" line and Approve.
- Previews: `CommandPreview` (with a `$` prompt), FileDiff, and `CallPreview` (a summary line, with the JSON a click away).
- The dialog stays about 200 ms after an answer so it can leave the way it was answered: up when approved, down when denied. The next queued approval slides in (`swap`), and `+N` counts the ones waiting.
- ⏎ approves and esc denies, but not while a button has focus, since the focused button handles ⏎ itself.

## Gotchas
- **Component stylesheets can land before `controls.css` in the built CSS.** A rule meant to beat `.btn` or `.input` needs two classes (`.approval .approval__approve`); with one, `.btn`'s background won and Approve rendered grey.
- **Flex items drop leading spaces**, so " of 5" inside an inline-flex rendered as "2of 5". Use `gap`.
- **To test a light theme over CDP**, `data-theme` alone isn't enough, because `--bg` and `--fg` are inline from settings. Patch `appearance.mode` and send `settings:changed` with the result to the window.
- **A scripted ⏎ needs `text: '\r'`** on `Input.dispatchKeyEvent`, or a focused button won't activate.

Links: [[Several Eaon windows: how chats and settings stay in step]], [[Agent transcript: activity lines and the files-changed card]], [[Worker autonomy: access levels, routines, memory and approve-once]]
