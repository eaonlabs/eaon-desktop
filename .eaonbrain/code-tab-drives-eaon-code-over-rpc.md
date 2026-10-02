---
title: Code tab drives Eaon Code over RPC
tags: [eaon-desktop, code-tab, eaon-code, rpc, ipc, streaming, gotcha]
created: 2026-09-24T00:00:00.000Z
updated: 2026-09-29T14:29:36.566Z
---

# Code tab drives Eaon Code over RPC

The Code tab (workspace id `eaon-code`, kind `code`) is a front end for one
`eaon-code --mode rpc` child process. Main side: `src/main/features/eaonCode.ts`
(IPC, all channels `eaon-code:*`) over `features/eaonCode/` — `bridge.ts` (the
one process, start/stop/commands), `rpc.ts` (spawn, id-correlated requests),
`jsonl.ts`, `batch.ts`, `locate.ts`, `sessions.ts`, `env.ts`, `install.ts`,
`terminal.ts`, `recents.ts`. Renderer: its own zustand store
`components/code/codeStore.ts` and a pure reducer `components/code/transcript.ts`.

## Decisions and why

- **Strict JSONL, not `readline`.** readline also splits on U+2028/U+2029,
  which are legal inside JSON strings. `jsonl.ts` splits on `\n` only and uses
  a StringDecoder so a code point split across chunks survives.
- **One IPC message per frame.** `batch.ts` buffers 16ms, merges adjacent
  text/thinking/toolcall deltas for the same `contentIndex`, keeps only the
  newest `tool_execution_update` (its `partialResult` is cumulative), and strips
  `agent_end.messages` / `turn_end` payloads and the `system`-role message
  (1.0.1 emits the whole system prompt as a message). Order is never changed.
  Against Ollama the model streams slower than 16ms/token, so batches ≈ deltas
  there; the coalescing matters for fast providers.
- **Transcript blocks are indexed by `contentIndex`**, parallel to the
  message's content array. `message_start` may already carry partial content
  and `*_start` resets the block, so deltas never double. `message_end` is
  authoritative and replaces the blocks.
- **Sessions are listed from disk**, not over RPC (there is no list command).
  Path: `<agentDir>/sessions/--<realpath(cwd) with / → ->--/*.jsonl`. The agent
  dir comes from the *binary's* package.json `eaonConfig.configDir` — the
  published 1.0.1 uses `.eaon`, the source checkout still says `.pi` — or
  `EAON_CODE_CODING_AGENT_DIR`. realpath matters: `/tmp` is `/private/tmp`.
  A session file only exists after the first assistant reply.
- **Plan/swarm support is detected, not versioned**: a build that has the RPC
  commands reports `planMode`/`swarmMode` in `get_state`. Absent → the pills
  are greyed with "Update Eaon Code to use swarm and plan here". See
  [[Plan and swarm over Eaon Code RPC]].
- **Keys**: `settings.eaonCode.shareKeys` maps Eaon provider ids to Eaon Code's
  env names (`gemini`→`GEMINI_API_KEY`, `nvidia-nim`→`NVIDIA_API_KEY`…). An
  already-exported variable wins; Azure is skipped (needs more than a key).
  Only variable *names* reach the renderer.
- **Esc = `clear_queue` then `abort`**, restoring queued text into the
  composer — Eaon Code's documented interactive behaviour.
- "New session" in the shared Sidebar/CollapsedNav calls
  `useCode.getState().newSession()` when the kind is `code`.

## Gotchas

- An RPC `bash` command emits `bash_execution_update` events but **no message
  events**; the renderer creates the item itself and finalises it from the
  response. Responses (invoke replies) and events (send) travel on different
  IPC channels, so a late delta can arrive after the response — the reducer
  drops deltas for a finished bash item.
- Testing with Ollama: Ollama truncates prompts to its own `num_ctx`
  (4096 by default), which the OpenAI endpoint cannot change. Eaon Code 1.0.1's
  system prompt is ~8k tokens, so input shows as 4095 and gpt-oss can hit
  "Truncated response recovery failed" compaction errors. That is the
  environment, not the bridge.
- `test/eaon-code-live.test.ts` runs a real session per binary (PATH, plus the
  source build at `~/Downloads/eaon-code-main/.../dist/bundle/cli.js`) with a
  temp agent dir; `EAON_CODE_TEST_SKIP_PATH=1` limits it to the extra ones.
- Screenshots of a real session: seed `<userData>/store/settings.json` with
  `activeWorkspaceId: "eaon-code"` and `eaonCode.lastCwd`, and pass
  `EAON_CODE_CODING_AGENT_DIR` to electron so the child gets a models.json.

Related: [[Streaming performance: where the per-token cost lived]], [[Eaon Desktop architecture]]

Related: [[Eaon Code RPC: prompt, steer and Windows spawn gotchas]]
