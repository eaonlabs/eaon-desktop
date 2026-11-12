# Making Eaon mods

A mod changes Eaon itself, or the coding CLIs Eaon starts in the ADE. Mods are listed in **Settings → Mods** (also the **Mods** tab of the Plugins page, or ⇧⌘M). The mod format is in alpha and may still change.

A mod is a folder with a `mod.json` and the files it names:

```
my-mod/
  mod.json
  panel.html          (only if it has a panel)
  claude/             (only if it has a Claude Code plugin)
```

Install your folder with **Add mod → From a folder…**. Eaon copies it into its mods folder (`<userData>/mods/<id>`), so edit the original and install it again to update it. **⋯ → Show the mods folder** opens the installed copies.

## mod.json

```json
{
  "schema": 1,
  "id": "jane.git-helpers",
  "name": "Git helpers",
  "version": "1.0.0",
  "publisher": "Jane Doe",
  "description": "Slash commands for writing commit messages.",
  "category": "commands",
  "homepage": "https://example.com/git-helpers",
  "license": "MIT",
  "contributes": {
    "commands": [
      { "name": "commit", "description": "Write a commit message", "prompt": "Write a commit message for this diff:" }
    ]
  }
}
```

| Field | Rules |
| --- | --- |
| `schema` | `1` |
| `id` | Lowercase words joined by dots or dashes, 3 to 64 characters. Ids starting with `eaon.` are kept for the mods that ship with Eaon. |
| `name`, `publisher` | Up to 40 characters. |
| `description` | Up to 240 characters. It's shown on the card. |
| `version` | `major.minor.patch`. |
| `category` | Where the card is filed: `themes`, `commands`, `instructions`, `editor`, `panels`, `workers`, `tools`, `ade`, `cli` or `sounds`. |
| `homepage` | Optional. Must be an `https` link. |
| `license` | Optional. |
| `contributes` | What the mod adds. See below. A mod must add at least one thing. |

Fields this version of Eaon doesn't know are ignored, so a mod written for a later version still installs and applies the parts this one understands. Anything malformed is refused with a message that names the field.

## What a mod can add

Everything below is data that Eaon reads and applies itself. Only two parts run code, and the install screen calls both out: **panels** run in a sandbox, and a **Claude Code plugin's** hooks and MCP servers are started by Claude Code.

### App themes: `appThemes`

```json
"appThemes": [{
  "name": "Harbor",
  "light": { "accent": "#1C6CB0", "background": "#F3F6F9", "foreground": "#0F1B26", "contrast": 40 },
  "dark":  { "accent": "#6DB6EC", "background": "#122130", "foreground": "#EEF4F9", "contrast": 44 }
}]
```

These are the four values per appearance that every surface is mixed from. `contrast` runs from 0 to 100. Lower values keep surfaces closer to the background, which keeps secondary text readable. Themes appear under **Settings → Appearance → From mods**. Keep body and secondary text at 4.5:1 or better: Eaon's own mods are held to that by `test/themes.test.ts`.

### ADE terminal themes: `terminalThemes`

```json
"terminalThemes": [{
  "id": "harbor", "name": "Harbor", "mode": "dark",
  "blurb": "Night water under a lighthouse",
  "scene": "lighthouse", "app": "Harbor",
  "colors": { "background": "#0E1B27", "foreground": "#D9E5EF", "cursor": "#D9E5EF", "selection": "#5AA9E655",
              "black": "…", "red": "…", "green": "…", "yellow": "…", "blue": "…", "magenta": "…", "cyan": "…", "white": "…",
              "brightBlack": "…", "brightRed": "…", "brightGreen": "…", "brightYellow": "…", "brightBlue": "…",
              "brightMagenta": "…", "brightCyan": "…", "brightWhite": "…" }
}]
```

- `scene` is one of the ADE's animated scenes (`code/terminal/themes.ts`, `SceneId`), or `null`.
- `app` names an app theme, either one of Eaon's or one in the same mod. Picking the terminal theme restyles the app to match.
- Every colour is `#RRGGBB`. Only `selection` may add an alpha byte.
- Themes show in `/theme` in any ADE terminal, and in **Settings → ADE**.

### Slash commands: `commands`

```json
"commands": [{ "name": "tldr", "description": "Summarize in three bullets", "prompt": "Summarize this in three bullets:", "where": ["chat"] }]
```

Typing `/tldr` and picking it puts `prompt` in the message box for the user to finish and send. A command never sends anything by itself. `where` is `chat`, `workers` or both; leave it out for both.

### Chat instructions: `instructions`

```json
"instructions": "Answer in plain language and lead with the answer."
```

Up to 2,000 characters, added to what Chat's model is told in every chat while the mod is on. The install screen shows the text word for word.

### Editor snippets: `snippets`

```json
"snippets": [{ "prefix": "fn", "description": "Function", "languages": ["ts", "js"], "body": "function name() {\n  $0\n}" }]
```

In the code editor, typing the prefix and pressing Tab inserts the body, indented like the current line. The caret lands at `$0`, or at the end if there's none. `languages` are file extensions.

### Syntax colouring: `languages`

```json
"languages": [{
  "id": "lua", "name": "Lua", "aliases": ["lua"],
  "lineComment": ["--"], "blockComment": ["--[[", "]]"], "strings": ["\"", "'"],
  "keywords": ["local", "function", "end"], "literals": ["nil", "true", "false"], "types": ["self"]
}]
```

This colours the code editor and code blocks in replies. A mod supplies only word lists and literal delimiters; Eaon builds the pattern from them, so a mod can't hand the app a regular expression. Eaon's own language names win a clash.

### Dock panels: `panels`

```json
"panels": [{ "id": "notes", "title": "Notes", "description": "Notes that save as you type", "entry": "panel.html", "host": ["storage", "composer"] }]
```

A panel is a page that opens in the dock, in Chat and in the ADE, from the dock's + menu. It runs in a frame sandboxed to scripts only, with an opaque origin, under this policy:

- Scripts, styles, images and fonts come from the mod itself (inline is fine).
- There's no network: no `fetch`, WebSocket, form posts or frames.
- There's no `window.api`, no `localStorage`, and no access to the app's page.

It talks to Eaon only by `postMessage`, and Eaon answers only the calls listed in `host`:

| `host` entry | Calls |
| --- | --- |
| `storage` | `storage.get(key)`, `storage.set(key, value)`, `storage.remove(key)`, `storage.keys()`: text saved for this mod, up to 256 KB, removed when it's uninstalled |
| `composer` | `composer.insert(text)`: puts text in the message box without sending it |
| `notify` | `notify(text)`: a short notice in the corner |

A request is `{ eaon: 'mod', id, call, args }` sent to `parent`. The answer is `{ eaon: 'mod', id, ok, result }` or `{ eaon: 'mod', id, ok: false, error }`. Eaon also sends `{ eaon: 'mod', event: 'theme', theme }` when the panel loads and whenever the app's colours change. `theme` has `mode`, `background`, `surface`, `raised`, `text`, `text2`, `text3`, `border`, `accent`, `onAccent`, `danger`, `font`, `mono` and `fontSize`. A small client:

```html
<script>
  const eaon = (() => {
    let next = 1
    const waiting = new Map()
    addEventListener('message', (event) => {
      if (event.source !== parent || event.data?.eaon !== 'mod') return
      const m = event.data
      if (m.event === 'theme') return document.documentElement.style.setProperty('--accent', m.theme.accent)
      const pending = waiting.get(m.id)
      if (!pending) return
      waiting.delete(m.id)
      m.ok ? pending.resolve(m.result) : pending.reject(new Error(m.error))
    })
    const call = (name, ...args) => new Promise((resolve, reject) => {
      const id = next++
      waiting.set(id, { resolve, reject })
      parent.postMessage({ eaon: 'mod', id, call: name, args }, '*')
    })
    return { get: (k) => call('storage.get', k), set: (k, v) => call('storage.set', k, v), insert: (t) => call('composer.insert', t), notify: (t) => call('notify', t) }
  })()
</script>
```

Eaon's Scratchpad, Focus timer, JSON tools and Time converter mods (`resources/mods/panel-*`) are complete examples.

### Worker templates: `workerTemplates`

```json
"workerTemplates": [{ "id": "brief", "name": "Morning Brief", "blurb": "A short morning summary", "color": "#3E86C6", "shape": "bun",
                      "purpose": "Each morning, …", "personality": "Calm and concise." }]
```

They appear under **Workers → New worker → Suggestions**, and picking one fills in the form. `shape` is one of `pebble`, `blob`, `bun`, `capsule`, `ghost`, `gumdrop`, `flower`, `gem`, `star` or `heart`.

### ADE session presets: `sessionPresets`

```json
"sessionPresets": [{ "id": "pair", "name": "Claude and Codex", "description": "Two agents side by side",
                     "panes": [{ "agent": "claude", "name": "Claude" }, { "agent": "codex", "name": "Codex", "prompt": "Review this branch." }] }]
```

Presets appear in the ADE's **New session** dialog under "Or a preset from your mods", and the session opens with these panes (up to 9). `agent` is any agent the ADE runs (`shell`, `claude`, `codex`, `gemini`…; see `TERMINAL_AGENT_IDS` in `shared/terminals.ts`). A pane with a one-line `prompt` starts its agent on that task. A preset whose agents aren't installed can't be picked, and says which agent is missing.

### ADE header widgets: `widgets`

```json
"widgets": [
  { "id": "utc", "kind": "clock", "label": "UTC", "timeZone": "UTC" },
  { "id": "focus", "kind": "timer", "label": "Focus", "minutes": 25 }
]
```

A `clock` shows the time in an IANA time zone. A `timer` counts down from `minutes` when clicked.

### Sounds: `sounds`

```json
"sounds": { "reply": [{ "freq": 880, "ms": 90 }, { "freq": 1318.5, "ms": 220, "wave": "triangle", "gain": 0.4 }] }
```

Notes Eaon plays with Web Audio, so a mod ships no audio files. The events are `reply` (a Chat reply finishes), `ade` (an ADE agent finishes or needs you) and `error` (a reply fails). Each event takes up to 8 notes of 40 to 4000 Hz and 20 to 1500 ms.

### Agent tools: `tools`

```json
"tools": [{
  "name": "weather_forecast",
  "description": "Current weather and a daily forecast for a latitude and longitude.",
  "url": "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&forecast_days={days}",
  "params": [
    { "name": "latitude", "type": "number", "description": "Latitude in degrees.", "required": true },
    { "name": "longitude", "type": "number", "description": "Longitude in degrees.", "required": true },
    { "name": "days", "type": "integer", "description": "Days of forecast, 1 to 16." }
  ],
  "pick": ["current", "daily"],
  "maxChars": 6000
}]
```

Each tool makes one HTTPS GET. Agents in Chat (with tools on) and Workers can call it while the mod is on.

- The host is fixed in `url`. `{name}` placeholders can only fill the path and query, and their values are URL-encoded.
- An optional argument left out drops its query parameter.
- Redirects and private addresses are refused.
- `pick` keeps parts of a JSON answer as dotted paths, with `*` for every item of a list (`results.*.name`). `maxChars` caps the answer, from 200 to 20,000 characters.

The install screen names every host a mod's tools reach.

### A Claude Code plugin: `claudePlugin`

```json
"claudePlugin": "claude"
```

This points at a [Claude Code plugin](https://code.claude.com/docs/en/plugins) folder inside the mod: `claude/.claude-plugin/plugin.json` plus its `commands/`, `agents/`, `skills/`, `hooks/hooks.json` and `.mcp.json`.

- Eaon passes it with `--plugin-dir` to the Claude Code panes the ADE starts, so it's never written into your own `~/.claude`.
- Panes already running pick it up when they restart.
- The install screen lists the plugin's commands, skills and subagents, the exact command each hook runs, and each MCP server. It flags any `plugin.json` field Eaon can't describe as something that may run code.
- Run `claude plugin validate <mod>/claude` to check the plugin.

### Codex: `codex`

```json
"codex": {
  "instructions": "Run the tests before saying a change is done.",
  "mcpServers": { "notes": { "command": "npx", "args": ["-y", "some-mcp-server"] } }
}
```

Eaon passes these as `-c developer_instructions=…` and `-c mcp_servers.<name>.…` to the Codex panes the ADE starts. It never sets one your Codex `config.toml` already sets: your own `developer_instructions`, or a server with the same name.

## Sharing a mod

**As one file.** A packed mod is a JSON document that holds the manifest and every file as text:

```json
{ "eaonMod": 1, "manifest": { …mod.json… }, "files": { "panel.html": "<!doctype html>…", "claude/.claude-plugin/plugin.json": "{…}" } }
```

Install it with **Add mod → From a file…**, or host it and use **Add mod → From a link…** (https only).

**As a source.** A mod source is a JSON index that lists packed mods:

```json
{ "name": "Jane's mods", "mods": [{ "url": "packs/git-helpers.json", "manifest": { …mod.json… } }] }
```

Add it with **Add mod → Add a mod source…**. Its mods show under its name, without a verified mark. Each one is read in full and reviewed before it installs, because the summary in the index isn't what gets installed.

## Limits and rules

- A mod can have up to 200 files and 2 MB, text or images. Symbolic links are refused. Dotfiles are skipped, except `.claude-plugin` and `.mcp.json`.
- Only mods bundled with Eaon get the verified mark. Nothing installed from outside can use an `eaon.` id.
- Turning a mod off removes everything it adds at once. Claude Code and Codex panes that are already running keep it until they restart. Uninstalling also deletes what its panels saved.
- Eaon's own mods update with the app when the new version asks for nothing more than the old one. One that asks for more waits on its card for you to review it.
- Turning off a theme mod you're using keeps those colours until you pick another theme.
