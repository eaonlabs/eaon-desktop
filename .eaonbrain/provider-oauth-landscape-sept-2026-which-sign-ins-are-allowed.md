---
title: Provider OAuth landscape (Sept 2026): which sign-ins are allowed
tags: [providers, oauth, policy, research, eaon-desktop]
created: 2026-09-30T13:20:03.838Z
updated: 2026-09-30T13:58:02.192Z
---

# Provider OAuth landscape (Sept 2026): which sign-ins are allowed

Web research done 2026-09-30 for adding more "sign in with your account" flows next to
[[Subscription sign-in: ChatGPT, Copilot and OpenRouter]]. Policies change often, so
re-check the cited pages before building.

## Official and safe (the app registers its own client, or needs no client)
- **OpenAI "Sign in with ChatGPT" (SIWC) plan usage**, launched 2026-09-29. This is the
  sanctioned replacement for borrowing the Codex CLI client id. The flow is for open-source
  and locally hosted apps only; paid or hosted apps go through an interest form.
  - Register dynamically: `client_id=dynamic_agent_client` plus `agent_name_hint` and a
    persisted `ext_agent_host_id`. Save the issued `oaiapp_...` id and reuse it afterwards.
  - Authorize at `https://auth.openai.com/api/accounts/authorize` and exchange the code at
    `https://auth.openai.com/api/accounts/oauth/token` with `resource=https://api.openai.com/v1`.
  - Scopes: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`.
  - Redirect must be `http://127.0.0.1:<any port>/.../callback`.
  - Calls go to `api.openai.com/v1/responses` (Bearer) with `store:false` and `stream:true`.
  - List models with `GET /v1/models` and keep entries with `visibility=="list"`.
  - Docs: developers.openai.com/siwc/token-sharing-open-source/*
- **Hugging Face**: self-serve public app with no client secret, PKCE or device flow,
  scope `inference-api`. Calls go to `router.huggingface.co/v1`.
- **Poe**: self-serve at poe.com/api/clients. A PKCE flow mints an API key, the same pattern as
  OpenRouter. Calls go to `api.poe.com/v1`.
- **Cloudflare**: self-serve OAuth clients since 2026-06-03. Browser PKCE only (no device
  flow). Making a client public needs domain verification.
- **Azure / Foundry**: register your own Entra public client. Prefer PKCE on loopback over
  device code, because security defaults on new tenants block device code (since 2026-07-01).
- **Google Gemini API**: register your own Desktop OAuth client, PKCE on loopback, scope
  cloud-platform. The user's Cloud project is billed, not their AI Pro plan. There is no
  device flow for these scopes.

## Must not implement
- **Anthropic Pro/Max**: the legal page forbids third-party Claude.ai login and forbids
  storing Claude tokens. The only allowed route is running the unmodified Claude Code binary.
- **Gemini CLI and Antigravity OAuth**: explicitly banned in both sets of terms, with account
  suspensions in Feb 2026. Consumer Gemini CLI login ended on 2026-06-18.
- **Kimi**: rules against faking the client identifier. Its coding plan is API-key only for
  third parties.
- **Z.ai**: allowlist of permitted tools.
- **Qwen**: OAuth was shut down on 2026-04-15.

## Grey (only possible by borrowing a CLI's client id)
- **xAI**: Grok CLI client id, endorsed only for named partners.
- **MiniMax**: openclaw's client id.
- **Fireworks**: fireconnect's Cognito client, fixed port 18000.
- **Mistral Vibe**: undocumented sign-in that mints a key.
- **Codex CLI client id**: what we use today. SIWC now supersedes it.

## Gone or no OAuth
- **GitHub Models**: retired 2026-07-30.
- **Vercel**: Sign in with Vercel has no AI Gateway scope yet (private beta).
- **Ollama**: ed25519 key registration, not OAuth.
- **API key only**: Groq, Together, DeepSeek, Perplexity and Cerebras.

Related: [[Claude plan through the user's own Claude Code (headless provider)]]
