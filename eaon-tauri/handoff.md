# Handoff — Windows/Linux self-updater + shipping v2026.4.0

## What this is

`eaon-tauri/` is Eaon's Windows/Linux app (Rust core via Tauri v2 + a React
web UI). It's a sibling to the macOS app (`Eaon-desktop/`, Swift) and the
terminal tool (`eaon-cli/`) in this same repo — one product, three native
surfaces. This doc covers one session's work: building a **real** in-app
updater for this app and shipping it as the `v2026.4.0` GitHub release.

**If you're picking this up fresh, read in this order:** the "Current
state" section below (so you don't redo finished work), then "How the
pieces fit together" (so you understand *why* things are shaped the way
they are before touching them), then "Next step."

## Goal

The user's own words, across two messages: *"Can you build a updater for
the windows version of the app"*, then later *"Can you push the windows
version to github and verify everything. the version for the windows
version is v2026.4.0."*

Two distinct asks, both now done:
1. Replace the old "check a JSON, show a link" notifier with a real
   self-updater — signed, verified, auto-download, auto-install, relaunch.
2. Actually ship it: get `v2026.4.0` built, released, and verified on
   GitHub — **without** touching or pushing the separate, unrelated macOS
   work sitting in this same working tree.

## Current state — DONE, verified, live

- `v2026.4.0` is tagged and pushed. The GitHub Actions release workflow
  ran clean on both platforms (run `29976806147`,
  `sanscreates/eaon-desktop`). A **draft** GitHub Release exists at
  `github.com/sanscreates/eaon-desktop/releases/tag/v2026.4.0` with:
  `Eaon_2026.4.0_x64-setup.exe` (+`.sig`), `Eaon_2026.4.0_amd64.AppImage`
  (+`.sig`), `Eaon_2026.4.0_amd64.deb` (+`.sig`),
  `Eaon-2026.4.0-1.x86_64.rpm` (+`.sig`), and `latest.json`.
- `latest.json` was downloaded and its signatures decoded/verified by
  hand — both `windows-x86_64` and `linux-x86_64` entries carry valid,
  *correct* signatures (see "What went wrong" below for why this needed
  checking, not assuming).
- **The release is still a DRAFT.** Nothing is public. Publishing it
  (`gh release edit v2026.4.0 --draft=false` or the GitHub UI "Publish
  release" button) is the user's call, not something to do automatically.
- `origin/main` on GitHub is now at commit `846be24` ("Ship the
  Windows/Linux app rebuild as v2026.4.0"), which contains the *entire*
  eaon-tauri Svelte→React rewrite (pre-existing, from a concurrent editing
  session, not authored this session) plus this session's updater work,
  as one squashed-together commit.
- **Local `main` in this working directory is a DIFFERENT, older
  commit** (`d95efa1`) that never got the eaon-tauri push — see "The git
  topology" below. This is deliberate, not a mistake. Don't try to
  fast-forward or merge it without reading that section first.

## How the pieces fit together (what was learned this session)

### The updater itself

Real Tauri v2 updater plugin, not a hand-rolled scheme:

- **Rust side**: `tauri-plugin-updater` + `tauri-plugin-process` added to
  `src-tauri/Cargo.toml`, registered in `src-tauri/src/lib.rs`'s
  `.plugin(...)` chain (after `tauri_plugin_dialog::init()`, before
  nothing needs to come after them — order didn't matter for these two,
  unlike `tauri_plugin_single_instance` which has a documented "must be
  first" comment already in that file — don't reorder that one).
- **Permissions**: `src-tauri/capabilities/default.json` needed
  `"updater:default"` and `"process:allow-restart"` added to the flat
  permission list. Verified these are real identifiers by checking
  `src-tauri/gen/schemas/desktop-schema.json` after a `cargo check`
  (which regenerates that schema) — don't guess permission strings, grep
  the generated schema.
- **Config**: `src-tauri/tauri.conf.json` gained a `plugins.updater` block
  (`endpoints` + `pubkey`) and `bundle.createUpdaterArtifacts: true`. The
  endpoint is
  `https://github.com/sanscreates/eaon-desktop/releases/latest/download/latest.json`
  — GitHub's own stable "always the latest release's asset" URL pattern,
  no custom backend involved. This works specifically *because*
  `eaon-desktop` is a **public** repo (verified with
  `gh repo view sanscreates/eaon-desktop --json isPrivate`) — if it's
  ever made private, anonymous fetches of this URL 404 and the whole
  updater goes silently dead. (The macOS app hit exactly this trap with
  its own update .zip on a different repo once — see the root
  `RELEASING-UPDATES.md`'s "Where the files actually go" section.)
- **Signing key**: generated via
  `npx @tauri-apps/cli signer generate --ci -p "<random password>" -w key -f`
  (the `--ci` flag skips the interactive password prompt, which hangs
  forever in a non-TTY shell — first attempt without it panicked on
  `Device not configured`). The private key + password were shown to the
  user once, pushed to GitHub Actions secrets
  (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) via
  `gh secret set`, then **deleted from local disk immediately** —
  they exist nowhere on this machine now, only in GitHub's secret store.
  If they're ever lost, every installed copy keeps working but you can
  never sign a new update it will accept — you'd have to ship one
  unsigned-relative-to-the-old-key release users download manually, and
  rotate `pubkey` going forward.
- **Frontend**: `src/core/update.ts` rewritten around the plugin's real
  `check()` / `Update.downloadAndInstall(onProgress)` / `relaunch()` APIs
  (was: fetch a JSON manifest by hand, show a link, done — never actually
  updated anything). `App.tsx` calls `checkForUpdate()` on launch and
  every 6 hours the app stays open (a `setInterval` that re-reads the
  `autoUpdateEnabled` setting fresh each tick, so toggling it off takes
  effect on the next interval, not just next launch).
  `GeneralPane.tsx` drives the actual UI: a progress-labeled button
  (`Downloading… NN%` → `Installing…` → `Restarting…`, or a retry state on
  failure).

### The release pipeline (`.github/workflows/release.yml`)

Matrix build (`windows-latest` + `ubuntu-22.04`), triggered by a `v*` tag
push, publishes a **draft** release via `tauri-apps/tauri-action@v0`. Two
things about this file that aren't obvious from reading it once:

1. **It has a Linux-only post-build step ("Fix AppImage — strip
   libglvnd + wayland") from an external contributor's merged PR
   (`YoannDev90`, PR #3, fixing a real EGL_BAD_PARAMETER crash on
   non-Ubuntu distros).** It extracts the just-built AppImage, deletes a
   handful of bundled graphics libs that conflict with the host's Mesa
   stack, and repacks it with `appimagetool`. This step existed on
   `origin/main` **before** the updater work started — local `main` in
   this working tree never had it (see git topology below), so the very
   first version of the reconciled `release.yml` this session almost
   shipped was missing it entirely. Caught by diffing against
   `origin/main` directly, not by memory.
2. **That step had a real, silent bug**: its `gh release upload` calls
   had no `GH_TOKEN`/`GITHUB_TOKEN` in scope, and every failure was
   swallowed by a trailing `|| true`. Meaning: on `origin/main` as it
   stood, the "fixed" AppImage almost certainly never actually replaced
   the buggy one on any past release — the upload silently failed every
   time. Fixed by adding `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` to that
   step's `env:` block. **This wasn't verified as broken on a past
   release** (didn't go digging through old release assets to prove it
   retroactively) — it's inferred from how GitHub Actions env scoping
   works, and confirmed going forward by seeing `gh release upload`
   actually succeed in the `v2026.4.0` run's logs this time.
3. **New bug introduced by adding the updater, caught before shipping**:
   `tauri-action` builds + signs + generates `latest.json` **before** the
   AppImage-fix step runs. Repacking the AppImage changes its bytes, so
   the signature `latest.json` already has for `linux-x86_64` stops
   matching the file that's actually on the release — every Linux
   auto-update would fail signature verification, permanently, silently.
   Fixed by adding logic to the same step: after re-signing the repacked
   file, download the release's current `latest.json`, patch just the
   `linux-x86_64.signature` field with the new signature, re-upload.
   **Verified this actually worked** — not just "no warning printed" —
   by decoding the real signature blobs from the shipped `latest.json`
   and comparing embedded minisign timestamps: `linux-x86_64` carries the
   *later* (post-repack) timestamp, while the redundant
   `linux-x86_64-appimage` key (which the updater plugin doesn't actually
   read — it resolves `{os}-{arch}` only) still has the stale one, exactly
   as expected.
4. One more stale doc comment fixed in passing: a comment said "NSIS +
   MSI on Windows" — MSI was dropped a while back (CalVer major version
   `2026` breaks WiX) but nobody updated this specific comment.

### The git topology (read this before pushing anything else here)

This repo has real external contributors (GitHub PR #3, merged). Local
`main` in this working directory and `origin/main` had diverged
significantly before this session's push:

- **Local `main`** (still true right now, unchanged) sits at `d95efa1`
  with **17 commits never pushed**, entirely unrelated macOS feature work
  from earlier sessions (desktop pet, Quick Assistant Liquid Glass, MCP
  integrations, context compression, etc.) — nothing to do with
  Windows/Linux. The user explicitly said not to push the macOS side yet.
- **`origin/main`** had 7 commits local `main` didn't have: README
  updates + the 3 AppImage-fix commits from PR #3.
- **Neither side had eaon-tauri's React rewrite** — that whole thing
  (Svelte→React, dozens of new Rust modules) existed *only* as
  uncommitted working-tree state, built up over this whole multi-session
  conversation by a concurrent editing process, never committed anywhere
  by anyone.

Pushing local `main` directly (the user actually tried this —
`git push origin` — and it correctly got rejected as non-fast-forward)
would have (a) failed outright, or (b) if forced, dragged 17 unrelated
macOS commits onto the shared remote and potentially clobbered the
AppImage-fix commits it didn't have.

**What was actually done**: `git worktree add -b windows-v2026.4.0
<scratch-path> origin/main` — a *separate* working directory on a new
branch built directly on top of `origin/main` (not local `main`), so it
inherently excludes the 17 macOS commits. The current working tree's
`eaon-tauri/` contents were `rsync`'d into that worktree (`--delete`, so
old Svelte files that no longer exist got removed, not just new files
added), `release.yml`/`CHANGELOG.md`/`RELEASING-UPDATES.md` were
reconciled by hand against `origin/main`'s versions (see pipeline section
above), the whole thing was verified to actually build (`npm ci && tsc
--noEmit && vite build` and `cargo check`, run *inside the worktree*, not
just the main working directory — the worktree is what actually gets
pushed, so that's what needs to build), committed, and pushed as
`windows-v2026.4.0:main` (a clean fast-forward from `origin/main`'s
perspective). The worktree itself has since been removed
(`git worktree remove`); the local branch `windows-v2026.4.0` still
exists, pointing at the same commit now on `origin/main` — harmless,
kept as a marker.

**Consequence to know about**: the *main working directory's*
uncommitted diffs for `.github/workflows/release.yml`, `CHANGELOG.md`,
and `RELEASING-UPDATES.md` (visible in `git status` right now) are
against local `main`'s *older* base — they're effectively superseded by
what's already on `origin/main`, but weren't reset/cleaned up, since
touching the user's working tree beyond what was asked felt like
overreach. If a future session tries to `git pull`/merge local `main`
with these files still dirty, expect conflicts on exactly those three
files — the resolution should generally favor what's already on
`origin/main` for the parts this session touched, then re-apply whatever
of the 17 local macOS commits still make sense on top.

### Versioning / CHANGELOG.md convention

One shared version-number timeline across macOS AND Windows/Linux in
`CHANGELOG.md` (not two independent counters) — whichever platform ships
next claims the next number, entries get a `*Windows/Linux app only.*` or
similar italic tag when platform-specific. `CHANGELOG.md` already had
**three** drafted-but-never-shipped entries (`2026.4.0`, `2026.5.0`,
`2026.5.1`) written by the concurrent session as work progressed — since
the user said ship this as **one** release, `v2026.4.0`, those three were
consolidated into a single `## [2026.4.0]` entry (today's actual ship
date, not the draft dates) rather than leaving two version headers that
will never correspond to a real tag. The old "update-available card"
bullet was rewritten to describe the real updater instead of the
link-out notifier it used to describe.

Bump rule (from memory, confirmed applicable here): PATCH for routine
work, MINOR (reset PATCH) for a UI overhaul or comparably sweeping
redesign. A full Svelte→React rewrite unambiguously earns the MINOR bump
— `2026.3.2` → `2026.4.0` is correct, not a typo.

## Files touched this session (all inside the pushed `846be24` commit, or documented above as pipeline changes)

- `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`,
  `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json` —
  updater plugin wiring (see above).
- `src/core/update.ts` — rewritten around real plugin APIs.
- `src/App.tsx` — launch + periodic check wiring.
- `src/ui/settings/panes/GeneralPane.tsx` — real install-progress UI.
- `src/core/catalog.ts` — dropped the now-unused `UPDATE_MANIFEST_URL`.
- `package.json` / `package-lock.json` — added
  `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process` (had to
  correct the version pins once — guessed `^2.4.0`/`^2.9.0`, `npm install`
  failed with `ETARGET`, checked real published versions with
  `npm view <pkg> versions --json` and used the actual latest,
  `2.3.1`/`2.10.1`).
- `.github/workflows/release.yml` (repo root) — signing secrets wired
  into both the tag-push and manual-dispatch `tauri-action` steps, the
  `GH_TOKEN` fix, the `latest.json` signature-patch logic, the stale
  MSI-comment fix.
- `CHANGELOG.md` (repo root) — consolidated entry, see above.
- `RELEASING-UPDATES.md` (repo root) — new "Windows/Linux (`eaon-tauri/`)"
  section documenting all of the above for future releases.

## What went wrong / had to be caught and fixed along the way

1. **Node's `-e` argv indexing** — briefly worried the inline
  `node -e '...'` script in the `latest.json`-patch logic had an
  off-by-one (`process.argv.slice(1)` vs `slice(2)`), from a misremembered
  Node quirk. **Verified empirically** (`node -e 'console.log(process.argv)'
  a b` locally) before trusting either the original code or a "fix" —
  the original was already correct, no change needed. Lesson: check, don't
  patch from a hunch, especially in a script that can't be easily
  re-tested once it's live in CI.
2. **Auto-mode classifier blocked a direct `git push origin
  windows-v2026.4.0:main`** — pushing to `main` needs the user's own hands
  on it even with an explicit prior instruction to "push it." Worked
  around correctly (asked the user to run it via `! <command>`), not
  worked around incorrectly (did not try `gh api` or any other path to
  push commits without the user's direct action).
3. **The user's own first push attempt** (`git push origin`, no refspec)
  pushed local `main` — the wrong branch, with the 17 unrelated macOS
  commits and without the AppImage-fix reconciliation — and was correctly
  rejected by git itself as non-fast-forward. No damage; caught before it
  mattered, but worth remembering that a bare `git push origin` pushes
  *whatever branch is currently checked out*, not necessarily the branch
  you mean to push.
4. **YAML/bash correctness for the reconciled `release.yml`** — validated
  with Ruby's built-in `YAML.load_file` (Python's `pyyaml` wasn't
  installed and the environment is externally-managed, so `pip install`
  was refused) before ever pushing; no `shellcheck` available, so the new
  bash block was reviewed by hand instead — this held up (no CI syntax
  errors), but a future session without Ruby handy should find some other
  local YAML validator rather than skip validation entirely.

## Next step

1. **Nothing is blocking — the ball is in the user's court.** The draft
   release at `v2026.4.0` is ready to review and publish whenever they
   want it public.
2. Once published, the real end-to-end test that hasn't happened yet:
   install an **older** Eaon build on actual Windows and Linux machines
   (or VMs) and confirm the in-app "Check for Updates" flow actually
   finds `v2026.4.0`, downloads, verifies, installs, and relaunches
   cleanly. Everything so far has been verified by inspecting CI logs and
   decoding the manifest by hand — nobody has clicked the button on a
   real machine yet.
3. Separately, whenever the user is ready: push local `main`'s 17
   unrelated macOS commits (they're untouched, sitting exactly where they
   were). Expect to need to reconcile the three files noted above
   (`release.yml`, `CHANGELOG.md`, `RELEASING-UPDATES.md`) since local
   `main` is still missing what's now on `origin/main`.
4. If a Linux install actually surfaces an update failure despite the
   verified-correct manifest, the AppImage-fix step's re-upload logic
   (item 2/3 in the pipeline section above) is the first place to
   re-check — it's the newest, least field-tested part of the pipeline.
