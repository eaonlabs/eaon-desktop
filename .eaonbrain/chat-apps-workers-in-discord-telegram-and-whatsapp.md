---
title: Chat apps: Workers in Discord, Telegram and WhatsApp
tags: [eaon-desktop, workers, integrations, discord, security]
created: 2026-10-01T00:06:59.373Z
updated: 2026-10-01T00:06:59.373Z
---

# Chat apps: Workers in Discord, Telegram and WhatsApp

Settings → Integrations → **Chat apps** connects a worker to a Discord bot, a Telegram bot or a WhatsApp account. The user pairs their own account and then talks to and controls the worker from their phone; friends and groups they let in talk to it as **guests**. Built Sept 30 2026 on top of [[Eaon Workers engine: threads, heartbeats and mail]]. Not the same thing as [[Discord Rich Presence]] (the "Playing Eaon Desktop" card), which has its own Settings page; that page links to Chat apps.

## Where it lives
- `src/shared/channels.ts`: contract. A `ChannelLink` is one bot pointed at one worker. It holds the owner, people (`chat` or `control` level), allowed chats, pending requests, `guestAccess`, `groupReplies`, `forwardAlerts` and `whatsappMode`. Also `CHANNEL_COMMANDS` and `GUEST_ACCESS`.
- `src/main/features/channels/service.ts`: all policy (who may say what, pairing, `/allow` requests, commands, reply routing, typing, forwarding asks). Everything is injected, so `test/channels.test.ts` drives it with a `FakeConnector` and the real engine.
- Connectors (`channels/types.ts` `Connector`): `telegram.ts` (Bot API long polling), `discord.ts` (gateway on `ws` + REST, hand-rolled), `whatsapp.ts` (Baileys, linked device). `format.ts` handles Markdown → Telegram HTML and WhatsApp marks, chunking, `replyText`, `calledByName` and `parseCommand`. `tools.ts` provides `send_chat_message`.
- `features/channels.ts` registers it after `workersFeature` (it gets the engine from `workersService()`), stores links in `channels.json`, and puts tokens in the secrets vault as `channel:<id>`. A WhatsApp session is an encrypted folder `userData/channels/whatsapp-<id>`.
- Renderer: `settings/pages/ChatApps.tsx`, `channels/channelsStore.ts`, `channels/ChannelLogo.tsx` and `styles/channels.css`. On the worker profile, `WorkersView` shows a chip per app and a "Connect a chat app" menu item. `ChatView` draws a guest's mail with initials and an app badge, and the owner's mail with "From Telegram".

## Engine hooks it added
- `engine.receive(id, mail)`: chat-app mail. The owner's arrives as `from: 'user'` (gets priority, bypasses the hourly cap); a guest's as `from: 'guest'` with `mail.channel.cap`.
- `engine.observe({turnStarted, turnEnded, asked, notified})`: the service posts replies, shows typing and forwards asks/notify_user to the owner through this. Layered on top of `deps.reachOut`, not replacing it.
- `begin()` computes `guestCap(mail, worker.access)` (`workers/guests.ts`) and passes it to the runner. `engine.turnCap(id)` exposes it to tools. `userTriggered` (desktop notification) ignores chat-app mail, because the reply goes back to the chat.
- `RunOptions.toolGate` in `agent/loop.ts` refuses a tool call outright, before the mutating/unattended checks. Guest turns use it.

## Decisions and why
- **Guest limits are enforced in the loop, not only in the prompt.** The cap is the weakest of every guest message in the turn and the worker's own access, so the owner's mail batched with a guest's is held down too. `talk` (the default) is an allow-list: web_search, web_fetch to public hosts only (`isPrivateHost` blocks localhost, RFC1918, .local, bare names), set_status, ask_user, notify_user and send_chat_message.
- **Guests can never touch anything that outlives the turn**: set_heartbeat, add/remove_routine, set_goal, update_notes, message_worker and create_worker are refused on any guest turn below "Same as you". Otherwise a guest could plant instructions that a later full-access turn carries out, or mail an autonomous colleague. That escalation path is the main reason the gate exists.
- **Guests below "Same as you" can't use tools that see the user's logins or screen**: `web_browser` (the worker's own BetterWright browser, which keeps the user's logins), `browser` (the user's real Chrome through the extension) and `computer`. The loop's read-only policy doesn't cover them, because their screenshot, read and switch_tab actions count as "looking", and looking is exactly how a guest would read the user's accounts back out. This is the `PRIVATE` set in guests.ts. When a new tool can see signed-in pages or the screen, add it there.
- **send_chat_message on a guest turn** can only post to chats that had mail in the turn, and sends no files. Files must resolve (realpath) inside the worker's folder.
- **WhatsApp has no bot API for personal accounts or groups.** The Cloud API needs a public webhook and business verification, and its group support is limited. So it uses Baileys (unofficial; the account can be restricted), and the UI warns before linking. In `personal` mode the bot is the user's own number: it answers only when called by name ("Nova, …") or in "Message yourself", signs replies `*Nova:*`, and never replies to strangers (requests are recorded silently; the owner hears in their self chat). Messages older than 30 min at arrival are not answered.
- **Discord** asks for the privileged Message Content intent only when the application has it on (flags 1<<18 or 1<<19); otherwise identify would close with 4014. Without the intent, DMs and mentions still arrive in full, which is all "When called" needs. Replies send `allowed_mentions: {parse: []}`, so a worker never pings @everyone.
- **Telegram**: `/start <code>` pairs, which is why "Open in Telegram" links to `t.me/<bot>?start=<code>`. 409 Conflict means another poller or a webhook; it is reported and retried every 30 s, never fought over.
- Replies post `replyText(assistant)`, the text after the last non-bookkeeping tool call, so a worker that ends with set_status still has its answer posted. No auto-reply goes to a chat the worker already posted in with send_chat_message.

## Gotchas
- `npm install` in this repo needs `--legacy-peer-deps`: betterwright 2.8.8 declares an optional peer `electron >=43`, and the app is on 33.
- Baileys is pinned to the exact `7.0.0-rc14` (an RC that is the npm `latest` tag). It is ESM-only, loads fine in Electron 33's Node 20.18, and is imported lazily (`await import('baileys')`) so the app loads none of it without a WhatsApp link. Its WASM (whatsapp-rust-bridge) is inlined as base64 and none of its deps are native, so asar packaging needs nothing. The QR text it emits is a long `https://wa.me/…`-style string; the renderer draws it with `qrcode`'s `create()`, black on white in every theme.
- `calledByName("Hey Nova")` returns an empty string. Don't treat that as an empty message: keep the original text (this was a real bug).
- Live checks done: a real WhatsApp QR arrives about 2 s after creating the link, inside the built app. Telegram and Discord are covered against fake servers in `test/channels.test.ts`. Pairing a real bot still needs real tokens.
- To screenshot a second build, see [[Building a second copy of the app with electron-vite --outDir]].
