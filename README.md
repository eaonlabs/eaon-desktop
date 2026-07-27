<div align="center">

# Eaon

**A native macOS chat client, built with SwiftUI.**

Talk to [Eaon](https://eaon.dev)'s hosted models, bring your own API key for any OpenAI-compatible / Anthropic / Gemini provider, or run models entirely on-device with Ollama, llama.cpp, or MLX — all from the same app, with no account required for the local-only path.

![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-blue)
![Swift](https://img.shields.io/badge/Swift-5.9%2B-orange?logo=swift)
![License](https://img.shields.io/badge/license-GPL--3.0-green)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen)

</div>

---

## ✨ Highlights

- **💬 Multi-provider chat** — Eaon's hosted catalog, BYOK cloud providers, and local models, with automatic routing based on which model you pick.
- **🏠 Local models** — discover and run GGUF/MLX models via Ollama, llama.cpp, or Apple's MLX framework, with live hardware-fit checks before you download anything.
- **🔌 Plugins** — connect real accounts (GitHub, Slack, Notion, Linear, and more) and let a model call their tools directly, with native tool-calling and a confirmation step before anything runs.
- **🎨 Image generation** — over an API or a local server (Automatic1111-style, or an Ollama-served diffusion model).
- **🖥️ Computer Control** — *optional, off by default* — let a model organize files or run shell commands on this Mac, with safety rules and confirmation built in.
- **📡 Local API Server** — run Eaon itself as a local, OpenAI-compatible server other tools can point at.
- **🧠 Memory** — Eaon can learn durable facts about you across conversations, entirely on-device.

## 🚀 Quick Start

Clone the repository, then run the development launcher:

```sh
git clone https://github.com/sanscreates/eaon-desktop.git
cd eaon-desktop
./run.sh
```

The launcher builds Eaon and starts it as a detached macOS app process.

## 🛠️ Building

**Requirements:** Xcode 15+ / Swift 5.9+ and macOS 14+

```sh
swift build
./run.sh            # builds and launches for local development
```

To produce a distributable universal build (arm64 + x86_64), see [`build-installer.sh`](build-installer.sh) and [`RELEASING-UPDATES.md`](RELEASING-UPDATES.md).

## 🤝 Contributing

**Contributions are genuinely welcome and made as easy as possible.** No account, no CLA to sign, no external dependencies to wrangle:

```sh
git clone https://github.com/sanscreates/eaon-desktop
cd eaon-desktop
swift build && ./run.sh
```

That's the whole setup. Open an issue, pick up a [`good first issue`](https://github.com/sanscreates/eaon-desktop/labels/good%20first%20issue), or just send a PR — see [CONTRIBUTING.md](CONTRIBUTING.md) for the (short) details and the one-line sign-off we use instead of a contributor agreement.

## 👥 Contributors

Thanks to everyone who has helped build Eaon:

- **Sanscreates**
- **Mincofficial**
- **Tanzim**
- **YoannDev90**

## 💖 Supporters

Thank you to our supporters:

- **CanadianJet**
- **gyro**

## 📄 License

Eaon is [GNU GPL v3.0](LICENSE.md). You're free to use, study, modify, and redistribute it. Any modified version you distribute must also be GPLv3, with source available, keeping the existing copyright notices. Fork away.
