---
title: Releasing Eaon Desktop: release branches, rc tags and a public repo
tags: [eaon-desktop, release, git, github, process]
created: 2026-10-02T00:17:05.743Z
updated: 2026-10-02T00:17:05.743Z
---

How this Electron codebase reaches GitHub (`eaonlabs/eaon-desktop`, **public**), as of 2026.6.0-rc.1 (Oct 1 2026):

- **`main` is this code since PR #7 was merged (Oct 2 2026).** Before that it was the old multi-app repo (Swift macOS app, Tauri, CLI) with an unrelated history; see [[The GitHub eaon-desktop repo is not this codebase]]. Changes reach `main` through pull requests only. Never push or force-push to it directly.
- **Work that lands on a release branch after its PR is merged needs a new PR.** The Linux installer commits reached `release/2026.6.0` and the old PR branch after #7 was merged, so they went to `main` in a follow-up PR (#8). Check `gh pr view <n> --json state` before editing or pushing to a PR's branch: a merged PR's head doesn't move.
- **This code lives on release branches.** `release/2026.5.0`, then `release/2026.6.0` (48 commits on top of it, fast-forward). The local working branch is `eaon-2026.6`; push it with `git push origin HEAD:refs/heads/release/<version>`.
- **Versions and tags.** Version in `package.json` and `package-lock.json` (two spots). Prereleases look like `2026.6.0-beta.1` / `2026.6.0-rc.1`, with annotated tags `v<version>`; older Mac-only builds used `mac-v*`. `scripts/win-exe-resources.cjs` turns a prerelease into four plain numbers for Windows. The CHANGELOG's top section gets the version and date (`## [2026.6.0-rc.1] — 2026-10-01`).
- **GitHub releases.** Beta 1 was a **pre-release** on GitHub with signed and notarized Mac `.dmg`/`.zip`, a Windows `-setup.exe`, blockmaps and `latest*.yml`, built as in [[Building installers on an Apple silicon Mac (no Rosetta)]]. Its tag pointed at `main`'s old commit, because the code wasn't pushed then. rc.1's tag points at the real code. Pushing a tag doesn't make a GitHub release; installers and the release page are a separate step (`release:mac`, and needs `GH_TOKEN`; see [[Auto-updater (GitHub releases)]]).
- **Before pushing (the repo is public):**
  - **Scan for secrets.** The user's real tokens have appeared in sessions; grep the staged files for them.
  - **Avoid token-shaped literals.** GitHub push protection knows Cloudflare's `cfut_`/`cfat_`/`cfk_` prefixes, so fake test tokens are joined at runtime (`['cfut', '…'].join('_')`, see `test/cloudflareFake.ts`).
  - **Scrub personal details.** Remove personal email addresses, Cloudflare account and zone IDs, private domains, and `/Users/<name>` paths from tests and `.eaonbrain`.
  - **Strip the co-author trailers.** See [[Commits and pushes: no Claude co-author trailer]].

## Merging this app into `main` (PR #7, Oct 1 2026)
The co-founder chose to make `main` this app. GitHub can't open a PR between branches with no shared history, so the PR's branch (`update-main-2026.6`) is `release/2026.6.0` plus `git merge -s ours --allow-unrelated-histories origin/main`: it keeps this app's tree and records the old `main` as a parent. GitHub then reports it mergeable and clean.
- **What goes away when it merges:** the old Swift, Tauri and CLI files and the old `.github` workflows, which built the Tauri Linux installers. This app's own `.github/workflows/linux.yml` replaces them for Linux (no `.rpm` yet); see [[Building the Linux installers on GitHub Actions]].
- **Licence:** `LICENSE.md` and `NOTICE` (GPL-3.0) were kept from the old `main`, but `package.json` says MIT. That's an open question for the co-founder; don't settle it by deleting files.

## Apple notarization: "A required agreement is missing or has expired" (HTTP 403)
`npm run dist:mac` signs fine and then fails at notarytool with that 403. Apple refuses notarization until the account holder accepts the updated developer agreement at developer.apple.com → Account (or App Store Connect → Agreements, Tax, and Banking). Nothing in the repo or keychain fixes it. rc.1 went out Windows-first for this reason. When the co-founder asked for a dmg anyway, they chose a **signed, un-notarized** stopgap:
- Build: `npx electron-vite build && npx electron-builder --mac --publish never --config.mac.notarize=false`. This skips `scripts/release-mac.sh`, which always notarizes. Then sign the dmg yourself: `codesign --force --sign "Developer ID Application" --timestamp dist/Eaon-<ver>.dmg`.
- Check: `codesign --verify --deep --strict` passes on the app. `spctl -a -vvv -t install` on the dmg says `rejected, source=Unnotarized Developer ID`, which is expected for this build.
- Upload **only the dmg**. Leave out `latest-mac.yml`, the zip and the blockmaps, so existing Mac installs don't auto-update to an un-notarized build. The dmg's blockmap is stale anyway, because signing the dmg changes it.
- The release notes tell testers to open it once with System Settings → Privacy & Security → **Open Anyway**. On recent macOS, right-click → Open no longer gets past Gatekeeper.
- Once `notarytool history` stops returning 403, run `npm run dist:mac` again, then upload the notarized dmg, zip, blockmaps and `latest-mac.yml` with `--clobber`, and remove the un-notarized note.

