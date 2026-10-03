---
title: Eaon Code installs from its install.sh, not npm
tags: [eaon-desktop, eaon-code, install, gotcha]
created: 2026-10-02T03:06:47.319Z
updated: 2026-10-02T03:06:47.319Z
---

Since Oct 2 2026, Settings → Eaon Code installs and updates Eaon Code with **its own installer** (`EAON_CODE_INSTALLER`, raw.githubusercontent.com/eaonlabs/eaon-code/main/install.sh), not `npm install -g @eaonlabs/eaon-code`. The co-founder said npm "no longer really works": the npm package lags (1.0.5 while main was 1.0.7). The page shows no version number, only **Install** or **Check for updates**, and the latter just reruns the installer.

## What the installer does
It clones (or `fetch --depth 1` + `reset --hard`) eaonlabs/eaon-code into `$EAON_CODE_PREFIX` (default `~/.local/share/eaon-code`), runs `npm install --ignore-scripts`, builds the packages the CLI needs, and writes `$EAON_CODE_BIN_DIR/eaon-code` (default `~/.local/bin`). That's a `sh` wrapper running `scripts/startup-update.mjs`. Last, it writes `.git/eaon-code-install.json` (`kind: "eaon-code-source-install"`). It needs node ≥22, npm, git and bash.

## Why Eaon never runs the wrapper
`startup-update.mjs` runs `git fetch` (up to 15 s) on **every start**, and if main moved it reruns install.sh **silently** (stdio ignored) before starting the CLI. In the ADE, restoring several Eaon Code panes would run several rebuilds in one folder at once, and an RPC start would hang for minutes. So the app starts the built CLI directly:
- `locate.ts`: `findInstallerCopy()` needs the marker and `packages/coding-agent/dist/bundle/cli.js`.
- `detectEaonCode()` order: the path set in Settings, then the installer's copy, then PATH (`eaon-code`/`pi`), then npm's global bin. The installer's copy beats PATH so an old npm copy doesn't shadow it.
- `EaonCodeStatus.launch = { command: node, args: [cli.js] }`. The bridge, `openInTerminal` and the ADE (`terminals.ts` `eaonCodeCommand`) all use it.
- The ADE recognises the pane's process by the script's **whole path** (`setAgentScript` in `agentSessions.ts`), since `cli` alone is too generic.

## install.ts
Downloads the script with `fetch`, writes it to a temp dir and runs `bash <file>`. On Windows it uses **Git for Windows' bash**, never `System32\bash.exe`, which is WSL and would install into Linux. One run at a time: a second call gets the same promise. `explainInstallFailure` uses the script's own `eaon-code: <reason>` line when there is one.

## Upstream bug found Oct 1 2026
eaonlabs/eaon-code main's install.sh failed: `packages/coding-agent` imports `@eaonlabs/eaon-mcp` and `@eaonlabs/eaon-codemode`, and the script never built `packages/mcp` or `packages/codemode` (TS2307). Adding `npm --prefix packages/mcp run build` and `npm --prefix packages/codemode run build` before the coding-agent build fixes it. Reported to the co-founder; it is the eaon-code repo's to fix.

## Testing
- `test/eaon-code.test.ts` uses a fake installer script.
- `test/eaon-code-install-live.test.ts` runs the real installer into temp dirs (`EAON_CODE_PREFIX`/`EAON_CODE_BIN_DIR`) when `EAON_CODE_LIVE_INSTALL=1`. It starts the result over RPC through the bridge, then runs the installer again. `EAON_CODE_LIVE_INSTALLER=<file>` uses a local install.sh, to try a fix before it's pushed. With the fixed script it passed in about 32 s.

Links: [[Code tab drives Eaon Code over RPC]], [[Eaon Code RPC: prompt, steer and Windows spawn gotchas]], [[ADE terminal view: node-pty, xterm and the pane grid]]
