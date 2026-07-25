# Handoff — Eaon CLI

## What this is

A terminal coding agent modeled on Claude Code — Node.js + TypeScript + Ink
(React for terminals). Lives in `eaon-cli/` inside the `Aqua Devs chat
interface` repo, alongside the macOS app (`Eaon-desktop/`, Swift) and a
Tauri build (`eaon-tauri/`). This is a **fresh implementation**, not a port —
but it deliberately carries over the Mac app's tool contracts, safety rules,
and prompting lessons so behavior stays consistent across all three
surfaces. When in doubt about "what should this tool do," the Mac app's
`Eaon-desktop/Services/DesktopControl.swift` and `ChatViewModel.swift` are
the reference implementation to check against.

**Git:** `eaon-cli/` IS tracked and committed (this note used to say
otherwise — it was stale). The remote is `sanscreates/eaon-desktop`. Note
that the wider repo usually has a lot of unrelated uncommitted work in
`Eaon-desktop/` and `eaon-tauri/` that belongs to the user — stage
`eaon-cli/` specifically rather than `git add -A`.

## Goal (user's own words, paraphrased across sessions)

"Make the CLI for Eaon good — agentic coding and everything, like Claude
Code. Commands and model picker and everything like Claude Code." The user
compares this directly against Claude Code and expects rough feature parity
on the things that make a coding CLI feel professional: real search tools,
a todo/plan tracker, context management (`/compact`, `/context`), a fast
non-laggy render loop, and the ability to interrupt/redirect mid-generation.

## Quick start for a fresh session

```bash
cd eaon-cli
npm install          # if node_modules isn't already there
npm run typecheck    # tsc --noEmit — do this after every change, it's fast
npm run build         # tsc -p tsconfig.json — emits to dist/
node dist/cli.js      # run it interactively
node dist/cli.js -p "some prompt" -m agent --auto   # non-interactive, scriptable
node dist/cli.js --welcome   # preview the first-run wordmark/log-in screen even if already configured
```

There's no `npm link`'d global `eaon` guaranteed to exist — always run via
`node dist/cli.js` (or `npm run dev` for `tsx`-based hot source running)
unless you've verified otherwise.

**Also relevant:** `Eaon-desktop/Services/EaonCLILauncher.swift` resolves a
`node` binary and this CLI's `dist/cli.js` so the macOS app can embed it in a
real terminal (SwiftTerm) under the app's "Eaon Code" mode. If you rename or
move `dist/cli.js`, or change how `node` needs to be invoked, that Swift file
needs a matching update or the desktop app's embedded terminal breaks
silently (falls back to a plain login shell with a "couldn't find eaon-cli"
message).

## Architecture map

```
src/
  cli.tsx              — entrypoint, arg parsing (commander), --print (one-shot) path
  config.ts            — ~/.eaon/cli/config.json load/save, env var overrides
  platform.ts           — the ONE file with process.platform branches; isMac/isWindows/isLinux
  types.ts              — shared types: Turn, ModelEntry, EaonConfig, CustomProviderConfig, ChatStreamEvent…

  agent/
    loop.ts              — the agent loop (async generator): stream → parse tool calls → plan-gate → confirm → execute → repeat.
                           Also hosts runSubagentTask() — the nested loop behind the `task` tool.
    prompts.ts           — system prompts: agent (with autonomy rules), chat, and subagentSystemPrompt
    context.ts            — slimHistoryForRequest(): elides old tool output at request time (big local-model speed win)
    fenceParser.ts        — text-fence tool-call fallback parser (```eaon:computer tool="...") for non-tool-calling models

  providers/
    chat.ts              — streamChat(): branches on format — OpenAI-compatible / Anthropic Messages / Google Gemini
    registry.ts           — buildCatalog() merges Aqua + BYOK custom + Ollama models; endpointFor() resolves base URL/key/format
    aqua.ts, ollama.ts    — provider-specific model listing / pull

  tools/
    index.ts              — tool catalog: schemas, execution dispatch, confirmation-prompt text
    fsTools.ts             — list_directory, write_file, edit_file, read_file, move_item, create_folder, trash_item
    searchTools.ts         — grep (content regex search) + glob (filename pattern search) — added this cycle
    todoTool.ts            — todo_write — model-maintained task checklist — added this cycle
    openTools.ts            — open_app, quit_app, open_url, open_path, run_applescript (macOS)
    shellTool.ts             — run_shell (2-min timeout, output cap)
    backgroundShell.ts        — run_shell_background / check_shell / stop_shell; all jobs killed on exit
    webTools.ts               — web_search (DuckDuckGo HTML) + web_fetch; SSRF-guarded, size/redirect capped
    readTracker.ts             — read-before-edit enforcement
    pathGuard.ts              — path safety: expand ~, resolve against project root, block system paths

  link/
    localAuth.ts           — /link: reads Eaon Desktop's saved credentials straight out of macOS UserDefaults (no network)
    server.ts               — /link's local-only HTTP server + browser confirmation page

  project/init.ts          — /init: scans the project, writes EAON.md (project memory/instructions)
  session/store.ts          — /resume, /clear: JSON-file session persistence under ~/.eaon/cli/sessions/
  session/checkpoints.ts     — /rewind: pre-change file snapshots under ~/.eaon/cli/checkpoints/

  ui/
    App.tsx                 — the whole app's state machine — THIS IS THE BIG ONE, read it first
    Composer.tsx             — input line: history, slash-command autocomplete, multi-line (\ + Enter)
    ModelPicker.tsx           — /model overlay, type-to-filter, provider-grouped
    MessageView.tsx           — renders one message row (banner/user/assistant/system/tool); ThinkingIndicator lives here
    Markdown.tsx              — terminal markdown renderer (headings, code blocks w/ cli-highlight, lists, etc.)
    DiffView.tsx               — write_file/edit_file diff rendering
    PermissionPrompt.tsx        — sandboxed-mode confirm dialog
    PlanReview.tsx               — plan-mode approval dialog (renders the plan as markdown)
    EaonBanner.tsx              — per-session banner: banded wordmark + 4 dim info lines
    WelcomeScreen.tsx            — one-time first-run splash (icon art + wordmark + /link)
    Wordmark.tsx, logoArt.ts, iconArt.ts — the EAON block art and its gradient
    theme.ts, quotes.ts          — colors, startup quotes
```

**Read `src/ui/App.tsx` first in any new session.** It owns nearly all
state — messages, catalog, model, mode, permission mode, the running
generator, session persistence — and every slash command's actual behavior
is wired there (`handleCommand`), not just declared in `commands/index.ts`.

## What already works (verified this project)

- Chat + Agent modes, streaming, native tool-calling with a text-fence
  fallback for models that don't support `tools` (verified live against
  local Ollama models).
- Full tool catalog (22): `grep`, `glob`, `read_file`, `write_file`,
  `edit_file`, `run_shell`, `run_shell_background`, `check_shell`,
  `stop_shell`, `web_search`, `web_fetch`, `task` (sub-agent delegation),
  `exit_plan_mode`, `list_directory`, `create_folder`, `move_item`,
  `trash_item`, `todo_write`, `open_app`, `quit_app`, `open_url`,
  `open_path`, `run_applescript` (macOS only).
- Slash commands: `/help /mode /permission /plan /model /models /pull /init
  /clear /new /resume /rewind /diff /copy /bashes /cost /link /status
  /compact /context /doctor /config /memory /export /exit`.
- CLI flags: `-p/--print`, `-m/--mode`, `-c/--continue`, `-r/--resume`,
  `--model`, `--permission-mode`, `--auto`, `--cwd`, `--max-steps`,
  `--welcome`.
- `/link` imports Aqua API key + **all** BYOK custom providers from Eaon
  Desktop's macOS UserDefaults (OpenAI-compatible, Anthropic Messages, and
  Google Gemini formats — see "This cycle's work" below).
- Session persistence (`/resume`), project memory (`EAON.md` via `/init` and
  `/memory`).
- Three permission tiers cycled with Shift+Tab: **plan** (researches and
  proposes, refuses every mutating tool until you approve a plan),
  **sandboxed** (asks before each change), **auto** (unattended). Per-tool
  "always allow" within sandboxed.
- Checkpoints + `/rewind` — files the agent changes are snapshotted first,
  so a bad autonomous run can be undone.
- Typing while it works QUEUES the message for the next turn (shown as
  `↳ queued:`); Esc interrupts.
- A live "Thinking…" spinner with elapsed time before the first token
  arrives.
- Streaming is throttled (~25fps flush) instead of one React re-render per
  token — this was a real, confirmed lag source (see below).

## This cycle's work (most recent → oldest)

1. **Big capability cycle: plan mode, sub-agents, web tools, background
   shell, checkpoints, lighter UI** (prompt: "add all the core
   functionality Claude Code has… UI looks crappy… agentic coding better so
   the user can create big things without constantly telling the model what
   to do… no sub agents [for the research]"). Research was done first-hand
   via WebFetch against code.claude.com's slash-command, CLI-reference and
   interactive-mode docs, then gap-ranked by impact on autonomy.
   - **Plan mode** — a third permission tier (`PermissionMode` is now
     `plan | sandboxed | auto`, Shift+Tab cycles all three). In plan mode
     every mutating tool is refused with a message steering the model to
     research; `exit_plan_mode` presents the plan; approving flips the
     RUNNING loop to auto so the same turn carries straight on into the
     work (approve once, not twice). New `ui/PlanReview.tsx` renders the
     plan as real markdown with numbered options.
   - **`task` sub-agent tool** — spawns a nested `runAgentTurn` with a
     fresh conversation (`subagentSystemPrompt`), same tools/model/root,
     max 20 steps, one level deep only. The parent gets back just the
     sub-agent's final report, which is the point: delegate exploration
     without dragging its transcript into the parent's context. Injected
     via a `runSubagent` callback on the new `ToolContext` so tools/ never
     has to import agent/ (that would be circular).
   - **Web tools** — `web_search` (DuckDuckGo HTML endpoint, no API key)
     and `web_fetch` (HTML→text). Hardened: HTTPS-preferred, redirect-
     capped and re-checked per hop, size/time capped, and loopback/private/
     link-local addresses refused so it can't be pointed at internal
     services or cloud metadata (169.254.169.254).
   - **Background shell** — `run_shell_background` / `check_shell` /
     `stop_shell`. run_shell's 2-minute cap made dev servers and long
     builds impossible; these spawn detached, buffer output, and return
     only what's NEW per poll so tailing a log works. All jobs are killed
     on exit (wired into both /exit and the Ctrl+C path).
   - **Checkpoints + `/rewind`** (`session/checkpoints.ts`) — every file
     the agent is about to change is snapshotted first; `/rewind` lists
     restore points and restores one plus everything after it. Deliberately
     NOT git-based (project may not be a repo / may have a dirty tree).
     Honest scope, stated in the command's own output: covers write_file/
     edit_file/move_item/trash_item, NOT changes made by shell commands.
   - **Message queueing** — typing while the agent works now QUEUES
     (shown as `↳ queued:` lines) instead of interrupting; Esc still
     interrupts. Much better for long autonomous runs.
   - **Session/CLI parity** — `-c/--continue` (most recent session for
     THIS project), `-r/--resume <id>`, `--permission-mode`. New commands:
     `/plan`, `/rewind`, `/diff`, `/copy`, `/bashes`. Composer gained
     Ctrl+K/Ctrl+W and Alt+B/Alt+F, and Ctrl+U now kills to line start
     (readline semantics) rather than clearing everything.
   - **UI** — rendered the real output to plain text and looked at it,
     rather than guessing. The banner was ~25 lines of chrome before you
     could type (full-width box + quote + tips + recent sessions); it's now
     the wordmark plus 4 dim lines. Also: shortened the composer
     placeholder to "What should I build?", dropped the path line the diff
     repeated (the tool label now carries the full relative path instead of
     a bare basename), and collapsed blank-line runs in tool output.
   - **Two real bugs the tests caught, worth remembering:**
     (a) `read_file` was never marked `readOnly` — pre-existing, and it
     would have made plan mode *useless* (the model couldn't read anything
     while planning) on top of prompting to read files in sandboxed mode.
     (b) I initially marked `task` read-only, which was a **sandbox
     bypass**: sub-agents don't prompt, so the model could have delegated
     writes to escape sandboxed mode's gate. `task` is now gated normally,
     with an explicit exemption in plan mode (safe there because the
     sub-agent inherits plan mode).
   - Verified: 42-check suite covering htmlToText, all four SSRF refusals,
     background job lifecycle (start/poll-only-new/stop/sudo-refusal),
     checkpoint record+restore incl. deleting files created after the
     point, tool gating per mode, and the REAL agent loop driven against a
     scripted SSE server for plan-refuse → propose → approve → write,
     plan-reject → still refused, plan-mode-still-allows-research, and a
     full parent→sub-agent→report round trip. Plus schema validation on all
     22 tools. Typecheck/build clean.
   - **Not verified:** a live run against a real model — the local 4B
     rambled instead of calling tools (model quality, not the CLI; the
     scripted-server tests cover the loop mechanics far more rigorously).
     Worth a real interactive session on a capable model, especially to
     feel plan mode and `task` end to end.
   - **Still missing vs Claude Code** (deliberate, not forgotten): MCP,
     hooks, custom subagent definitions, vim mode, `/agents`, output
     styles, IDE integration, image input.

2. **Banded-gradient wordmark in the session banner** (prompt: "add the
   eaon logo like this [Hermes-Agent screenshot] — different color instead
   of orange"). The Hermes signature is a big block wordmark with hard
   horizontal color bands printed at the top of every session.
   - **`ui/Wordmark.tsx`** (new): `BandedWordmark` renders the existing
     figlet EAON art (logoArt.ts) with one solid color per row from
     `WORDMARK_GRADIENT` — an 8-step glacier cyan→blue ramp (#C6F2FF →
     #2680BE). Color choice per the user's explicit "not orange": the
     cyan/blue family is already Eaon-adjacent (user/tool colors), so the
     coral accent stays reserved for interactive chrome while the wordmark
     gets its own identity. Hard per-row bands on purpose — the banding IS
     the Hermes style, smoothing would read as antialiasing.
   - **`EaonBanner.tsx`**: the banded wordmark now opens EVERY session
     (above the compact welcome card), gated on terminal width ≥
     wordmark+2 cols; narrow terminals just get the card (which already
     names the product). Uses useStdout for columns.
   - **`WelcomeScreen.tsx`**: its previously flat-coral wordmark now uses
     the same shared component, so the treatment can't drift between the
     two surfaces. Narrow fallback text stays accent-colored (it's one
     word, not the art).
   - Verified (headless-Ink + FORCE_COLOR=3): all 8 gradient truecolors
     actually emitted, art rows confirmed NOT accent-colored anymore,
     width gating on/off, card still renders, welcome screen uses the
     ramp — 10/10. Typecheck/build clean. Not committed (not asked).
     Real-terminal eyeball still worthwhile (`node dist/cli.js`).

3. **Full UI restyle to the Claude-Code/Cursor visual language** (prompt:
   "make it look good and function good, like cursor cli and claude cli").
   The shared vocabulary of both reference CLIs: quiet neutral chrome, one
   accent, a ●-bullet left edge on every agent action, ⎿ tree-branch
   results, background-tinted diffs, dim rounded composer. Eaon keeps its
   coral accent (#F17455) as the identity marker. All in `src/ui/`, no
   logic changes:
   - **Transcript rhythm** (`MessageView.tsx`): assistant replies get a
     `● ` marker with hanging indent (Box row + flexGrow column so
     wrapping stays aligned); user prompts echo back DIM with a `> `
     prefix (both CLIs keep visual weight on answers, not questions);
     tool results connect with `⎿  ` + aligned 3-space continuations;
     tool names render plain white bold (dropped the old blue —
     `theme.toolName` now equals `assistant`; neither reference CLI
     colors tool names).
   - **Diffs** (`DiffView.tsx` rewritten): dim right-aligned gutter line
     numbers + changed lines as SOLID background-tinted blocks — new
     `diffAddedBg` #1C3A26 / `diffRemovedBg` #42232A with light
     `diffAdded`/`diffRemoved` foregrounds (was: bare colored +/- glyphs
     in a bordered box; border dropped, the tint IS the structure now).
   - **Working indicators**: braille spinner replaced by the pulsing-star
     rhythm (`STAR_FRAMES · ✢ ✳ ✻ ✽ …` in theme.ts) in both the
     pre-first-token ThinkingIndicator and the whole-turn
     GenerationStatus, which now also picks one verb per turn from
     `WORKING_VERBS` ("Working/Thinking/Brewing/Tinkering/Considering…") —
     per-mount, so the line never jitters mid-turn.
   - **Composer** (`Composer.tsx`): chrome went neutral — border is dim
     gray always, and only takes color when a prefix mode is active
     (`!` warning / `#` accent), so color always MEANS something;
     permission state no longer tints the composer (it lives in the
     footer); suggestion cursor is `❯`; `permissionMode` prop removed
     entirely (interface + App call site).
   - **Permission prompt** (`PermissionPrompt.tsx` rewritten):
     Claude-style — `● <summary> (tool)` header, detail branched under
     `⎿`, numbered options with a `❯` cursor ("1. Yes / 2. Yes, allow
     this tool for the rest of the session / 3. No (esc)"); now also
     answerable by NUMBER keys in addition to the existing y/a/n,
     arrows+Enter, Esc.
   - **Banner** (`EaonBanner.tsx` rewritten): the hand-drawn block-letter
     box (+ its exported buildBannerLayout helper — grep-confirmed no
     other references) replaced by the compact Claude-Code welcome card:
     small rounded accent box (`✻ Welcome back, <user>! · Eaon vX`, dim
     mode·model and ~-shortened cwd), quote as one dim italic line below,
     tips + recent sessions as quiet plain lines. The big art moment
     stays on the one-time WelcomeScreen (untouched).
   - **Footer + todos** (`App.tsx`): footer all-dim except auto-accept
     (`⏵⏵ auto-accept on (shift+tab)` in warning color — the one state
     that changes behavior earns the one color); todo pin restyled as a
     quiet tree with a `Todos (n/m done)` header, ☒ for completed.
   - Verified via the established headless-Ink harness (fake
     stdin/stdout through the REAL render(), `FORCE_COLOR=3` per the
     chalk-binds-to-real-stdout gotcha documented two cycles back):
     24/24 — bullets, dim codes (ESC[2m on user lines), both diff
     background truecolors (48;2;28;58;38 / 48;2;66;35;42) actually
     emitted, gutter numbers, ⎿ connectors, ❯ suggestion + permission
     cursors, number-key answers (1→approve, 2→always), composer border
     + placeholder, banner box/quote/tips/recents. Typecheck + build
     clean. NOT committed — the user didn't ask this time. Note: work
     landed on top of an external commit (b24e5f6, "Add an updater for
     Eaon CLI") that bumped the version to 0.1.2 and added
     src/updateCheck.ts + a startup notice in App.tsx — untouched here,
     and parallel uncommitted Eaon-desktop changes (updater banner UI)
     were left alone too.
   - **Not verified**: real-terminal look (colors/spacing to a human
     eye) — the harness proves structure and emitted codes, not taste.
     Worth a quick run of `node dist/cli.js` to eyeball.

4. **Fixed `/link` only ever showing the Aqua provider** (user report: "the
   only provider that is showing up is the aqua provider... pull all of the
   data"). Two real, confirmed bugs, found by directly inspecting this
   machine's actual UserDefaults data rather than guessing:
   - **The actual root cause**: `defaultsReadDataAsJSON` (`link/
     localAuth.ts`) does `defaults export <domain> -` to get the full
     domain as a plist, then `plutil -extract` just the one key it
     wants — but a real `defaults export dev.eaon.desktop -` on this
     machine is **8.8MB** (Eaon Desktop caches plenty else in UserDefaults
     beyond the one key this cares about), and Node's `execFileSync`
     defaults to a 1MB output buffer. Reproduced directly:
     `execFileSync('defaults', ['export', 'dev.eaon.desktop', '-'], ...)`
     throws `ENOBUFS` — caught by the function's blanket `try/catch` and
     silently returned as `null`, which `discoverDesktopCredentials`
     treats as "no custom providers saved" even though 3 real ones were
     sitting right there. Confirmed `defaults read domain key` can't be
     used as a workaround either — it truncates large DATA values in its
     display (verified: an 86-byte truncated dump for what should be 2536
     bytes). Fix: explicit generous `maxBuffer` (200MB, real observed
     sizes are 4-9MB) on both `execFileSync` calls in that function — kept
     the existing stdin/stdout-only approach (no temp file), which is a
     deliberate documented security property of this file (secrets never
     touch disk, even briefly) that a temp-file workaround would have
     broken.
   - **The second bug**: `discoverDesktopCredentials` returned as soon as
     the FIRST UserDefaults domain (`dev.eaon.desktop`, the release build)
     had ANY data at all, never even checking the second (`Eaon-desktop`,
     the debug build) — so a user who's run both builds at different times
     (completely normal during development) only ever gets whichever
     build's data happened to be checked first. Confirmed this is real for
     THIS user specifically: both domains have genuinely different custom
     providers saved (one shared connection, two pairs that are separately-
     added, different-`id` connections to similar-looking endpoints).
     Rewrote to scan and MERGE both domains (dedup by real `id`, dist's Aqua
     key wins if both somehow have one) instead of stopping at the first
     match — this is the literal "pull all of the data" fix.
   - **Follow-on polish, motivated by real data**: merging both domains
     means two distinct connections can share a display name (this user
     has two separately-added "Aquadevs" providers, one per build) — added
     `sourceDomain` to `DiscoveredCustomProvider` and a `domainLabel()`
     helper (`"dev.eaon.desktop"` → "release build", `"Eaon-desktop"` →
     "debug build"), used to disambiguate ONLY colliding names (both on
     the picker page and in `/link`'s closing summary message) so the
     common single-build case stays uncluttered.
   - **Verified against this machine's REAL UserDefaults data end-to-end**,
     not synthetic mocks: the actual fixed `discoverDesktopCredentials()`
     now returns the Aqua key plus all 5 real custom providers across both
     domains (previously: Aqua key only); rendered the actual `/link`
     browser page (via a real local server, `fetch()`ed directly — never
     called `open()`, so no real browser was launched — then immediately
     POSTed `/cancel` to clean up) and confirmed all 5 provider checkboxes
     appear with the two "Aquadevs" entries correctly disambiguated as
     "(release build)"/"(debug build)". Also grepped the whole codebase
     for other unguarded `execFileSync` calls that could hit the same
     buffer-limit bug class — confirmed the two fixed here were the only
     ones actually at risk (the other two calls in this same file read a
     single small key, or discard stdout entirely, so `maxBuffer` was
     never actually a concern there). Typecheck/build clean.

5. **Real Eaon app-icon rendered as terminal block art, added to
   WelcomeScreen** (prompt: "add the eaon logo [the actual icon image] into
   that same format"). Sits above the wordmark as an icon+logotype lockup.
   - **`ui/iconArt.ts`**: generated from the REAL icon file (the user
     shared it — `Eaon.jpg`, 1024x1024) via a small Python/Pillow pipeline,
     not hand-drawn or guessed. Measured the real colors directly from the
     image first (`img.getpixel(...)` at known interior points) rather
     than assuming: background is pure `#000000` (so treating near-black
     as transparent blends seamlessly with a terminal's own black bg),
     the field color is `#F68A66` — note this is close to but NOT the same
     as `theme.accent` (`#F17455`) used everywhere else in the CLI; used
     the real measured value for fidelity to the actual logo rather than
     silently forcing it to match the theme, worth knowing if that
     divergence ever needs reconciling — and the mark is pure `#FFFFFF`.
     Downsampled to 44x44 with `Image.BOX` (true area-average — compared
     against `LANCZOS` at the same sizes and they agreed almost exactly,
     so no ringing-artifact risk either way) after first checking 36x36
     lost the triangle mark almost entirely (thin features vanish
     disproportionately at low res) and 48-60x confirmed clearly readable;
     44x44 was the compact/legible balance. Colors are the true
     area-averaged RGB per pixel (NOT palette-snapped to 3 flat colors) so
     edges anti-alias smoothly instead of looking like hard pixel-art —
     only 41 unique colors resulted in practice since it's a flat 2-tone
     source. Deduped into a palette + index grid, `-1` = transparent.
   - **Rendering** (`IconArt` in `WelcomeScreen.tsx`): classic half-block
     technique — 2 source pixel-rows packed into 1 terminal row via `▀`
     (its own foreground paints the cell's top half, background paints the
     bottom half), giving a roughly-square 44x22 render instead of a
     vertically-squashed one. `▄`/plain-`▀`/space fallbacks for
     partially- or fully-transparent cells. Built once via `useMemo` — as
     a WelcomeScreen sibling of the pulsing prompt/spinner, it doesn't
     re-render on their ticks anyway (React re-renders don't propagate
     sideways to siblings), but memoized to be explicit about it.
   - **New responsive gate**: the icon needs real vertical room (~40 rows
     for icon+wordmark+chrome together) that the existing width-only
     `fitsFullArt` check didn't cover — added a `stdout.rows`-based check,
     defaulting to SHOWING the icon when height is unknown rather than
     assuming too little.
   - **Verified with real measured colors, not just structure** — and this
     surfaced a genuine gap in every headless-Ink test this project has
     run so far, worth remembering for next time: Ink's colorize.js
     imports a single GLOBAL `chalk` instance, which detects color support
     from the REAL `process.stdout` (this sandboxed shell's, which isn't a
     TTY — `process.stdout.isTTY` is `undefined` here), not from whatever
     fake stdout stream gets passed into Ink's own `render()` options. So
     every earlier headless test this session technically only verified
     TEXT content (via stripAnsi), never actual color application — those
     checks are still valid as behavior/content tests, they just never
     happened to claim color correctness specifically. Caught this by
     writing an assertion that specifically expected real hex-derived
     truecolor codes (246;138;102 for the measured orange, etc.) and
     watching it fail; root-caused via chalk's own source rather than
     assuming the harness was fine or the code was broken; confirmed the
     fix with `FORCE_COLOR=3` (the standard override for exactly this
     class of problem), which made the real measured RGB values — orange,
     white, and even the anti-aliased edge blends — appear as correct
     `38;2;R;G;Bm`/`48;2;R;G;Bm` truecolor sequences. Final suite: 9/9,
     covering the half-block render, both real measured colors present as
     truecolor, coexistence with the wordmark, the new height fallback
     (both a too-short terminal and an unknown-height terminal), and the
     pre-existing width fallback still intact. Typecheck/build clean; temp
     scripts deleted after use.
   - **Also noticed, unrelated to this change**: the real
     `~/.eaon/cli/config.json` legitimately changed during this session
     (new mtime, real `aquaApiKey`/`selectedModelKey` content) — audited
     every test script run this cycle and confirmed none of them could
     have written it (isolated temp `$HOME`, or a fully mocked `onLogin`
     with no real save path); this reads as the user's own normal use of
     the CLI between messages, not a side effect of anything here, but
     flagging per this project's own "never silently assume, disclose
     what you notice" standard.
   - **Not verified**: actual visual/color judgment in a real terminal, same
     caveat as the wordmark itself — worth a `--welcome` look.

6. **First-run welcome/log-in screen + real ASCII wordmark** (prompt: "make
   the CLI look cool, show the EAON logo like [reference image] on first
   install, press-any-key opens the browser to import providers from Eaon
   Desktop"). New, not a tweak to the existing in-app banner (EaonBanner.tsx,
   untouched) — that one's a dense returning-user card; this is a rare,
   once-per-install moment, so it's deliberately spacious/theatrical instead
   (see the frontend-design skill's guidance this was built against).
   - **`ui/logoArt.ts`**: the EAON wordmark, generated via `figlet -f
     univers.flf EAON` (installed via `brew install figlet` — local,
     reversible, one-time generation aid; not a runtime dependency, the
     output is baked in as a static string array so end users never need
     figlet). Chosen after comparing ~15 candidate fonts against the
     reference image — `univers` was the closest real match to its 3D-
     shaded block vocabulary (`db`, `Y8,`/`,8P`, `8b`/`dP`), confirmed by
     printing both side by side, not eyeballed from memory. Regeneration
     command is in the file's own doc comment.
   - **`ui/WelcomeScreen.tsx`**: centered wordmark (accent color) + version
     line (muted) + a slow-pulsing green "Press any key to log in…"
     (mirrors the reference exactly; falls back to "…to continue" on non-
     macOS, where /link has nothing to connect to). Any key (not Ctrl+C,
     which is left to the app-level double-press exit) triggers the REAL
     `handleLink` — reused as-is, not reimplemented, so there's exactly one
     "what /link does". Shows a spinner while waiting on the browser, Esc
     skips the wait (the link attempt keeps running in the background —
     safe, since handleLink already can't crash the process per last
     cycle's hardening), and a brief closing line ("✓ Connected — …",
     "No Eaon Desktop found — continuing…", etc.) before auto-advancing.
     Narrow terminals (<58 cols) fall back to plain "EAON" text instead of
     an overflowing 54-col block. `cli.tsx`/`config.ts`/`platform.ts`
     untouched beyond a new `--welcome` debug flag (see below).
   - **`handleLink` now returns a `LinkOutcome` tag** (was `void`) — every
     branch (`linked`/`nothing_selected`/`nothing_found`/`cancelled`/
     `timed_out`/`no_platform_support`/`error`) instead of a bare early
     `return`, so WelcomeScreen can show a real closing message instead of
     jumping silently. `/link`'s own command handler still just awaits it
     and ignores the value — fully backward compatible.
   - **First-run gate**: `!fs.existsSync(configFile())` in `App.tsx` — no
     config file on disk yet IS "first install". Whatever ends the welcome
     screen (linked or not) calls `saveConfig(config)` so a config file
     always exists afterward and the screen can never show a second time,
     even down paths that don't already save one themselves.
   - **`--welcome` CLI flag**: force-shows the screen even with an existing
     config — added because the user's OWN config file already existed
     from earlier sessions' testing, so the natural gate wouldn't have let
     them see this without it.
   - **Verified far more thoroughly than prior UI work in this project**:
     rather than falling back on the documented pty-is-unreliable-here
     excuse, built a real headless Ink test harness — a fake `stdin`
     (Node `Readable` with `isTTY`/`setRawMode`/`ref`/`unref` stubbed, which
     is ALL Ink's `App.js` actually reads) and fake `stdout` (captures
     writes, strips ANSI) passed straight to Ink's real `render()`. This
     sidesteps the pty layer entirely — no real tty, so none of the
     keystroke-timing races that made `expect`-based testing unreliable
     apply. Drove the REAL `WelcomeScreen` and the REAL `App` (not mocks)
     through: renders wordmark/version/prompt copy, does NOT call
     onLogin/onFinish before a keypress, a keypress calls the real
     `handleLink` and shows the connecting spinner, Esc-while-connecting
     skips immediately, Ctrl+C is correctly ignored by this screen, non-mac
     copy switches correctly with no caption, narrow terminal falls back to
     plain text, the full happy path (key → connecting → "Connected" →
     auto-finish after ~1.2s) — 19/19 checks, plus a separate 6/6 App-level
     integration pass confirming fresh-install shows the screen,
     already-configured skips straight to the normal composer, and
     `--welcome` forces it. One flake surfaced and was root-caused (not
     hand-waved): 5 `setImmediate` ticks weren't enough for Ink's real
     render scheduler to flush to the fake stdout; adding a genuine ~80ms
     wait fixed it — a real, explained timing fact, not a shrug. Deliberately
     never simulated a keypress against the real `App` (only against
     WelcomeScreen with a mocked `onLogin`) — on this dev Mac that would
     invoke the REAL `discoverDesktopCredentials`/`runLinkServer`/`open`,
     popping an actual browser tab as a side effect of an unattended test,
     which isn't acceptable regardless of how safe the underlying feature
     is. Also confirmed via file mtime that the real
     `~/.eaon/cli/config.json` was never touched by any of this (every test
     used a temp `$HOME`). Typecheck/build clean; temp test scripts deleted
     after use, nothing left in the repo.
   - **Not verified**: actual visual/color judgment in a real terminal —
     the harness proves correctness of state/logic/content, not "does it
     look good to a human eye." Worth an actual look with `--welcome`.

7. **Agent-loop hardening + speed pass** (prompt: "make it work like Claude
   Code, make agentic coding better and faster"). This cycle went after the
   loop itself, driven by failures actually observed in the previous
   cycle's live runs (a model calling tool "write" and burning a corrective
   round-trip; runs dying on transient errors; context bloat slowing every
   local-model turn):
   - **Tool-name alias rescue** (`TOOL_ALIASES`/`resolveToolName` in
     `tools/index.ts`, applied in `agent/loop.ts`): ~60 unambiguous
     aliases (write→write_file, bash/sh/exec→run_shell, cat→read_file,
     str_replace→edit_file, ls→list_directory…) canonicalize instead of
     erroring — each rescue saves a whole model round-trip. The canonical
     name must also be in the mode/platform's tool set. Unknown names still
     get the corrective-error path.
   - **Fence tolerance**: attributed fences accept unquoted tool names
     (tool=write_file) and alias names; the bare-name form (```bash) stays
     canonical-only ON PURPOSE — a ```bash code block in prose must never
     silently become a run_shell call (tested).
   - **Transient-error retry with backoff** (`agent/loop.ts`): 429/5xx/
     can't-reach retries up to 2× (1s, 3s), abort-aware, and ONLY when
     nothing has streamed yet (a mid-reply failure never retries — no
     duplicated partial content). A visible "retrying (1/2)…" step_error
     is emitted. Hard errors (400/401) never retry. The old tools-400
     retry-without-tools behavior is preserved alongside.
   - **Request-time context slimming** (`agent/context.ts`,
     `slimHistoryForRequest`): all but the most recent 6 tool results are
     elided to first-line + "[N chars elided — call the tool again]" stubs
     at request time only (stored history/UI/resume/export untouched;
     results <400 chars never slimmed). Biggest practical latency lever
     for local models, where prompt length ≈ processing time.
   - **`read_file` offset/limit** (1-based line slice, tolerant of
     string-typed numbers) and **`edit_file` replace_all** (multi-match
     error now reports the count and points at replace_all) — both cut
     forced re-read/retry round-trips. `read_file`'s no-such-file error now
     steers to write_file (this exact hesitation killed a live run:
     the model read a nonexistent file, got a bare error, and gave up —
     with the steering text the same model then completed the task).
   - **callId threading**: tool_call_requested/tool_result events carry the
     loop's call id; App matches rows by it (name-based fallback kept).
     Also fixed a latent glitch found while in there: a DENIED tool call
     never got a tool_result event, so its row stayed "pending" (◌) in the
     live region forever. Deny now emits a result.
   - **Persistent working indicator**: `GenerationStatus` in App.tsx —
     spinner + elapsed seconds + esc/redirect hints for the whole turn
     (tools included), Claude-Code style. `SPINNER_FRAMES` moved to
     theme.ts (shared with ThinkingIndicator).
   - Verified: 27-case unit script (aliases, fence forms incl. the ```bash
     safety case, slimming incl. non-mutation, read slices, replace_all) —
     all pass; a fake-SSE-server suite driving the REAL runAgentTurn — 13
     checks: 500→retry→success with measured ~1s backoff and exactly 2
     requests, 401 stops with no retry, and a native "write"-alias call
     that canonicalizes, executes (file really written), pairs by callId,
     and finishes clean; plus a live nemotron-3-nano:4b run that wrote
     fizz.py and its function verified correct by an independent python3
     run. Typecheck/build clean. UI bits (status line, deny-row fix) still
     need an interactive eyeball per the pty caveat below.

8. **Big reliability + Claude-Code-parity + agentic pass** (prompt: "add
   everything Claude Code has, make the UI look like Claude Code, make
   agentic coding better, it's lagging/crashing — fix it"). Scoped
   deliberately: told the user up front that "everything" isn't a
   one-shot and did a cohesive high-value slice rather than 40 shallow
   half-features. What landed:
   - **Found the REAL remaining lag** (3rd report — the earlier "fixed the
     quadratic highlight" only covered highlighting). `Markdown.parseBlocks`
     still ran over the WHOLE growing message and re-laid-out every block
     node in Yoga on every ~40ms flush → still O(n²) in reply length. Fix:
     `MessageView` now renders a streaming assistant message (and long
     reasoning) as a single bounded plain-text node (`StreamingText`,
     tail-capped at 6k chars); the full Markdown render happens exactly
     once when the finished message commits to `<Static>`. This is the
     structural fix the previous cycle missed.
   - **Render error boundary** (`ui/ErrorBoundary.tsx`) wraps every message
     row. A throw inside any message's render (bad diff, regex, unexpected
     shape) now degrades to one fallback line instead of unmounting the
     tree and wrecking the terminal — a real anti-crash measure on top of
     last cycle's process-level `uncaughtException` net.
   - **Claude-Code UI**: tool rows are now `● Tool(arg)` with the result
     branched under a `⎿` connector (`MessageView.ToolMessage` +
     `toolInvocationLabel` in `tools/index.ts`); composer uses a `>` prompt
     (or `!`/`#` glyph), a placeholder, and an `⏵⏵ auto-accept · shift+tab`
     bottom-bar indicator; bottom bar shows mode · model · tokens.
   - **Input affordances (Claude-Code parity)**: `!cmd` runs a shell
     command directly and folds its output into context (doesn't trigger a
     model reply); `@path` mentions autocomplete from a lazily-built,
     session-cached project file index (`listProjectFiles` in
     `searchTools.ts`) and expand into the model's turn (the on-screen
     message stays as typed); `#note` appends to EAON.md. All wired in
     `App.tsx` (`handleBash`/`handleMemoryNote`/`expandMentions`/
     `queryFiles`) and documented in `/help`.
   - **Read-before-edit guard** (`tools/readTracker.ts`): `edit_file` and
     overwriting an existing non-empty file via `write_file` are refused
     with a corrective nudge unless the file was read (or written) this
     session — prevents blind-clobbering a file the model is guessing at.
     Reset on `/clear` and `/resume`. Agent prompt updated to state this
     rule (so the guard reads as expected, not a surprise) plus
     parallel-reads / verify-by-running / don't-stop-early guidance.
   - Verified: typecheck + build clean; a 13-case direct tool-layer test
     (read-before-edit happy/blocked paths, overwrite guard, new-file
     allowance, `listProjectFiles`, label formatting) all pass; two live
     `nemotron-3-nano:4b` agent runs — one confirmed the guard fires then
     the model reads then proceeds (the seeded file was NOT clobbered), one
     confirmed the create-and-run happy path still completes cleanly.
     **Not verifiable headlessly:** the UI itself — `-p` mode bypasses
     Ink/React entirely, and pty capture is unreliable here (see Testing
     methodology). The streaming-lag fix, the ●/⎿ tool rows, the composer
     `!`/`@`/`#` modes, and the error boundary all need a real interactive
     spot-check before they're fully trusted.
   - **Consciously deferred** (told the user): MCP/plugins, sub-agents/Task
     tool, image gen, plan mode, `/vim`, hooks, `--continue`, and the long
     tail of Claude Code slash commands. "Everything" is a direction here,
     not a finish line.

9. **`/link`'s browser page is now a picker, not all-or-nothing.** Every
   discovered item (Aqua API key, each BYOK custom provider) gets its own
   checkbox — checked by default so the old "import everything" behavior
   is still one click away — plus a Select all/Select none toggle. Only
   what's actually checked when "Import selected" is clicked gets merged
   into the CLI's config.
   - `link/localAuth.ts`: new `LinkSelection { includeAquaKey,
     selectedProviderIds }` type; `applyDiscoveryToConfig` now takes a
     selection and only merges the chosen items (added `selectAll()` for
     the "everything" case).
   - `link/server.ts`: `renderPage`'s pending state renders a real
     `<form>` of checkboxes (`name="aqua"` / `name="provider_<id>"`); the
     `/approve` POST body is read and parsed
     (`readRequestBody`/`parseSelection`) to build the actual
     `LinkFlowResult`, which now carries `includeAquaKey` +
     `selectedProviderIds` instead of just a boolean. The approved-state
     page shows exactly what was picked (✓/– per row), and an all-
     unchecked submit renders "Nothing imported" instead of a misleading
     "Connected". The request handler is now async (needed to await the
     body read) with its own local error catch, on top of last cycle's
     process-level safety net.
   - `App.tsx`'s `handleLink()` builds its "Linked ✓" summary from the
     real selection (e.g. "2 of 3 custom providers (Together AI, Local
     vLLM)"), not blind discovery counts, and reports a distinct "nothing
     was checked" outcome rather than falsely calling an empty-selection
     submit a success.
   - Verified with a direct Node script against the real running server
     (not just typecheck) — GET renders all three checkboxes + skipped-
     count + Select all/none; POSTing a body with only one of two
     providers checked resolves the exact partial selection; an
     all-unchecked submit and a plain /cancel both correctly resolve to
     nothing; an all-checked submit matches the old default behavior.
     16/16 checks passed. This still isn't a substitute for actually
     clicking checkboxes in a real browser, though — worth a quick manual
     /link if you touch this page again.

10. **Crash/glitch fixes ("it keeps crashing and glitching") + a small visual
   polish pass** — three separate, concrete bug classes, each verified
   against source (Ink's own, not just this repo's) before fixing, per this
   project's own "don't fabricate results" rule:
   - **`<Static>` misuse**, confirmed by reading `node_modules/ink/build/
     components/Static.js` directly: it only ever renders
     `items.slice(alreadyRenderedCount)` and NEVER re-renders an item once
     committed. Two real consequences: (a) tool-call rows were pushed into
     the Static-fed `completed` list the instant they were requested
     (`pending: true`), then mutated in place once the result landed — so a
     tool call's final ✓/✗ silently never appeared, permanently stuck on
     "pending" in the scrollback; (b) `/clear`, `/resume`, and `/compact`
     all wholesale-replace `messages` (`setMessages([])` or a fresh array)
     without remounting `<Static>`, so its internal "already rendered"
     counter went stale against the new (shorter) array — a resumed
     session's transcript, or `/compact`'s own summary message, could
     silently never render at all. Fixed by keeping pending tool rows in
     the same non-Static "live" path as the streaming assistant message
     until they resolve (`isLive` in `App.tsx`), and by keying `<Static>`
     on a new `historyEpoch` counter bumped on `/clear`/`/resume`/
     `/compact` so React remounts it cleanly instead of leaving it desynced.
   - **No crash safety net anywhere**: zero `process.on('uncaughtException'
     /'unhandledRejection')`, and `runLoop`/`handleCommand` both run
     fire-and-forget (`void runLoop()`) with no `.catch` — so Node's
     default (kill the whole process on an unhandled rejection) applied to
     any exception escaping a handful of real gaps: `/memory`'s unguarded
     `fs.writeFileSync`, `handleCompact`'s `try/finally` with no `catch`,
     `handleLink`'s server-startup section, and `link/server.ts`'s
     `http.createServer` having no `.on('error', …)` (an unhandled
     EventEmitter `error` event throws synchronously). Fixed all of the
     above, plus added global `uncaughtException`/`unhandledRejection`
     handlers in `cli.tsx` (log to `~/.eaon/cli/crash.log`, never exit) as
     a last-resort net for whatever isn't covered locally.
   - **Non-TTY stdin crash**: Ink's `useInput` calls `setRawMode(true)`
     unconditionally with no `isRawModeSupported` guard (confirmed in
     `node_modules/ink/build/hooks/use-input.js`) — if stdin isn't a real
     TTY (piped input, or a pty that doesn't expose raw mode), it throws
     inside a `useEffect` with no error boundary anywhere in this tree,
     killing the process instantly with a cryptic stack. Relevant given the
     Mac app embeds this CLI via SwiftTerm (`EmbeddedTerminalView.swift`) —
     worth checking that PTY setup if this specific crash resurfaces. Added
     a pre-flight `process.stdin.isTTY` check in `cli.tsx` before
     `render()` that prints a clear, actionable message and exits cleanly
     instead of letting Ink's internals throw.
   - **Composer empty-state placeholder** (`Type a message… ( / for
     commands)`) — small, low-risk visual polish. Checked Gemini CLI's own
     architecture (also Ink-based, same component taxonomy: banner/
     message/diff/dialog components) and confirmed Eaon's existing UI —
     built for Claude Code parity in an earlier cycle per this file's own
     history — was already well-aligned structurally. The bugs above were
     the more likely actual source of "doesn't look right," not the static
     design, so this pass stayed intentionally small rather than
     re-designing what was already deliberate.
   - Verified: typecheck/build clean, plus a real live run against
     `ollama:nemotron-3-nano:4b` in `--auto` agent mode that exercised
     `write_file` + `todo_write` end-to-end successfully (a first attempt
     hit the model calling a wrong tool name — unrelated small-model
     flakiness already handled gracefully by the existing failure-signature
     logic, not a bug). The `<Static>` fix itself can't be exercised via
     `-p` mode (that path bypasses Ink/React entirely — see `runOneShot` in
     `cli.tsx`), so per this project's own testing methodology, a quick
     interactive spot-check (trigger a tool call, confirm the row updates
     from pending to ✓ instead of freezing; try `/resume` on an older
     session) is worth doing before fully trusting it live.

11. **`/link` connects ALL configured providers**, not just Aqua + OpenAI-
   compatible BYOK. Root cause: `providers/chat.ts` only spoke the OpenAI-
   compatible wire format, so `link/localAuth.ts` silently *skipped* any
   custom provider saved in Anthropic Messages or Google Gemini native
   format. Fixed by:
   - Adding `format?: CustomProviderFormat` to `CustomProviderConfig`
     (`types.ts`), threaded through `registry.ts`'s `endpointFor()` and
     `agent/loop.ts` / the `/compact` summarizer in `App.tsx`.
   - Porting the Mac app's `CustomProviderAPIService.streamAnthropicMessages`
     / `streamGoogleGemini` (in `Eaon-desktop/Services/CustomProviderAPI.swift`)
     into two new generator functions in `providers/chat.ts`.
   - `localAuth.ts` no longer filters by format — it imports all three and
     only skips a genuinely unrecognized format string.
   - **Caveat, same as the Mac app:** Anthropic/Gemini providers don't get
     native function-calling (different `tool_use` wire shape) — they still
     get full agent capability via the text-fence fallback taught in every
     system prompt regardless of format.
   - Verified: typecheck/build clean, plus a real local fake-SSE-server test
     confirming both new streaming paths correctly extract text end-to-end
     (see "Testing methodology" below for why this mattered).

12. **Performance fix (the "it's lagging" report) + interrupt + thinking
   indicator:**
   - **Root cause of lag:** streaming pushed a full `setMessages` (→ full
     Markdown re-parse, and for code blocks a full `cli-highlight`
     re-tokenize of the whole growing block) on *every single token*. For a
     code-heavy reply this was quadratic in the reply's length. Fixed by
     buffering deltas and flushing to React state on a fixed ~40ms cadence
     (`runLoop` in `App.tsx`), and by skipping syntax highlighting entirely
     while a code block is still streaming (`Markdown.tsx`/`CodeBlock` —
     highlights once, for real, when the block finishes; `useMemo`-cached).
   - **Interrupt:** the composer used to be fully locked (`isActive =
     !isGenerating && ...`) — Escape couldn't even reach the cancel handler
     while generating. Now the composer stays active during generation;
     Enter while generating aborts the in-flight turn and, once it's
     actually finished unwinding (`interruptResubmitRef` picked up in
     `runLoop`'s `finally`), sends the new message as the next turn — avoids
     two turns racing on `turnsRef`.
   - **Thinking indicator:** `MessageView.tsx`'s new `ThinkingIndicator`
     component — a spinner + elapsed-seconds readout with its own local
     `setInterval`, so it doesn't add any extra re-renders to the rest of
     the tree.

13. **Claude-Code-parity pass:**
   - New tools: `grep` (regex content search, skips `node_modules`/`.git`/
     build dirs, handles binary files and bad regex gracefully — see
     `tools/searchTools.ts`), `glob` (filename pattern match,
     most-recent-first), `todo_write` (model-maintained checklist, pinned
     above the composer while incomplete — `tools/todoTool.ts`).
   - New commands: `/compact` (has the model summarize the conversation,
     replaces `turnsRef.current` with the summary, shows before/after token
     counts), `/context` (approximate token breakdown by role), `/doctor`
     (Node/Ollama/Aqua/config/EAON.md/catalog checks), `/config` (config
     path + redacted settings), `/memory` (opens/creates `EAON.md`),
     `/export` (writes the transcript as Markdown).
   - Model picker (`ModelPicker.tsx`) rewritten with type-to-filter search
     and provider grouping (`[aqua]`/`[byok]`/`[local]`).
   - **Eaon Claw folded into Agent** (matching the same merge already done
     in the Mac app) — Agent now gets the full tool catalog including the
     app/URL/AppleScript tools that used to be Claw-only. `/mode claw` and
     old saved Claw sessions map to Agent gracefully
     (`agentTools()`/`toolsForMode()` in `tools/index.ts`).

## Known gaps / stale docs — do these next if asked to keep improving

- **`README.md` is stale.** Still describes a 3-mode (Chat/Agent/Claw) setup
  and doesn't mention `grep`/`glob`/`todo_write` or the new slash commands.
  Update it before anyone reads it as current docs.
- **No automated test suite.** Everything so far has been verified via
  `npm run typecheck`, `npm run build`, direct Node script invocation of
  individual functions (see below), and live runs against a real local
  Ollama model. There's no `npm test`. If the user wants real regression
  coverage, that's greenfield work.
- **Anthropic/Gemini streaming is implemented from public docs, not
  live-tested against a real key** (same honest caveat the Mac app's own
  Swift implementation carries — see its doc comment). If a user reports
  either format breaking, that's the first place to suspect a real API
  shape drift, not a logic bug.
- **No image generation, no MCP/plugin support in the CLI** (the Mac app has
  both). Not started — flag to the user before assuming scope.
- **Windows is untested.** `platform.ts` has the branches (`shellInvocation`,
  `isWindows`, protected-path lists in `pathGuard.ts`), and the stack
  (Node + Ink) is nominally cross-platform, but nobody has actually run this
  on Windows this project. Don't claim it works without checking.
- **`eaon-cli`'s `handleSubmit`/interrupt logic and the `ThinkingIndicator`
  were reviewed carefully but could not be verified via an automated pty
  capture this session** — see "Testing methodology" below. Worth a real
  interactive spot-check if you touch that code path.

## Testing methodology — READ THIS BEFORE YOU CONCLUDE SOMETHING IS BROKEN

Verification tools used successfully in this project, in order of
preference:

1. **`npm run typecheck` / `npm run build`** — fast, catches real breakage,
   run after every change.
2. **Direct Node script testing of pure functions** — the most reliable way
   to verify logic without a TTY. Example pattern (works great for
   `tools/*.ts`, `providers/chat.ts`, `link/localAuth.ts`):
   ```bash
   node --input-type=module -e "
   import { grepSearch } from './dist/tools/searchTools.js';
   console.log(grepSearch({ pattern: 'foo' }, { projectRoot: process.cwd() }));
   "
   ```
   For the two provider streaming formats, a genuinely useful pattern is
   spinning up a tiny local `http.createServer` that emits real SSE
   payloads shaped like the actual API, then pointing `streamChat` at it —
   this caught real bugs and is much more trustworthy than eyeballing the
   code.
3. **Live runs against a real local Ollama model** for end-to-end agent-loop
   behavior (tool calls, file writes, actual execution) — e.g.
   `node dist/cli.js -p "..." -m agent --auto --model "ollama:nemotron-3-nano:4b"`
   then inspect the filesystem for real output. `deepseek-r1:7b` was too
   slow for quick checks in this environment; `nemotron-3-nano:4b` is fast
   and reliable for smoke tests.
4. **⚠️ `expect`/pty-based interactive capture is UNRELIABLE in this
   environment for verifying Enter/keystroke submission** — repeatedly,
   across multiple sessions, sending text + `\r` (even with realistic
   human-typing delays via `send -h`) to a spawned `node dist/cli.js`
   process under `expect` results in the Enter keystroke never being
   processed as a distinct submit — the composer buffer fills with the
   typed text but nothing sends, and this reproduces identically whether
   it's a real bug or not. This has been **independently confirmed to be a
   test-harness artifact, not a real CLI bug**, via the actual user's own
   real terminal screenshots working correctly on the same code paths. If
   you hit this while verifying something, do not conclude the CLI is
   broken — say plainly that automated pty verification wasn't conclusive
   here and ask the user for a quick manual check, exactly as was done
   for the interrupt/thinking-indicator work this cycle.

## Design principles established across this project (follow these)

- **Dual-channel tool calling, always.** Every tool is offered via native
  `tools`/`tool_calls` AND taught as a `​```eaon:computer tool="name"`
  fenced block in the system prompt (`agent/prompts.ts`,
  `agent/fenceParser.ts`). Smaller/local models often ignore or mishandle
  the `tools` array — the fence fallback is not optional scaffolding, it's
  load-bearing for half the models this CLI targets.
- **Real failures get a `failureSignature`; three identical ones in a row
  stop the loop** (`agent/loop.ts`) — prevents burning tokens/tool calls
  forever on a model stuck retrying the same malformed call.
- **A reply that's only internal thinking, with nothing after it, is bounced
  back with a corrective nudge**, not silently treated as "done" — models
  observed doing this live (Nemotron, DeepSeek) and going silent otherwise.
- **No secrets ever touch disk in plaintext, even briefly** — `/link`'s
  UserDefaults reads pipe `defaults export`/`plutil -extract` through stdin,
  never a temp file.
- **Path safety is centralized in one file** (`tools/pathGuard.ts`) —
  anything that writes/moves/deletes goes through `normalizePath` +
  `isModifiablePath`/`guardModifiable`. Never hand-roll a path check
  elsewhere.
- **Every OS-specific branch lives in `platform.ts`** — grep that one file
  to audit cross-platform gaps instead of hunting `process.platform` across
  the codebase.
- **Verify before claiming done.** This whole project has been built under
  a "don't fabricate results" discipline — web search / live curl / real
  local model runs / real fake-server tests before shipping a claim about
  behavior, not just code that type-checks. Keep doing that; it's caught
  real bugs every time it's been applied (a misattributed quote, a stale
  closure in `/link`, the quadratic markdown-highlight lag, several others).

## Where to find the reference behavior when unsure

- **Tool semantics, safety rules, confirmation copy:**
  `Eaon-desktop/Services/DesktopControl.swift` (Swift, macOS app).
- **Agent loop shape, mode merge history (Claw→Agent):**
  `Eaon-desktop/ViewModels/ChatViewModel.swift`, and the top-level
  `handoff.md` in the repo root (long — covers the Mac app's Agent-mode
  history in detail, not CLI-specific, but explains *why* certain rules
  exist, e.g. the thinking-only-reply nudge, the failure-signature stop).
- **How the CLI is meant to be launched from the desktop app:**
  `Eaon-desktop/Services/EaonCLILauncher.swift`,
  `Eaon-desktop/Views/EaonCodeHomeView.swift`,
  `Eaon-desktop/Views/EmbeddedTerminalView.swift` (SwiftTerm wrapper).
