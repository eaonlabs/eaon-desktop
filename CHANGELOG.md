# Changelog

All notable changes to Eaon are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) — newest release on top.

## [Unreleased] — 2026.6

*macOS and Windows.*

### Added
- **Three tabs: Chat, Work and Code.** Chat is the plain assistant and its
  only tool is web search. Work is an agent that does the task on your
  computer. Code is a front end for an Eaon Code session in a project folder.
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
- **Pets.** Six hand-drawn companions react to what the agent is doing, and
  can float on the desktop.

### Changed
- **Token efficiency.**
  - Prompt caching on Anthropic.
  - Stale tool output and screenshots are cleared in batches; old tool
    output and file bodies are trimmed from history.
  - Only the newest screenshot is resent.
  - Plugin schemas are deferred behind a lookup tool.
  - Conversations are compacted automatically near the context limit.
  - Each reply shows tokens used and the cached share.
- Model selection remembers which provider serves the model.

### Fixed
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
