---
title: Releasing Eaon Desktop: release branches, rc tags and a public repo
tags: [eaon-desktop, release, git, github, process]
created: 2026-10-02T00:17:05.743Z
updated: 2026-10-02T00:17:05.743Z
---

How this Electron codebase reaches GitHub (`eaonlabs/eaon-desktop`, **public**), as of 2026.6.0-rc.1 (Oct 1 2026):

- **`main` is not this code.** It's the old multi-app repo (Swift macOS app, Tauri, CLI) with an unrelated history: `git merge-base HEAD origin/main` is empty. See [[The GitHub eaon-desktop repo is not this codebase]]. Never push or force-push this code to `main`.
- **This code lives on release branches.** `release/2026.5.0`, then `release/2026.6.0` (48 commits on top of it, fast-forward). The local working branch is `eaon-2026.6`; push it with `git push origin HEAD:refs/heads/release/<version>`.
- **Versions and tags.** Version in `package.json` and `package-lock.json` (two spots). Prereleases look like `2026.6.0-beta.1` / `2026.6.0-rc.1`, with annotated tags `v<version>`; older Mac-only builds used `mac-v*`. `scripts/win-exe-resources.cjs` turns a prerelease into four plain numbers for Windows. The CHANGELOG's top section gets the version and date (`## [2026.6.0-rc.1] — 2026-10-01`).
- **GitHub releases.** Beta 1 was a **pre-release** on GitHub with signed and notarized Mac `.dmg`/`.zip`, a Windows `-setup.exe`, blockmaps and `latest*.yml`, built as in [[Building installers on an Apple silicon Mac (no Rosetta)]]. Its tag pointed at `main`'s old commit, because the code wasn't pushed then. rc.1's tag points at the real code. Pushing a tag doesn't make a GitHub release; installers and the release page are a separate step (`release:mac`, and needs `GH_TOKEN`; see [[Auto-updater (GitHub releases)]]).
- **Before pushing (the repo is public):**
  - **Scan for secrets.** The user's real tokens have appeared in sessions; grep the staged files for them.
  - **Avoid token-shaped literals.** GitHub push protection knows Cloudflare's `cfut_`/`cfat_`/`cfk_` prefixes, so fake test tokens are joined at runtime (`['cfut', '…'].join('_')`, see `test/cloudflareFake.ts`).
  - **Scrub personal details.** Remove personal email addresses, Cloudflare account and zone IDs, private domains, and `/Users/<name>` paths from tests and `.eaonbrain`.
  - **Strip the co-author trailers.** See [[Commits and pushes: no Claude co-author trailer]].
