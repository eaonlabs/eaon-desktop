---
title: What Eaon Work still lacks to match Claude Code / Cursor
tags: [eaon-desktop, eaon-work, agentic-coding, gaps, audit, ui, providers]
created: 2026-08-30T01:12:47.602Z
updated: 2026-08-30T01:12:47.602Z
---

# What Eaon Work still lacks to match Claude Code / Cursor

Audit of the existing agentic machinery (see [[Eaon Work mode]] and
[[Codebase index and agentic coding tools]] for what *does* exist and why).
Those notes describe the design; this one records what was verified **missing**
when the whole path was read end to end, so a build plan does not have to
rediscover it.

The backend is real and complete: ten tools execute for real in the main
process (`localTools.ts:345 runLocalTool`), the loop runs for real in both
provider paths (`providers.ts:565` Anthropic, `providers.ts:638` OpenAI), and
approvals block the loop on a real promise (`providers.ts:365`). Nothing here
is a stub. The gaps are at the edges.

## 1. Tool context is lost between turns — the biggest one

`state/store.ts:407-416` builds the history sent to the model from
`m.parts.filter((p) => p.type === 'text')`. Tool calls and tool results live
only inside the `messages` array local to one `streamAnthropic` /
`streamOpenAICompatible` invocation; when that function returns they are gone.
The `↳ toolName` markers land in `reasoning` parts, which are filtered out too.

So on turn 2 the model cannot see that on turn 1 it read a file, made an edit,
or that a test failed. Each turn re-explores from zero. `ChatMessagePart` is
`'text' | 'reasoning'` only (`types.ts:37`) — there is nowhere to persist a
tool call, so this needs a schema change, not just a filter change.

## 2. No markdown or code-block rendering

`ChatView.tsx:339` is `<div className="msg--assistant">{body}</div>` — a raw
text node. No markdown dependency exists in `package.json` at all. A coding
agent's replies are mostly fenced code, and they currently render as flat
prose. The `.diff-preview` styles in `settings.css:224` are **not** a diff
viewer — they are a static mockup inside the Appearance theme picker
(`Appearance.tsx:264`), unrelated to agent edits.

## 3. No diff review, no live command output

`edit_file` returns `"Edited path (+3 lines)."` — the user never sees what
changed. `run_command` (`localTools.ts:159`) buffers stdout+stderr and resolves
only on `close`, so a two-minute test run shows nothing until it finishes.
Approval for `run_command` shows the command string but no output surface
afterwards. There is no terminal component anywhere in the renderer.

## 4. `planMode` is a pure no-op

`settings.planMode` is toggled in the composer's + menu
(`Composer.tsx:315-320`) and read **nowhere else** — grep finds only the
toggle, the type, and the default. It does not reach `StreamRequest`, the
system prompt, or tool gating.

Same story for `configuration.approvalPolicy` and `configuration.sandbox`
(`Configuration.tsx:61`) — Select controls persisted to disk and read by
nothing. `general.fullAccess` likewise. The *only* wired approval control is
`settings.approvalMode`, read at `providers.ts:534`.

## 5. `approvalMode: 'auto'` is unconditional trust

`providers.ts:534` is `isMutatingTool(name) && approvalMode === 'ask'`. The UI
promises "Only ask for actions detected as potentially unsafe"
(`Composer.tsx:373`) but there is no detection — `auto` never prompts, for
`rm -rf` as readily as for `npm test`. Either build the classifier or fix the
copy.

## 6. Latent bug: effort is sent to models that reject it

`inferEfforts()` (`providers.ts:46`) deliberately returns `undefined` for
4.5-era Sonnet/Haiku because "Effort is rejected on" them — but
`streamAnthropic` sends `output_config: { effort: … }` **unconditionally**
(`providers.ts:573`), with no check against the model's `efforts`.
`claude-haiku-4-5` ships in `BUILT_IN` with no `efforts` field, so selecting it
should 400. `thinking: {type:'adaptive'}` (`providers.ts:572`) is likewise
unconditional. Neither was exercised because Eaon Work is hidden and these are
on the shared chat path too.

## 7. Smaller things

- **No context-window management.** History grows unbounded; `max_tokens: 64000`
  is hardcoded (`providers.ts:569`). At 40 tool rounds with 20 KB tool outputs
  (`MAX_OUTPUT`, `localTools.ts:139`) a long session will overflow with no
  compaction, summarisation, or `contextWindow` check — even though
  `ModelInfo.contextWindow` exists and is populated.
- **No file watcher.** The index refreshes on app open (`store.ts:236`) and on
  folder pick; edits made outside the app go unnoticed until a manual rebuild.
  The agent's own `write_file`/`edit_file` do not invalidate it either.
- **`chat:stream` is one long-lived `invoke`.** Approvals already needed their
  own channel for this reason ([[Eaon Work mode]]); any future mid-stream
  interaction (plan approval, follow-up question) needs the same treatment.
- **Dead capture step.** `capture.ts:103` still clicks `.workspace__button`,
  deleted with the switcher — steps 27/28/28b/29/30 (workspace menu, Eaon Work
  home, pull requests) cannot run. See
  [[Eaon Work hidden and the workspace switcher removed]].
- **No tests.** `package.json` has `typecheck` but no test script; the
  verification described in [[Codebase index and agentic coding tools]] was done
  with throwaway esbuild harnesses that were not kept.

## Reachability right now

Everything above is invisible in a running build: `DEFAULT_WORKSPACES` is one
`kind: 'chat'` entry (`store.ts:59`), so `useIsWork()` is permanently false and
`cwd` is always null — which means `localToolsFor(null)` returns `[]` and
`maxToolRounds()` returns 8. The code is live and compiled, just unreachable.
