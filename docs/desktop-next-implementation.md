# Eaon Desktop 2026.6 — implementation record

Branch `eaon-2026.6`. The design notes are in project memory (`.eaonbrain/`,
start at "Eaon 2026.6 feature map"). This file records status and evidence.

## What the codebase is

- **Stack.** Electron + React + TypeScript, macOS and Windows. It replaced the
  SwiftUI and Tauri apps in 2026.5; those live on `main`, which is the old
  repo. Cross-platform means one Electron codebase with per-OS adapters
  (computer use, background mode), not three separate apps. Linux is not
  shipped.
- **Code tab.** Drives a real `eaon-code --mode rpc` process (JSONL over
  stdio) and does not copy Eaon Code's agent. It negotiates features from
  `get_state` and `get_commands`.
  - Eaon Code's newer `protocol`/`server` packages call themselves
    experimental, with no compatibility guarantee and no peer auth, so RPC
    stays the integration.
- **Already present before this pass.** Most of the brief was already built
  and tested in the 2026.6 branch:
  - Chat/Work/Code tabs, and Plan/Swarm/Goal.
  - 51 built-in providers; ChatGPT/Codex, Copilot and OpenRouter sign-in.
  - 67 plugins; the scheduler; the MV3 extension; computer use.
  - The model library and 14 themes.
  - Prompt caching, pruning, compaction and deferred plugin schemas.

## Changed in this pass

| Area | Change | Commit |
|---|---|---|
| Providers | A stream that closes before its terminal event is an error, not an answer. Chat-completions, Ollama and Anthropic are covered; a cut-off with nothing shown yet is retried. | a32d143 |
| Work loop | Refuses the same failing call after 3 identical failures. Dedupes unchanged re-reads. `goal_complete` is sent back once when the last change was never checked. | d1c3f22, f9521d8 |
| Goal | Time and token limits beside the iteration limit. Pause and limits apply between rounds. Pause reaches a running goal. | d1c3f22, f9521d8 |
| Scheduler | Opt-in background mode: macOS LaunchAgent, Windows login item + tray. Single-instance lock. "Launch at login" and "Prevent sleep" made real. | 2987900 |
| Code tab | Correct plan/swarm explainer (1.0.1 has no RPC toggle; sub-agents still work). Labels for Eaon Code's sub-agent tools. | 6912032 |
| Models | Refuse a download that would fill the disk (UI + main-process check). Refresh the re-published `qwen3.8:27b` digest. | b7e536c, and the commit with this file |
| Tests | Live E2E scenarios, a real-extension browser test, token budgets. | 09459d5 |

## Status per requirement

Legend: **V** = verified end to end on this Mac; **T** = automated tests;
**I** = implemented but not verifiable here (reason given).

| Requirement | Status | Evidence |
|---|---|---|
| Chat: web search only | V | Scenario A, qwen3.5:9b. Offered tools = `['web_search']`; it searched and cited URLs. |
| Work: act → observe → fix → verify | V | Scenario B: `run_command` → `edit_file` → `run_command`. We ran `node check.js` ourselves: PASS. |
| Work + browser | V | Real extension in Chrome for Testing (isolated profile), paired through its popup. Agent: navigate → snapshot → type → click → snapshot. The server received exactly one submission; the answer had the code. |
| Work + plugin | V (no-auth) | Scenario D: agent chose `deepwiki__read_wiki_contents` and answered from it. An authenticated plugin needs an account (see below). |
| Goal | V | Scenario E: check → edit → check → `goal_complete`; the check really passes and `check.js` is untouched. Loop tests cover continuation, limits, pause and the evidence rule. |
| Swarm | V | Scenario F: `spawn_agents`, 15 sub-agent events, lead summary covers all three modules. |
| Code tab over Eaon Code | V | Real 1.0.1 session in the UI: prompt, thinking, Edit with diff, Run, answer, Agent sub-agent card, "1 running agent". `eaon-code-live` passes on 1.0.1 and the older source build. |
| Code: plan/swarm toggles | I (upstream) | 1.0.1 has no `set_plan_mode`/`set_swarm_mode` over RPC. Pills are greyed with a correct explanation; sub-agents work regardless. Needs an Eaon Code PR. |
| Scheduled tasks after restart | V | Isolated profile, `--background`: 0 windows; task fired at slot + 26 ms. After quit, `launchctl bootstrap` of the written agent: the missed slot ran once, then the grid continued. Second launch handed over. |
| Plugins catalog | V | `node scripts/verify-plugins.mjs --no-register`: 67/67. 7 no-auth plugins connect and list tools; 60 sign-in plugins have valid discovery. |
| Local model IDs | V | `npm run verify:models`: 22 models / 48 variants resolve, with sizes and digests checked. One digest was refreshed: Ollama re-published `qwen3.8:27b`. MiniCPM5 2B (`openbmb/MiniCPM5-2B`), K2 Horizon 7B (`IFM/K2-Horizon-7B`) and Qwen3.8 27B (`Qwen/Qwen3.8-27B`) confirmed on Hugging Face. K2 Horizon still needs a llama.cpp PR (flagged unsupported). |
| Codex OAuth | I (account) | Client id, URLs, loopback callback, scope and originator match upstream Eaon Code exactly. Adapter tests cover the Codex backend. Sign-in needs a ChatGPT account. |
| Computer use | T | 21 tests (approvals, per-action confirm, stop). Not driven live: it would move this machine's mouse and needs Screen Recording + Accessibility grants. |
| Themes | T | AA contrast test per theme (light + dark). Unchanged in this pass. |
| Windows paths of background mode | I (OS) | Code paths written (login item, tray); no Windows machine here. |

## Token efficiency (measured, `test/token-budget.test.ts`)

Fixed overhead per request (system + tool schemas, ≈ chars / 3.6):

| Mode | Tokens | Tools |
|---|---|---|
| Chat | ≈297 | 1 |
| Work | ≈1,560 | 12 |
| Plan | ≈1,468 | 9 |
| Swarm | ≈1,991 | 13 |

Observation dedupe A/B (a 300-line file re-read unchanged): the final
request was ≈6,471 tokens with dedupe vs ≈11,120 without — **4,649 tokens
(42%) saved** on that request. The test asserts ceilings for all four modes
so a regression fails CI.

Live runs (qwen3.5:9b, input / output tokens):

| Scenario | Input | Output |
|---|---|---|
| A research | 1,587 | 476 |
| B fix | 13,584 | 665 |
| D plugin | 8,743 | 220 |
| E goal | 21,455 | 1,158 |
| F swarm, incl. sub-agents | 24,441 | 1,425 |

## Tests

```
npm run typecheck                                  # clean
npm run test:main                                  # 356 tests: 340 pass, 0 fail, 16 skipped (live, opt-in)
EAON_LIVE=1 EAON_LIVE_MODEL=qwen3.5:9b npm run test:main -- agent-live   # 4 + 5 scenarios, all pass
EAON_LIVE=1 npm run test:main -- browser-live      # pass
node scripts/verify-plugins.mjs --no-register      # 67/67
```

Baseline before this pass: 321 tests, 309 pass, 0 fail, 12 skipped.

## Known limits and gotchas

- **Eaon Code + Ollama** needs `OLLAMA_CONTEXT_LENGTH=32768` (or more).
  Ollama's OpenAI endpoint truncates to 4,096 tokens, which cuts off Eaon
  Code's tool list; every model then looks broken. Desktop's own Work mode is
  unaffected (native API with `num_ctx`).
- **`eaon-code-live`** is not behind `EAON_LIVE`: it runs whenever Ollama is
  up, and it timed out once while the GPU was busy with another live run.
- **Model catalog** is compiled in; not remotely updatable yet.
- **Provider capabilities** are per model (`tools`, `vision`, `reasoning`,
  `efforts`, `contextWindow`, `maxOutput`) plus per-vendor compat rules in
  `providers/compat.ts`. There is no single per-provider capability record.
- **Unwired settings.** "Show in menu bar" and "Bottom panel" (Settings →
  General) are saved but read by nothing. They need a product decision.

## Needs a person

1. **Authenticated plugin read.** Sign in to one plugin (e.g. Linear or
   Notion) in Plugins, then in Work ask it to list something.
2. **Codex sign-in.** Settings → Model providers → ChatGPT → Sign in; send a
   Work message on a Codex model; Sign out.
3. **Computer use.** Settings → Computer use → on, grant Screen Recording and
   Accessibility, then ask Work to open TextEdit and type a line.
4. **Windows.** Install the Windows build, turn on "Keep running in the
   background", close the window (tray icon stays), sign out and back in, and
   check a scheduled task runs.
5. **Chrome Web Store.** No longer needed: the extension was retired for
   Browser Use, which attaches through the browser's own remote debugging.
6. **Eaon Code plan/swarm over RPC** needs an upstream PR to
   eaonlabs/eaon-code (port of the old `rpc-session-modes.ts` onto 1.0.1).
