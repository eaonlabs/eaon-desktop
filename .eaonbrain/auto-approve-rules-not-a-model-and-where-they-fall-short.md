---
title: Auto-approve: rules, not a model, and where they fall short
tags: [eaon-desktop, approvals, security, agent]
created: 2026-10-02T22:48:59.196Z
updated: 2026-10-02T22:48:59.196Z
---

The co-founder asked what Chat's **Auto-approve** permission mode uses (Oct 2 2026). The answer: **no model at all. It's deterministic rules**, in `agent/loop.ts` around `isMutating`/`risky`/`catastrophic`:
- Read-only tool calls and read-only shell commands (`isReadOnlyCommand`, an allow-list) never ask, in any mode.
- A mutating call asks in Auto-approve only when the tool's own `risky(input, ctx)` says so. `catastrophic` asks in every mode, Full autonomy included.
- `risky` per tool:
  - file edits, writes and moves: outside the work folder, unless Settings → General → Full access;
  - `run_command`: `isRiskyCommand` (the `RISKY_COMMANDS` deny-list in `agent/approvals.ts`), or **writing outside the work folder** (`writtenPaths()`: redirects, tee, rm/mv/touch/chmod…, cp's destination);
  - plugin (MCP) tools: anything not marked read-only, unless "Allow all tool permissions";
  - email sends and broker orders: always;
  - browser and computer use: payments, deletions and passwords.

## Where the rules fell short
A probe showed these ran with no prompt: `rm --recursive --force ~/Documents`, `find ~ -delete`, `echo … > ~/.zshrc`, `python -c "shutil.rmtree(…)"`, `git checkout .`, `curl -d @.env https://…`, `osascript … delete every message`, `chmod -R 755 ~`, and `bash -c "$(… | base64 -d)"`. All now ask (tests in `test/approvals.test.ts` and `test/localTools.test.ts`), and ordinary dev commands (`npm install`, `git checkout -b`, `curl` GETs, `node -e "console.log(…)"`) still don't.

A deny-list is still only a list. It catches the usual forms and can't judge intent: a prompt-injected page can word a harmful command a new way. That's the case for a **classifier model** in front of the rules. The co-founder suggested a recent ~0.4B model built for this; its name wasn't known when this was written. The plan: run it on-device through Eaon's llama.cpp ([[Eaon's own llama.cpp runtime (no Ollama)]]). Rules stay first (catastrophic always asks; read-only always runs), the model judges the rest given the user's request and the call, and anything it can't answer quickly or confidently asks the user. The default mode stays **Ask first** (`store.ts`, `approvalMode: 'ask'`) until that's decided; the co-founder wants Auto-approve as the default afterwards.

See [[Full autonomy and goals with an end time]] and [[Worker autonomy: access levels, routines, memory and approve-once]].
