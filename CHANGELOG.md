# Changelog

All notable changes to Eaon are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) — newest release on top.

## [Unreleased]

### Changed
- **"Enjoying Eaon?"** The GitHub star prompt is a small card in the corner
  after 10 to 20 minutes of using Eaon in a session, not a dialog. Open GitHub
  stars the repository for you when the GitHub CLI is signed in, and opens it
  either way; after that, or when your GitHub account has already starred it,
  it never shows again. Later asks again in a week, three times at most.

### Fixed
- **The ADE's sessions.** A session with no terminals open now shows its past
  Claude Code and Codex conversations on its page ("Pick up where you left
  off"), one click to carry on; they were only in a small list in the
  sidebar, so a session looked like it had none.
- A home folder that is itself a git repository (an empty `git init` in ~ is
  enough) no longer makes every folder in it one project named after the home
  folder, with sessions called "main". Each folder is its own project again,
  and sessions saved that way are filed again when the list loads.
- A project that is just its own folder is one row in the sidebar, not a
  heading over a row repeating its name.
- The sidebar no longer reorders itself when a session is opened, which moved
  the next session out from under the pointer.
- **A terminal in a folder macOS keeps Eaon out of says so.** When Eaon isn't
  allowed into Downloads, Documents or the Desktop (Privacy & Security → Files
  and Folders), nothing it starts there can read the folder: Homebrew said
  "the current working directory must be readable" and Claude Code failed
  with "An unknown error occurred (Unexpected)". The terminal now says which
  switch to turn on and has an Open Privacy Settings button, and macOS's own
  prompt explains what Eaon wants the folder for.
- Turning on "Run in the background" on a Mac no longer makes macOS announce
  "Software from <the developer's name> can run in the background". The agent
  that starts Eaon at login now ships inside the app and is registered with
  macOS as Eaon's, so the notice (which macOS always shows) names Eaon.

## [2026.6.2-beta.6] — 2026-10-07

### Added
- **Eaon CLI** (Apple silicon for now): a coding agent in the terminal, a fork
  of OpenCode that uses only the open-source models you've downloaded in
  Eaon. Start it from the ADE's New terminal menu or Models → Downloaded. The
  Local API Server answers it under `/local/v1` with the downloaded models
  alone; a cloud model name there is refused.
- **Control Eaon from other tools.** A control API (MCP at `/control/mcp`,
  JSON at `/control/v1/tools`, behind this install's key) can list and manage
  models, downloads, the ADE, tabs, workers, chats and a few appearance
  settings. It never hands out keys or tokens. Eaon CLI connects to it and
  asks before anything that changes much.
- **Remote devices** (Settings → Remote devices, off by default): the Eaon app
  on your iPhone can see and control your workers and use this Mac's models,
  over your own network, with a key for every request.
- **Terminal themes for the ADE.** Type `/theme` in any terminal, or use the
  header's Theme button: Eaon, Everforest, Nord, Kanagawa, Tokyo Night,
  Catppuccin, Gruvbox, Dracula, Solarized, One Dark, Rosé Pine Dawn and more,
  each previewed on every pane before you keep it, some with a scene drawn
  behind the text. A theme restyles the app in its colours too; Eaon puts
  back the app's own look.
- **Star Eaon on GitHub**, from Settings → General or an occasional prompt
  (after a few launches, at most three times, two weeks apart). With the
  GitHub CLI signed in it stars the repository for you; otherwise it opens
  the page. It never stars anything without the button being pressed.
- **Beta updates, on their own.** Settings → General → Software update has a
  separate "Beta updates" section. Turn on "Install beta updates" and, when a
  newer beta is out, it appears with its own Download beta button. A beta is
  never downloaded unless you press it, and stable updates work as before.
- **Credits worth reading.** "Made with ♥ in California and New York", the
  people who contributed, and what Eaon is built on. The notices for the MIT
  software Eaon ships (OpenCode, llama.cpp) are in `NOTICE`.
- **Browser extension 1.2.0**, which installed copies update to themselves.
  Three new actions for the agent: `links` (a page's links with where each
  goes, far smaller than a snapshot), `clear` (empty a field) and `get_text`
  (what a field or element holds; passwords are never shared).

### Fixed
- **Linux installers start on Ubuntu 24.04.** The AppImage needed `libfuse2`
  and `libz.so`, which Ubuntu doesn't install, so opening it did nothing; it now
  uses electron-builder's static runtime. The .deb aborted at launch ("The SUID
  sandbox helper binary was found, but is not configured correctly") because
  Ubuntu 23.10 and later block the user namespaces Chromium's sandbox needs; it
  now installs an AppArmor profile, and the AppImage's launcher adds
  `--no-sandbox` only where that's the case. The .deb also depends on `libgbm1`
  and ALSA, and the running window groups under its launcher on GNOME and KDE.
- **A helper left behind by computer use could use a whole CPU core, for days.**
  The macOS input helper compared a length to `0` that its scripting bridge
  returns as a string, so after Eaon quit it read an empty pipe forever.

### Changed
- A worker's browser that goes unused for ten minutes puts its page away (it
  comes back where it was at the next step), so a page with a video or a
  spinner no longer keeps a processor core busy for hours; the live view
  only captures the page while something is happening on it.
- The Windows installer no longer includes a 32-bit build, which had no terminal
  and no local models, and is a third smaller.
- A Windows build now installs on a clean machine in CI, on x64 and arm64
  (`.github/workflows/windows.yml`), and the Linux build is installed and opened
  on Ubuntu 24.04 without `--no-sandbox` before it's attached to a release.

## [2026.6.2-beta.5] — 2026-10-07

### Added
- **An installer for the beta on Mac.** "Install Eaon Beta" finds the Eaon
  already on the Mac, quits it, puts the beta in its place and opens it. Chats,
  settings and keys stay; nothing has to be uninstalled first.

## [2026.6.2-beta.4] — 2026-10-07

### Added
- **Go back to the stable version.** On a beta build, Settings → General →
  Software update has "Switch to stable": after asking, it downloads the
  latest stable release and installs it when Eaon restarts. It isn't offered
  on a stable build.

## [2026.6.2-beta.3] — 2026-10-06

### Added
- **Chat on Codex.** Chat's model picker has a Codex tab with the models your
  Codex account offers; pick one and Chat runs on Codex, with its sign-in and
  plan. The next message carries on the same Codex conversation, a Codex that
  joins a chat part-way is told what was said, and the commands it wants to
  run are asked in Chat's own approval dialog. Signed out, the sign-in is
  right above the composer; on first run Eaon offers "Use Codex in Chat" when
  it finds Codex signed in.
- **A worker's model on its message box**, as in Chat, and an **Edit** button
  on its page.

### Changed
- The ChatGPT provider offers the newer models the catalog knows even when
  your plan's own list leaves them out (that list lags new models), after the
  plan's own and marked "May not be on your plan".
- A worker's engine field always offers Codex: not installed, it says how to
  get it; signed out, it signs in right there.
- Clicking a worker's face winks, the same every time (it was a random look);
  faces on cards no longer react, since the click opens the worker.

### Fixed
- On a worker's page the header ran out of room at an ordinary window size
  and hid the More menu, which held Edit worker. Its buttons now keep their
  icons when the words don't fit.
- The Codex entry in Settings → Model providers and in the model picker showed
  the letters "Co" instead of its logo.

## [2026.6.2-beta.2] — 2026-10-06

### Added
- **ADE sessions.** The ADE's sidebar lists your projects, each with its
  sessions: what the session is called, its branch, and whether an agent is
  working (orange), waiting for you (green) or nothing runs (grey). The open
  session shows its agents — the terminals running in it, with the task each
  agent says it is on, and the past Claude Code and Codex conversations from
  its folder, which a click reopens.
- **New session** makes a branch for the work (from its name: "Fix CI checks
  detail link" → `fix/ci-checks-detail-link`) in a worktree of its own under
  `~/Eaon/worktrees`, and starts the agent you pick in it. Your project folder
  isn't touched. Removing a session can remove its worktree too; the branch
  always stays, and git's refusal to delete uncommitted work is respected.
- **Settings → ADE → Import sessions** finds the conversations Claude Code and
  Codex have on this computer and adds a session for each folder they ran in.
  Nothing in either CLI changes.
- **Resize and rearrange the ADE's terminals.** Drag the line between two
  terminals to give one more room (or focus it and use the arrow keys;
  double-click evens them out); the sizes are remembered for the folder. Drag
  a terminal by its title bar onto another to swap them, or use Move left /
  Move right in its menu.

### Changed
- Claude Code is shown with Claude's own symbol in the ADE, Connect apps and
  Link accounts.

## [2026.6.2-beta.1] — 2026-10-05

*macOS, Windows and Linux. A repair release: Workers, models and providers,
and a long list of dead ends removed.*

### Added
- **Workers run on their own.** A worker has its conversation with you plus a
  thread of its own for every routine, side task (New task) and job a
  colleague delegates. They run side by side and stop on their own; a running
  routine no longer makes your message wait. Up to four runs go at once, two
  per worker, and one that has to wait says so ("Queued") instead of looking
  idle.
- **Run history.** Every run leaves a receipt — what woke it, how it ended
  and why, how long it took, tokens — under Activity on the worker's page,
  with Retry. A run Eaon quit in the middle of is picked up again if it
  hadn't changed anything; one that may have is left for you to retry.
- **Delegation you can follow.** "Nova delegated … to Vega" is a job with a
  state (assigned, working, waiting, done, failed), the background Nova chose
  to share, what to send back and an optional deadline. Loops and chains more
  than three deep are refused.
- **Workers wake on events.** A worker can wait for a command to finish or a
  file to change instead of guessing a time; repeating wake-ups nobody
  follows stop by themselves.
- **Codex as a real engine.** Settings → Agent engines finds the Codex you
  have installed (including the one in the ChatGPT app), shows its version and
  whether it is signed in or the session expired, offers sign-in or update,
  and lists the models your account really has, from Codex itself. A worker
  can run on Codex with its own session. Eaon still decides what it may do.
- **Search in Workers**: workers, their tasks, questions waiting for you and
  group chats, with arrow keys.
- **Edit what a worker remembers**, stop a routine, and choose how hard a
  worker thinks, from its page.
- **One model picker everywhere**, with search, stars, recents and grouping;
  a model that goes away stays visible as unavailable with why, never silently
  replaced. Lists refresh in the background and say what changed ("Updated
  just now · 3 new models", "Couldn't refresh X — showing the list from 2 h
  ago").
- **The computer's one pointer is leased** to one run at a time, with an
  indicator saying who has it and Take back control.
- **Your 2026.6.0 and 2026.6.1 data upgrades safely**: a damaged file is set
  aside and repaired instead of stopping Eaon or replacing your chats.

### Changed
- **Provider errors say what to do** ("Your ChatGPT session expired. Sign in
  again.") with a button, instead of a status code; a provider whose saved
  sign-in stopped working shows "Needs attention".
- **With no usable model, the composer says so before you type**, and keeps
  your draft.
- Settings → General's links point to the Eaon Labs repository and the
  version you are running; "Import work from other AI apps" is now "Use your
  accounts from other AI apps" and opens Link accounts.
- A chat reply still being written is saved every few seconds, so a crash
  keeps most of it. Scheduled tasks keep every run as a record, run once
  after sleep instead of once per missed time, and follow the time zone.
- Settings → Usage never shows a subscription's use as money spent, and says
  so when a provider reported no token counts.
- Subscriptions and recurring payments always ask; a payment authorization
  covers one press of the pay button.

### Fixed
- **Security.** One permission policy now decides every tool call, including a
  swarm's sub-agents (they ran with none of their lead's limits). A worker
  can't get a more trusted colleague to act for it. Approvals sent to
  Discord, Telegram or WhatsApp show the exact call and are answered by code.
  ⏎ in the composer no longer approves a command. Links from a symlink can't
  reach ~/.ssh. Pages and extensions need the gateway's key. Only web and
  email links leave the app, and the window never navigates away. Keys stay
  on their origin when a provider redirects. Logs blank keys, tokens and card
  numbers. Local-network pages need approval in the agent's browsers and
  `web_fetch`.
- **The agent's browser**: new tabs, file pickers, downloads and a crashed
  page no longer hang or open windows on your screen; failures say what to
  try.
- **Windows and Linux**: keyboard shortcuts work; the header reserves the
  right space.
- **Narrow windows**: a side panel no longer squeezes the conversation to a
  sliver; Send is always visible.
- Dead controls removed or made to work (settings that nothing read, buttons
  with no action, shortcuts that applied nothing); failures that were
  swallowed now reach you.
- Dialogs and menus work from the keyboard and give focus back.
- Voice dictation falls back to your other key when the first fails and
  stops when the microphone is unplugged; image generation refuses oversized
  or unreadable images before billing or saving.

### Known limits
- Windows and Linux were checked by unit tests, not on real machines, for
  computer use, Codex discovery and some layout rules.
- Real ChatGPT sign-in, a real expired session and the iOS Simulator were not
  exercised end to end.

## [2026.6.1] — 2026-10-04

*macOS, Windows and Linux.*

### Added
- **The agent can use your computer.** With Computer use on, Chat and
  workers can see the screen, move the pointer, type and click, zoom into one
  app or a region, and save screenshots to a folder (for example, a
  screenshot of every page of an app or a website).
- **Your iPhone, through the Mac.** The agent can boot and drive the iOS
  Simulator, and it opens on screen so you can watch (Device Hub on Xcode
  27). With iPhone Mirroring it can use your real phone.
- **Payments.** Settings → Payments holds a card the agent can pay with.
  Choose to approve every purchase, or let it pay on its own after you read
  and accept a waiver; automatic payments can't be turned on without it.
- **Teams of workers.** Up to four workers run at the same time. They talk
  in group chats, share context from their threads and hand work to each
  other. Start a team from Workers, or ask Chat for one.
- **Watch a worker's browser** in a panel beside its thread.
- **Connect apps.** Other AI apps on your computer can use Eaon's models
  through Eaon's gateway, set up from Settings → Connect apps.
- **Link accounts and a new model picker.** Link the AI accounts you already
  have through each provider's own sign-in or key; the picker shows them with
  their models, stars and thinking levels.
- **Usage** in Settings: requests, tokens and the estimated cost for each
  model, day by day.
- **A new app icon,** the Disc E on a black, grained tile, made in Apple's
  Icon Composer. On macOS 26 and later it's a Liquid Glass icon with dark,
  clear and tinted looks. Settings → Appearance → App icon switches the Dock
  (or, on Windows and Linux, the window icon) to the Agent icon.
- **Livelier worker faces.** Their eyes glance around and blink on their own,
  they have new expressions (excited, curious, surprised, sad, sleepy), and
  they react to clicks and new messages. Workers can pick an expression too.

### Changed
- **The working animation** is now a calm ring around the face, with the
  eyes narrowing into focus. Finishing well completes the ring and the face
  pops once.

### Fixed
- **Websites load much faster** in the agent's browser, and far more of them
  load at all.
- **"No endpoints found that support image input":** with a model that can't
  read images, Eaon now takes the images out and asks again.
- The agent's browser and computer tools accept the action names models
  commonly use, so fewer steps fail.

## [2026.6.0] — 2026-10-02

*macOS, Windows and Linux. The release of everything in 2026.6: the
release candidate below, plus what was added and fixed since.*

### Added
- **More than one window.** File → New Window (⌥⌘N), or the Dock menu,
  opens another Eaon window. Each window keeps its own tab and chat. Chats,
  projects and settings changed in one window show up in the others, and a
  reply being written in one window can be watched live from another.
- **`/` and `@` in Chat's message box.** `/` lists what the + menu can do
  (files, folder, Goal, Plan, Swarm, permissions, browser, computer use,
  plugins, model, new chat) plus your skills. `@` brings up your plugins and
  switches one on for the chat.
- **Workers' + menu** now has Goal, the worker's browser, computer use,
  plugins and the worker's permission level, besides files. There's no Swarm
  or Plan: workers already work as a team, and run without anyone to approve
  a plan.
- **@ a worker in Workers.** Mentioning a colleague in a message to a worker
  sends it to both. Workers don't appear in Chat's `@`.
- **Antigravity in the ADE**, in place of Gemini CLI. A pane saved as Gemini
  CLI comes back as a plain shell.
- **Voice input.** A mic button in Chat's and Workers' message boxes records
  you, shows a live waveform with a timer, and drops the transcript into the
  box (it's never sent on its own). It transcribes with your OpenAI key
  (`gpt-4o-mini-transcribe`) or, without one, your Groq key (Whisper).
- **Image generation.** Chat and workers can make or edit images with your
  OpenAI key (`gpt-image-1`) or Gemini key, saved into the work folder. A card
  in the conversation shows the images developing, then fading in; click one
  to see it full size.
- **Reasoning effort as a slider** in the model menu, stepped through the
  model's own levels.
- **Message actions under replies**: thumbs up or down, emoji reactions (kept
  with the chat), copy, reply-with-quote, read aloud, try again and fork chat.
- **Tables and diffs look the part.** Tables in replies are drawn as proper
  data tables, and as comparison tables (✓ and —) when they compare options.
  Code changes show in a new diff card with line numbers where they're known.

### Changed
- **The agent's work reads like a coding agent's.** Each edit shows as a card
  with its diff where it happened ("Edited store.ts +12 −3"), and each command
  as a card with the command and the end of its output, plus its exit code
  when it fails. A command waiting on your OK says so. Reads and searches fold
  into one line that, while the agent works, shows a short scrolling window of
  its latest steps and how long it's been going. Before a reply has anything
  to show, it shows what it's doing and a timer.
- **Eaon Code installs and updates from its own installer** instead of npm,
  which no longer carries current builds. Settings → Eaon Code shows no
  version number, just Install, or Check for updates, which runs the installer
  again. The app starts the installed build with Node directly rather than
  through the `eaon-code` wrapper, which checks GitHub and can rebuild on
  every start.
- **Electron 43** (from 33). It's built for macOS 26 and later, so the
  window gets the current macOS look: the larger 14pt window buttons and
  their spacing. It also drops Electron 33's bug that made macOS 26 and later
  lag while an Electron app was open. macOS 12 is now the oldest supported.
- **Tool calls read like a coding agent's.** An edit shows as a card with the
  file and its diff, a command as a card with what ran and the end of its
  output (and the exit code if it failed), and a call waiting on you says so.
  New loaders show the model working and a reply on its way.
- **A turn reads in the order it happened**: thinking, tool, tool, thinking.
  Each thought is a row you can open, and a finished turn folds to one line.
  Reasoning summaries render as Markdown instead of showing `**`.
- **A new plan checklist and approval prompt.** The plan shows a progress
  ring and a timeline whose steps check off as they finish. The approval
  prompt says what's about to happen and shows it, coloured by how much it
  matters (a command that deletes or touches credentials is red), with ⏎ to
  approve and esc to deny; workers' approvals use the same card.

### Fixed
- **Markdown in replies.** Numbered lists spaced with blank lines no longer
  restart at 1, sub-bullets stay under their item, tables render, and
  `_italic_`, `__bold__`, `~~strike~~`, task boxes and bare links work.
  Worker questions render Markdown too.
- **Auto-approve asks before more dangerous commands.** It used to let
  through `rm --recursive`, `find … -delete`, `git checkout .`, uploads like
  `curl -d @.env`, AppleScript, deleting from `python -c`, disguised
  `bash -c "$(… base64 -d)"`, and any command writing outside the work folder.
  It still uses rules, not a model.
- The chat list's error mark only shows when the chat's latest reply failed,
  not for good after any earlier error.
- The window buttons sometimes landed in the wrong place, after leaving full
  screen, a light/dark switch (including macOS switching by itself) or a
  title change. Eaon now puts them back after each.
- Computer use reporting Accessibility as off while the Eaon switch in System
  Settings is on. That switch can belong to an older, differently signed copy
  of Eaon (old builds share its bundle id). Settings → Computer use now says
  so, lists such copies, and has a "Reset and ask again" button that clears
  the stale entry.
- A worker's question card fits the composer's width instead of the whole
  pane, and empty worker turns no longer show "No response".
- The conversation no longer scrolls flush under the top bar; it stops with
  the same gap as the bar has to the top of the window.

### Removed
- The Share button in the chat's top bar. Copy transcript is still in the
  chat's … menu.

## [2026.6.0-rc.1] — 2026-10-01

*macOS, Windows and Linux. Release candidate for 2026.6.0: everything below is in,
and what's left is testing. Email on your own domain through Cloudflare is
labelled beta.*

### Added
- **Linux installers**: an AppImage, which runs on most distributions and
  updates itself, and a `.deb`, for x64 and arm64. They're built on Linux by
  GitHub Actions (`.github/workflows/linux.yml`), and each is started once
  before it's attached to the release. Local models run on Eaon's own
  llama.cpp, compiled for Linux on the CPU, so K2 Horizon runs there too.
- **Three tabs: Chat, Workers and ADE**, centred in the top bar of every
  screen (⌘1 / ⌘2 / ⌘3). Chat now *is* the agent: it answers plainly, and
  when you ask for something it does it with files, the shell, the web, your
  browser and plugins. The old Work tab is folded into Chat, and its chats,
  projects and folder move across on first launch. The Code tab is now the
  **ADE** (agentic development environment).
- **A simpler chat box.** It has +, your message, the model and Send. The
  approval mode, Plan / Swarm / Goal, the work folder, plugins, browser and
  computer use all live behind +. Anything switched on shows as a small chip
  that turns it off again. Under the home composer, chips suggest things Chat
  can do.
- **Eaon Workers.** Workers are always-on agents with a name, a colour, a
  personality and a purpose. Each has one thread that never ends and is
  compacted automatically, and you can clear it. A worker wakes when you
  write, when a teammate sends it mail, or on a heartbeat it schedules for
  itself (every minute while a model trains, for example). Workers hand each
  other parts of a job, send each other files and check on each other. They
  create new workers only rarely. Each face is a coloured circle whose eyes
  show its mood: neutral, happy, serious, angry, asleep, or X'd out when a
  task failed.
- **Workers run on their own**, modelled on xAI's Grok Bot and OpenAI's dots:
  - **Three levels of freedom.** *Autonomous* (the default) uses files,
    commands, plugins, its own browser and your computer without asking.
    *Careful* refuses anything risky. *Look only* never changes anything.
  - **Actions that always need you.** Even an autonomous worker never
    spends money, types a card number or password, uses `sudo`, erases a
    disk, force-pushes, or makes a plugin call the plugin marks
    destructive. For those it asks, and approving lets exactly that one
    call through, once.
  - **Questions that don't block.** A worker can ask you something
    (`ask_user`) and keep working while it waits. Questions show as cards
    above its message box with quick answers, Approve once or Decline, and
    a notification.
  - **Its own memory.** A goal, plus notes on decisions and your
    preferences. The worker keeps both up to date, and they stay in its
    prompt even after its thread is summarised.
  - **Routines.** Several named schedules per worker, such as "every 30
    minutes, check the deploy" or "daily at 08:30, write the morning
    brief". They sit alongside the one-off heartbeat. A routine that fails
    reports and waits for its next run instead of retrying in a loop.
  - **Reaching out first.** `notify_user` sends a notification when a
    worker has something you'd want to know now.
  - **Its own web browser,** through BetterWright. It's a real browser in a
    hidden window with the worker's own logins, and it can open pages,
    click, type, search within a page, read and take screenshots. Its
    Browser card opens the same live view as Chat's, with its cursor and
    Take control, to watch it or to sign it in somewhere.
  - **No swarm mode,** since your workers are the swarm. Workers no longer
    see the scheduler (it starts chats); heartbeats and routines replace it.
- **Chat apps: Workers in Discord, Telegram and WhatsApp** (Settings → Chat
  apps). Connect a worker to a Discord bot, a Telegram bot, or a WhatsApp
  group through your own number linked like WhatsApp Web. Pair your account
  with a code and you can talk to the worker from your phone and control it
  with commands: /status, /stop, /pause, /resume, /wake, /workers, /use, and
  /answer, /approve or /decline for its questions. Friends and groups ask to
  join, and you let them in from Eaon or with /allow. What a friend may make
  the worker do is your choice, from "Talk only" (the default: chat and web
  search, nothing on your computer) up to "Same as you". A friend's message
  can never change the worker's schedule, notes or team. Workers can also
  post on their own, such as a daily digest to a group. WhatsApp has no bot
  API for personal accounts, so it uses an unofficial client and a spare
  number is safest; Settings says so before you link.
- **Full autonomy** (+ → Permissions). Chat runs any command and makes any
  change it needs, anywhere on your computer, without asking. It still stops
  for anything that can't be undone: sudo, erasing a disk, force-pushing,
  passwords, payments.
- **Goals with an end time.** With Goal on, choose how long Eaon keeps at it:
  until it's done, for 30 minutes up to 8 hours, or until a time you pick. It
  keeps your computer awake until then, and while it waits for something it
  pauses instead of spinning.
- **Eaon's own browser, live.** Chat now has a browser of its own, separate
  from your Chrome and with its own logins. A panel beside the chat shows the
  page as it changes, about 8 frames a second, while the panel is open. Eaon's
  cursor (a blue arrow tagged "Eaon") glides to each thing before it clicks or
  types, and what it's clicking is ringed. Typing appears letter by letter.
  The step in hand and the ones before it are listed underneath.
- **Take control of an agent's browser.** Press Take control and the picture
  becomes the page: your clicks, scrolls, typing, copy and paste go straight
  to it, and the address bar takes an address or a search. The agent's next
  step waits until you press Hand back. It is then told you stepped in and
  sees the page as you left it. Closing the view hands it back too, so an
  agent is never left waiting on nobody. Use it to sign the agent in, get it
  past a captcha, or show it the way. The real window is still one click away.
- **Its own email** (Settings → Email). Eaon gets an address from AgentMail,
  set up inside the app; AgentMail emails you a code to confirm. Add your own
  domain and Eaon lists the DNS records to publish, then checks them. Eaon can
  read its inbox and write and reply to people. It asks before sending (unless
  you've given it full autonomy, and never for a worker: a worker always asks,
  showing you the exact email), has a daily cap, and treats what's in an
  email as information, never as instructions.
- **Email on your own domain, without AgentMail — beta** (Settings → Email →
  "My own domain, on Cloudflare", labelled Beta). Paste a Cloudflare API token, pick a domain on your
  account and an address, and Eaon sets everything up there: the DNS records
  (MX, SPF, DKIM, DMARC), Email Routing, and a small `eaon-mail` Worker that
  keeps incoming mail in your own Workers KV. Sending uses Cloudflare Email
  Sending. Eaon never takes over a domain that already gets email elsewhere;
  it asks for a subdomain such as agents.yourdomain.com instead. If the token
  is missing a permission, Eaon names it. Sending to people needs Cloudflare's
  Workers Paid plan ($5 a month, 3,000 emails included); receiving is free. An
  AgentMail inbox you switch from is kept, and disconnecting Cloudflare goes
  back to it.
  No custom token needed: paste your Global API Key with your Cloudflare login
  email, and Eaon uses it once to make a token with only the seven
  permissions email needs, limited to the chosen domain. It keeps that token,
  never the key. Whatever you paste is cleaned of spaces, quotes, "Bearer" and
  invisible characters. A wrong paste says what it is — a zone or account ID,
  a cut-short token, the Global API Key without its email, or a token
  Cloudflare doesn't recognise — instead of "didn't accept the API token".
  Before changing anything, Eaon checks every permission the token needs and
  lists all that are missing in one message. A good token without Email
  Sending (which Cloudflare refuses with a 401) is no longer reported as
  unrecognised.
  Email Sending no longer blocks setup. Until it is turned on for the Cloudflare
  account (Email Service → Email Sending, on the Workers Paid plan), Cloudflare
  offers the token only "Email Sending: Read". Eaon then sets up receiving, shows
  the address as "Receiving only", explains how to turn sending on, and finishes
  the job on "Check again". Meanwhile the agent knows it can't send and doesn't
  ask to.
  Sending now works without Email Sending too, to the addresses verified in
  your Cloudflare account (free on any plan): the `eaon-mail` Worker sends them
  through its own send binding, on a private workers.dev endpoint only Eaon can
  call. Verify an address from Settings → Email (Cloudflare emails a link), or
  under Email Service → Email Routing → Destination addresses in Cloudflare.
  Anyone else is refused before sending, with the way out. When Email Sending
  is turned on, Eaon notices on its next check and switches to it by itself.
  A setup made by an older Eaon gets the new Worker the next time Eaon starts.
- **Workers can have their own email address** on the same domain (Settings →
  Email → Workers' addresses). A worker's email tools read and send as its own
  address, and it still always asks you before sending.
- **Agentic trading** (ADE → Trading). A trading desk shows the account's
  value over time, today's and total returns, win rate, profit factor,
  drawdown and Sharpe ratio, your holdings, and every trade with the reason it
  was placed. Ask Eaon to trade from a chat, place orders yourself, or let it
  trade on its own in a window you choose: right now until a set time, or on
  a schedule such as weekdays during market hours. It starts on a simulator
  priced with real market quotes. Alpaca paper accounts work too. Real money
  (Alpaca live) needs your keys and a typed confirmation. Every order, yours
  or Eaon's, has to pass your limits: largest order, largest holding, most
  invested, a daily loss stop and orders per day. "Stop all trading" halts
  everything at once.
- **Library.** Every photo, video and file you have attached to a chat, in
  one grid you can filter and search. Attachments now also show in the
  conversation itself; before, they were sent but never displayed.
- **Projects you can actually create.** The Projects section used to only
  say "No projects". Now you can create, edit and delete projects, give them
  instructions, and expand them to see their chats.
- **Open on launch** (Settings → General): start in Chat, Workers, the ADE,
  or wherever you left off.
- **The ADE is a terminal workspace.** It's a grid of real terminals in the
  project folder, each running Eaon Code, Claude Code, Codex, Gemini CLI,
  OpenCode or a plain shell, side by side. Panes get names, status dots,
  maximise, restart and rename, and they keep running when you switch tabs or
  folders, even across a window reload. The old Agent view (Eaon Code driven
  over RPC) is gone, so opening a folder no longer starts anything in the
  background. Eaon Code terminals get Eaon's API keys when Settings → Eaon
  Code shares them.
- **A pane's logo follows the CLI running in it.** Quit Codex and type
  `opencode`, or type `claude` into a plain shell, and within a few seconds
  the pane's logo and name change to match, in its header and in the sidebar.
- **The ADE comes back as you left it.** Quit Eaon and reopen it, and every
  pane returns:
  - An agent that was in a conversation reopens that conversation: Claude
    Code with `--resume`, Codex with `resume`, Gemini CLI with `--resume`,
    OpenCode and Eaon Code with `--session`. This works even for an agent you
    started by typing its name into a shell.
  - An agent that hadn't started a conversation starts fresh.
  - A shell comes back in the folder it had `cd`'d to, showing what it showed
    before, under a "restored" line.
  - An editor or monitor that was open (vim, nano, htop, lazygit…) opens
    again.

  Dev servers and scripts are never re-run on their own. A conversation you
  exit on purpose stays closed. On Windows, which has no process list to
  read, a pane's agent continues the folder's latest conversation, but only
  when it's the only pane of that agent in the folder.
- **Sign in with your account** where providers officially allow it:
  - **ChatGPT**: OpenAI's official "Sign in with ChatGPT" (launched
    2026-09-29). It needs no app registration and uses your plan's limits.
    The older Codex-based sign-in stays as "ChatGPT (Codex)".
  - **Hugging Face**: inference billed to your account, with the token
    refreshed automatically.
  - **Poe** (new provider): sign-in mints an API key, like OpenRouter.

  Hugging Face and Poe only sign in apps registered with them, so each shows
  the three setup steps and a field for the Client ID. Providers whose terms
  forbid third-party sign-in say so instead of offering a button: Anthropic,
  Gemini, and Kimi's and Z.ai's coding plans. Anthropic also forbids apps
  from sending requests through a user's Claude Free, Pro or Max plan, so
  Claude in Eaon uses an API key. To use a Claude plan, run the real Claude
  Code in the ADE; the Anthropic provider has a button that opens it there.
- **A cleaner transcript.** Tool calls are no longer a stack of bordered
  cards. Each run of calls between two sentences folds into one quiet line of
  what happened, such as "Used 2 skills, listed 7 folders and looked for a
  file". Click the line to see the calls. While a call is running, the line
  shows it live. A turn's edits appear once, at the end of the reply, as one
  "N files changed" card with line counts, and each row opens its diff. The
  Plan panel above the composer is now a single line showing the current
  step. The ADE's agent view uses the same design.
- **Real provider logos.** Every provider in Settings → Model providers, and
  every agent in the ADE's terminal panes (Claude Code, Codex, Gemini CLI,
  OpenCode, Eaon Code), now shows its own logo instead of a letter. The logos come from Lobe
  Icons (MIT); see `assets/providers/NOTICE.md`.
- **Recommended models.** MiniCPM5 2B, K2 Horizon 7B and Qwen3.8 27B sit in
  their own section at the top of Models.
- **Local models run on Eaon's own llama.cpp, not Ollama.** Get downloads a
  model's GGUF straight from Hugging Face, along with the vision projector
  for models that see images. A `llama-server` built into the app runs it.
  Downloaded models appear in the model picker under "On this computer",
  load on first use and unload after 15 idle minutes. Nothing to install.
  - Eaon's llama.cpp is upstream plus pull requests that haven't landed yet
    (`native/llama-fork.json`, built by `scripts/build-llama.sh`). Right now
    that's #29535, so **K2 Horizon runs**; Ollama couldn't load it.
  - Every library variant was re-pointed at Hugging Face files and checked
    (`scripts/verify-model-library.mjs`).
  - Downloaded embedding models can power the code index too.
  - Windows ships upstream's prebuilt `llama-server` (Vulkan on x64, CPU on
    ARM), so K2 Horizon isn't available there yet.
- **Work mode that actually works.** It acts in a folder you choose, or
  `~/Eaon` if you don't choose one. It reads, edits and writes files, runs
  commands with live output, starts background servers, and deletes to the
  Trash. It can also read web pages and use connected plugins, your browser
  and your computer. Changes outside the Work folder, and risky commands,
  always ask first.
- **Plan, Swarm and Goal modes** in the Work composer.
  - Plan researches read-only and then presents a plan you approve.
  - Swarm splits work across 2–6 sub-agents, each limited to its role's tools.
  - Goal keeps working until the goal is verified done or blocked.
- **Scheduled tasks that really run.** They fire on their own timer with the
  window closed and catch up once if a run was missed. Each run leaves a chat
  behind. The agent can create schedules itself.
- **Keep running in the background** (Scheduled page, or General → Launch
  at login). Eaon starts at login without a window so schedules run after a
  restart. On Windows, closing the window leaves Eaon in the notification
  area. Off by default.
- **Goal limits.** Goal mode pauses on a time limit (1 hour) or a token limit
  (2M) as well as its continuation limit. The banner says which one it hit.
  All three are in Settings → Code index → Agent.
- **Browser control through a Chrome extension** (`extension/`). It pairs over
  loopback and works in its own tab group. Payments, deletions and password
  fields ask first. The folder includes a Web Store publishing kit.
- **Computer use.** The agent can take screenshots and drive the mouse and
  keyboard. An on-screen indicator shows while it does, and ⌃⌥⌘. stops it.
- **55 model providers.** They include ChatGPT (Codex) and GitHub Copilot
  sign-in, DeepSeek, Kimi, GLM, Qwen, MiMo, Cerebras, Fireworks, Together,
  Bedrock, Vercel, Cloudflare, LM Studio, vLLM and Jan. OpenAI and xAI now
  use the Responses API. Ollama gets a native connection with a full-size
  context window.
- **67 verified plugins**, with browser sign-in (MCP OAuth). Seven connect in
  one click with no account: Context7, DeepWiki, Hugging Face, Microsoft
  Learn, AWS Knowledge, Cloudflare Docs and Exa.
- **Real skills.** `SKILL.md` folders are read from `~/.claude/skills`,
  `~/.eaon/skills` and the project, and loaded only when used. You can install
  one from GitHub.
- **A curated local model library**, featuring MiniCPM5 2B, K2 Horizon 7B and
  Qwen3.8 27B plus 19 current models, with fit badges for your Mac's memory
  and one-click download.
- **14 coloured themes**: Nord, Dracula, Tokyo Night, Catppuccin, Gruvbox,
  Solarized, Rosé Pine, One Dark, Everforest, Kanagawa, Abyss, Forest, Plum
  and Synthwave. Each has a light and a dark version and passes an AA
  contrast check.

### Changed
- **Plain system fonts.** The UI uses the platform's own typeface, the same
  stack ChatGPT uses: SF Pro on macOS and Segoe UI on Windows. The Inter,
  SF Mono and Georgia picker is gone; the text-weight setting stays.
- **Chat sidebar** follows the new layout: New chat, Models, Library,
  Plugins, Settings, then Projects and Recents. Scheduled moved to the
  Workers tab, and Pull requests to the ADE.
- **Token efficiency.**
  - Prompt caching on Anthropic.
  - Stale tool output and screenshots are cleared in batches; old tool
    output and file bodies are trimmed from history.
  - Only the newest screenshot is resent.
  - Plugin schemas are deferred behind a lookup tool.
  - Conversations are compacted automatically near the context limit.
  - Each reply shows tokens used and the cached share.
- Model selection remembers which provider serves the model.
- **Model lists are generated, not typed in.** Each provider's models come
  from Pi's provider data and models.dev, newest first, with the right
  context, output and effort limits. Claude Sonnet 5.5, GPT-6.1 Sol and the
  rest of this month's releases are in. Eaon checks models.dev once a day,
  so later releases show up without an update. Providers with a key also
  merge in their own `/models` list.
- **Effort follows the model.** The Effort menu lists only the levels the
  current model accepts, named as providers name them (Off, Minimal, Low,
  Medium, High, Extra high, Max). Switching to a model with fewer levels no
  longer overwrites your choice. The "Available reasoning efforts" and
  "Ultra in model picker slider" settings are gone.
- The **Star** on a model now marks a favourite: starred models come first in
  the model menu, and clicking the star again unstars it.
- The model menu no longer has an **Advanced** row that jumped to Settings.
  "Manage models…" at the bottom of the model list goes to Model providers.
- **Agentic trading trades better.**
  - Protective exits: every buy can carry a stop-loss, take-profit or
    trailing stop, and Eaon sells at market when one is reached, between
    the agent's checks, on every broker. The trading desk shows each
    holding's protection and lets you set or change it, and the ticket takes
    a stop and a target.
  - The agent can scan today's gainers, losers and most active stocks, read
    a stock's latest headlines, and see ATR, MACD and volume against its
    average for up to five stocks at once.
  - Each check starts with SPY and QQQ, the strategy's own tickers, and how
    big the next buy can be. The agent sizes trades to risk about 1% of
    equity, gives each buy a stop, and doesn't average down.
  - A finished session says how SPY did over the same time.
- **Workers can trade for you.** The New worker form has a Trading section:
  pick where it trades, give it a strategy, choose how often it checks the
  market (only while it's open), and decide whether it places orders on its
  own or asks you first. It trades on the trading desk's account (simulator
  or Alpaca, with the desk's limits and stops), or through a broker you
  connect right there:
  - **Robinhood**, through its official agentic-trading connection, from a
    separate account funded with only what you move into it.
  - **Interactive Brokers**: reads your account and drafts trades you submit
    in IBKR.
  - **Webull**: order instructions you confirm in the Webull app.
  - **Tradier**, live or paper, with an API token.
  - Any other broker's MCP server you add yourself.
- **Brokers on the Plugins page**, in their own section, each saying what an
  agent can actually do there.
- **Computer use walks you through macOS permissions.** Settings → Computer
  use shows a two-step checklist for Accessibility and Screen Recording, with
  one button per step and "Quit & reopen Eaon" when macOS needs a restart.
  Permission errors in chat point to it.

### Fixed
- **Broker orders always wait for you unless you said otherwise.** A
  connected broker's order tool, or any plugin action that can't be undone,
  now always asks first: in a chat, even with "Approve for me" or "Allow all
  MCP tool permissions" on, and for a worker, unless you set that worker up
  to place orders on its own. Before, a broker that didn't flag its order
  tool (Tradier's doesn't) could be traded through by an autonomous worker
  without asking. The trading desk's kill switch now stops broker plugins'
  orders too.
- **Long dialogs scroll.** A tall dialog (the New worker form) ran off the
  bottom of a small window, hiding its Create button.
- **Practice trading after hours did nothing.** With "fill orders anytime"
  on, the session's instructions still told the agent to do nothing while
  the market was closed, and it obeyed. It now trades the simulator.
- **Trading sessions, workers and scheduled tasks no longer run at Max
  effort** when the chosen level isn't one the model offers. They use the
  nearest level below, as the chat does.
- **"llama-server quit unexpectedly."** With a local model loaded, quitting
  Eaon that had been started from a terminal (or closing that terminal) made
  macOS report a llama-server crash. The terminal's Ctrl+C reached the model
  server as well as Eaon's own stop signal, and llama.cpp aborts on a second
  one. The model server now runs apart from the terminal and is stopped once;
  one left behind by an Eaon crash is stopped on the next launch, so it no
  longer holds the model's memory.
- **Approving a worker's email now actually lets it send.** Some models (GPT
  style) name the tool "functions.email_send" when they ask for approval;
  Eaon compared names literally, so the approval never matched the real call
  and the email was refused right after you approved it. Tool names are now
  compared without that prefix (and Gemini's "default_api."). This applies to
  every approve-once action, orders included.
- **The worker page no longer slides sideways in a narrow window.** A long
  check-in note made one of the pills under the worker's name wider than the
  window, and a sideways trackpad swipe moved the whole page. The pills now end
  in "…" (the full note is in the tooltip). Chat, worker and ADE threads, pages
  and settings no longer scroll sideways at all, so nothing wide can bring
  this back. Header buttons like Check in keep their label on one line.
- **The chat-apps tests no longer hang the suite.** The Telegram test read
  the second long-poll before it had always arrived, and a failure left its
  connector polling forever, so the whole test run never finished. It now
  waits for that poll and always stops the connector.
- **Closing the window no longer throws in the background.** With Discord
  presence on, closing Eaon's window (or quitting) sent a last status update
  to the page that was already gone, and Electron showed "A JavaScript error
  occurred in the main process". Messages to a closing window are now dropped.
- **Settings → Email no longer goes blank** when it can't load. It says what
  went wrong, and if Eaon was updated while running it says to reopen it.
- **Crashes recover and leave a record.** A window whose page crashed now
  reloads by itself (after three crashes in five minutes it asks instead). An
  error while showing a screen shows "Something went wrong" with a Reload
  button, not a blank window. Errors are written to `logs/crashes.log` in
  Eaon's data folder; Help → Show Crash Log opens it.
- **Model providers page.** Removing a model no longer loses it: it is
  hidden and can be restored. Rename works (it used a browser prompt that
  Electron doesn't show). Refresh works without a key and says what it found.
- **Submenus open beside their menu.** The Model and Effort submenus covered
  the menu they came from when there was no room on the right. They now open
  on the other side, and the parent menu stays usable while one is open.
- **Plugins work in Workers.** Unattended runs refused every plugin call not
  marked read-only, even with Settings → MCP → "Allow all tool permissions"
  on. That pre-approval now holds for workers and scheduled runs too.
- **"Message me now" no longer errors.** A worker asking for an immediate
  wake-up (`in_minutes: 0`) got "Say when…". It now means "as soon as
  possible", and a clock time ("9:30 PM") works too.
- **Top-bar overlap.** Wide header content (the ADE's context meter) drew
  over the Chat · Workers · ADE switch. Header sides now clip, and overflow
  never runs leftwards under the switch.
- **Installers are about 60 MB smaller.** The app used to ship old test
  builds inside itself. They also broke the universal Mac build whenever tests
  ran during packaging. Windows installers can now be built on an Apple
  silicon Mac without Rosetta.
- **Cut-off replies taken as finished.** A stream that closed before the
  provider said it was done was treated as a complete answer. It could even
  carry a half-received tool call. Chat-completions, Ollama and Anthropic
  streams now fail instead, and a cut-off with nothing shown yet is retried.
- **Work spinning in place.** The same failing tool call is now refused after
  three identical failures, and re-reading unchanged output costs a short
  pointer instead of a second copy.
- **Goals declared done without checking.** A goal is sent back once to
  verify when its last action was an unchecked change.
- **Pausing a goal that was running did nothing.** The pause now reaches the
  agent between steps, as do the time and token limits.
- **Two copies of Eaon could run at once.** Scheduled tasks then ran twice.
  A second launch now brings the first one forward.
- **Launch at login and Prevent sleep did nothing.** Both switches now work.
- **Model downloads could fill the disk.** Get now checks free space first.
- **Tool calls dropped by some providers.** Ollama and several gateways sent
  them with an unexpected finish reason. Mistral rejected tool ids made by
  other providers, Gemini rejected common schema keywords, and local models
  without tool support failed outright.
- **Ollama models hidden** until you pressed refresh. Local runtimes are now
  discovered automatically.
- **Commands failing from a Dock-launched app** because it had no PATH
  (npx, node, Homebrew). The app now adopts the login shell's PATH.
- **Small models stalling.** They would end a Work turn after only thinking,
  or after announcing a plan they never carried out. They are now sent back
  to act.
- **Plan mode and scheduled tasks** were settings nothing read. Both now work.
- **`keys:reveal` exposed more than it should.** It could return plugin
  tokens and OAuth credentials to the renderer; it now returns only provider
  keys.

## [2026.5.0] — 2026-08-27

*macOS and Windows.*

### Changed
- The app has been **rebuilt on Electron + React**, replacing the native
  Swift macOS client.
- **On macOS, existing installs update themselves in place** through the
  same self-updater as before — the build keeps the `dev.eaon.desktop`
  bundle identifier and the `Eaon` executable name the installed app
  validates against, so 2026.4.5 swaps itself for this one and relaunches.
  No manual download, and chats and settings are untouched at
  `~/Library/Application Support/Eaon`.
- **Windows is newly supported**, as a fresh install rather than an update:
  one `.exe` covering x64, ARM64 and 32-bit, which picks the right build for
  the machine. The window controls sit where Windows puts them, at the top
  right, and the header layout accounts for them.
- **The sidebar is a floating panel.** Rounded, inset from the window edge,
  with the traffic lights inside it rather than on the strip above. Its
  controls collapse into a single row and the navigation sits directly
  beneath them.
- **One window background.** The sidebar, main area and Settings each used
  to paint their own, so the translucent sidebar left a visible seam where
  it met the chat. There is now a single background and the seam is
  structurally impossible.
- Every top row across the app shares one baseline, so header controls stop
  shifting as you move between screens or toggle the sidebar.
- **Settings** navigation matches the app sidebar, and row titles are
  weighted so a setting's name reads ahead of its description.

### Added
- **Web search.** The model can look things up when an answer depends on
  something current rather than answering from memory, citing the pages it
  used. Off, snippets, or full-page scrapes — Settings → Configuration.
- **A theme picker** with eight palettes. The accent colour now drives
  toggles, links and focus rings, so picking a theme changes the whole
  interface rather than one decorative detail.
- **Bring your own key** for any supported provider, with fallback keys
  tried in order when one fails.

### Fixed
- Long replies stay smooth. Streaming used to rebuild every chat in the
  sidebar and re-join the whole message on each token; it now updates only
  the message that changed, and the main process batches tokens per frame.
- Selecting a model no longer falls back to the first one in the list.
- The light theme no longer leaves the sidebar unreadable on a Mac running
  the system in Dark.

### Known limits
- **Windows builds are not code-signed.** SmartScreen shows "Windows
  protected your PC" on first run until an Authenticode certificate is in
  place — click More info → Run anyway.
- **Windows and Linux users of the Tauri app do not cross over
  automatically.** That app updates through its own Ed25519-signed channel,
  which this build cannot publish into; the Windows installer here is a
  fresh install rather than an update. Linux is not covered by this release
  at all.
- Eaon Work — the agentic coding mode — is hidden in this release. The
  browser panel, plugin tray and approval controls belong to it and return
  with it.
