# Eaon Desktop

The Eaon desktop app — an AI chat client that runs on **your own API keys**. Built with
Electron, React and TypeScript; the interface follows the supplied design frames.

## Run it

```bash
npm install
npm run dev        # hot-reloading dev build
npm run build      # production bundle into out/
npm start          # run the production bundle
npm run dist:mac   # package a .dmg / .zip
```

## Bring your own key

Open **Settings → Model providers** and paste a key. Providers ship configured
out of the box:

| Provider | Notes |
| --- | --- |
| Anthropic | Official SDK, adaptive thinking, effort levels |
| OpenAI | Chat completions |
| Google Gemini | Via its OpenAI-compatible endpoint |
| OpenRouter, Groq | Chat completions |
| Ollama | Local, no key needed |
| Custom endpoint | Anything speaking the OpenAI chat-completions format |

Keys are encrypted with the OS keychain (Electron `safeStorage`), written to
your user-data directory, and never sent to the renderer process or anywhere
except the provider you entered them for. After saving a key the app calls the
provider's model list, so the picker fills in immediately.

The composer's **Effort** control maps onto real reasoning-effort levels:
Light, Medium, High, Extra High, Ultra.

## What's in the app

- **Chat** — streaming replies, reasoning summaries, stop, copy, rename, pin,
  archive and delete, grouped into workspaces and projects
- **Plugins** — a directory with Plugins/Skills tabs, plus a manager for
  plugins, MCP servers and skills with per-item toggles
- **Browser** — an in-app browser panel beside the conversation
- **Scheduled** — recurring prompts
- **Settings** — General, Appearance, Voice, Configuration, Personalization,
  Pets, Keyboard shortcuts, Model providers, Computer use, Appshots, Plugins,
  Browser, Hooks, Connections, Git, Environments, Worktrees, Archived chats

## Theming

Appearance exposes accent, background, foreground and contrast per theme. Every
surface is mixed from those four values, so editing a hex or dragging contrast
re-tones the entire UI. Light, dark and system modes are all supported, along
with UI font, font size, reduced motion and diff-marker preferences.

## Layout of the source

```
src/main       window, menus, JSON store, encrypted key vault, model streaming
src/preload    contextBridge API exposed to the renderer as window.api
src/renderer   React UI (components, state, styles, icons)
src/shared     types shared across processes
```

### Design-verification harness

`EAON_CAPTURE=<dir> npx electron ./out/main/index.js` drives the UI and writes a
PNG per screen so the build can be compared against the design frames. It runs
offscreen and resets the store first; it is inert without the env var.
