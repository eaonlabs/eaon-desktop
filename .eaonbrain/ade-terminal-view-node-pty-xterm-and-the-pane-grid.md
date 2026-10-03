---
title: ADE terminal view: node-pty, xterm and the pane grid
tags: [eaon-desktop, ade, terminal, electron, gotchas]
created: 2026-09-30T13:36:18.344Z
updated: 2026-10-01T02:28:12.411Z
---

# ADE terminal view: node-pty, xterm and the pane grid

**Since Sept 30 2026 the ADE is terminals only.** The co-founder asked for "ADE only": the Agent view (Eaon Code driven over RPC, [[Code tab drives Eaon Code over RPC]]) was removed from the UI, along with Thread.tsx, CodeComposer.tsx, ToolRow.tsx, Onboarding.tsx and ExtensionDialog.tsx. `codeStore.ts` now holds just the folder, the recents and Eaon Code's install status. Opening a folder calls `eaon-code:use-folder`, which records it as recent and as `lastCwd` and **starts nothing**; before, every folder open spawned an Eaon Code RPC process. `transcript.ts` stays because tests use it, and the main-process RPC bridge still exists but nothing calls it. `settings.eaonCode.view` is gone. The sidebar shows New terminal (`openNewTerminal()`: a shell in the folder, asking for a folder if none is open), Pull requests, Models, Plugins, Settings, then the terminal list and folders. Eaon Code panes get Eaon's API keys when Settings → Eaon Code shares them: `TerminalSpawnRequest.agent` → `agentEnv()` in features/terminals.ts → `buildChildEnv`. Every sidebar and header button was clicked through CDP and works.

The view is a grid of real terminals in the project folder, each running a shell or a CLI agent (Eaon Code, Claude Code, Codex, Antigravity, OpenCode). Antigravity replaced Gemini CLI on Oct 2 2026; see [[Antigravity CLI (agy) in the ADE]]. Eaon Code panes run the installer's build as `node …/cli.js`; see [[Eaon Code installs from its install.sh, not npm]]. It was built to match a mockup the user supplied (panes named "Cynthia", "Andy"…), ported and slimmed down from the standalone Eaon ADE app (`~/Downloads/Eaon ADE/EaonADE`, its `pty-manager.ts` and `lib/terminals.ts`). It's also **the** sanctioned way to use a Claude plan in Eaon: the unmodified Claude Code, signed in with its own `/login` (see [[Claude plan through the user's own Claude Code (headless provider)]]).

## Layout

- Main: `features/terminals/ptyManager.ts` (shells), `features/terminals.ts` (IPC, agent detection on PATH via `onPath` in shellEnv.ts, layout in `ade-terminals.json`). Shared types and `gridColumns` are in `shared/terminals.ts`. Bridge: `window.api.terminals`.
- Renderer: `components/code/terminal/registry.ts` (xterm runtimes), `terminalStore.ts` (panes per folder, `openNewTerminal`, `openInAde`), `TerminalWorkspace.tsx` (grid, panes, empty state, "New terminal" menu), `styles/terminal.css`.

## Decisions carried over from Eaon ADE (learned the hard way there)

- **Shells live in main; terminals outlive React.** Each xterm sits in a detached wrapper that is re-parented into whichever pane shows it.
- **WebGL only for panes on screen.**
- **Clean environment.** Drop `CLAUDECODE`, `npm_*`, `ELECTRON_*`…; start a login shell with `-l`; set `LANG` when launched from the Dock.
- **Typing the agent command:** it is typed once the shell prints its first output (400 ms after), with a 2.5 s fallback.
- **Keys:** Shift+Enter sends `ESC CR`; ⌘←/→/⌫ send readline codes; other ⌘ chords go to the app.

## Gotchas found here

- **`posix_spawnp failed`**: npm unpacks node-pty's prebuilt `spawn-helper` without the execute bit; `scripts/fix-node-pty.mjs` (postinstall) fixes it. Packaged builds need `asarUnpack: node_modules/node-pty/**`.
- **Loading node-pty:** the main bundle is ESM, so node-pty is loaded lazily through `createRequire(import.meta.url)`.
- **Quit must reap the shells.** Otherwise node-pty's exit callback lands during V8 teardown and aborts the process. Feature `shutdown()` handles it.
- **Blank panes after a renderer reload:** main keeps about 512 KB of recent output per shell and replays it.
- **Dark strip at the bottom of a pane:** `.xterm-viewport` must be transparent.
- **Colours for xterm:** resolve theme colours to `#rrggbb` through a probe element plus a 1×1 canvas.
- **Header overlap:** the TopBar's sides now clip (`overflow: hidden`), and the right side uses `justify-content: safe flex-end`. The old ADE header's context meter used to overflow leftwards *under* the mode switch (the co-founder's screenshot).

Related: [[Chat, Workers and ADE: the three tabs and Chat as the agent]], [[Quitting: held before-quit, will-quit and app.exit]]

Related: [[ADE panes come back after a quit: session watch, records, restore]]
