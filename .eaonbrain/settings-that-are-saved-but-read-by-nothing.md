---
title: Settings that are saved but read by nothing
tags: [eaon-desktop, settings, product, gaps]
created: 2026-09-29T14:28:46.910Z
updated: 2026-09-29T14:28:46.910Z
---

Controls that persist a value no code reads, as found in the Sep 2026 bug pass. Each needs a product decision — wire it, hide it, or reword it — not a guess. Fixed ones are listed at the end so nobody re-audits them.

## Still dead

- **General:** Show in menu bar, Bottom panel, Default file open destination, Language. The Import button has no handler.
- **Configuration:** config scope, Approval policy, Sandbox, Output detail, Reasoning summary, Workspace dependencies. "Open config.toml" and "Reinstall" have no handler; "Diagnose" is a fake 1.2 s spinner; "Current version 26.819.11345" is hard-coded.
- **Keyboard shortcuts:** bindings are saved but never applied; menu accelerators in `index.ts` are hard-coded.
- **Browser:** Homepage; Search engine and Block trackers live only in localStorage.
- **MCP:** "Use a dedicated model for routing" and "Routing model". "Smart MCP tool routing" really means "defer plugin schemas past 12 tools" (see [[Token efficiency in the agent loop]]).
- **Claude Code integration** (Settings → Claude Code) points Claude Code at the Local API Server, which has no `/v1/messages` route and drops tools, so it cannot work as advertised; it also writes the deprecated `ANTHROPIC_SMALL_FAST_MODEL`.

## Made real in this pass

- `mcp.allowAllToolPermissions` — skips approval for plugin tools only; see [[Agent loop cancellation and tool robustness]].
- Earlier: Launch at login, Prevent sleep ([[Background mode: LaunchAgent, tray and single instance]]), plan mode and approval mode ([[What Eaon Work still lacks to match Claude Code / Cursor]]).

## Removed

- **Appearance → Dock icon** (Oct 1, 2026, at the user's request): the row, its `DockGlyph`, the `.dock-choice` styles and `appearance.dockIcon`. A stale `dockIcon` in an old settings.json is harmless; `merge` carries unknown keys and nothing reads it.
