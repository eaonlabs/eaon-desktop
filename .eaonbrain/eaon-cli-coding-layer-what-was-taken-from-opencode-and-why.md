---
title: Eaon CLI coding layer: what was taken from opencode and why
tags: [eaon-cli, agentic-coding, lsp]
created: 2026-10-03T16:49:16.081Z
updated: 2026-10-03T16:56:24.250Z
---

The user asked for the CLI's Chat to be "as good as open code", with the UI showing "the code and … the files getting changed". The code lives in `cli/src/coding/` (`tools.ts`, `replace.ts`, `diff.ts`, `lsp.ts`, `snapshot.ts`, `instructions.ts`, `files.ts`) and `cli/src/tui/{diffview,diffviewer,highlight}.ts`. It sits on top of [[Eaon CLI: the desktop's main process in a terminal]].

## The app's tools are wrapped, not replaced
`installCodingTools()` (called from `runtime/boot.ts` after features register) uses `getToolSource('files')` and re-registers source `files`. Each tool keeps the original's `mutating`, `risky` and `catastrophic` flags and resolves paths with `resolveWorkPath`. The app's safety rules (credential folders, approval outside the work folder) therefore still apply unchanged. `getToolSource` in `src/main/agent/tools.ts` is the only app change. Rejected alternative: a separate CLI tool source with its own edit tools. That would have needed the safety rules copied, and two `edit_file`s offered to the model.

## Taken from opencode
- **Replacer chain** (`replace.ts`, attributed): exact, trimmed lines, block anchors (Levenshtein), whitespace, indentation, escapes, trimmed boundary, context and occurrences. It refuses a match much larger than old_text.
- **Shadow-git snapshots** (`snapshot.ts`):
  - A private git dir per project under `<cliHome>/snapshots/<sha1(root)>`, with `objects/info/alternates` pointing at the project's objects and the project's index copied in as a seed.
  - A turn is `track()` (add -A, write-tree) before and after, then `diff tree tree`. It catches changes made by shell commands too.
  - The project's own index and history are never touched.
  - Calls are serialised through a promise chain (`locked`), so a live mid-turn `track()` can't collide with the end-of-turn one on `index.lock`.
- **LSP feedback**: after edit/write, errors go back in the tool result as "LSP errors detected in this file, please fix:" plus a `<diagnostics>` block, errors only, at most 20.
- **AGENTS.md / CLAUDE.md / CONTEXT.md**: findUp to the git root, plus a global file. Sent as the request's `projectInstructions`.

## Improvements over opencode
- **Indentation.** When a non-exact matcher found the text at a line start, the new text is shifted to the file's indentation. opencode keeps new_text as sent. That once left gpt-oss:20b's one-line fix at column 0.
- **Live approval mode.** The agent loop reads `approvalMode` once per turn (`loop.ts`), so pressing `a` ("approve the rest") on an approval card used to keep asking for the rest of that turn. The CLI's `allowedNow()` in `core/chat.ts` now re-applies the loop's rule with the live setting. It looks the tool up with `toolsFor`, and still asks for risky calls in auto and catastrophic calls in full. The desktop app has the same once-per-turn read.
- **`/diff` and the sidebar mid-turn.** `currentChanges()` / `runningTurnChanges()` diff the turn's starting snapshot against a fresh one. Before this, `/diff` during a turn said "no changes".

## TypeScript 7 changed the LSP setup
Since TypeScript 7 (the native Go port, npm `typescript@7.x`, October 2026), the package has **no `lib/tsserver.js`**. typescript-language-server can't start against it. TS 7 has its own server, `tsc --lsp --stdio`. It offers **pull** diagnostics only (`diagnosticProvider`, `textDocument/diagnostic`): it never pushes them for .ts files. It also **lowercases file URIs** on macOS when it does publish.

So the launch is:
- If the project's `node_modules/typescript` has `tsserver.js`, use typescript-language-server with that tsserver.
- Otherwise, run `node <ts>/bin/tsc --lsp --stdio`.
- With no TypeScript in the project, `npm install typescript` into `<cliHome>/lsp` and apply the same rule.

The client asks (pull) when the server offers it and waits for publishDiagnostics otherwise. It compares URIs decoded and lowercased off Linux.

`diagnose()` races server start-up against 5 s, so a first-time install never holds an edit up; the server carries on starting in the background.

The real-server test is opt-in: `EAON_CLI_LSP_TEST=1 npm run test:main -- cli-coding`. It npm-installs servers. Note that the tools test sets `EAON_CLI_NO_LSP=1` for the rest of the file.

Related: [[Agent core: one loop, adapters and tool sources]]
