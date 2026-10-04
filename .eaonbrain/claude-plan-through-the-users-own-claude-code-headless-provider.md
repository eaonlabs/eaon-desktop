---
title: Claude plan through the user's own Claude Code (headless provider)
tags: [providers, oauth, policy, claude-code, eaon-desktop]
created: 2026-09-30T13:57:50.568Z
updated: 2026-10-03T15:27:37.065Z
---

**Removed on Sept 30, 2026. Do not rebuild this.** For about a day a "Claude (Claude Code)" provider (kind `claude-code`) answered Eaon's chats by spawning the user's own `claude -p` headless, using Claude Code's login. The co-founder pointed out that Anthropic's terms forbid it, and the provider was deleted: adapter, flow, catalog entry and tests.

## The policy, as quoted by the co-founder from Anthropic's docs
- OAuth (subscription login) "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, **or to route requests through Free, Pro, or Max plan credentials on behalf of their users**." Third parties also can't collect, store or intermediate Claude.ai tokens. **Agent SDK products must use API keys.**
- Allowed: signing in with your own subscription to the **unmodified Claude Code binary**, including when a platform hosts it.
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice." In other words, users could be banned.

Eaon spawning `claude -p` to answer *Eaon's* chats is routing Eaon's requests through the user's plan credentials. It is an Agent-SDK-style product built on a subscription login, even though Eaon never touched the token. The fact that the user ran it on their own machine doesn't change that.

## What Eaon does instead
- **The Anthropic provider is API-key only.** Its `noSignInReason` explains why. `ProviderMeta.planInAde: 'claude'` adds an "Open Claude Code in the ADE" button, which calls `openInAde('claude')` in `code/terminal/terminalStore.ts`: switch to the ADE and open a pane running `claude`.
- **The ADE terminal is the allowed route.** It runs the real, unmodified Claude Code interactively, and the user signs in with Claude Code's own `/login`. That is "hosting the unmodified binary". Eaon never reads its output as a model backend.
- **Don't build any variant** that feeds Eaon prompts to Claude Code and reads its answers back, whether through `-p`, the Agent SDK, stream-json or a PTY scraper.

Technical notes from the removed implementation, in case they matter again for an **API-key** integration: `claude -p --output-format stream-json --include-partial-messages` streams `stream_event` deltas and ends with a `result` event. `--bare` never reads OAuth.

Related: [[Provider OAuth landscape (Sept 2026): which sign-ins are allowed]], [[ADE terminal view: node-pty, xterm and the pane grid]]

Related: [[Eaon CLI session bus and the Claude Code bridge]]
