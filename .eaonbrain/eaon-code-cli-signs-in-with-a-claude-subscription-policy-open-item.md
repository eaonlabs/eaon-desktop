---
title: Eaon Code CLI signs in with a Claude subscription (policy open item)
tags: [eaon-code, anthropic, policy]
created: 2026-10-01T02:28:20.007Z
updated: 2026-10-01T02:28:20.007Z
---

# Eaon Code CLI signs in with a Claude subscription (policy open item)

Observed on Sept 30, 2026, while testing ADE restore ([[ADE panes come back after a quit: session watch, records, restore]]). On this machine, `eaon-code` 1.0.1 (`@eaonlabs/eaon-code`, a separate repo from Eaon Desktop) starts with:

> Warning: Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits.

Its status line shows `claude-haiku-4-5 … sub`. So the Eaon Code CLI can authenticate with a Claude.ai subscription.

Anthropic's policy, which the co-founder pasted and asked us to follow, says third-party products may not offer Claude.ai login or route requests through Free, Pro or Max credentials; the Agent SDK requires API keys. Eaon Desktop already complies: its Claude provider uses an API key, and a Claude plan is used only by running the unmodified Claude Code in the ADE (see [[Claude plan through the user's own Claude Code (headless provider)]]). **Eaon Code's own Anthropic sign-in has not been reviewed against that policy.** It is the remaining open item, and the fix belongs in the eaon-code repo, not here.
