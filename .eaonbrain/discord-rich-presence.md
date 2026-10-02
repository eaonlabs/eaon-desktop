---
title: Discord Rich Presence
tags: [eaon-desktop, discord, integrations, electron, gotcha]
created: 2026-09-30T02:16:35.313Z
updated: 2026-10-01T00:07:10.834Z
---

# Discord Rich Presence

Settings → Integrations → **Discord** puts "Playing Eaon Desktop" on the user's Discord profile while Eaon's window is open: an animated Eaon logo, an animated status badge, what Eaon is doing, the elapsed time and a **Get Eaon Desktop** button to `https://eaon.dev/download#desktop`. Off by default (`settings.discord`).

## Where it lives
- `src/main/features/discord/rpc.ts` — a hand-rolled client for Discord's local IPC socket (`discord-ipc-0..9`: a Unix socket in `$TMPDIR` on macOS, `$XDG_RUNTIME_DIR` plus flatpak/snap subfolders on Linux, `\\?\pipe\` on Windows). Frames are an int32 LE opcode and an int32 LE length, then JSON. Handshake is op 0 `{v:1, client_id}`, Discord answers with a `DISPATCH`/`READY` frame, then `SET_ACTIVITY` goes as op 1 with a nonce, and PING must get a PONG. No npm dependency: the protocol is about 200 lines, and this app keeps its dependencies few.
- `src/main/features/discordPresence.ts` — owns the connection. Retries every 15 s while Discord isn't running, and every 5 min after Discord refuses the app. Holds updates to **one per 4 s** (Discord allows 5 per 20 s), coalescing to the latest. Dedupes identical activities. Clears the presence when the renderer that set it is destroyed.
- `src/renderer/src/components/discord/DiscordPresence.tsx` — mounted in `App.tsx`. It reads `useAppActivity()` from `components/discord/useAppActivity.ts` (thinking / working / asleep → thinking / working / away, everything else → ready), because the main window is the only place that knows what the app is doing. The hook was `usePetActivity` until pets were deleted ([[Pets — sprites, moods and the desktop window]]).
- `src/shared/discordPresence.ts` — the app id, URLs, and the card text shared by main and the settings preview. `discordPlace()` maps workspace kinds to card text and falls back to "In a chat" for a kind it doesn't know yet (the tabs changed mid-build: Chat / Workers / ADE).
- `test/discordPresence.test.ts` — a fake Discord on a real socket in a temp dir. It redirects `TMPDIR`/`XDG_RUNTIME_DIR` so a real Discord on the machine is never touched.

## Decisions and gotchas
- **Animated images only work as external URLs.** Art uploaded to the developer portal is static, and only PNG/JPEG/WebP are accepted there. GIF, animated WebP and AVIF animate only when `large_image`/`small_image` is an https URL. So the GIFs are served from `eaon.dev/img/discord/*-vN.gif` and bundled into the renderer for the preview. The renderer's CSP only allows `img-src 'self'`, so the preview cannot load the eaon.dev copies.
- **Discord's media proxy caches by URL.** To change the art, bump `VERSION` in `scripts/discord-art.py` and `DISCORD_ART_VERSION` together, then publish the new files. The script renders frames at 4× with PIL and encodes them with ffmpeg (single palette, bayer dither, `diff_mode=rectangle`). Keep the background static, or every pixel changes every frame and the GIF balloons. The loop starts on a frame where the mark is at rest, because some Discord views show only the first frame.
- `large_url` (a clickable image) is newer than the rest of the activity object. If Discord errors on an activity, the feature retries once without it.
- **The Discord application** is "Eaon Desktop", id `1554698208846938112` (`DISCORD_APP_ID`), and the app name is what follows "Playing". Rich Presence needs only that public id. The client secret and public key are never needed, and must not go in the app or this brain. "Eaon" and "Eaon ADE" are separate apps. Creating an app from Chrome ran into an hCaptcha and a signed-out Chrome profile, so the user created it by hand.
- **Verified live (Sep 2026).** Discord echoes the stored activity back from SET_ACTIVITY. External images come back as `mp:external/<hash>/https/eaon.dev/...`. `large_url` was accepted. `buttons` come back as labels only, with the URLs under `metadata.button_urls`. `media.discordapp.net/external/...` serves the GIF re-encoded but with all 160 frames, so it animates. To test live without the UI, bundle the feature with esbuild (`--alias:@shared=./src/shared --external:electron`), register it with a fake ctx, and log `setActivity` replies.
- `npm run dev` hot-reloads the renderer only. A change to main or `src/shared` (like the app id) needs the dev app restarted.
- Invalid app id: Discord sends an op 2 CLOSE frame `{code: 4000, message: 'Invalid Client ID'}` before hanging up. Handshaking with a bogus id against the real Discord is a safe way to check socket discovery without showing anything on a profile.
- Capture harness: a step that calls `location.reload()` never resolves, so the run hangs. Switch themes by clicking Appearance → Light instead. See [[Driving the capture harness over CDP for scripted app states]].
- Hosting the art: [[eaon.dev deploys: CI is broken, deploy with wrangler from a clean main]].

Related: [[Chat apps: Workers in Discord, Telegram and WhatsApp]]
