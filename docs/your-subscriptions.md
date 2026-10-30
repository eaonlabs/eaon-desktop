# Using your AI subscriptions in Eaon

Many people already pay for ChatGPT, GitHub Copilot, Google or Claude, and have that company's coding app installed. Eaon can use those plans, but only in the way each company allows other apps to. This page lists what works, how it works, and what is different about Claude plans.

Checked against each company's own pages in October 2026. The rules have changed several times this year.

## What Eaon does, and never does

For every app below, Eaon runs **your own installed copy**, signed in by you, through the mode its maker documents for editors and other apps. That app signs in and makes every request to its maker itself.

Eaon never does any of these:

- Read another app's sign-in or tokens, whether from its files or the system keychain. Eaon's agent can't read them either (`~/.codex/auth.json` and `~/.claude/.credentials.json` are blocked).
- Call ChatGPT's, GitHub's, Google's or Anthropic's services with your account itself.
- Make its requests look like they come from another app, through spoofed headers or user agents.
- Add its own system prompt to another company's agent. A turn carries only what you wrote, plus your own project instructions or a worker's role at the start of a conversation.

Apps that broke these rules lost their users' accounts. Google suspended accounts that used Gemini CLI's sign-in from other tools. Anthropic stopped other tools from using Claude plan sign-ins, which they had copied out of Claude Code.

## What works

| Your plan | App Eaon uses | How | Where in Eaon |
|---|---|---|---|
| ChatGPT (Plus, Pro, Business…) | Codex (on its own, or inside the ChatGPT app) | Codex's app-server, the protocol OpenAI's own IDE extension uses | Model picker → Codex; Settings → Agent engines |
| GitHub Copilot | Copilot CLI (`npm install -g @github/copilot`) | Copilot CLI's ACP server, which GitHub documents for "custom frontends" | Model picker → GitHub Copilot; Settings → Agent engines |
| Google account | Gemini CLI (`npm install -g @google/gemini-cli`) | Gemini CLI's ACP mode. Gemini CLI is Google's reference ACP agent, built with Zed | Model picker → Gemini CLI; Settings → Agent engines |
| Claude (Pro, Max) | Claude Code (`npm install -g @anthropic-ai/claude-code`) | Anthropic's [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), running your own Claude Code (see below) | Model picker → Claude Agent; Settings → Model providers → Claude Agent |

ACP is the [Agent Client Protocol](https://agentclientprotocol.com), the open protocol that editors such as Zed and JetBrains use to run coding agents.

**Claude models through Copilot.** Copilot plans that let you choose a model include Claude models (Sonnet, Opus, Haiku), along with GPT, Gemini, Grok and others. GitHub licenses them from their makers, so choosing a Claude model in the Copilot tab is an allowed way to use Claude in Eaon on a subscription. Some Copilot plans offer only Auto, where Copilot picks the model for each message; on those, the Copilot tab shows just Auto.

### How it works

1. Install the app and sign in once, the usual way (`codex login`, `claude auth login`, `copilot login`, or `gemini` and then "Log in with Google").
2. Eaon finds it on its own, at launch and every half hour, or when you press **Check again** in Settings → Agent engines.
3. Its models appear in the model picker under its own tab. Pick one, and Chat (or a worker) runs on that app from the next message.

To check whether you're signed in, Eaon opens a session and sees whether the app answers "authentication required". It does this once after launch, and again only when you ask or when the last check didn't find you signed in. Each such session leaves an empty folder in the app's own data. Copilot keeps these out of its session list.

Copilot's help lists every model it knows, not the ones your plan includes, and a model your plan lacks still runs, quietly, on Auto. So in that same session Eaon asks Copilot's own `/model` command about each model. Copilot answers these itself: nothing goes to a model, nothing counts against your plan, and nothing is added to your history. A plan that offers Auto only shows Auto in the Copilot tab. On other plans, models yours lacks are marked "Not on your plan", and a message sent on one says that Copilot picked the model.

Tool calls the app makes, such as running a command or editing a file, go through Eaon's approval setting, just as Eaon's own agent's do. Usage counts against your plan with that company, not against Eaon credits.

## Claude plans

Eaon runs your own Claude Code through Anthropic's Agent SDK, the library Anthropic publishes for running Claude Code from other apps. Claude Code signs in and makes every request itself, so a turn uses your Claude plan's limits.

There are two ways to use it:

- **Claude Agent** (Model picker → Claude Agent). Claude models running Eaon's own agent: Eaon's tools, approvals, memory, workers and history, the same as any other model in Eaon, so you can switch models mid-chat. Claude Code supplies only the model. Its built-in tools, its settings, CLAUDE.md files, hooks and memory are switched off for these sessions, and Eaon's tools are offered to it as an MCP server inside Eaon. Eaon's instructions follow Claude Code's own system prompt, with a note that it is running in Eaon.
- **The Claude engine** (Settings → Agent engines, and a worker's engine). Claude Code's own agent, with its own tools and your Claude Code settings, inside Eaon. Claude Code's system prompt is left as it is.

A conversation keeps one Claude session for as long as it and Eaon's history agree, so follow-ups reuse Claude's prompt cache. After an edit, a compaction or another model's turns, Claude starts a new session that opens with the conversation so far. The Local API Server never offers Claude Agent: a Claude plan is yours alone, not for other apps through Eaon.

Anthropic's rules, as of October 2026:

- Their [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) lets products run Claude Code when the binary is unmodified, its sign-in methods are left alone, and each user signs in with their own subscription or key. It also says the rules don't "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
- The same page forbids apps to offer their own Claude.ai login, or to "collect, store, or intermediate Claude.ai credentials or session tokens".
- Their [support page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits."
- Their [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview) still say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Anthropic hasn't approved Eaon under that line. The Claude engine keeps to the legal page's conditions below; whether that is enough is Anthropic's call, and they say they may enforce their rules without notice.

How Eaon keeps to those rules:

- It runs **your** `claude`, as Anthropic published it. Eaon ships no copy of Claude Code: the Agent SDK's bundled ones are left out of the app.
- Sign-in happens only in Claude Code's own flow, `claude auth login`, in your terminal. Eaon reads three things from `claude auth status`: whether you're signed in, whether it's a Claude account or a key, and the plan's name. It never reads your email, organization or tokens.
- Claude Code's own system prompt is used as is. Your project instructions or a worker's role open a new conversation as your words.
- It says who it is: every session names Eaon (`CLAUDE_AGENT_SDK_CLIENT_APP`), and is kept in Claude Code's own history, where `claude --resume` finds it.
- The name in menus is "Claude Agent", as Anthropic's branding rules for Agent SDK apps ask, never "Claude Code", and its logo is Anthropic's mark.

It never runs on anything Anthropic charges for. Claude Code gets no API key from Eaon's environment; a Claude Code signed in with a key (`claude auth login --console`) is refused before it starts; and if your plan's limit runs out with extra usage switched on, the turn stops at once and the next one waits for your plan to reset.

Tool calls Claude Code would ask about (editing files, running commands) go to Eaon's approval setting. A plan runs in Claude Code's own read-only plan mode.

Other ways to use Claude in Eaon:

- **Claude Code in the ADE.** The real, interactive Claude Code in a terminal, signed in with your plan.
- **Eaon's tools in Claude Code** (Settings → Connect apps → Your Claude plan). Your own Claude Code gets Eaon as an MCP server, so it can read your chats, message your workers, and use your models and the ADE. The Claude engine's sessions get them too.
- **Claude models through GitHub Copilot**, if you have Copilot.
- **An Anthropic API key** (Settings → Model providers → Anthropic), billed per use by Anthropic.

## For developers

- The engines are in `src/main/engines/`: `codex/` for Codex, `claude/` for Claude Code through the Agent SDK, and `acp/` for Copilot and Gemini CLI.
- Claude Agent, the provider, is in `src/main/providers/claudeAgent/`: `adapter.ts` keeps each conversation's session, `session.ts` runs Claude Code and holds each tool call for Eaon's loop, `tools.ts` is the MCP server, and `history.ts` decides when a session can go on.
- An agent belongs in `acp/agents.ts` only when its maker documents ACP for other apps.
- Before adding one, check the maker's terms for apps that run their agent with the user's own sign-in, and link the page in the agent's `docs`.
