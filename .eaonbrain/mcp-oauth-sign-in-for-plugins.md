---
title: MCP OAuth sign-in for plugins
tags: [eaon-desktop, plugins, mcp, oauth, security]
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-29T14:29:38.114Z
---

# MCP OAuth sign-in for plugins

Browser sign-in for MCP servers lives in `src/main/mcpOAuth.ts` and is built on
the MCP SDK's `auth()` orchestrator (`@modelcontextprotocol/sdk/client/auth.js`),
not a hand-rolled flow. The app only supplies an `OAuthClientProvider`
(`McpOAuthProvider`): where state is stored, how the browser opens, and the
loopback listener the browser comes back to.

## Decisions and why

- **Two modes, one class.** The provider attached to every OAuth server's
  transport is *background*: it hands out stored tokens and lets the SDK
  refresh on a 401, but its `clientInformation()` throws
  `SignInRequiredError` when nothing is stored (so the SDK never runs Dynamic
  Client Registration on its own) and `redirectToAuthorization()` throws too
  (so a launch-time reconnect never pops a browser). The server then shows
  state `needs-auth` and the UI offers "Sign in". Only `signIn()` builds an
  *interactive* provider.
- **Fixed loopback port** `http://127.0.0.1:51849/callback`
  (`MCP_OAUTH_REDIRECT_URI`). Ephemeral ports would be nicer, but servers
  without DCR (Slack, Asana, HubSpot, PagerDuty, Box) need the exact URI typed
  into an app the user creates. The listener only runs while a sign-in is
  waiting and matches redirects by OAuth `state`; a wrong state gets a 400.
- **Storage**: one encrypted vault entry per server, `mcp-oauth:<serverId>`,
  holding client registration, tokens, discovery state and the `serverUrl` they
  were issued for. Tokens are ignored if the server's URL changes (custom
  servers can be edited or re-added under the same id). Reads are cached in
  memory because `secrets.get` decrypts the whole vault file and the transport
  asks for tokens on every request.
- **Registration is public-client + PKCE** (`token_endpoint_auth_method:
  none`), from `MCP_OAUTH_CLIENT_METADATA` in `src/shared/mcpCatalog.ts`. The
  verifier script registers with the same object, so a pass there proves the
  app's registration.
- **Manual clients need a secret.** Every vendor without DCR that we checked
  (Slack, Asana, HubSpot, PagerDuty, Box) lists only `client_secret_*` token
  auth, so the UI asks for client id *and* secret (`manualClientNeedsSecret`).
- A re-sign-in keeps the registered client (vendors would otherwise collect a
  new registration per sign-in) but drops tokens. Disconnect revokes (best
  effort) and drops tokens, keeping the client.
- Custom HTTP servers (Settings → MCP Servers) get the same background provider,
  so any server that answers 401 with OAuth metadata can be signed in to.

## Gotchas

- `McpServerStatus.state` gained `'needs-auth'` in `src/shared/types.ts`;
  `syncMcpServers` does not retry servers in that state (it would only repeat
  the 401).
- Tests drive the whole flow against a fake OAuth + MCP server
  (`test/mcpFixtures.ts`); the Electron stub's `shell.openExternal` calls
  `globalThis.__eaonOpenExternal` so a test can play the browser.

See also [[Plugin catalog verification]] and [[Skills loaded on demand]].

Related: [[MCP server lifecycle and SDK gotchas]]
