---
title: Local API Server: origin rules and never routing to itself
tags: [eaon-desktop, providers, security, gotcha]
created: 2026-09-29T14:28:54.742Z
updated: 2026-09-29T14:28:54.742Z
---

`src/main/localServer.ts` exposes the user's models (and so their API keys) as an OpenAI-compatible server on 127.0.0.1. Loopback binding keeps the network out but not a website open in the user's browser.

## Who may call it

Ollama's rules: requests with no `Origin` (CLIs, SDKs) pass; browser origins only if loopback http(s) or a desktop-app scheme (`app:`, `vscode-webview:`, `chrome-extension:`…); `Origin: null` is refused (any site can produce it). The `Host` header must be an IP literal, `localhost`, `*.localhost/.local/.internal` (Docker's `host.docker.internal`) or this machine's hostname — a public domain means DNS rebinding. CORS echoes the allowed origin; it used to send `Access-Control-Allow-Origin: *`, which let any page spend the user's keys.

## Never route to itself

**Jan's default port (1337) is also this server's default.** Local discovery copied every model this server offers into the "Jan" provider, Jan sorts before custom providers, and a request for one of those models was proxied back into the server forever. The port is registered with `setOwnServerPort` **before** `listen` (index.ts starts discovery in the same tick), and discovery, `refreshModels`, `/v1/models` and routing all skip `isOwnServerUrl`.

## Other behaviour

- A client hanging up aborts the run (`res` close without `writableFinished`); Stop Server calls `closeAllConnections()` so it doesn't wait on open streams.
- OpenAI content arrays are reduced to their text; `developer` counts as system.
- An out-of-range port throws from `listen` rather than emitting `error`; it is caught and reported.

Related: [[Model provider quirks and where they live]], [[Provider adapter gotchas: retry-after, image tokens and timeouts]].
