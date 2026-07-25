# Changelog

All notable changes to Eaon are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) — newest release on top.

## [Unreleased] — Mac app

### Added
- **Agent Swarm** — in Eaon Work, pick your model and then choose **Agent**
  or **Agent Swarm** from the pill beside the permission control. Instead of
  one model reasoning to itself, a *creator* convenes a roster of
  specialists chosen for your specific task (an engineer, a design
  specialist, a security reviewer — whoever the work actually calls for),
  they argue the approach out in rounds, and the discussion ends as soon as
  three of them vote to hand off. A *synthesizer* then reads the whole
  discussion and does the real work through the normal agent tool loop, so
  it writes actual files exactly like Agent does. The finished discussion is
  kept as a collapsible card on the reply, so you can read what they decided
  and why. Runs on whatever model you picked — hosted, BYOK, or a local
  Ollama model.

### Removed
- **The `/reasoning` debate panel and its Settings page.** Agent Swarm does
  the same thing properly: personas built for the task instead of a fixed
  panel of models, a real multi-round discussion instead of two fixed
  rounds, a vote to decide when it's done, and it works on any model rather
  than requiring a hosted account. Models' own chain-of-thought (the
  collapsible "thinking" section on a reply) is untouched — that's a
  separate feature and still works exactly as before.

## [Unreleased] — Windows/Linux app

### Added
- **17 typefaces in Settings → Appearance**, up from three — the same
  families the Mac app ships, so both apps now offer an identical font list.
  Sans-serif: Space Grotesk, Inter, Geist, IBM Plex Sans, Poppins,
  Montserrat, Raleway, Archivo, Barlow, and System. Monospaced: JetBrains
  Mono, Fira Code, Geist Mono, IBM Plex Mono, Source Code Pro, Inconsolata,
  and Space Mono. Every one is bundled with the app rather than downloaded,
  so they all render offline and identically on Windows and Linux; the list
  is grouped and searchable, and each row previews itself in its own face.
  Picking a monospaced face makes the whole app monospaced; picking a
  sans-serif leaves code in its own monospaced font, so choosing Montserrat
  never renders a diff proportionally.
- **Eaon CLI, reachable from Settings → Tools → Eaon CLI** — install the
  standalone `eaon` terminal command with one click ("Install Now"), no
  download or npm required (a ready-to-run copy ships inside the app).
  Installing automatically copies your saved Eaon API key and any BYOK
  providers into the CLI's own config, so it's usable the moment it's
  installed — no separate sign-in or manual key entry, with a "Sync now"
  button for after a key rotation. The Windows/Linux counterpart to the Mac
  app's own Eaon CLI manager, minus the embedded-terminal-specific bits that
  don't apply outside that app; a global `eaon` shim is written per platform
  (a batch file on Windows, a POSIX script on Linux).

## [2026.3.6] — 2026-07-24

### Added
- **Import chats from the cloud** (Mac; Settings → Cloud Sync). Sync only
  ever pushed before — a second machine could upload perfectly and still
  show nothing, because nothing ever came back down. There's now an explicit
  **Import now** button, and an automatic import that runs by itself once a
  day shortly after launch. It reports what it did ("Imported 3 new chats, 1
  updated") rather than finishing silently, and pages through results so an
  account with more than a hundred chats isn't quietly truncated.
  - An import can **add and update, never delete**. A chat here but not in
    the cloud is left alone: absence means either "deleted elsewhere" or
    "never uploaded", the two are indistinguishable, and losing a
    conversation to a sync heuristic is not a risk worth taking. A chat
    that's mid-reply is skipped entirely rather than swapped out underneath
    a live stream. Memories merge the same way — an import can only ever add
    to what Eaon knows about you.

### Fixed
- **Cloud sync's list requests failed with a 404** (Mac), which broke both
  importing and "Delete everything in the cloud". The query string was being
  appended to the path before `appendingPathComponent` escaped the `?` into
  `%3F`, producing a route that doesn't exist — and Appwrite's 404 reads like
  a missing table rather than a malformed URL.
- **…and then failed with a 400 once that was fixed**, because the query JSON
  was percent-encoded twice: `%7B` became `%257B`, so the server received the
  literal text `%7B` instead of `{`. Encoding now happens exactly once.

## [2026.3.5] — 2026-07-24

### Added
- **Cloud Sync — your chats on every machine, encrypted so the server can't
  read them** (Mac; Settings → Cloud Sync). Off by default and gated behind
  typing `turn on cloud sync`, because it's the one setting that changes
  where your data physically lives and a stray click shouldn't undo that.
  What actually leaves the Mac is ciphertext plus an anonymous id and a
  timestamp — never a title, a message, or a filename.
  - **A sync code instead of an account.** Eaon generates 20 characters,
    shown once. That code *is* your identity and your decryption key: no
    email, no password, no provider, nothing personal collected or stored.
    Enter the same code on another machine and your chats appear. Sloppy
    retyping is fine (case and spacing are forgiven); one wrong character
    reaches nothing at all.
  - **A real progress bar**, driven by real counts — "7 of 20 items
    uploaded", or "12 of 20 chats not yet uploaded" when idle. If a sync
    fails partway it keeps the count instead of resetting, because "it
    stopped at 7 of 20" tells you something and a blank bar doesn't.
  - **Delete everything in the cloud**, in its own section, worded so it's
    unmistakable that it erases the *server* copy and leaves the chats on
    this Mac alone. Deleting a chat locally now also removes its cloud copy,
    so a deleted conversation can't reappear on your next device.
  - Encryption is AES-256-GCM with the key wrapped under your sync code
    (PBKDF2-HMAC-SHA256, 600,000 iterations). Changing the code re-wraps one
    32-byte key rather than re-uploading everything. Your API keys and this
    Mac's own settings are never synced.

### Fixed
- **Replies no longer stop dead partway through** (both apps). A connection
  closed by a gateway mid-answer looks, at the socket, exactly like the
  model finishing — so a cut-off reply was presented as a complete one, or
  surfaced as "no response was generated" when the cut landed before the
  first token, or left a half-written file fence the agent then tried to act
  on. Eaon now detects that the provider never actually said it was done and
  quietly re-asks (up to twice, briefly) instead of surrendering. Only if
  every attempt is cut does it keep the partial and say so.
- **A dropped connection no longer erases the reply you already had** (Mac).
  The error message used to replace the whole bubble, so a drop two
  paragraphs in left you with a one-line error and nothing else. The text
  that arrived is real, and is now kept with a note about what interrupted
  it.
- **Chat mode stopped behaving like a coding agent** (both apps). Saying
  "hello" could return a pitch about writing code, and a follow-up "hi"
  could send a small model off inventing its own project and writing files
  for it. Chat mode had no general identity at all — the only thing it was
  told about itself was a 1,000-token coding-agent brief, sent on every
  message including a bare greeting, so with no real request in front of it
  the model simply ran the workflow it had been handed. Chat now has a
  short identity of its own, and the coding instructions are sent only when
  you're actually asking for something to be built. A greeting now costs
  about 100 tokens of instruction instead of 1,050.
- **Small models get a prompt they can actually hold** (both apps). The
  guard that trims the instruction stack for small models only ever applied
  to local ones with a parameter count in their name, so hosted small tiers
  (GPT-5 Nano, Mini, Haiku, Flash-Lite) took the full load, and local models
  whose id carries no size — `gemma3:latest`, `mistral`, `llama3.2`,
  `phi4-mini` — were treated as large. All of them are now recognised, while
  an explicit parameter count still wins so a 27B Gemma isn't mistaken for a
  small one.

## [2026.5.2] — 2026-07-24

*Windows/Linux app only.*

### Added
- **A live "Thinking" indicator with a travelling wave** — a pulsing accent
  orb beside the current status word, whose letters rise and fall in
  sequence (T, then h, then i…) so a wait always looks alive. It reports
  what's actually happening rather than one generic state: *Thinking* while
  the model works, *Responding* once the answer starts, and the real action
  during tool use — *Searching the web*, *Using GitHub*, *Running a
  command*, *Creating an image*, *Waiting for you* at a confirmation
  prompt.

### Fixed
- **Long waits no longer look like the app froze.** The old indicator lived
  inside the assistant bubble, but the agent loop deletes that bubble when a
  turn is nothing but tool calls — so the entire tool-execution window, very
  often the longest wait in a run, rendered nothing at all. The indicator
  now lives at thread level and covers every gap.
- **The wait now starts at Send**, not several steps later: the generation
  session opens before the model route is resolved and before attachments
  are rebuilt off disk, so the seconds those take are no longer dead air.
  Pressing stop during that window is honored instead of starting a stream
  anyway.
- **The animation no longer stutters while a local model is running.** It is
  pure CSS on `transform`/`opacity` only, so it animates on the compositor
  and keeps full frame rate even while Ollama has the main thread pinned —
  and the letters are memoized against the token stream, so a re-render
  can't restart their keyframes mid-cycle, which is what made it visibly
  glitch before. No JS timers, no layout-triggering properties.
- Reasoning models no longer show two stacked "Thinking" indicators — the
  chain-of-thought disclosure now reads *Reasoning* and offers the detail,
  while the status row carries the state.

## [2026.5.1] — 2026-07-22

*Windows/Linux app only.*

### Fixed
- **MCP catalog services now send their required extra headers** — GitHub's
  connection was silently dropping `X-MCP-Toolsets`, so it exposed its
  entire ~90-tool surface instead of the curated repos/issues/PRs set,
  flooding the model's context. Pinned by a wire-level test.
- **Custom MCP servers reconnect on launch** — enabled servers now come
  back by themselves at startup (same as catalog plugins), instead of
  sitting dead until manually reconnected from Settings.
- **The Plugins page no longer forgets connections** — leaving Settings and
  coming back showed "Connect" for custom servers that were still connected;
  connection state now lives in the shared store the whole app reads.
- **The Local API server survives a relaunch** — with the toggle left on,
  the listener now restarts on app launch (after the model list loads, so
  it serves everything); if the port has been taken meanwhile, the toggle
  turns itself off and says why instead of lying.
- **Image generation no longer dies on a half-filled provider card** — a
  connection missing its base URL or model id (e.g. a fresh "Custom"
  preset) is skipped, falling through to the next complete connection,
  Eaon's hosted image models, or Ollama; the card itself now says when and
  why it's being skipped.
- **Proxy misconfiguration is no longer silent** — an address Rust rejects
  used to leave traffic on the old route while the field showed the new
  one; Settings → Network now surfaces the parse error inline.

### Added
- **Test connection button in Settings → Network** — one real HTTPS request
  through the current route (proxy or direct) with latency on success and
  the actual failure text otherwise.
- The Settings close (X) button is gone; the sidebar and Esc do that job —
  sidebar navigation now correctly leaves Settings from anywhere.

## [2026.5.0] — 2026-07-21

### Added
- **Full Plugins parity for Windows/Linux** — the same 30-service,
  individually-verified MCP catalog the Mac app ships (GitHub, Stripe,
  Sentry, Cloudflare, PostHog, Semrush, Linear, Supabase, Render, Neon,
  Datadog, Resend, Notion, Vercel, LaunchDarkly, Slack, ClickUp, Trello,
  Airtable, monday.com, Asana, HubSpot, Intercom, Attio, GitLab, PagerDuty,
  DigitalOcean, Figma, Exa, Apify, Dropbox), reachable from Settings →
  Plugins, on top of the custom-server-by-URL support that was already
  there.
- **OAuth 2.1 sign-in for MCP plugins** — a from-scratch Rust port of the
  MCP authorization spec (2025-06-18): RFC 9728/8414 discovery, RFC 7591
  Dynamic Client Registration, PKCE (S256), and a loopback redirect
  listener, so services like Notion, Vercel, Figma, and Slack connect with
  a real browser sign-in instead of a pasted token. Falls back to a
  one-time manual client ID for the handful of services (Slack, Asana,
  HubSpot, PagerDuty, Dropbox) that don't support self-service client
  registration, exactly as the Mac app already handles them.

## [2026.4.0] — 2026-07-21

### Changed
- The Windows and Linux app has been rebuilt from scratch on a cleaner
  foundation — same Tauri (Rust core + web UI) approach as 2026.3.x, same
  data on disk (existing installs migrate in place, no lost chats or
  settings), but a reorganized codebase: no more 1,700-line files, every
  Settings page is its own component, and BYOK connections now support
  three wire formats instead of one.
- **BYOK providers can now speak Anthropic Messages and Google Gemini
  natively**, not just OpenAI-compatible — paste a Claude or Gemini key
  directly instead of routing it through a compatibility shim.
- The hosted service is addressed as "Eaon" everywhere in the app; no
  leftover "Aqua" labels remain in Settings, onboarding, or the model
  picker.
- The chat streaming layer, agent tool safety model, MCP client, and Local
  API Server all carry forward unchanged in behavior, each with unit/e2e
  test coverage (28 Rust tests).

### Added
- Free Week trial support in the Windows/Linux app (start it from
  onboarding or Settings → Providers → Eaon API), signed with the same
  per-device HMAC scheme as the Mac app.
- A hardware-aware Models library: RAM-based fit estimates (Fits well /
  Might be tight / Too big) before you download a local model, plus
  per-platform Ollama install guidance (winget on Windows, curl on Linux).
- An update-available card that points Windows/Linux users at the correct
  installer for their platform.

### Fixed
- Windows installers stay NSIS-only (MSI/WiX rejects the app's CalVer major
  version) — carried forward and documented in `eaon-tauri/BUILDING.md`
  alongside the full "how to build the Windows version" walkthrough.

## [2026.3.2] — 2026-07-19

### Added
- Free Week — 7 days of every hosted model, free, one click, no
  account, no card. Bound to this Mac (hardware fingerprint), so
  reinstalling the app recovers your existing trial instead of
  starting a new one. Start it from onboarding, Settings → Providers,
  or the new one-time popup nudge for installs that already dismissed
  onboarding before this existed.
- Settings → General → Gifts — a stable place to see and redeem what's
  currently available, showing the live claimed/remaining count and
  redemption deadline for the Free Week.
- Eaon CLI now tells you when the copy installed by a previous version
  of the app is out of date — a badge and Update button in the CLI
  hub, plus a status line in General. Updating re-copies the newer
  bundled build without touching your CLI config or sessions.

### Changed
- The bundled Eaon CLI now checks Eaon Desktop's own copy on launch
  and prints a one-line heads-up in the terminal when it's behind.

## [2026.3.1] — 2026-07-19

### Added
- One-click Eaon CLI install (Settings → General → Eaon CLI) — a
  ready-to-run copy now ships inside the Mac app; Install copies it to
  `~/.eaon/cli-app` and links a global `eaon` command, no npm or
  network needed.

## [2026.3.0] — 2026-07-18

### Added
- Eaon is now on Windows and Linux — a ground-up rebuild on Tauri (a
  Rust core with a web UI, the same cross-platform approach Jan.ai
  uses) that reaches real feature parity with the Mac app: Agent mode
  with the full coding toolset and the same safety model, Skills,
  Memory, MCP plugins (including local `npx`-style servers, which the
  Mac app doesn't support yet), image generation, live web search,
  attachments, per-model sampling parameters, a Local API Server, a
  network proxy setting, read-aloud, and first-run onboarding.
- Agent mode can now work inside an existing project instead of only
  building fresh ones — it can search your codebase by keyword/regex
  and find files by name before editing, and can pause mid-task to ask
  you a real clarifying question (clickable options or free text)
  instead of guessing.
- Eaon Code — a new mode with a real embedded terminal in the app, for
  driving the standalone Eaon CLI tool when it's installed; falls back
  to your normal shell otherwise.
- Quick Assistant — a small floating chat panel you can summon from the
  menu bar or a global hotkey without opening the main window, sharing
  your model, instructions, and settings. "Continue in Eaon" hands the
  conversation to the main app.
- Replies can now be read aloud — a speaker icon on any assistant
  message uses your Mac's built-in voices, no account or network
  needed.
- Settings → Network — an optional HTTP/HTTPS proxy for all of Eaon's
  outbound traffic, with a connection test.
- Settings → Model Parameters — temperature, top-p, max output tokens,
  and frequency/presence penalties, each opt-in per request; applies
  to any model, hosted or local.
- The "Thinking" and research-template items in the composer's "+"
  menu now actually work (previously silent no-ops) — Thinking toggles
  real extended reasoning on local Ollama models that support it, and
  the research templates insert a fillable prompt.
- Any chat can now generate an image mid-conversation without switching
  to a dedicated image model, using whichever image backend you have
  set up.
- More control over local llama.cpp models: a tunable context window
  (Compact/Balanced/Large/Huge, replacing llama.cpp's own default of
  the model's full trained context) and a Flash Attention switch,
  alongside the existing CPU/GPU mode.
- A live memory badge on loaded local models, with a one-click eject to
  free RAM immediately instead of waiting out the keep-alive timer.
- Hugging Face model browsing redesigned — each result is a card with
  a one-click default download plus an expandable list of every real
  quantization, each tagged Small/Balanced/Large with its own fit
  check; oversized downloads now ask for confirmation first.
- Settings → Memory → "Import from another AI" — paste a memory list
  copied from ChatGPT, Claude, or Gemini and Eaon parses and imports it
  locally, with a report of what was added versus skipped as a
  duplicate or junk.
- Your own messages can now be edited and resent — everything after
  that point is discarded and regenerated.
- A first-run onboarding flow — three skippable steps covering the
  app's modes and how to get started, running locally or with an API
  key.
- A real font picker — Settings → Appearance → Font, with 16 bundled
  typefaces plus anything already installed on your Mac, applied to
  both UI text and code.
- Up to three of your most recent conversations now appear as
  quick-open shortcuts on the empty chat screen.
- Starting a new chat or switching conversations no longer interrupts
  a reply still streaming elsewhere — each keeps generating in the
  background, marked by a small pulsing dot in the sidebar.
- Update downloads are now integrity-checked against a SHA-256 hash
  before installing, when the update manifest provides one.

### Changed
- Device Control is now a toggle inside Agent mode instead of a
  separate "Eaon Claw" mode — turn it on in Settings to give Agent the
  full file/app/browser/AppleScript toolkit. Same guardrails as before
  (asks first, Trash not delete, no sudo, no passwords or purchases).
- Image Studio is no longer a separate mode — image generation still
  works the same way, just through the model picker (and now
  mid-chat, see Added) instead of a dedicated tab.
- Settings is now a full page instead of a popup modal, reorganized
  into General/Appearance/Shortcuts, Assistant, Tools, and System
  groups.
- Memory now only surfaces facts relevant to what you're currently
  discussing (up to 10, relevance-ranked) instead of injecting
  everything it knows into every message; your last 30 days of
  activity still always rides along.
- If your accent color is set to "Default," it now spreads a 7-color
  palette across different areas of the UI instead of one flat color —
  pick any other color in Settings → Appearance if you'd rather keep a
  single flat accent. New installs default to a plain white accent
  instead.
- On-device toggle switches now render a fixed green in their "on"
  state everywhere, instead of following whatever accent color is
  selected.
- A few more leftover "Aqua" references renamed to "Eaon" across
  Settings and in-chat text.

### Fixed
- The regenerate button on a reply did nothing — it now actually
  discards the last reply and generates a new one.
- Photos added through the general "Add photos & files" picker weren't
  being sent as images — the model only ever saw a filename note, no
  thumbnail, unless you used the dedicated image picker. Now any
  picked file is sent as what it actually is.
- A DNS-rebinding vulnerability in the Local API Server that could let
  a malicious webpage reach it from your browser — closed wildcard
  CORS, added Host-header and Origin validation, and made the API key
  comparison constant-time.
- Small local models could take a long time to even start responding —
  llama.cpp was sizing its memory cache to the model's full trained
  context by default (often 128K–256K, sometimes multiple gigabytes)
  even for tiny models; now defaults to a much smaller, adjustable
  window.
- The app could stutter while a fast local model streamed a reply —
  text rendering and local server logs are now both batched to a
  smooth, fixed rate instead of updating as fast as tokens arrived.
- The traffic-light window buttons could silently drift out of
  position over time — they now continuously self-heal instead of
  only repositioning on specific window events.
- Toggle switches going nearly invisible when the accent color was set
  to white (the new default).

## [2026.2.0] — 2026-07-14

### Added
- MCP & Skill integration — connect any custom MCP server with a pasted
  token, and install a Skill Library from GitHub or your own local Claude
  Code skills. Invoke any enabled skill directly in chat with
  `/skill-name`.
- A rebuilt memory system — Eaon can learn from your conversations over
  time (with consent), remembering specific things you've shared instead
  of only static facts, and can learn from a file you pick or from a
  connected plugin's results.
- Live code streaming with syntax highlighting — watch code appear in
  color as the model writes it, and the chat no longer yanks you back to
  the bottom while you're scrolled up reading.
- A per-model CPU/GPU control for downloaded Hugging Face (llama.cpp)
  models — force CPU-only, force max GPU, or leave it on auto.

### Fixed
- Chat mode not actually writing code to disk when asked.
- The sidebar re-sorting your chats out of order just from clicking
  between them.
- Several Hugging Face model download/run issues: a hard crash on
  Gemma-family models, misleading "try a different quantization" advice
  when a model's whole architecture isn't supported, and a truncated
  error log that hid the real reason a model failed to load.
- Deleting a downloaded model reporting success without actually freeing
  disk space.
- A confusing "wait for models to load from the Aqua API" message
  appearing even when the real issue had nothing to do with Aqua.
- `pip`'s "externally-managed-environment" error when Eaon's agent tries
  to install a Python package.

## [2026.1.9] — 2026-07-13

### Added
- Eaon Claw — a one-click, on-device agent mode that controls this actual
  Mac (files, shell, apps, and the browser) to carry out real multi-step
  tasks, off until explicitly enabled with full disclosure of what it can
  do and its guardrails (asks first, Trash not delete, no sudo, no
  passwords/purchases).
- A 4-mode sidebar: Chat, Agent (sandboxed coding), Eaon Claw (on-device
  control), and Image Studio — each its own capability context, picked
  before a conversation starts via a segmented control you can tap or
  smoothly drag between modes, sitting right on the composer.
- Several new local models (Qwen3.6, Gemma4 26B, Llama4 Maverick, and
  more), plus a "NEW" badge in the model library so recently-added models
  stand out.

### Fixed
- Eaon Claw denying access to device/browser control on some local models
  (e.g. Nemotron) — it now leads with a clear statement of what it can do
  instead of a buried, easily-ignored instruction.
- Local models (Ollama/llama.cpp) sometimes showing Meta's logo instead
  of their real provider's — a matching bug caused by the internal
  `ollama:`/`llamacpp:` id prefixes both containing the substring "llama".
- Added a real Cerebras logo (was a generic fallback icon before).

## [2026.1.8] — 2026-07-12

### Added
- Image generation — use an image model over the API (Aqua's hosted
  models, or a BYOK cloud key) or a local one running on this Mac
  (Automatic1111-compatible servers like DrawThings/ComfyUI, or an
  Ollama-served diffusion model), with zero extra setup. Settings →
  Image Providers.
- A model attribution header (name + logo) on every reply, so it's always
  clear which model actually answered.
- Multi-step agent replies (a tool call followed by more text) now render
  as one continuous message instead of restarting the header and typing
  indicator for every step, with a live "what's happening right now"
  indicator between steps — including a subtle per-letter wave animation
  on the "Thinking…" text.
- A "Thinking" dropdown under any reply that used real reasoning
  (DeepSeek-R1, QwQ, and other reasoning models served locally through
  Ollama, or DeepSeek's own API) — click to see the model's actual
  chain-of-thought, collapsed by default instead of dumped as raw
  `<think>` tags into the reply.
- "Always allow tool calls" (Settings → Privacy, on by default) — code
  execution and connected-plugin (MCP) tool calls run without asking
  each time. Desktop Control still confirms every action regardless,
  since it can move the mouse and type on your behalf.
- Local API Server (Settings → Local API Server, off by default) — run a
  local, OpenAI-compatible server on this Mac that any external tool
  (a script, a coding CLI, another app) can point at, routed through
  whichever backend — Aqua, a BYOK key, or a local model — actually
  serves the requested model. Streaming and non-streaming both work.
  Bound to this Mac only; requires an API key by default.

### Fixed
- A stray rounded line could appear along the top of the sidebar, from a
  system titlebar decoration view rendering at the wrong size once the
  window's traffic-light controls were repositioned.
- A downloaded local image-generation model (e.g. from Ollama) failing
  with "does not support chat" now works — image models need a different
  endpoint than chat models, handled automatically.

## [2026.1.7] — 2026-07-11

### Added
- Plugins — connect real accounts (GitHub, Stripe, Cloudflare, PostHog,
  Semrush, Linear, Supabase, Render, Neon, Datadog, Resend, Sentry,
  Notion, Vercel, LaunchDarkly, Slack) and let the model call their tools
  directly on your behalf — create an issue, query analytics, check a
  deployment, and so on. Every call shows exactly what it's about to do
  and asks first. Uses native tool-calling where the model supports it,
  so it works the same reliable way ChatGPT/Claude's tool use does.
  Settings → Plugins.
- Computer Control (Beta) — ask Eaon to organize files, run shell
  commands, or open/close/navigate apps and websites on this Mac. Off by
  default. Every change asks first; deletions go to the Trash, never a
  permanent delete; there's no admin (sudo) access, no touching system
  files, and it will never enter passwords, buy anything, or change
  account settings. Settings → Computer Control.
- Settings → Hardware — live CPU, memory, and OS info for this Mac, the
  same numbers Eaon already checks before telling you whether a local
  model will actually fit.
- "Learn from your existing chats" — a one-click, on-demand pass that
  mines durable facts out of conversations you had before Memory was
  turned on, instead of only learning going forward. A separate
  "Automatically learn new facts" toggle lets you keep everything already
  remembered working while turning off the silent per-message learning
  specifically. Settings → Memory.
- Settings → General: an "Automatic Update Check" toggle (checks on
  startup and periodically while Eaon is open, not just once), and a Data
  Folder card showing exactly where downloaded local models and
  attachments live, with Show in Finder / Copy Path.
- Custom providers can now have their own logo — click the badge on any
  of your BYOK connections (Settings → Model Providers) to pick an image,
  for the common case where the closest built-in brand icon doesn't
  really look like what you connected.

### Fixed
- The app's on-disk data folder was still physically named "AquaChat"
  from before the rename — never user-visible until the new Data Folder
  card was about to display it. Migrated to "Eaon" automatically
  (renamed, not copied, so existing downloaded models aren't duplicated
  or orphaned).
- Gateway 5xx retries were too short to survive a real provider hiccup —
  three tries across roughly 1.5 seconds, observed to sometimes land
  entirely inside a several-second flap and surface a hard error the very
  next try would have cleared. Now five tries with backoff spanning about
  6 seconds. The model list fetch, which previously had no retry at all,
  is covered the same way.

### Changed
- The Privacy page's "Messages & attachments" description is now
  provider-neutral ("any API provider," not naming Aqua specifically).

## [2026.1.6] — 2026-07-10

### Added
- Live web search — models can now search the internet for time-sensitive
  or current information (news, prices, scores, recent releases, "as of
  today" facts) instead of answering from training data alone. Backed by
  [MIKLIUM](https://github.com/MIKLIUM-Team/MIKLIUM)'s free, keyless
  search API. Works automatically across every provider (Aqua, your own
  API key, and local models) via native tool-calling where the model
  supports it, with a fenced-text fallback (`eaon:search`) for models that
  don't. On by default; turn it off in Settings → Privacy, where the new
  "Web search" toggle also discloses exactly where those queries go.
- The model is now told the current date and time (from this Mac's clock),
  so "what's today?" / "what time is it?" are answered instantly and
  correctly instead of triggering a web search — a search can't reliably
  report the local wall-clock time anyway. This is also the anchor the
  model uses to judge what genuinely postdates its training and therefore
  actually warrants a search.

### Changed
- Sharpened the web-search guidance so models search only when a question
  really needs current, outside information — and skip it for things they
  already know, can reason out, or were just told (like the date/time).
  Verified live: a model that previously web-searched even for "what time
  is it" now answers that from context and reserves search for genuinely
  current questions.
- Gateway/server errors (HTTP 5xx, including the "API error (502)" some
  models intermittently return) now say plainly that it's the provider
  having a temporary problem with that specific model — not something on
  your end — and suggest switching models, rather than showing a bare
  status code with no way forward.

## [2026.1.5] — 2026-07-09

### Fixed
- The traffic-light buttons (close/minimize/zoom) only responded to
  clicks and hover right at their very edge. Cause: they're nudged down
  to sit on the sidebar's header row, but their containing titlebar strip
  stayed its factory height — the moved buttons were still fully
  *visible* outside it, but hover/click only register on the part still
  inside the parent, leaving a ~1pt sliver as the only live area. The
  titlebar strip now resizes along with the buttons.
- The Models tab could show a large empty region on a wide window, with
  the actual list pinned to the left edge. The list's content is
  intentionally capped at 720pt so rows don't stretch absurdly wide, but
  the container holding it filled the whole window and top-left-aligned
  everything instead of centering the capped block. Now centered.

## [2026.1.4] — 2026-07-08

### Fixed
- The model picker's blank-gaps-while-scrolling bug, for real this time.
  2026.1.3's fix deduplicated Aqua's own catalog, but the actual trigger
  was the same model id arriving from two different sources at once —
  e.g. a custom (BYOK) gateway serving `deepseek-v4-flash` while Aqua's
  catalog also lists it. Both copies land in the same picker section
  (everything routes by bare model id), and duplicate ids inside one
  list corrupt SwiftUI's scroll layout. The merged all-sources list is
  now deduplicated at the point where Aqua, custom-provider, and local
  models are combined, keeping the copy with the proper display name —
  so the row also reads "DeepSeek V4 Flash" instead of the raw id.

## [2026.1.3] — 2026-07-08

### Fixed
- The model picker could show large blank gaps while scrolling, hiding
  models below the fold. Cause: the live model catalog occasionally
  listed the same model twice (once with a proper display name, once
  without) — SwiftUI's model list requires unique ids per row, and a
  duplicate silently breaks its scroll layout instead of just showing
  twice. Deduplicated before the list ever reaches the UI, preferring
  whichever copy has a real name.
- Three buttons (Update Now, and Save/Add in Custom Instructions and
  Memory) hardcoded white text on their accent-colored fill — invisible
  for anyone using the "white" accent option, since that's white text on
  a white button. Now uses the accent-aware foreground the app already
  had a helper for (`AppearanceSettings.onAccentColor`), which just
  hadn't been wired into these three.

### Changed
- Aqua is no longer a permanent fixture in Settings → Model Providers on
  a fresh install — it now shows as an "Add Aqua" entry point, same
  discoverability as adding a custom provider, and only earns a
  permanent row once a key is actually saved.
- The update card now has an explicit close (×) button — separate from
  "Update Now" — so declining is never ambiguous. Closing it (or
  clicking × without picking Update Now) never installs anything; you
  can always check again later from Settings → General → Check for
  Updates. Updates have never installed without an explicit "Update Now"
  click — this just makes the "no" path as obvious as the "yes" path.

## [2026.1.2] — 2026-07-08

### Added
- Memory — Eaon can quietly remember durable facts you share (name, role,
  ongoing projects, preferences) and bring them into future chats. Off by
  default; reviewable and editable any time in Settings → Memory.
- Real vision support — attached/pasted images are now actually sent to
  models that support it (verified via `ModelCatalog.supportsVision`), as
  a proper multi-part payload in whichever wire format the active
  provider speaks (OpenAI content-array, Anthropic image blocks, Gemini
  inline_data). Previously an attachment became nothing but its filename
  in the text sent to the model, despite the UI showing a vision icon and
  rendering the image in the chat bubble.
- A confirmation dialog before the coding agent runs generated code for
  the first time in a conversation — it executes with full user
  permissions and no sandbox, so this is a real decision, not a
  formality. Approving covers the rest of that conversation; a new chat
  asks again.
- Lightweight syntax highlighting for chat code blocks and the coding
  workspace's file editor (keywords, strings, comments, numbers) —
  covering Python, JS/TS, Swift, Bash, JSON, Go, Rust, Ruby, PHP, HTML,
  CSS, C/C++, Java, SQL, and YAML.
- Markdown tables now render as real tables instead of raw pipes/dashes.
- Real logos for 7 more model providers that previously fell back to a
  plain SF Symbol: Amazon, Cohere, AI21 Labs, Liquid AI, Allen Institute
  for AI, Upstage, and Groq — sourced from Simple Icons (CC0) and Lobe
  Icons (MIT, AI-provider-specific), each verified to actually be that
  company's mark before bundling. Aqua's own provider row now renders the
  app's real brand mark natively instead of a generic icon. Reka AI and
  Writer still have no available permissively-licensed mark and keep
  their SF Symbol fallback.

### Fixed
- The update manifest URL pointed at a stale domain/path and never
  resolved to anything real.
- "Copy Link" in the share sheet copied a URL with no real page behind
  it. It now copies the actual chat transcript, which works today.
- The share sheet's X/LinkedIn/Reddit buttons were silent no-ops; they
  now show an honest "coming soon" state like the rest of the app does
  for unbuilt features.
- `textTertiary`'s light-mode color failed WCAG AA contrast (~3.24:1
  against white, needs 4.5:1) — most noticeable in timestamps and other
  small de-emphasized text. Darkened to clear the bar; dark mode was
  already fine and is unchanged.

### Changed
- Removed the forced "enter your Aqua API key" screen that gated the
  entire app on first launch. Eaon now opens straight into the chat —
  set up whichever provider you actually want (Aqua, your own API key, or
  a local model) from Settings, whenever you want. The composer's nudge
  when nothing's configured yet is provider-neutral too, not Aqua-specific.
- API keys are now stored in UserDefaults instead of the system Keychain.
  Reason: this app is ad-hoc signed (no paid Apple Developer ID), and an
  ad-hoc signature isn't stable across rebuilds — every update looked like
  a "different app" to Keychain, triggering a scary "wants to use your
  confidential information" system prompt on every single update. Given
  the choice between that and plain local storage for what's just an API
  key, plain storage won. If self-updating ever moves to a stable signing
  identity, this is worth revisiting.

## [2026.1.0] — 2026-07-08

First official release under the new versioning scheme (`YYYY.MINOR.PATCH`
instead of semver).

### Added
- Self-updating installer — "Update Now" downloads, verifies, and installs
  the new version in place and relaunches automatically. No more manual
  quit-and-drag-to-Applications.
- One-click download-and-chat for Hugging Face GGUF models and Ollama
  models, including a real quantization picker.
- Command palette (⌘K) — jump to Settings pages, switch model, set theme,
  in addition to conversation search.
- Idle model auto-unload and configurable keep-alive for local Ollama
  models, plus background model warming on selection.
- Custom instructions, applied to every conversation.
- Export/import all conversations, and delete-all-data.
- Context-window usage indicator per model.
- Pinned conversations.
- Real IBM Plex Mono/Sans typography throughout, with a techy/open-source
  visual direction.
- A signed-locally, drag-to-Applications .dmg installer.

### Changed
- Renamed from AquaChat to Eaon (app identity, source layout, package
  name); "Aqua" is kept only as the underlying model provider's name.
- Wider sidebar; removed the redundant account row at the bottom (Settings
  is still reachable from the main nav).

### Fixed
- A silent data-loss bug where the AquaChat → Eaon-desktop rename stranded
  existing conversation history in the old UserDefaults domain — existing
  users are migrated automatically on first launch.

## [0.8.2] — 2026-07-07

Last release under the old `0.x` versioning, immediately prior to the
Eaon rename.
