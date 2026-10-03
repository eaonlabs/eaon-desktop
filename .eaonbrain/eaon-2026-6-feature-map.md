---
title: Eaon 2026.6 feature map
tags: [eaon-desktop, architecture, index]
created: 2026-09-24T00:00:00.000Z
updated: 2026-10-03T00:20:43.961Z
---

# Eaon 2026.6 feature map

Where each part of the 2026.6 release lives and which note explains it. Built
on branch `eaon-2026.6` (off `release/2026.5.0`, the Electron app — `main` is
the old Swift/Tauri repo; see [[The GitHub eaon-desktop repo is not this codebase]]).

| Area | Code | Note |
| --- | --- | --- |
| Agent loop, tools, modes | `src/main/agent/` | [[Agent core: one loop, adapters and tool sources]], [[Work modes: plan, goal and swarm]] |
| Token savings | `agent/context.ts`, adapters | [[Token efficiency in the agent loop]], [[Preserved thinking forbids editing earlier turns]] |
| Providers, sign-in, quirks | `src/main/providers/` | [[Model provider quirks and where they live]], [[Subscription sign-in: ChatGPT, Copilot and OpenRouter]] |
| Model catalog, effort levels | `providers/{catalogSources,modelCatalog}.ts`, `catalog.generated.json`, `shared/effort.ts` | [[Model catalog: generated from Pi and models.dev, with user overlays]], [[Effort levels: old ids, provider names and clamping]] |
| Plugins (MCP) and skills | `mcp.ts`, `mcpOAuth.ts`, `features/skills.ts` | [[MCP OAuth sign-in for plugins]], [[Plugin catalog verification]], [[Skills loaded on demand]] |
| Scheduled tasks | `features/scheduler/` | [[Scheduled tasks engine and headless runs]] |
| Browser extension | `extension/`, `features/browser/` | [[Browser extension bridge]] |
| Computer use | `features/computer/` | [[Computer use: how the computer tool sees and drives the screen]] |
| Code tab | `features/eaonCode/`, `components/code/` | [[Code tab drives Eaon Code over RPC]] |
| Model library | `modelLibrary/`, `ModelsPage.tsx` | [[Local model hub (Models page)]] |
| Themes | `lib/themes.ts` | [[Coloured themes, text fade and on-accent]] (pets were deleted: [[Pets — sprites, moods and the desktop window]]) |
| Loop guards, goal limits | `agent/guards.ts`, `loop.ts` | [[Loop guards: repeated failures, duplicate observations, goal evidence]] |
| Stream truncation | `providers/adapters/` | [[Truncated provider streams are errors]] |
| Background mode, single instance | `main/background.ts`, `index.ts` | [[Background mode: LaunchAgent, tray and single instance]] |
| Tabs, top bar, chat composer, Library, Open on launch | `TopBar.tsx`, `ModeSwitch.tsx`, `Composer.tsx`, `LibraryPage.tsx`, `store.ts` migration | [[Chat, Workers and ADE: the three tabs and Chat as the agent]] |
| Workers (always-on agents) | `features/workers/`, `shared/workers.ts`, `components/workers/` | [[Eaon Workers engine: threads, heartbeats and mail]], [[Worker faces: eyes-only animation and derived moods]] |
| ADE terminal view (pane grid) | `features/terminals/`, `components/code/terminal/` | [[ADE terminal view: node-pty, xterm and the pane grid]] |
| Account sign-in (ChatGPT official, Hugging Face, Poe) | `providers/oauth/{siwc,appClients}.ts` | [[Account sign-in: official ChatGPT, Hugging Face and Poe]] |
| Testing Eaon Code locally | `test/eaon-code-live.test.ts` | [[Testing Eaon Code against Ollama needs a bigger context]] |

Status, evidence and open items for the release: `docs/desktop-next-implementation.md`.

Each feature registers through `src/main/features/<x>.ts` (IPC) and
`src/preload/features/<x>.ts` (renderer bridge), so features grow without
editing `index.ts` or the shared `window.api` object.

Process lesson: parallel agents in git worktrees can start on the wrong
history — see [[Agent worktrees may start on the wrong history]].

Related: [[Agent loop cancellation and tool robustness]]

Related: [[MCP server lifecycle and SDK gotchas]]

Related: [[Quitting: held before-quit, will-quit and app.exit]]

Related: [[Settings that are saved but read by nothing]]

Related: [[Main-process test harness gotchas]]

Related: [[Discord Rich Presence]]

Related: [[Chat apps: Workers in Discord, Telegram and WhatsApp]]

Related: [[Trading desk and email settings: the UI over the trading and email backends]]

Related: [[Full autonomy and goals with an end time]]

Related: [[Chat agent's own browser and the live view]]

Related: [[Agentic trading backend: engine, brokers, sessions and guardrails]]

Related: [[Agent email through AgentMail: backend, decisions and API gotchas]]

Related: [[Step cards, loaders and the Cursor-style transcript]]
