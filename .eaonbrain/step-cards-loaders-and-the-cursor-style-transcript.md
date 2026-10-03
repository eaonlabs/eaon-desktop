---
title: Step cards, loaders and the Cursor-style transcript
tags: [eaon-desktop, chat, agent, design-system, ui, gotchas]
created: 2026-10-03T00:20:32.817Z
updated: 2026-10-03T00:20:32.817Z
---

On Oct 2 2026 the user asked for the agent transcript to look like **Cursor's agentic coding UI**, built from two outside component libraries (an MIT agent-chat kit and an Apache-2.0 kit with agent components). The user said **"Do not give credit at all"**, the same rule as for the AICSS pieces in [[Diff card and reply tables (adapted from AICSS)]]. So there is no credit in the UI, changelog or commits. The license texts that MIT/Apache require sit in a source-only file, `components/agent/LICENSES.txt`, and each adapted file has a one-line header pointing at it. The libraries are Tailwind and Base UI. Nothing was installed: everything was ported to plain CSS on Eaon's tokens (`styles/agent.css`), since the renderer has no Tailwind.

## What came from where
- **`StepCards.tsx`**
  - `EditCard` (`edit_file`/`write_file`): a bordered card with a 30 px header band ("Edited **store.ts** src/lib +12 −3", file icon), then `FileDiff bare` flush inside. It's clipped to 168 px with a fade and "Show more" (measured via `scrollHeight`, so short diffs get no button). Skipped or failed edits start folded.
  - `CommandCard` (`run_command`): "Ran npm, grep", then `$ command` and the output's tail, 84 px folded with the top fading only when it overflows (`data-overflow` set in a layout effect). A red `exit N` badge comes from the first output line. The header click expands the output.
- **`commandText.ts`** (pure, tested in `test/commandText.test.ts`)
  - `commandSummary` names the programs: it splits on `| || && ; \n`, skips env assignments and `sudo/env/time/nohup/exec/command`, drops `cd` unless it's alone, and keeps at most 4.
  - `splitCommandOutput` parses run_command's `exit code N` / `terminated (SIG)` first line and `(no output)`.
- **`Loaders.tsx`**
  - `Spinner`: arc on a faint ring, for a running call.
  - `PixelGrid`: 3×3 grid with a chevron wavefront, for the model working.
  - `LoadingState`: grid, shimmer label and a 0.1 s clock, for a reply with nothing yet; it replaced ThinkingOrb + "Thinking" in `MessageRow`.
  - `useElapsed` / `formatElapsed`.
- **`FileIcon.tsx`**: the TS/JS/JSON marks plus tinted lucide glyphs, and `splitPath`. Shared by the edit cards and `FilesChanged`.
- **`.step-shimmer`**: the transcript's sweep (text-3 → text → text-3, 250% wide, 1.4 s). The app-wide `.shimmer` in app.css is untouched.

## Decisions
- **"Waiting for approval" on the card.** The loop emits `tool-call` *before* asking (`runTool` in loop.ts), so a call stuck at the approval dialog used to read as "Running". `useAwaitingApproval` matches `pendingApproval`/`approvalQueue` by tool name and `JSON.stringify(input)`. `PendingApproval` has no tool-call id. Only Chat's approvals are visible to it; workers ask through their own card. The approval dialog itself (`ApprovalCard`, rebuilt the same day) was deliberately left alone. Inline Run/Skip buttons on the card were considered and not done, to avoid two sets of controls.
- **Panels open with `interpolate-size: allow-keywords` + `@starting-style { height: 0 }`** (`.tool__panel`, `.step-card__panel`, `.activity__list`). Contents still mount only when open (diffs are expensive), so a grid-rows transition, which needs the content mounted while closed, was not an option. Electron 43's Chromium supports both.
- The plan checklist (`TodoPanel`) and approval card were *not* replaced with the libraries' to-do/task-steps components; both are original designs built earlier that day.

## Gotchas
- **The app's own reduce-motion switch makes infinite animations strobe.** `body[data-reduce-motion='on'] *` sets `animation-duration: 0.001ms !important`, which turns a looping shimmer or spinner into a per-frame flicker rather than stopping it. Loops need an explicit `animation: none !important` under that selector (done for `.step-shimmer`, `.pixel-grid__cell`, `.spin-arc`), and the shimmer falls back to plain `--text-2`.
- **Shimmer through nested spans.** `background-clip: text` paints descendants' glyphs, but a child with its own `color` covers it. So `.step-shimmer *` is `color: inherit` (transparent while sweeping, text-2 under reduced motion). `.step-card__file` needs the more specific `.step-card__title.step-shimmer .step-card__file`, because its own rule comes later.
- **Seeding chats over CDP:** the preload API is `window.api.chats.apply(upserts, removed)`. There is no `chats.save` (older notes say there is). Open the chat by clicking its title in `.sidebar`.
- **Live Chat states without a model**, from the main inspector:
  1. Wrap `ipcMain._invokeHandlers.get('providers:list')` to return the first provider with `enabled: true, hasKey: true`.
  2. Replace `chat:stream` with a handler that stores `event.sender` and `request.messageId` and returns a promise kept referenced in a global.
  3. Reload, type into the composer's `textarea` (native value setter + `input` event) and dispatch Enter.
  4. Push `sender.send('chat:event', { messageId, type: 'reasoning' | 'delta' | 'tool-call' | 'tool-progress' | 'tool-result' | 'approval-request' | 'done', … })`.
  The rest of the recipe is in [[Driving the capture harness over CDP for scripted app states]] and [[Building a second copy of the app with electron-vite --outDir]].

Related: [[Agent transcript: activity lines and the files-changed card]], [[Reply action bar, plan checklist and approval card]]
