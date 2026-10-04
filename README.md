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

Model lists come from a catalog generated from Pi's provider data and
[models.dev](https://models.dev) (`npm run generate:models`), checked against
models.dev once a day while the app runs, and merged with each provider's own
`/models` once a key is added. Removing a model in Settings → Model providers
hides it, and it can be restored from the same page.

The composer's **Effort** control offers exactly the levels the chosen model
takes, named the way providers name them: Off, Minimal, Low, Medium, High,
Extra high and Max.

## What's in the app

Three tabs, centred at the top of every screen (⌘1 / ⌘2 / ⌘3):

- **Chat**: the assistant, and an agent underneath. It answers questions
  plainly, and when you ask for something to be done it does it: files and
  commands in its folder (`~/Eaon` unless you pick one), the web, connected
  plugins, your browser (through the Eaon Chrome extension) and your
  computer. The chat box stays simple — Plan, Swarm and Goal modes, the
  folder, plugins and permissions all sit behind its + button. Anything that
  changes things asks first unless you choose "Auto-approve", and risky
  actions always ask.
- **Workers**: always-on agents, each with a name, colour, personality and
  purpose, one never-ending thread, and heartbeats it schedules for itself.
  Workers message each other, hand over files and share out big jobs. They
  run with risky actions refused, since nobody is there to approve them.
- **ADE**: the agentic development environment — a graphical front end for
  an [Eaon Code](https://github.com/eaonlabs/eaon-code) session in a project
  folder.

The Library collects every file you have attached to a chat.

Also: scheduled tasks that run in the background, 67 plugins with browser
sign-in, skills (`SKILL.md`), a curated local model library and coloured
themes.

## Eaon CLI (beta)

`cli/` is Eaon in a terminal: Chat and Workers as in the app, with an agentic
trading desk in place of the ADE. It runs this app's main process headless,
can import your setup from the desktop app, and talks to other terminal
sessions, including Claude Code and Codex. Install it with
`npm install -g @eaonlabs/cli` and run `eaon`. It updates itself when a new version
is out. From a checkout, build it with `npm run build:cli` and run `eaon`
after `npm link`. See [cli/README.md](cli/README.md).

## Browser extension

`extension/` holds the Chrome extension. To try it before it's on the Web
Store, open `chrome://extensions`, turn on Developer mode, choose **Load
unpacked** and pick the folder. Then pair it with the code shown in
**Settings → Browser extension**. `npm run pack:extension` builds the zip to
upload; `extension/STORE_LISTING.md` has the listing text and publishing
steps.

## Tests

```bash
npm run typecheck
npm run test:main                              # main-process tests (esbuild + node --test)
EAON_LIVE=1 npm run test:main -- agent-live    # real agent runs against local Ollama (EAON_LIVE_MODEL)
EAON_LIVE=1 npm run test:main -- browser-live  # the real extension in Chrome for Testing
EAON_TEST_OUT=test-quick npm run test:main     # a quick run beside a live one
npm run verify:plugins                         # checks every catalog plugin live
npm run verify:models                          # checks every library model resolves
```

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
