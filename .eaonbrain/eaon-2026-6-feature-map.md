---
title: Eaon 2026.6 feature map
tags: [eaon-desktop, architecture, index]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-24T00:00:00.000Z
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
| Plugins (MCP) and skills | `mcp.ts`, `mcpOAuth.ts`, `features/skills.ts` | [[MCP OAuth sign-in for plugins]], [[Plugin catalog verification]], [[Skills loaded on demand]] |
| Scheduled tasks | `features/scheduler/` | [[Scheduled tasks engine and headless runs]] |
| Browser extension | `extension/`, `features/browser/` | [[Browser extension bridge]] |
| Computer use | `features/computer/` | [[Computer use tool design]] |
| Code tab | `features/eaonCode/`, `components/code/` | the eaon-code notes |
| Model library | `modelLibrary/`, `ModelsPage.tsx` | [[Local model hub (Models page)]] |
| Themes, pets | `lib/themes.ts`, `components/pets/` | theme and pets notes |

Each feature registers through `src/main/features/<x>.ts` (IPC) and
`src/preload/features/<x>.ts` (renderer bridge), so features grow without
editing `index.ts` or the shared `window.api` object.

Process lesson: parallel agents in git worktrees can start on the wrong
history — see [[Agent worktrees may start on the wrong history]].
