# Changelog

All notable changes to Eaon are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/) — newest release on top.

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
