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

Three tabs across the top:

- **Chat**: a plain assistant with streaming replies and web search. Nothing
  else touches your machine.
- **Work**: an agent that does the task. It works on files and commands in
  the Work folder, and can also use the web, connected plugins, your browser
  (through the Eaon Chrome extension) and your computer. Plan, Swarm and Goal
  modes sit in the composer. Anything that changes things asks first unless
  you choose "Approve for me", and risky actions always ask.
- **Code**: a graphical front end for an [Eaon Code](https://github.com/eaonlabs/eaon-code)
  session in a project folder.

Also: scheduled tasks that run in the background, 67 plugins with browser
sign-in, skills (`SKILL.md`), a curated local model library, coloured themes,
and pets.

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
EAON_LIVE=1 npm run test:main -- agent-live    # real agent runs against local Ollama
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
