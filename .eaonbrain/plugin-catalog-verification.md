---
title: Plugin catalog verification
tags: [eaon-desktop, plugins, mcp, catalog, testing]
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-23T00:00:00.000Z
---

# Plugin catalog verification

`src/shared/mcpCatalog.ts` only lists vendor-hosted MCP servers that were
checked live with `node scripts/verify-plugins.mjs`. Never add an entry on a
guess. The script:

- POSTs an anonymous MCP `initialize` and records status + `WWW-Authenticate`.
- Walks RFC 9728 → RFC 8414 discovery with the SDK's own functions, the
  same ones the app's sign-in uses.
- For OAuth entries with a `registration_endpoint`, really registers a client
  with `MCP_OAUTH_CLIENT_METADATA` and GETs the PKCE authorization URL. A pass
  means a login page or a redirect to one, not an `invalid_client` page. Some
  vendors return the OAuth error on a *200* page, so the body is scanned too.
- For `authMode: 'none'` entries it connects and lists tools.
- `--url <endpoint>` vets a candidate (mode inferred: anonymous 200 = none);
  `--no-register` skips DCR (each run creates a real client record at the
  vendor, which is harmless but adds up).

## Findings worth remembering (2026-09-23)

- Figma's remote server returns 403 on registration for clients outside its
  allowlist and has no manual route, so it was removed.
- Stack Overflow and Hex publish no OAuth metadata. Gamma rejects DCR.
  Smartsheet has no DCR and advertises no PKCE. Ahrefs' authorize page sits
  behind a bot challenge. Coda, Circleback and Pulumi had no endpoint. None of
  these were added.
- Atlassian and Intercom have no RFC 9728 document. The SDK falls back to the
  origin's RFC 8414 metadata, which works.
- Exa answers anonymous requests, so it moved from OAuth to `none` (one click).
- Most "pasted token" vendors (Stripe, Sentry, Linear, Supabase, Neon,
  Datadog…) now also offer DCR, so they could move to browser sign-in later.
- The anonymous "none" servers are also exercised by
  `test/pluginsLive.test.ts` through the real IPC (skipped offline or with
  `EAON_OFFLINE=1`).
- Vendors are occasionally slow (Trello timed out once), so the script retries
  the first probe once before calling an endpoint dead.

Logos: only Simple Icons (CC0) or vendor press-kit marks, stored as
single-colour SVGs and drawn through a CSS mask in `PluginLogo` so they follow
the theme. The old white `<img>` marks were invisible on the light theme.
Vendors without an official mark get a monogram.

See [[MCP OAuth sign-in for plugins]].
