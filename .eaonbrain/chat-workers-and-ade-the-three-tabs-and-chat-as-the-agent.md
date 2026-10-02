---
title: Chat, Workers and ADE: the three tabs and Chat as the agent
tags: [eaon-desktop, workers, sidebar, composer, layout, ui]
created: 2026-09-30T02:42:26.543Z
updated: 2026-09-30T02:42:26.543Z
---

# Chat, Workers and ADE: the three tabs and Chat as the agent

Built from the user's design spec (a Google Slides PDF, "Design Spec: Eaon Desktop", Sept 2026). It **reverses** [[Chat mode is the lean product: what got gated to Eaon Work]]: the lean-chat / separate-Work split is gone.

## What the spec asked for, and how it landed

- **Tabs are Chat · Workers · ADE.** Workspaces in `store.ts` `DEFAULT_WORKSPACES`: `work` (kind `chat`, now carries `cwd`), `workers` (kind `workers`, holds no chats — workers have their own store, see [[Eaon Workers engine: threads, heartbeats and mail]]), `eaon-code` (kind `code`, labelled ADE). `migrateWorkspaces()` folds the old Work workspace (id `code`) into Chat: its chats and projects are re-homed, its folder becomes Chat's, an install left on the Work tab opens on Chat. Test: `test/workspaces-migration.test.ts`.
- **Chat IS the agent.** The spec wanted chat simple for normal people *and* able to "do soooo much, like an agent". So `send()` sends `mode: 'work'` for the chat workspace (`isAgentKind`), and `useIsWork()` is now true in Chat. The old web-search-only `mode: 'chat'` is still used by scheduled "Answer" tasks and the Local API Server, but nothing in the UI sends it. The agent intro in `prompts.ts` became "You are Eaon, the user's assistant and an autonomous agent…" with a line that a plain question gets a plain answer.
- **Everything bloaty moved behind + in the composer** (`Composer.tsx`): attach, work folder, Goal / Plan / Swarm, Browser, Computer use, Plugins (submenu of toggles), Permissions (submenu). The approval chip, mode pills, project-folder bar and plugin tray are deleted. Anything switched ON shows as a removable chip in the toolbar (`ActiveChip`) — tucking controls away must never hide state that is in effect. The + menu uses `className="menu--tall"` (460 px cap) because the general 340 px `.menu` cap made it scroll.
- **Home** is "What can I help with?" + composer + four capability chips (Research, Organize files, Build an app, Use my browser). Five chips wrapped to two lines at the 640 px composer width.
- **Mode switch "at the top"**: `TopBar.tsx` is every screen's header — a 3-column grid (`1fr auto 1fr`) with `ModeSwitch` in the middle, so the switch sits at the true centre and long titles ellipsise instead of sliding under it. Absolute centring was rejected: at the 720 px minimum window width it collides with the left content. Padding is equal on both sides and on both row kinds (`.chat-header` / `.page__bar`) or the switch shifts a few px between screens; `code.css` used to add `margin-right: 4px` to it. Labels hide below 700 px via `@container main`. ⌘1/⌘2/⌘3 switch tabs (`GlobalKeys` in App.tsx).
- **Chat sidebar = the spec image**: New chat, Models, Library, Plugins, Settings; Projects; Recents. Scheduled moved to the Workers sidebar (things that run on their own), Pull requests to the ADE sidebar. Projects were a dead section ("No projects", no way to create one) — now create/edit/delete with instructions, and a project row expands to its chats (auto-opens when it contains the active chat).
- **Library** (`LibraryPage.tsx`, view `library`) is built from the transcripts: every user message's `attachments`. Main only answers `library:stat` (exists/size) and opens/reveals (`features/library.ts`; anything runnable is revealed, never opened). `eaon-file://` now also serves video. Attachments were previously sent to the model but **never shown in the thread** — `MessageRow` now draws them.
- **Open on launch** (`general.launchMode`: chat / workers / ade / last), applied in main by `store.applyLaunchMode()` right after the migration, before the window exists.
- **Fonts**: `--font-ui` is the ChatGPT stack (`ui-sans-serif, -apple-system, system-ui, 'Segoe UI', …`); the Inter / SF Mono / Georgia picker is gone and `palette.fontFamily` is ignored. Body letter-spacing reset to normal.
- **Recommended models**: MiniCPM5 2B, K2 Horizon 7B and Qwen3.8 27B (the catalog's `featured`) get their own "Recommended" section on Models. K2 Horizon stays `unsupported` — as of Sept 29 2026 the GGUF card still says llama.cpp support is an open PR (local Ollama is 0.34.4).

## Gotcha: the ADE home shares Chat's CSS classes

`code/CodeView.tsx`'s home uses `.suggestions`, `.suggestion-card` and `.project-bar` from `chat.css`. Restyling `.suggestions` into Chat's chip row and deleting the card and project-bar rules (once Chat stopped using them) broke the ADE home: cards unstyled, the folder bar overlapping the composer. The user reported it as "the layout is all messed up". Chat's chips now use `.home-chips`, and the card and project-bar rules are back, commented as the ADE's. Before deleting a rule that looks unused, grep `components/code/` too.

Related: [[Sidebar nav layout]], [[Worker faces: eyes-only animation and derived moods]]
