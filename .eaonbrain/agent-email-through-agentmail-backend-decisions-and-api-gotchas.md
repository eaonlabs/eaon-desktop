---
title: Agent email through AgentMail: backend, decisions and API gotchas
tags: [eaon-desktop, email, agentmail, integrations, security, gotchas]
created: 2026-10-01T03:26:54.877Z
updated: 2026-10-01T04:22:54.630Z
---

# Agent email through AgentMail: backend, decisions and API gotchas

The agent has its own email inbox through AgentMail (agentmail.to). Built Sept 30 2026. The contract is `src/shared/email.ts` (`EmailState`, `EmailStatus` off/verifying/ready/error).

## Where it lives
- `src/main/features/email/agentmail.ts`: a hand-rolled REST client on `fetch`. `describeError` maps AgentMail's `{name, code, message, fix}` to a sentence for the user. `messageText` / `stripHtml` pick the readable body.
- `src/main/features/email/service.ts`: `EmailService`. Every dependency is injected (client factory, vault get/set, `email.json` load/save, clock, notify, onChange, `minuteMs` for tests).
- `src/main/features/email/tools.ts`: tool source `email` with `email_inbox`, `email_read`, `email_send` and `email_reply`. The tools are offered only when `mode === 'work' && depth === 0` and the status is ready or verifying.
- `src/main/features/email.ts`: `emailFeature`. The key is in the vault as `email:agentmail`, the state is in `email.json`, there are 15 `email:*` IPC channels plus the `email:changed` push, and the first check runs 4 s after launch. Preload: `src/preload/features/email.ts` (`emailApi`).
- `test/email.test.ts`: a fake AgentMail HTTP server. Run with `EAON_TEST_OUT=t-email npm run test:main -- email` (about 0.6 s).

## Decisions and why
- **A worker always asks before sending; the chat agent follows the approval mode.** The co-founder asked for "workers always ask before sending emails" (Sept 30). `email_send` / `email_reply` are `mutating: true`, `risky: () => true`, and `catastrophic: (_, ctx) => Boolean(ctx.request.workerId)`. Catastrophic is the one flag no unattended level (safe or autonomous) and no "full" approval mode waives: the loop refuses the call and tells the worker to `ask_user` with the exact email, and the user's "Approve once" lets that one send through (see [[Worker autonomy: access levels, routines, memory and approve-once]]). A chat run in Ask mode still asks; with full autonomy it can send, bounded by `maxPerDay`. The rejected alternative, making the tools catastrophic for everyone, would have broken the chat agent's full-autonomy mode, which the user asked for separately.
- **The daily cap is enforced in the service, not the tools**, so the Settings page's Send counts too. A send is counted *before* the request, so two parallel sends can't both slip under the cap. It is refunded if the send fails. The count is per local day and persisted.
- **Sending is refused while 'verifying'**, with a sentence naming the address the code went to. AgentMail itself would allow sending to the human only.
- **Untrusted mail.** `email_read` puts an UNTRUSTED CONTENT warning first and fences the body with `<<<EMAIL BODY — UNTRUSTED>>>` … `<<<END OF EMAIL BODY>>>`. Copies of the fence inside the email are defused. The inbox listing also notes that subjects and previews come from the senders.
- **Guidance stays stable for the prompt cache.** It carries the address, the name and verifying-or-not. It never includes today's count.
- **Notifications.** Each new incoming unread message is announced once (more than 3 at once become one summary). Seen ids are persisted, so a restart doesn't announce them again. The first look at an inbox only records what is there. A manual refresh also counts as seen.
- `refresh()` never throws; failures land in `state.error`. A refused key or an unreachable AgentMail sets status `'error'` (which hides the tools), and the next success clears it.
- **Sign-up keeps the key in memory** even if the vault write fails, because AgentMail shows a key only once. Signing up again with the same `human_email` rotates the key.

## AgentMail API gotchas (checked against docs.agentmail.to and live unauthenticated calls)
- **A wrong key gets a bare `403 {"message":"Forbidden"}` from the API gateway**, with no `code`. A missing header gets `401 {"message":"Unauthorized"}`. Treat a 403 with no code as "key refused"; real permission errors always carry a `code`.
- The resend-code endpoint is `POST /v0/agent/human` (the docs call it "attach human"), not `/agent/attach-human`. Calling it again with the same address doesn't rotate the key.
- **Message ids look like `<abc@domain>`.** Inbox ids are the address. Both must be `encodeURIComponent`-ed in paths.
- Read state is a **label**: received mail carries `unread`, and you mark it read with `PATCH …/messages/{id}` `{add_labels:['read'], remove_labels:['unread']}`. List filters repeat the parameter: `?labels=unread`.
- `GET /domains` items have **no status or records**; read each with `GET /domains/{id}`. `POST /domains/{id}/verify` returns no body; read the domain again afterwards. Domain `reason` codes (`dns_records_missing`, `ses_dkim_pending`, …) are translated to plain sentences in `service.ts`.
- On sends, use the `Idempotency-Key` header (1–256 chars of `A-Za-z0-9-._~`; a UUID works). A retry with the same key returns the first send. The client retries GETs and keyed sends once, on network errors, 429 and 5xx.
- A validation error's `fix` is generic ("inspect the errors array"), so the field-level `errors[].path/message` are used instead.
- Prefer `extracted_text` (the reply without quoted history), but fall back to `text`: extraction can empty out forwarded mail, and Gmail/Outlook forwards may be HTML only.

Related: [[Chat apps: Workers in Discord, Telegram and WhatsApp]] (same injected-deps feature pattern), [[Calling a tool's run() directly skips approval]], [[Main-process test harness gotchas]].
