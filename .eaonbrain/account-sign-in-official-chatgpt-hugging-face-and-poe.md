---
title: Account sign-in: official ChatGPT, Hugging Face and Poe
tags: [eaon-desktop, providers, oauth, security]
created: 2026-09-30T13:36:29.505Z
updated: 2026-09-30T13:36:29.505Z
---

# Account sign-in: official ChatGPT, Hugging Face and Poe

Added Sept 30 2026 after the user asked for "sign in with your account" on every provider that allows it. Which ones allow it is in [[Provider OAuth landscape (Sept 2026): which sign-ins are allowed]]; the older flows are in [[Subscription sign-in: ChatGPT, Copilot and OpenRouter]].

## Official "Sign in with ChatGPT" (`oauth/siwc.ts`, provider `chatgpt`)

OpenAI's sanctioned route for open-source/local apps (developers.openai.com/siwc). No app registration: the first sign-in sends `client_id=dynamic_agent_client` + `agent_name_hint=Eaon` + a per-install `ext_agent_host_id` (`urn:uuid:…`, created once and kept across sign-outs); the redirect carries the issued `oaiapp_…` client id, which every later request uses. Redirect must be `http://127.0.0.1:<port>/callback` — so `startLoopback` now exposes the redirect's full query (`params()`).

- The ID token is verified (RS256 against the JWKS from the openid-configuration, issuer, audience = issued client, expiry, nonce) before anything is stored; a different account than the stored one is refused until sign-out.
- Access tokens last 1 h; refresh tokens **rotate every refresh** (`singleFlight`, keep the replacement). 4xx on refresh → signed out; network/5xx → retried.
- Requests: ordinary `api.openai.com/v1/responses`, vendor `chatgpt-plan` in the Responses adapter: system prompt in `instructions` (explicit system message items are refused), no `max_output_tokens`/`temperature`; function tools are fine (only hosted tools are unsupported). `/v1/models` returns `{models:[{slug, display_name, visibility}]}` → `parseChatGptPlanListing`, keeping `visibility: "list"`.
- A WebFetch summary of the "models and inference" page claimed `tools` and `instructions` were forbidden; the more precise "preview limitations" page contradicts it. Trust the latter.
- The old Codex-client flow stays as "ChatGPT (Codex)" so existing sign-ins keep working.
- curl against `auth.openai.com` gets a Cloudflare challenge (403), so the live flow can only be checked in a real browser; `test/provider-signin.test.ts` drives the protocol against faked endpoints and the real loopback.

## Registered-app flows (`oauth/appClients.ts`)

Hugging Face (public PKCE app, `inference-api` scope, token used directly and refreshed) and Poe (`apikey:create`, mints a key stored like OpenRouter's). Both only sign in apps that registered an OAuth client, so:

- `BUILT_IN_CLIENT_IDS` holds Eaon's own client ids — **empty until someone registers them** (HF: huggingface.co/settings/applications/new, no secret, redirect `http://127.0.0.1/callback`; Poe: poe.com/api/clients, localhost needs no registration). Until then a person pastes one in the provider's settings; it is stored in the vault as `oauth-client::<flow>`.
- Status carries `needsClientId` / `clientSetup` / `clientId`; the settings page shows the three setup steps instead of the button.
- Plumbing: `ProviderMeta.keyFlow` + `OAuthFlow.providesCredentials` (token used as a credential after any keys, in `credentialAttempts`; also makes `hasKey` true) + `ProviderMeta.accountSignIn` (render an Account section above the keys).

## No sign-in, on purpose

`ProviderMeta.noSignInReason` shows why for Anthropic (third-party Claude.ai login is forbidden), Gemini (Gemini CLI/Antigravity reuse gets accounts suspended) and the Kimi/Z.ai coding plans.
