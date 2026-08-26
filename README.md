<div align="center">

# Eaon

**A native macOS chat client, built with SwiftUI.**

Talk to [Eaon](https://eaon.dev)'s hosted models, bring your own key for any OpenAI, Anthropic or Gemini style provider, or run models entirely on your own machine with Ollama, llama.cpp or MLX. Same app, same chat window, no account needed if you stay local.

![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-blue)
![Swift](https://img.shields.io/badge/Swift-5.9%2B-orange?logo=swift)
![Latest release](https://img.shields.io/github/v/release/sanscreates/eaon-desktop)
![License](https://img.shields.io/badge/license-GPL--3.0-green)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen)

[Download](#download) · [Features](#what-it-does) · [Build from source](#build-from-source) · [Contributing](#contributing)

</div>

---

## Download

**macOS.** Grab the `.dmg` from the [latest release](https://github.com/sanscreates/eaon-desktop/releases/latest) and drag Eaon into Applications. It is a universal build, so Apple Silicon and Intel both work, and it needs macOS 14 or later. The `.zip` sitting next to it is what the in-app updater pulls down; you can ignore it.

**Windows and Linux.** Those builds come from the Tauri app in [`eaon-tauri/`](eaon-tauri) and ship on their own tags. Look for `Eaon_<version>_x64-setup.exe`, or the `.deb`, `.rpm` and `.AppImage` on the [releases page](https://github.com/sanscreates/eaon-desktop/releases). Each installer is signed for the in-app updater.

Mac releases are tagged `mac-v*`, Windows and Linux releases `v*`, because they are built by different pipelines and rarely ship on the same day.

Prefer to build it yourself? Skip to [build from source](#build-from-source).

## What it does

### Models

You pick a model and Eaon routes the request; nothing else about the UI changes between a hosted model, a key you pasted, and a 4GB GGUF running on your laptop.

| Where it runs | How you connect |
| --- | --- |
| Eaon's hosted catalog | An API key, or the Free Week: seven days of hosted models, one click after install, no signup |
| Cloud, your own key | OpenAI, Anthropic, Google, Mistral, DeepSeek, xAI, Perplexity, Cohere, NVIDIA, plus the gateways Groq, OpenRouter, Together, Fireworks and Cerebras |
| Anything else | A custom base URL speaking OpenAI `/chat/completions`, Anthropic Messages, or Gemini |
| This Mac | Ollama, llama.cpp or MLX, discovered and started by the app |

The model library carries a curated Ollama catalog with live pull progress, and it checks a model against your actual RAM and chip before you download it, so you find out a 70B will not fit before you spend an hour waiting for it. Local backends all expose an OpenAI-compatible endpoint on localhost, which is why local and remote chat share the same streaming code.

### Modes

The mode you are in decides which tools the model gets offered and how long its agent loop may run. It persists across launches.

| Mode | What it is |
| --- | --- |
| Chat | Ordinary conversation. Web search and connected plugins still apply if you turned them on. No code execution, no access to your machine. |
| Agent | Writes real files on your Mac, runs them, reads the output and keeps going until they work. Shift+Tab flips between Sandboxed, where every action asks first, and Auto. Turn Device Control on in Settings and the same mode can also organize files, drive apps and open URLs. |
| Code | An embedded terminal running `eaon-cli`, for git, test runners and the work a chat bubble is bad at. |

### Tools

**Plugins** connect real accounts over MCP: GitHub, Slack, Notion, Linear, Vercel, Supabase, Stripe, Sentry, Cloudflare, PostHog, Datadog, Render, Neon, Resend, LaunchDarkly and Semrush. Some take a pasted token, others use a proper browser sign-in through the MCP spec's own OAuth discovery. Every entry was checked against the vendor's live server before it went in the list, and anything that turned out to be blocked was removed rather than parked under a "coming soon" label. You can add your own MCP servers too.

**Skills** use the same `SKILL.md` shape as Claude Code, so a skill you already wrote works here. Invoke one with `/name` in the composer. A starter set ships with the app, and you can import from `~/.claude/skills`, install from a GitHub URL, or paste one in by hand.

**Memory** keeps durable facts about you separately from dated events, because the two age differently: where you work stays true until it changes, while Friday's exam stops mattering next month. It stays on your Mac.

**Web search** is on by default. Queries go to MIKLIUM, a free independent search API, not to Eaon and not tied to any account. There is an off switch in Settings.

**Image generation** works by picking an image model from the normal model picker. Point it at a cloud `/images/generations` API, or at a Stable Diffusion server already running locally: Automatic1111, DrawThings with its API server on, or ComfyUI in compatible mode.

**Device Control** is the one that reaches into your filesystem and running apps, so it is off until you go and switch it on in Settings. While it is off the tool definitions are never sent, and any imitated call from an old transcript is refused at execution time.

**Local API Server** turns Eaon into an OpenAI-compatible endpoint other tools can point at. It binds to loopback only, defaults to port 1234 (the same one LM Studio uses, so most clients need no reconfiguring) and serves `GET /v1/models` and `POST /v1/chat/completions`. Off by default, since turning it on opens a listening port.

### Around the app

A menu bar item and the ⌥Space hotkey summon a floating assistant that takes keyboard focus without dragging the whole app in front of what you were doing. Any script, Raycast command or shell one-liner can toggle it through a distributed notification.

Compare mode runs one prompt across several models side by side and shows how long each took and how many tokens it spent. Statistics tracks prompts over time, token usage, and tokens per second and latency per model. Projects are plain folders you file chats into. ⌘K opens a palette over chats and commands, so jumping to a settings page or switching model is the same gesture as finding a conversation.

Appearance covers accent colour, font size and typeface, including fonts already installed on your Mac, and picking a theme changes the real macOS appearance rather than only the colours Eaon paints, so menus and scrollbars follow along. Any reply can be read aloud with the system speech voices, which needs no network and no key.

Updates install themselves: Eaon downloads the new build, swaps the app bundle in place with two renames on the same volume, and relaunches. The old bundle is kept as a backup until the swap has succeeded.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘N | New chat |
| ⌘K | Search chats and commands |
| ⌘\ | Toggle sidebar |
| ⏎ | Send message |
| ⇧⏎ | New line |
| ⌥Space | Show or hide the floating assistant |
| ⇧⇥ | Switch between Sandboxed and Auto in Agent mode |

## Your data

Conversations, settings and API keys live in the app's own settings store on this Mac. Downloaded models and message attachments are files under `~/Library/Application Support/Eaon`.

Your key is sent as an authorization header to the provider you gave it to and nowhere else. Messages and attachments go to whichever provider generates the reply, which may be a local model on your own machine.

Settings → Privacy exports every conversation and project as one JSON file, imports a previous export without overwriting what is already there, and deletes everything if you want a clean slate.

## What's in this repo

Three surfaces, one product. They share tool contracts, safety rules and prompt design rather than code.

| Path | What it is |
| --- | --- |
| [`Eaon-desktop/`](Eaon-desktop) | The macOS app. SwiftUI, Swift 5.9, one dependency ([SwiftTerm](https://github.com/migueldeicaza/SwiftTerm), for the embedded terminal). |
| [`eaon-tauri/`](eaon-tauri) | The Windows and Linux app. Rust core, React UI, Tauri 2. The webview has no network access at all: every HTTP request, file write and process spawn happens in Rust. |
| [`eaon-cli/`](eaon-cli) | `eaon` in your terminal. Node 18.17+ and Ink, cross platform, and what Code mode runs inside the Mac app. |
| [`installer/`](installer) | The app icon and the script that generates it. |
| [`build-installer.sh`](build-installer.sh) | Produces the universal arm64 + x86_64 Mac build. |
| [`RELEASING-UPDATES.md`](RELEASING-UPDATES.md) | How a release is cut and how the updater manifest is signed. |
| [`CHANGELOG.md`](CHANGELOG.md) | Every release, newest first. |

## Build from source

### macOS app

Needs Xcode 15+ with Swift 5.9, on macOS 14 or later.

```sh
git clone https://github.com/sanscreates/eaon-desktop.git
cd eaon-desktop
./run.sh
```

`run.sh` builds Eaon and launches it detached from the terminal, which matters: started any other way, Terminal keeps stealing your keystrokes. Click the window once and type. Run `swift build` on its own if you only want to check that it compiles.

For a distributable universal build, see [`build-installer.sh`](build-installer.sh) and [`RELEASING-UPDATES.md`](RELEASING-UPDATES.md).

### Windows and Linux app

```sh
cd eaon-tauri
npm install
npm run tauri dev     # the real app, live reload
npm run check         # TypeScript
```

Installers for both platforms are built by GitHub Actions on a version tag, on real Windows and Ubuntu runners, so you do not need either machine to produce them.

### CLI

```sh
cd eaon-cli
npm install
npm run build
npm link              # puts `eaon` on your PATH
```

Then `cd` into a project and run `eaon` there. It roots itself in your working directory. `/help` lists the commands, `/init` writes an `EAON.md` that later sessions load automatically.

## Contributing

Contributions are welcome, and the setup is short on purpose. No account, no CLA, no build tooling past Swift itself:

```sh
git clone https://github.com/sanscreates/eaon-desktop
cd eaon-desktop
swift build && ./run.sh
```

That is the whole thing. Open an issue, take a [`good first issue`](https://github.com/sanscreates/eaon-desktop/labels/good%20first%20issue), or send a PR. Two habits worth knowing before you do: comments in this codebase explain why something is the way it is rather than restating the code, and new functionality tends to be hand rolled rather than pulled in as a package. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest, including the one-line sign-off we use instead of a contributor agreement:

```sh
git commit -s -m "your message"
```

## Contributors

Thanks to everyone who has helped build Eaon:

- **Sanscreates**
- **Mincofficial**
- **Tanzim**
- **YoannDev90**

## Supporters

Thank you to our supporters:

- **CanadianJet**
- **gyro**

## License

Eaon is [GNU GPL v3.0](LICENSE.md). Use it, read it, change it, pass it on. If you distribute a modified version it has to be GPLv3 as well, with source available and the existing copyright notices intact. Fork away.
