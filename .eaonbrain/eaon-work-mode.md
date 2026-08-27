---
title: Eaon Work mode
tags: [eaon-desktop, eaon-work, workspaces, agentic-coding, tools, approvals, pull-requests, gh-cli]
created: 2026-08-21T00:00:00.000Z
updated: 2026-08-22T00:00:00.000Z
---

# Eaon Work mode

See [[Eaon Desktop architecture]] for the base process split. This note covers
the coding-agent product mode added on top of it.

## What changed and why

The user showed a screenshot of ChatGPT's product switcher (`ChatGPT Work` /
`Codex`, each with a one-line description and a checkmark) and asked for the
same shape: a fixed two-item switcher instead of the old arbitrary
multi-workspace creator (Work / Personal / "New workspace"). Second item is
"Eaon Work" — agentic coding, explicitly asked to be "capable of agentic
coding and running commands."

## Data model

`Workspace` (`shared/types.ts`) gained `kind: 'chat' | 'work'` and
`cwd?: string | null`. The switcher is now exactly two fixed entries, id
`work` (kind `chat`, name "Eaon") and id `eaon-work` (kind `work`, name "Eaon
Work"), no more free-form creation. `Sidebar.tsx`'s `WorkspaceMenu` renders
them via `MenuItem`'s `description` prop, which already existed for a taller
two-line row — no new component needed.

**Migration** (`store.migrateWorkspaces()`, called once in `index.ts`
`app.whenReady()` before anything else reads workspaces): old installs had
real user-created workspaces (this session's dev machine had three: Work,
Personal, Workspace 3). Rather than drop chats/projects that lived in the
discarded ones, anything not in the canonical two ids gets its
`workspaceId` rewritten to the chat workspace's id, so nothing disappears
from view. Confirmed against the real on-disk `workspaces.json` during
testing — folded correctly, chat history intact.

## How the coding tools work

Three local tools in `main/localTools.ts` — `read_file`, `write_file`,
`run_command` — are NOT MCP; they're merged into the existing MCP tool list
inside `providers.ts`'s `selectTools()` (`[...getTools(), ...localToolsFor(request.cwd)]`)
so the pre-existing Anthropic/OpenAI tool-call loop picks them up for free.
`StreamRequest` grew a `cwd: string | null` field (renderer's `send()`
resolves it from the active workspace when `kind === 'work'`); tools are
offered only when `cwd` is set, i.e. only after the user picks a project
folder.

**Project-folder picker moved once already** — v1 was a `WorkFolderBar`
banner pinned above the chat thread (reused `.browser__banner`). v2 (this
session, once the user supplied Codex reference screenshots) replaced it
with a `.project-bar` button stacked *above* `Composer`'s `.composer` box,
using the exact same negative-margin/z-index overlap trick `.tray` already
used to stack *below* it (`.tray{margin:-18px ...; z-index:1}` vs
`.composer{z-index:2}`) — mirrored, not reinvented. Only shown on the home
composer (`variant==='home'`) when the active workspace is Eaon Work; the
old Plugins/browser `.tray` is hidden in that case instead (Codex's
reference has no plugin tray on its home screen). If `WorkFolderBar` or
`.browser__banner`-for-cwd ever resurfaces, that's a regression — the
project bar is the current single source of that affordance.

**Safety, deliberately scoped down:**
- `read_file`/`write_file` resolve against `cwd` and hard-refuse anything
  that escapes it (`resolveInProject` in `localTools.ts`) — no bypass flag,
  by design, to avoid over-building. `run_command` runs a real shell in
  that `cwd`, so a `cd ..` inside the command isn't stopped — this is a
  known, accepted limitation (no OS sandbox/container), not an oversight.
- Approval gating reuses the settings that already existed but were
  dead code: `settings.approvalMode` ('ask'/'auto'), already wired to a
  toggle in the composer ("Ask for approval" / "Approve for me") but never
  actually enforced anywhere before this. Now `write_file`/`run_command`
  request approval when `approvalMode === 'ask'` (the default); `read_file`
  never prompts. Deliberately did NOT wire the separate
  `configuration.sandbox` / `configuration.approvalPolicy` Select controls
  in Configuration.tsx — those are a different, more granular, still-cosmetic
  system; wiring both would have been scope creep for what the user asked.
- The approval round-trip: main emits a new `StreamEvent` variant
  (`approval-request`) over the existing `chat:event` channel, renderer shows
  it as a `pendingApproval` piece of state + a `Modal` (`ApprovalPrompt` in
  `ChatView.tsx`), and the decision comes back over a *new* one-shot IPC
  channel `chat:approve` (can't reuse `chat:stream`'s single long-lived
  `invoke` for this). `providers.ts` keeps the pending-promise map itself
  (`pendingApprovals`) rather than a separate module — kept it next to
  `activeStreams`/`cancelStream` since cancelling a stream must also resolve
  any approval it's blocked on (`false`), or the tool loop hangs forever.

## Codex-parity pass (session 2, same day)

User supplied real Codex screenshots and asked Eaon Work to look like that
specifically, not just function like it. Three pieces, all gated on the same
`isWork` boolean (`workspace?.kind === 'work'`) computed the same way in each
component — no shared hook, just the same one-liner in `Sidebar.tsx`,
`Composer.tsx`, `ChatView.tsx`'s `Home()`:

- **Sidebar**: adds a "Pull requests" nav item (only when `isWork`) and moves
  "Settings" out of the scrollable body into the footer next to Help
  (`.sidebar__footer[data-split='true']` → `justify-content: space-between`,
  new `.footer-item` class). Regular Eaon (chat) mode keeps Settings in the
  body exactly as before — that placement was a deliberate prior user choice,
  see [[Sidebar nav layout]] — Eaon Work is allowed its own layout, it's not
  bound by that decision.
- **Home hero**: swaps the plain "What should we work on?" title for a
  `MessageSquareDashed` icon + "What should we build?" + a 4-card suggestion
  grid (Explore/Build/Review/Fix, colored lucide icons), gated additionally
  on `settings.general.suggestedPrompts` — a field that already existed in
  the Settings type and was completely unused before this. Clicking a card
  doesn't send immediately; it goes through a new `composerDraft` /
  `setComposerDraft` store field that `Composer.tsx` consumes once via
  `useEffect` (sets local text, focuses the textarea, clears the draft) —
  needed because Composer's `text` is local `useState`, not store state, so
  a sibling component (the suggestion cards live in `ChatView.tsx`, not
  `Composer.tsx`) can't set it directly.
- **Pull requests**: real data, not mock — `main/github.ts` shells out to the
  `gh` CLI (confirmed installed + authenticated as `sanscreates` on this
  machine). `gh search prs --json ...` gives cross-repo author/reviewer
  results but *not* diff stats or branch name, so each hit gets a second
  enrichment call, `gh pr view <url> --json additions,deletions,headRefName`
  (batched, `ENRICH_CONCURRENCY = 6`). Verified the exact numbers from the
  user's own Codex screenshot (`Release/2026.4.5`, `+53,556 -16,708`) came
  back byte-for-byte identical from `gh pr view` — this is really their
  GitHub account, not a fabrication. `PullRequestsPage.tsx` groups by
  Authored/Reviewing under the "All" tab (skips empty groups), and clicking
  a row opens a real detail pane (repo/title/state/branch/stats + "Open in
  GitHub") — the reference screenshot only showed the *empty* "Select pull
  request to view" state, so the selected-state layout past that empty
  placeholder was designed fresh, not copied from an unseen reference.

## Gotchas hit while building this

- `Settings` full-page view (`view === 'settings'`) replaces the whole
  `<Sidebar/>` + main layout in `App.tsx` — no sidebar renders there at all.
  The design-verification harness (`capture.ts`) steps that test the
  workspace switcher have to click `.settings__back` first or
  `.workspace__button` won't exist yet.
- `capture.ts` (`EAON_CAPTURE=<dir> npx electron ./out/main/index.js`) is the
  fast way to verify UI changes on this project without a real API key or
  browser automation — offscreen, screenshots each step, no xvfb needed
  since it's macOS. It resets chats/projects but NOT workspaces, so running
  it against a dev machine's real user-data dir is exactly how the migration
  above got validated against real 3-workspace data.
- Verified `localTools.ts` functionally (not just typechecked) by
  esbuild-bundling it standalone (`esbuild src/main/localTools.ts --bundle
  --platform=node --format=cjs`) and calling `runLocalTool` directly from a
  throwaway Node script — confirms read/write/run and the path-escape
  refusal actually work, without needing a live LLM tool-call.
- `gh search prs --state` only accepts `open`/`closed`, not `all` — omit the
  flag entirely to search every state; the JSON `state` field then comes
  back lowercase `open`/`closed`/`merged` on its own.
- **Another session was editing this exact repo concurrently** while this
  work was done (added `ThinkingSteps`/`ThinkingOrb`, a `Models` nav item +
  `ModelsPage`, a vibrancy refactor in `main/index.ts`, extra capture.ts
  steps) — same file, interleaved writes, no coordination. Their edits and
  mine mostly merged fine since we touched different regions of shared
  files, but `main/capture.ts` specifically got clobbered more than once
  (my later step additions silently disappeared when their edit landed
  after mine) — it's a dev-only screenshot harness so low stakes, but if a
  future session sees this repo mid-build-error on an unfamiliar missing
  file (e.g. `ModelsPage.tsx` not found), that's very likely a *different,
  still-in-flight* session's WIP, not a bug in this note's work — check
  what's actually missing before assuming something here broke it.
