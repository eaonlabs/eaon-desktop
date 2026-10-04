# Eaon CLI (beta)

> **Beta.** Eaon CLI is new and changes often. It tells you when a new version
> is out and updates itself (see [Updates](#updates)). Trading carries real
> risk; read the disclaimer it shows before anything trades.

Eaon in a terminal. It has the same three tabs as the desktop app, except the
ADE is replaced by an **agentic trading desk**:

- **Chat**: the agent, and a coding agent (see below). It reads and edits
  files in the folder you start it in, runs commands, searches the web,
  uses your plugins and skills, and can trade. Changes ask first; Shift+Tab
  switches between "ask first", "approve for me" and "full access".
- **Workers**: your always-on agents, with each one's live thread,
  any questions it's waiting on, and a box to write to it.
- **Trading**: a market terminal over the desktop's trading engine, opening on
  the agent desk (below).
  The pages are home, market, portfolio, orders, sessions, watchlist,
  lookup, rates & commodities, and the trading agent.

**Tab** moves to the next tab and Shift+Tab to the previous one (in Chat,
Shift+Tab cycles approvals instead), whenever the screen isn't using Tab
itself, such as for completing a command. F1 to F3 and clicking a tab work
too.

It is the desktop app's own main process running headless, so models,
providers, the agent loop, guardrails and the order ledger behave exactly
as they do in the app.

## Install

```bash
npm install -g @eaonlabs/cli
eaon
```

It needs Node 22 or newer, and the command it installs is `eaon`. `npx @eaonlabs/cli` runs it without installing. If you have
the older `eaon-cli` package (a different, earlier CLI that also installs an
`eaon` command), remove it first with `npm uninstall -g eaon-cli`.

To run it from a source checkout of this repository instead:

```bash
npm install
npm run build:cli          # writes out/cli/eaon.mjs
npm link                   # puts `eaon` on your PATH (or link bin/eaon.mjs yourself)
eaon
```

`bin/eaon.mjs` runs the built bundle, so after pulling changes,
`npm run build:cli` is all it takes to update the command.

## API keys

`/keys` in the app, or `eaon keys` in a shell, lists 95 providers you can add a key for, grouped:

- **Model makers:** Anthropic, OpenAI, Gemini, xAI, DeepSeek, Mistral, Cohere, Meta's Llama API and more.
- **Coding plans and sign-ins:** ChatGPT, GitHub Copilot, GLM Coding Plan, Kimi For Coding and others.
- **Gateways and routers:** OpenRouter, Vercel, Requesty, Helicone and others.
- **Inference hosts:** Groq, Cerebras, Together, Fireworks, SiliconFlow, Ollama Cloud and others.
- **China and regional platforms.**
- **Your own endpoints.**

Local runtimes (Ollama, LM Studio, llama.cpp, MLX, vLLM, Jan) need no key; start one and its models show up.

Using the screen:

- Type to search, then press **⏎** to add or replace a key. ChatGPT and Copilot sign in with your browser instead. A provider that needs more than a key asks for it in the same form, such as an Azure endpoint, a Cloudflare account ID or a Bedrock region.
- The key is checked straight away by listing the provider's models, which then appear in `/model`. A key that fails the check is kept, and its row is marked ✗ with the provider's reason.
- **⌃T** checks a key again and **⌃D** removes it.
- **⌃O** opens the page where you make a key, and **⌃E** edits the endpoint.
- **⌃N** adds a provider of your own: any OpenAI-compatible, Anthropic or OpenAI Responses API, such as a LiteLLM proxy or a company gateway.
- `/key groq` goes straight to one provider.

Keys are kept in the CLI's vault (the keychain on macOS) and never shown again.

```
eaon keys                         what's set up
eaon keys list --all              every provider
eaon keys add groq                asks for the key without showing it
pbpaste | eaon keys add openai    or pipe it in
eaon keys add azure --base-url https://my-resource.openai.azure.com
eaon keys add cloudflare-workers-ai --account-id <id>
eaon keys add --custom "Company gateway" --base-url https://llm.example.com/v1
eaon keys check groq
eaon keys remove groq
```

A key is never taken as an argument, so it stays out of your shell history.

## Updates

A few seconds after it opens, Eaon checks npm for a newer version, at most
every six hours. When one is out, a popup asks whether to update:

- **⏎** installs it now, with the package manager that installed this copy
  (`npm install -g @eaonlabs/cli@<version>` into the same place);
- **l** asks again tomorrow;
- **s** skips that version.

The popup waits until no other dialog is open and you've stopped typing for
a moment. Installing doesn't stop what's running: the new version starts the
next time you open `eaon`, and the popup then offers to quit. Until then the
header shows **⬆ \<version\> · /update**, and `/update` opens the popup again,
or checks right away.

From a shell, `eaon update` installs the newest version and
`eaon update --check` only looks. Other commands mention a newer version
when the app has already found one. The beta follows npm's `beta` and
`latest` tags; once there's a stable release, stable installs follow only
`latest`. Copies run from a source checkout or through npx are told how to
update instead. Set `EAON_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER`) to turn
the check off.

```
eaon                      the app, on Chat
eaon trading [page]       straight to the desk (e.g. eaon trading watchlist)
eaon ask "…"              answer once and exit (--allow lets it make changes)
eaon status               the desk in a few lines
eaon quote NVDA ^VIX GC=F BTC-USD
eaon order buy 10 AAPL --stop 180 --reason "…"   (also $500, --limit, --target, --trail)
eaon keys [add <provider>]  API keys for 95 providers (see below)
eaon import               bring your setup over from Eaon Desktop
eaon peers | send | connect | disconnect | mcp
eaon doctor
eaon update [--check]
```

## Coding

Chat works on the folder you start `eaon` in (`/cwd` changes it). Its file
tools are built on the techniques opencode uses:

- **Edits that land.** `edit_file` finds the text to replace exactly first.
  If that fails, it tries opencode's chain of forgiving matchers in turn:
  trimmed lines, block anchors, whitespace, indentation, escapes and
  context. When the match ignored indentation, the new text takes the
  file's indentation. Line endings and a BOM are kept. Ambiguous matches,
  and matches much larger than what was sent, are refused with a message
  the model can act on.
- **Every change shown.** Edits and writes appear as diffs in the
  transcript, with line numbers and syntax colouring, side by side on wide
  terminals. Approval cards show the diff before anything is written. After
  a turn, a card sums up the files it changed. **/diff** opens a reviewer of
  every file changed (↑↓ files, s split, Esc), and works mid-turn too.
- **Language servers.** After each edit, the project's language server
  checks the file, and errors go straight back to the agent ("LSP errors
  detected in this file, please fix"):
  - TypeScript uses the project's own compiler. Version 7 has a built-in
    server; 6 and earlier use typescript-language-server.
  - Pyright is used for Python, and gopls, rust-analyzer and clangd when
    they are installed.
  - Missing TypeScript and Python servers are npm-installed once into
    `<profile>/lsp`. `EAON_CLI_NO_LSP_DOWNLOAD=1` stops that, and
    `EAON_CLI_NO_LSP=1` turns checking off.
- **Undo anything.** In a git project, every turn is bracketed by
  snapshots in a private git directory in the profile. It never touches the
  project's own history or index. **/undo** (⌃Z) reverts the last turn,
  whether the files changed through tools or commands, and puts your
  message back in the box. **/redo** puts it back.
- **Project instructions.** Instructions come from the nearest `AGENTS.md`
  (or `CLAUDE.md`, `CONTEXT.md`) up to the git root, plus
  `~/.config/eaon/AGENTS.md`. **/init** writes one for the project, and
  **/instructions** shows what's loaded.
- **In the composer.** `@` completes file names and attaches the files. A
  line starting with `!` runs a command. Its output shows in the chat and
  goes to the agent with your next message.
- **Sidebar** (⌃B, on wide terminals): context use, modified files, the
  agent's todo list, language servers and instruction files.
- **Watching it work.** While the agent runs, an opencode-style scanner
  sweeps under the composer. Beside it is what the agent is doing ("Editing
  math.ts", "Running npm test", "Thinking"), how long the turn has run and
  roughly how much it has written. Its thinking streams into the
  transcript, and each finished thought folds to one line. **⌃O** shows
  every thought and all tool output in full.
- **Scrolling back.** The wheel or trackpad scrolls the whole conversation,
  as do PgUp/PgDn and ⇧↑↓. ⌃Home goes to the top and ⌃End follows again.
  While you're scrolled up, the view stays put as new output arrives, and a
  scrollbar shows where you are. Dragging over text selects it and copies it
  to the clipboard. `--no-mouse` (or `/mouse`) gives the mouse back to your
  terminal's own selection.

The snapshot step can be turned off with `EAON_CLI_NO_SNAPSHOTS=1`; undo then
covers only what the edit tools changed, and only in the same session.

## The trading desk

The lines across the top stay put: page tabs and the broker, a ticker tape
of the watchlist, and the market (indexes, regime, whether it is open). The
other pages add the account (NAV, day and total return, win rate, profit
factor, drawdown, Sharpe) and risk next to the agent's session.

### Before anything trades

The first time you start the agent or place an order, Eaon shows a risk
disclaimer. Until you tick its box and accept it, the trading engine refuses
every order and every session, from any source: the desk, the chat,
workers, schedules, `eaon order` and Claude Code. Protective sells (stops,
end-of-session sells) still go through. It is asked once per profile, and
again if the disclaimer changes. You can read it again under DISCLAIMER in
mission control.

### How trading works

1. **Link an account.** Open **LINKED** in mission control (or `/accounts`)
   and add your Alpaca keys, paper or live. You can also practise on the
   simulator first, with nothing to link.
2. **Open the Trading tab.** It opens on the agent desk.
3. **Give it a goal.** Pick who trades with **AGENT**: Eaon's own agent or
   your Claude Code. Then write the **GOAL** in your own words.
4. **Press G.** The agent trades until the market closes. At the next open
   it starts again on the same goal, every market day, until you press
   **X**. If the market is closed when you press G, it waits for the open.

Each day's session ends five minutes before the close, or before 1 PM on
half days. Holidays are skipped. Eaon has to be running at the open,
because it is what starts the agent: keep a terminal with `eaon` open and
the computer awake. If you only want one session, set **RUN FOR** to a
number of hours or to `close` instead of "every market day".

### The agent desk (page 1)

The trading tab opens on the agent at work. With no session yet, the
activity panel walks you through the four steps above and ticks off the
ones that are done.

- **Agent activity** (left) shows everything the agent does in its session,
  as it does it, check by check:
  - what it thought;
  - every scan, quote, chart read, headline and web search, with what came
    back;
  - its buys and sells in colour, with what protects them and the reason
    it gave;
  - what it decided;
  - stops that fire between checks.

  While it works, a scanner shows what it is doing and for how long.
  Between checks it shows when the next one is due and the live price watch.
  **D** shows every step's full output, and **‹ ›** pages back through
  earlier sessions.
- **Talk to the agent while it trades: T.** Your message goes to the
  running agent, which reads it in a check that starts at once (or as soon
  as the current one ends), acts on it within your limits and answers in the
  feed. With no session running, T asks the trading chat (page 0) instead.
- **Real-time feed.** Between checks Eaon watches the agent's holdings, the
  tickers in its strategy and the S&P 500 every 15 seconds. A sharp move (a
  holding 1.5%, a watched ticker 2.5%, the market 0.75%) or a holding within
  0.5% of its stop wakes the agent early, with an ALERT. Every check also
  lists what moved since the last one. Prices come from Yahoo Finance.
- **Account** (right) shows:
  - the balance in large figures;
  - today's, the session's and the total return, and the S&P 500 over the
    session;
  - cash, buying power, realized and open P&L, win rate, profit factor,
    Sharpe and drawdown;
  - the equity curve with every buy (▲) and sell (▼) marked on it. **[ ]**
    switches its range: session, hour, day, week or all.

  Under it are the holdings, with their stops and targets, and today's
  trades.
- **Mission control** (bottom) holds:
  - the mission:
    - **GOAL**, what the agent should do, in your words;
    - **RUN FOR**, every market day by default, or one session (today
      until the close, 30 minutes to 8 hours, or ⏎ for any hours or a
      time);
    - how often it checks, and whether to sell everything at the end of
      each session;
  - **ACCOUNT**, which account the agent trades (the simulator or a linked
    Alpaca account; ⏎ switches, and real money asks you to confirm), the
    model and every limit;
  - **AGENT**: who trades, Eaon's own agent or your Claude Code (below);
  - **LINKED**, your linked accounts, and **CLAUDE CODE**, whether Claude
    Code may trade real money;
  - the kill switch;
  - gauges of today's orders, loss and investment against their limits.

  Between sessions the badge reads **◷ MISSION ARMED**, with when the agent
  starts again.

  **←→** picks a setting, **⏎** changes it and **-/+** steps it. Limits
  apply at once. **G** starts the agent on the mission, or arms it until
  the open (G again updates an armed mission). **N** runs a check now, and
  **X** stops the agent: today's session and the mission, so it doesn't
  start again at the next open. **K** is the kill switch.

The agent's steps are kept in the CLI profile, so they outlive a restart.
Every open terminal shows them.

### Claude Code as the trading agent

Set **AGENT** to Claude Code and the session is run by your own Claude Code
instead of Eaon's agent, with full control of the account. To start:

1. Press **G**. Eaon arms the mission (or starts the session) and opens
   Claude Code. You hand it over yourself by typing `/mcp__eaon__trade`
   there. (Anthropic's terms don't let another app start Claude Code's
   work, so this one step is yours.)
2. When Claude Code first asks to use Eaon's tools, choose "don't ask
   again", so it can trade without stopping for permission.

From then on Claude Code runs the session like Eaon's agent:

- **Checks:** it waits for each check (the interval, a price alert, your
  message, or **N**) and gets the same brief: market, account, positions,
  what moved, alerts.
- **Research:** the same tools as Eaon's agent (history, scans, news,
  quotes).
- **Trading:** orders count as the session's, so your limits, the kill
  switch and the end-of-session sell all apply.
- **Decisions:** it logs one line per check, and its steps appear in the
  activity feed.

**T** talks to it, and **X** stops it. Eaon keeps the clock, so the session
ends on time even if Claude Code is closed.

For an every-day mission you hand it over once. When a day's session ends,
Claude Code waits for the next open itself, overnight and over weekends,
and picks the mission up again at the bell. Leave its window open. While it
waits, the desk and the Claude Code screen show "Claude Code is waiting
for it". If you close it, the next day's session waits for you to type
`/mcp__eaon__trade` again. When you press **X**, Claude Code is told the
mission is over and stops.

| Key | Does |
| --- | --- |
| 1 to 9, 0 | Pages: agent desk, home, market, portfolio, orders, sessions, watchlist, lookup, rates, chat with the agent |
| / | Go to any symbol (stocks, ^VIX, GC=F, EURUSD=X, BTC-USD) |
| B / S | Order ticket, with a live check against your limits |
| E (X off the desk) | Stop, target or trailing stop on the selected holding |
| G | Start the agent: from the mission on the desk, from a form elsewhere |
| K | Kill switch: no orders and no sessions until it's off |
| M | Broker (simulator, Alpaca paper, Alpaca live), keys, limits, simulator, trading model |
| [ ] · V | Chart range · line or candles |

Every order, from the ticket, the agent, a session, a worker or
`eaon order`, goes through the same limits in the trading engine. Real
money needs the confirmation phrase typed in the CLI, even if it was
confirmed in the desktop app.

### Linked accounts

**LINKED** in mission control (or `/accounts`) links two kinds of account.

The first is the account the agent trades: **Alpaca**, paper or live, with
its API keys. ⏎ on a linked one makes it the account the agent's sessions
trade, whether Eaon's agent or Claude Code is driving. Eaon's limits check
every order first.

The second is brokers over MCP:

- Robinhood (its agentic account), Interactive Brokers and Webull, by
  browser sign-in (OAuth);
- Tradier, live or paper, by API key;
- any other broker's MCP server, by URL or local command (Alpaca's,
  tastytrade's, Coinbase's…).

An MCP broker's tools reach the trading chat, workers and Claude Code. Each
order through one asks you first, or is confirmed in the broker's own app.
Autonomous sessions don't trade them, because Eaon can't put its limits in
front of their orders.

## Claude Code inside Eaon

`/claude` opens your own, unmodified `claude` in a terminal pane on a screen
of its own; it isn't one of the tabs. You type to it and sign in with its
own `/login`; Eaon never sends it prompts or reads its answers.

- **⏎** gives it the keyboard, and every key then goes to it, Esc and Tab
  included.
- **⌃]** gives the keyboard back to Eaon.
- **Esc** (once the keyboard is back) returns to the tab you came from.
  Claude Code keeps running, and `/claude` brings it back.
- The wheel scrolls its history.

It starts with Eaon's MCP server in control mode (`eaon mcp --control`,
passed with `--mcp-config`; your `~/.claude.json` isn't changed). That gives
it the whole app, plus the `trade` prompt that hands it a session (see
*Claude Code as the trading agent* above):

- read the desk and prices;
- place, cancel and close orders, and set stops and targets;
- start the trading agent for some hours, stop it, run a check now, or
  tell it something;
- change the limits, the broker and the kill switch;
- message workers and other sessions.

Its own permission prompts still ask before it uses a tool. Every order
still passes your limits, the kill switch and the disclaimer. Real money
(Alpaca live) is refused unless you switch **CLAUDE CODE** to "real money
too" in mission control. `eaon connect claude` keeps an outside Claude Code
read-only.

## Eaon Desktop

`eaon import` (or the dialog on first launch) copies keys and sign-ins,
providers, the model choice, MCP servers and the trading setup into the
CLI's own profile. On macOS, reading the desktop's keys makes the system ask
once to allow access to "Eaon Safe Storage". The desktop app is only ever
read, never written. Imported trading schedules start switched off, so the
two apps don't trade the same account in the same window. `/chats` can
continue a desktop chat in the CLI, and `eaon desktop` shows what the app
has.

## Other sessions, Claude Code and Codex

Sessions on one computer find each other on a local bus (Unix sockets in the
profile folder, which only you can open). Each one shows up in `/sessions`
and in `eaon peers`.

With more than one eaon open, the first runs the workers and trading
engines and the others use them over the bus, so every terminal sees one desk
and one team. If the first one closes, another takes over.

`/send <session> <text>` or `eaon send` messages a session. An Eaon
session answers with its agent, in a chat of its own, so the message never
lands in the middle of what you were doing.

`eaon connect claude` adds `eaon mcp` to Claude Code as an MCP server
(`connect codex` does the same for Codex). Their sessions can then list sessions, message Eaon, check their
inbox, wait for a message, read the trading desk and get quotes, but not
place orders. They run as themselves, signed in their own way; Eaon never
drives them headlessly.

## Files

| What | Where |
| --- | --- |
| Profile (settings, keys, chats, trading, workers) | `~/Library/Application Support/Eaon CLI`, `%APPDATA%\Eaon CLI`, `~/.config/eaon-cli` |
| Log | `<profile>/logs/cli.log` |
| Move it | `EAON_CLI_HOME=/path` |

Keys are encrypted with a keychain item of the CLI's own on macOS. On Linux
and Windows they are kept in the profile folder, which is made private to
you.

## Development

The source is `cli/src`. `scripts/build-cli.mjs` bundles it with esbuild:
`electron` points at `cli/src/runtime/electron.ts`, and `@main` and `@shared`
point at the app's sources. `npm run test:main -- cli-` runs the CLI's
tests. `eaon --snapshot trading:home --size 160x48` prints one frame of
a screen without opening the app (`--html out.html` writes it in colour,
`--keys` presses keys first).

### Releasing to npm

The package is `@eaonlabs/cli` on npm (npm refused the bare name `eaon` as too close to bson, cron, json, yarn and nan). `cli/package.json` is its manifest and gives the
CLI its name and version.

1. Bump the version in `cli/package.json`. Betas look like `0.1.0-beta.2`.
2. Run `npm run pack:cli`. It builds the bundle and assembles
   `out/cli-package`: the bundle without its source map, the manifest, this
   README, `LICENSE.md` and `NOTICE`.
3. Check the package with `npm pack --dry-run out/cli-package`.
4. Run `npm publish out/cli-package --tag latest`. For a beta, also run
   `npm dist-tag add @eaonlabs/cli@<version> beta`.

Installed copies see the new version within six hours and offer to update.
