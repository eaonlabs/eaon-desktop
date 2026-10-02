---
title: Testing Eaon Code against Ollama needs a bigger context
tags: [eaon-code, ollama, testing, gotcha, code-tab, local-models]
created: 2026-09-28T01:16:24.973Z
updated: 2026-09-28T01:16:24.973Z
---

# Testing Eaon Code against Ollama needs a bigger context

Eaon Code 1.0.1 talks to Ollama over the OpenAI-compatible `/v1` endpoint, which cannot set `num_ctx`. Ollama then truncates to its default 4,096 tokens, but Eaon Code's system prompt plus tool schemas is ~8k tokens. The tool definitions get cut off, and every model looks broken:

- nemotron-3-nano:4b claimed "fixed, prints 5" with no tool call; the file was unchanged.
- gpt-oss:20b invented `repo_browser.*` tools.
- qwen3.5:9b said it could not edit files.

**Fix for testing:** start the server with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`. Then qwen3.5:9b does read → edit → bash and really fixes the file, and in the Code tab it also started a sub-agent.

Desktop's own Work mode is unaffected: its Ollama adapter uses native `/api/chat` with `num_ctx`.

## Other facts checked 2026-09-27
- Over RPC, 1.0.1 offers the model `read, bash, edit, write, Agent, SubagentWorkflow, get_subagent_result, steer_subagent`. Captured by pointing a provider at a recording server, not inferred. So sub-agents work in the Code tab even though the Swarm pill is greyed.
- Upstream 1.0.1 has **no** `set_plan_mode` / `set_swarm_mode`. Those lived only in the unzipped `~/Downloads/eaon-code-main` (0.85.x, not a git repo). `/plan` and `/swarm` exist only in the TUI. Porting is feasible: `enablePlanMode` = `toolsForPlanMode` + `setActiveToolsByName` + rebuild the mode prompt; swarm only rebuilds the prompt. It needs an upstream PR.
- Capture harness: a single step of 120 s silently ends the run; split long waits into 30 s steps.

Links: [[Code tab drives Eaon Code over RPC]], [[Plan and swarm over Eaon Code RPC]].
