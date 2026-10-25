# Using your AI subscriptions in Eaon

Many people already pay for ChatGPT, GitHub Copilot, Google or Claude, and have that company's coding app installed. Eaon can use some of those plans, but only in the way each company allows other apps to. This page lists what works, how it works, and why Claude plans work differently.

Checked against each company's own pages in October 2026. The rules have changed several times this year.

## What Eaon does, and never does

For every app below, Eaon runs **your own installed copy**, signed in by you, through the mode its maker documents for editors and other apps. That app signs in and makes every request to its maker itself.

Eaon never does any of these:

- Read another app's sign-in or tokens, whether from its files or the system keychain. Eaon's agent can't read them either (`~/.codex/auth.json` and `~/.claude/.credentials.json` are blocked).
- Call ChatGPT's, GitHub's, Google's or Anthropic's services with your account itself.
- Make its requests look like they come from another app, through spoofed headers or user agents.
- Add its own system prompt to another company's agent. A turn carries only what you wrote, plus your own project instructions or a worker's role at the start of a conversation.

Apps that broke these rules lost their users' accounts. Google suspended accounts that used Gemini CLI's sign-in from other tools. Anthropic stopped other tools from using Claude plan sign-ins.

## What works

| Your plan | App Eaon uses | How | Where in Eaon |
|---|---|---|---|
| ChatGPT (Plus, Pro, Business…) | Codex (on its own, or inside the ChatGPT app) | Codex's app-server, the protocol OpenAI's own IDE extension uses | Model picker → Codex; Settings → Agent engines |
| GitHub Copilot | Copilot CLI (`npm install -g @github/copilot`) | Copilot CLI's ACP server, which GitHub documents for "custom frontends" | Model picker → GitHub Copilot; Settings → Agent engines |
| Google account | Gemini CLI (`npm install -g @google/gemini-cli`) | Gemini CLI's ACP mode. Gemini CLI is Google's reference ACP agent, built with Zed | Model picker → Gemini CLI; Settings → Agent engines |
| Claude (Pro, Max) | Claude Code | Not as a model in Eaon's chat (see below) | Connect apps → Your Claude plan; the ADE |

ACP is the [Agent Client Protocol](https://agentclientprotocol.com), the open protocol that editors such as Zed and JetBrains use to run coding agents.

**Claude models through Copilot.** Copilot plans that let you choose a model include Claude models (Sonnet, Opus, Haiku), along with GPT, Gemini, Grok and others. GitHub licenses them from their makers, so choosing a Claude model in the Copilot tab is an allowed way to use Claude in Eaon on a subscription. Some Copilot plans offer only Auto, where Copilot picks the model for each message; on those, the Copilot tab shows just Auto.

### How it works

1. Install the app and sign in once, the usual way (`codex login`, `copilot login`, or `gemini` and then "Log in with Google").
2. Eaon finds it on its own, at launch and every half hour, or when you press **Check again** in Settings → Agent engines.
3. Its models appear in the model picker under its own tab. Pick one, and Chat (or a worker) runs on that app from the next message.

To check whether you're signed in, Eaon opens a session and sees whether the app answers "authentication required". It does this once after launch, and again only when you ask or when the last check didn't find you signed in. Each such session leaves an empty folder in the app's own data. Copilot keeps these out of its session list.

Copilot's help lists every model it knows, not the ones your plan includes, and a model your plan lacks still runs, quietly, on Auto. So in that same session Eaon asks Copilot's own `/model` command about each model. Copilot answers these itself: nothing goes to a model, nothing counts against your plan, and nothing is added to your history. A plan that offers Auto only shows Auto in the Copilot tab. On other plans, models yours lacks are marked "Not on your plan", and a message sent on one says that Copilot picked the model.

Tool calls the app makes, such as running a command or editing a file, go through Eaon's approval setting, just as Eaon's own agent's do. Usage counts against your plan with that company, not against Eaon credits.

## Why Claude plans work differently

Anthropic's rules for Claude Pro and Max plans:

- Their [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/overview) say: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- Their [support page](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says subscribers themselves can use their plan with `claude -p`, the Agent SDK and third-party apps.

So a person may use their own plan that way, but an app like Eaon may not offer it as a feature without Anthropic's approval. Some apps run Claude Code behind their own chat on the user's plan anyway. Eaon doesn't, until Anthropic approves it.

What Eaon offers for a Claude plan instead:

- **Claude Code in the ADE.** The real, interactive Claude Code in a terminal, signed in with your plan. This is Claude Code, the app the plan is for.
- **Eaon's tools in Claude Code** (Settings → Connect apps → Your Claude plan). Your own Claude Code gets Eaon as an MCP server, so it can read your chats, message your workers, and use your models and the ADE. Claude Code stays the app you talk to.
- **Claude models through GitHub Copilot**, if you have Copilot.
- **An Anthropic API key** (Settings → Model providers → Anthropic), billed per use by Anthropic.

## For developers

- The engines are in `src/main/engines/`: `codex/` for Codex, and `acp/` for Copilot and Gemini CLI.
- An agent belongs in `acp/agents.ts` only when its maker documents ACP for other apps.
- Before adding one, check the maker's terms for apps that run their agent with the user's own sign-in, and link the page in the agent's `docs`.
