---
title: Email on the user's own domain through Cloudflare
tags: [eaon-desktop, email, cloudflare, integrations, gotchas]
created: 2026-10-01T14:03:46.668Z
updated: 2026-10-01T14:03:46.668Z
---

Since Oct 1 2026 the agent's email can run on the user's own domain and their own Cloudflare account, with no AgentMail. The co-founder asked for this ("custom domain… without having to use agentmail… make dns records and make it compatible with cloudflare… for the agents"). It is in Settings → Email → "My own domain, on Cloudflare", or under "Use your domain on Cloudflare" while AgentMail is connected.

**Labelled Beta** at the co-founder's request (Oct 1 2026): `BetaBadge` in `Email.tsx` reuses the shared `.badge` (as MCP Servers' "Experimental" does). It appears on the setup card, the address card, the "Use your domain on Cloudflare" row, the dialog title and the setup choice ("My own domain, on Cloudflare (Beta)"; that Select is 300 px wide so the label isn't cut). Take it off in all five places together.

## How it works
- **Sending:** Cloudflare Email Sending, `POST /accounts/{id}/email/sending/send`. The `from` is `{address, name}`; `to`, `cc`, `subject`, `text`, and `headers` (`In-Reply-To` and `References` are allowlisted, so replies thread). The REST call returns `{delivered, queued, permanent_bounces}` but **no Message-ID**. Email Sending entered public beta in April 2026. Sending to people outside the account needs **Workers Paid** ($5/month, 3,000 emails included, then $0.35 per 1,000). The domain must use Cloudflare DNS.
- **Receiving:** Email Routing, with one literal rule per address → the `eaon-mail` Worker (`MAIL_WORKER_SOURCE` in `src/main/features/email/cloudflare.ts`). The Worker only stores: the raw message goes into the `eaon-mail` KV namespace (bound as `MAIL`) under `m/<13-digit inverted ms>-<8 hex>`, so the newest sorts first. Metadata (KV allows at most 1024 bytes) is `{d:'in', r:<envelope rcpt>, f, t, s, at, z}`. Eaon reads it through the KV API and parses the MIME itself with `postal-mime`. The Worker has no fetch handler, and workers.dev is switched off for it.
- **Sent copies:** Eaon stores its own sent messages in the same KV (`d:'out'`, with a small RFC 822 body), so the agent sees both sides of a thread.
- **Read state:** kept in Eaon (`email.json` → `read`). `CloudflareMailClient.updateMessage` throws on purpose, so the service falls back to remembering it.

## Design
- **One client shape for both backends.** `CloudflareMailClient` has the same methods as `AgentMailClient`: inboxes are addresses, and the one domain is the configured one. `EmailService` takes either as a `MailClient`, so the daily cap, notifications, tools and approval rules are shared. `saved.provider` picks the client. Tokens are in the vault: `email:agentmail` and `email:cloudflare`.
- **Setup is idempotent.** `setUp` creates whatever is missing, in order: KV namespace, Worker upload, Email Routing, the sending domain, DNS records, rules. "Check again" runs it once more.
- **Existing mail is never taken over.** Before turning on Email Routing, `refuseForeignMx` refuses if the address domain has MX records that don't point at `*.mx.cloudflare.net`, and suggests `agents.<domain>`. Eaon never adds a second SPF or DMARC record next to the user's own. Any existing DMARC record counts as valid.
- **A missing permission is named.** `step()` turns a 403 or code 10000 into "the token needs the “X” permission". Token codes 1000, 6003, 6111, 9103, 9106, 9107 and 9109 mean the token itself is wrong.
- **Switching keeps AgentMail.** When the user moves from AgentMail to Cloudflare, the AgentMail key stays in the vault, and disconnecting Cloudflare goes back to it (`state.cloudflare.returnsToAgentMail`).
- **Workers' own addresses** (both providers). They live in `saved.workerInboxes`. Tools pass `ctx.request.workerId`, and `addressFor(workerId)` falls back to Eaon's address. On Cloudflare, removing an address deletes its routing rule; at AgentMail the inbox is only unmapped.

## Credentials: what gets pasted, and what Cloudflare says
The co-founder's first live try ended in "Cloudflare didn't accept the API token", a sentence that covered every failure. Cloudflare's answers, probed live with fake values (Oct 1 2026):
- **A well-formed token Cloudflare doesn't know** (deleted, rolled, expired, or a character lost): `/zones` → 403 `9109 "Invalid access token"`; `/user/tokens/verify` → 401 `1000 "Invalid API Token"`.
- **Anything not shaped like a token** (a legacy hex Global API Key, a 32-hex ID, a quote or zero-width character pasted along): 400 `6003 "Invalid request headers"` with `error_chain` `6111 "Invalid format for Authorization header"`.
- **A Global API Key with the wrong email** (X-Auth-Email/X-Auth-Key): 403 `9103`. **No credentials at all:** 403 `9106` + `9107`.
- **The same code means two things.** 9109 also reads "Unauthorized to access requested resource" for a *good* token without the permission, so only "Invalid…" means a bad token.
- **A 401 isn't a bad token either.** Seen on the co-founder's real account (Oct 1 2026): with a valid `cfut_` token, `GET /zones/{id}/email/sending/subdomains` answered **401 `2036 "Unauthorized"`** because Email Sending wasn't granted, while `email/routing/rules` answered 403 `10000 "Authentication error"`. The first version treated every 401 as "token not recognised", like AgentMail's 401. Hence `CloudflareError`, whose `keyRefused` is only `cloudflareError`'s verdict; `AgentMailError.keyRefused` is true for any 401.
- **Email Sending: Edit isn't offered until the account has Email Sending.** On the co-founder's account the dashboard offered only "Email Sending: Read", and even a read of `…/email/sending/subdomains` answered 401 2036. The docs' prerequisites are "an account with Email Sending enabled" plus a domain onboarded under Email Service → Email Sending, and the pricing page lists Email Sending as "Not available" on Workers Free. So sending is optional in setup: `checkPermissions` returns `{ sending }`, setup routes receiving anyway with `sendingTag: null`, and `state.cloudflare.canSend` is false. The page shows "Receiving only" with the steps (`SENDING_OFF`). `sendingInbox` refuses before any request, the tool guidance tells the agent it can't send, and "Check again" (`verifyDomain` → `setUp`) onboards sending once it's available.
- **Free sending to verified addresses, through the Worker.** Cloudflare: "you can send to verified destination addresses … through the REST API or the Workers binding, free of charge on any plan — including when only Email Routing is configured". The REST route needs Email Sending: Edit, which the account can't grant, so Eaon uses the Worker.
  - **Bindings and endpoint.** The Worker (MAIL_WORKER_VERSION 2) has `send_email` SEND and `secret_text` SECRET bindings, and a `fetch` handler that answers only `POST /send` with `Authorization: Bearer <SECRET>`; anything else gets a 404. It is reached on workers.dev at `https://eaon-mail.<account subdomain>.workers.dev`, from `GET /accounts/{id}/workers/subdomain` plus `POST …/scripts/eaon-mail/subdomain {enabled:true}`.
  - **The secret** is HMAC-SHA256(token, "eaon-mail-send"), so it needs no storage of its own and changes when the token does; setup re-uploads the Worker then.
  - **Sender format.** The binding takes the sender as `{ email, name }`; the REST API takes `{ address, name }`.
  - **Verified addresses.** Eaon lists and adds them through `/accounts/{id}/email/routing/addresses`, which needs the optional "Email Routing Addresses" permission. Without it, sends are attempted and the Worker's refusal is explained, and the UI points to the dashboard. `deliver` order: `tryEnableSending` first, then REST if `sendingTag`, else the Worker if `workerUrl`, else SENDING_OFF.
- **Email Sending is picked up on its own.** `tryEnableSending` runs before every send and on every background check. `EmailService.start()` re-uploads a Worker whose `workerVersion` is out of date (`upgradeWorker`), so existing setups gain the send route on the next launch.
- **Why the worker said "still unavailable" for hours.** On the co-founder's account (Oct 1), `sendingTag` was null and only "Check again" refreshed it. The tool guidance kept telling the worker "don't try to send", so it never did. Both are fixed by the two points above.
- **Permissions are checked before anything changes.** `checkPermissions` makes six reads (KV list, Workers scripts list, sending subdomains, routing settings, DNS list, routing rules) and lists every missing permission in one message. Before this, setup failed one step at a time, after it had already created the KV namespace and the Worker.

Formats (developers.cloudflare.com → Token formats):
- user tokens are `cfut_`, account tokens `cfat_`, and the Global API Key `cfk_`, each followed by 40 characters and an 8-hex checksum;
- the legacy forms still work: 40-character tokens and 37–45-character lowercase-hex Global API Keys.

`@shared/email` has `cleanCloudflareKey` (strips spaces, invisible characters, quotes, "Bearer" and "Authorization:") and `cloudflareKeyKind` (token / global-key / id / cut-short / unknown). The form reacts as you type; the service refuses an ID or a cut-short token before sending anything.

**The Global API Key path.** The key and the login email go to `CloudflareMailClient` as `globalKeyEmail`, sent as X-Auth headers. `createEmailToken(zone)` reads `GET /user/tokens/permission_groups`, matches the seven permissions by name ("Write" or "Edit", colon optional), and calls `POST /user/tokens`. The zone permissions are limited to `com.cloudflare.api.account.zone.<id>`, the account ones to `com.cloudflare.api.account.<id>`. Only the returned token is kept. `settle()` retries the new token for up to ~9 s, in case it takes a moment to work. **Unverified live:** that `/user/tokens` accepts the Global API Key (the docs only show a token with API Tokens Write), and the API's exact name for the Email Sending group. If either is wrong, the error says so and the user can make a token by hand.

## Token permissions
- **Zone:** Zone Read, DNS Edit, Zone Settings Edit (`/email/routing/dns` needs it, not "Email Routing Rules"), Email Routing Rules Edit.
- **Account:** Workers Scripts Edit, Workers KV Storage Edit, Email Sending Edit.

The template link (`dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{key,type}]&accountId=*&zoneId=all&name=`) pre-fills only the keys the docs confirm: `zone`, `dns`, `workers_scripts`, `workers_kv_storage`. The keys for Zone Settings, Email Routing Rules and Email Sending aren't documented, so the UI asks for those three by hand.

## Confirmed on the co-founder's account (read-only checks, Oct 1 2026)
- **Subdomains work through the API.** `POST /zones/{id}/email/routing/dns {name: "agents.<zone>"}` turns on Email Routing for the subdomain: MX records `route1–3.mx.cloudflare.net` appear at the subdomain with `meta.email_routing: true`, and the apex's iCloud MX is untouched.
- `GET …/email/routing/dns` lists names as the bare zone apex and content with a trailing dot (`route1.mx.cloudflare.net.`), which `sameRecord` already strips.
- KV namespaces and `GET /accounts/{id}/workers/scripts` are plain lists; the uploaded `eaon-mail` script shows `handlers: ["email"]`.

## Not verified against a live account (verify on first real use)
Everything was built from the API reference and tested against `test/cloudflareFake.ts`, which is shared by `test/email-cloudflare.test.ts` and the E2E run. Unconfirmed points:
- whether creating a sending subdomain via the API adds its DNS records itself. Eaon creates any missing ones from `GET …/sending/subdomains/{tag}/dns`, either way.
- whether names in that `/dns` list are relative or absolute (`absoluteName` handles both).
- the exact error Cloudflare returns without Workers Paid (Eaon adds the plan hint on a 403 or matching words).

Related: [[Agent email through AgentMail: backend, decisions and API gotchas]], [[A dev app whose main process is older than its page]].
