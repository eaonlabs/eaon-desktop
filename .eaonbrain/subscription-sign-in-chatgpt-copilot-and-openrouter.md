---
title: Subscription sign-in: ChatGPT, Copilot and OpenRouter
tags: [eaon-desktop, providers, oauth, codex, copilot, openrouter, security]
created: 2026-09-24T13:44:37.000Z
updated: 2026-09-30T13:36:43.478Z
---

# Subscription sign-in: ChatGPT, Copilot and OpenRouter

Flows live in `src/main/providers/oauth/{codex,copilot,openrouter}.ts`, register in
`oauth/flows.ts` (imported for its side effect by `providers/index.ts`), and are
driven from the renderer through `features/providerAuth.ts` +
`preload/features/providerAuth.ts` (`window.api.providerAuth`). Tokens live in the
encrypted vault under `oauth::<flowId>` and never reach the renderer. Claude Pro/Max
subscription sign-in is deliberately not implemented.

## Decisions and gotchas

- **ChatGPT (Codex)** mirrors Eaon Code exactly: client id
  `app_EMoamEEZ73f0CkXaXp7hrann`, PKCE S256, redirect **must** be
  `http://localhost:1455/auth/callback` (the only one that client id is registered
  for — so port 1455 busy, e.g. a Codex CLI login, is a hard error; the UI offers
  "paste the redirect URL" as the fallback). Requests go to
  `chatgpt.com/backend-api/codex/responses` with `chatgpt-account-id` (from the
  access token's `https://api.openai.com/auth` claim, falling back to the id token),
  `originator: pi`, `OpenAI-Beta: responses=experimental`, and the system prompt in
  `instructions`. No `max_output_tokens`.
- **Refresh tokens are single-use** (OpenAI rotates them). Two requests refreshing at
  once would spend the same token and sign the user out — every refresh goes through
  `singleFlight` in `oauth/shared.ts`.
- **Copilot tokens last ~30 minutes** but the loop resolves credentials once per
  turn. `adapterFor` wraps OAuth providers in `withFreshCredentials`, which
  re-resolves before every request and force-refreshes once on a 401.
- **Copilot's base URL comes from the token** (`proxy-ep=proxy.X` → `https://api.X`),
  it needs the VS Code editor headers (provider `headers`), and `X-Initiator`
  (`user` vs `agent`) decides premium-request billing — set per request by
  `adapters/router.ts`. Claude on Copilot goes over Messages with the token as a
  **bearer** (`authToken`), not `x-api-key`.
- **OpenRouter** "sign-in" mints an ordinary API key and stores it as the provider's
  key (auth stays `key`). The button only shows when no key exists, so it can never
  silently replace one.
- The device-code page is opened from the UI *after* the code is shown ("Copy code
  and open GitHub"); a plain authorization page opens immediately.

## Known limitation (not in this feature's files)

The renderer identifies the selected model by id alone (`settings.selectedModelId`,
`availableModels().find(m => m.id === …)` in `state/store.ts`). With ChatGPT,
Copilot and an OpenAI key all offering `gpt-5.5`, the first provider in list order
wins. Fixing it needs a provider-qualified model key in the store.

Related: [[Model provider quirks and where they live]], [[Eaon Desktop architecture]]

Related: [[Provider OAuth landscape (Sept 2026): which sign-ins are allowed]]

Related: [[Account sign-in: official ChatGPT, Hugging Face and Poe]]
