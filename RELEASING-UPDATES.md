# How Eaon updates work, and how to ship one

This covers the **macOS** app (`Eaon-desktop/`). For **Windows/Linux**
(`eaon-tauri/`), see [Windows/Linux updates](#windowslinux-eaon-tauri) at the
bottom — different mechanism entirely (Tauri's signed updater plugin, not a
hand-rolled manifest).

## How it works

- On every launch, the app fetches one small JSON file (the **update
  manifest**) from `UpdateChecker.manifestURL`
  (`Eaon-desktop/Services/UpdateChecker.swift`).
- If the manifest's `latestVersion` is newer than the app's own
  `AppVersion.current`, the "New Version" card appears (bottom-right) with
  **Remind Me Later / Update Now**.
- **Update Now** downloads the `.zip` at `downloadURL`, hands it to
  `SelfUpdateInstaller`
  (`Eaon-desktop/Services/SelfUpdateInstaller.swift`), and — once verified —
  swaps it into place and relaunches automatically. No manual quit-and-drag.
  See that file's header comment for the exact safety mechanics (nothing is
  touched on disk until the download is verified complete and the bundle
  checks out; a failed swap rolls back immediately).
- **Remind Me Later** snoozes *that version* for 24 hours. A newer version
  published during the snooze still prompts.
- An unreachable server or malformed manifest is a silent no-op — users are
  never shown update errors they didn't ask for. (Settings → General →
  "Check for Updates" is the manual check, and that one does report its
  outcome either way.)

## One-time setup

1. Pick a stable HTTPS URL for the manifest (any static host: your site,
   GitHub releases/raw, S3, …).
2. Put that URL in `UpdateChecker.manifestURL`. Until you do, checks fail
   silently and nobody is ever prompted.

## Shipping a release

1. Add an entry to `CHANGELOG.md` describing what's in the release —
   this is also where the manifest's `releaseNotes` text comes from, so
   write it for the card, not just for developers.
2. Bump `AppVersion.current` in `UpdateChecker.swift` to the new version.
   Do this **before** building — the version baked into the binary you're
   about to ship must match what the manifest will announce, or a
   freshly-updated app immediately thinks it needs to update again.

   Versioning is `YYYY.MINOR.PATCH`, not semver. Default to a PATCH bump
   (`2026.1.1` → `2026.1.2`) — that covers bug fixes, new features, even a
   large batch of them (a whole audit's worth of fixes bundled into one
   release is still PATCH). Reserve the MINOR bump (`2026.1.2` →
   `2026.2.0`) specifically for a UI overhaul or comparably sweeping
   visual/structural redesign — not just "a lot of changes." When in
   doubt, PATCH is the safer default; confirm with the user before a
   MINOR bump if it's not clearly a visual overhaul.
3. Run `./build-installer.sh` — it produces two files from the same build:
   - `dist/Eaon-<version>.dmg` — the drag-to-Applications installer, for
     first-time downloads from the website. Without a paid Apple Developer
     ID + notarization, downloaders see Gatekeeper's "unidentified
     developer" warning and must right-click → Open the first time — a
     real limit of unsigned distribution, not a bug in the installer.
   - `dist/Eaon-<version>.zip` — what the in-app self-updater downloads.
     This one doesn't hit the Gatekeeper prompt again, since it isn't
     downloaded through a browser.

   Upload **both** files to your host — see "Where the files actually go"
   below before picking one; not every host works.
4. Edit the hosted manifest JSON (shape in `update-manifest.sample.json`):
   - `latestVersion` — the new version, e.g. `"2026.1.1"`
   - `downloadURL` — the uploaded **`.zip`**'s URL (not the dmg — that one's
     only for the website's own download link)
   - `releaseNotes` — the changelog entry's highlights, plain text, `\n`
     for line breaks

Every already-installed copy sees the new manifest on its next launch and
shows the card. That's the whole pipeline — no rebuild of anything
server-side, just one JSON edit plus two file uploads.

## Where the files actually go

Two hosts, both learned the hard way (2026-07-12):

- **Cloudflare Pages can't take the `.zip`.** Pages auto-extracts any zip
  uploaded as a project (it's a static-site host, not a blob host) and
  enforces a hard 25MB-per-file cap regardless — the universal
  (arm64+x86_64) binary alone is ~32MB. No folder-wrapping or packaging
  trick gets around this; it's a product mismatch, not a config issue.
  Pages is still fine for the tiny `update-manifest.json` itself.
- **GitHub Releases work, but not on a private repo.** `eaon-desktop` is
  private, so release-asset download URLs there 404 for anyone without a
  GitHub token — including this app's own self-updater, which downloads
  anonymously. The fix: release binaries live in a separate **public**
  repo, [`sanscreates/eaon-releases`](https://github.com/sanscreates/eaon-releases)
  (source stays private in `eaon-desktop`). Tag and publish each release
  there:

  ```
  gh release create v<version> \
    dist/Eaon-<version>.zip dist/Eaon-<version>.dmg \
    --repo sanscreates/eaon-releases \
    --title "Eaon <version>" \
    --notes-file <changelog-excerpt>.md \
    --target main
  ```

  `downloadURL` in the manifest then points at
  `https://github.com/sanscreates/eaon-releases/releases/download/v<version>/Eaon-<version>.zip`.
  Verify it's actually public before trusting it — `curl -sL <url> -o
  /tmp/x -w "%{http_code}"` with no auth header should return 200, not
  404.

## Known limits (deliberate, for now)

- The build is **ad-hoc signed**, not Developer ID-signed or notarized —
  that needs a paid Apple Developer account. First-time `.dmg` downloads
  still hit Gatekeeper's warning; this doesn't change until that's in
  place.
- The manifest and download are trusted on the honor system (HTTPS only,
  no cryptographic signature — `SelfUpdateInstaller` validates that the
  downloaded bundle is a *complete, well-formed* Eaon.app, but not that it
  was published by you specifically). Fine for now; closing this properly
  means either a Developer ID + notarization or adopting
  [Sparkle](https://sparkle-project.org)'s EdDSA-signed appcasts.

## Windows/Linux (`eaon-tauri/`)

Unlike the Mac side above, this uses Tauri's own official updater plugin —
cryptographically signed from day one, no honor-system manifest.

### How it works

- On launch (and every 6 hours the app stays open), `checkForUpdate()`
  (`eaon-tauri/src/core/update.ts`) calls the updater plugin's `check()`,
  which fetches `latest.json` from the endpoint in
  `src-tauri/tauri.conf.json` (`plugins.updater.endpoints`) — currently
  `https://github.com/sanscreates/eaon-desktop/releases/latest/download/latest.json`,
  a file the release workflow generates and attaches automatically.
- The plugin verifies `latest.json`'s Ed25519 signature against the
  `pubkey` pinned in `tauri.conf.json` **before** returning anything — a
  compromised or unsigned release is rejected at this step, never shown to
  the user.
- If a newer, verified version exists, the General settings pane shows an
  "Eaon `<version>` is available" card. **Update Now**
  (`installUpdateNow()`) downloads with live progress, installs, and
  relaunches — no manual download-and-run.
- An unreachable server or failed verification is a silent no-op on the
  background check, same policy as the Mac side. The manual "Check for
  Updates" button always reports an outcome.

### One-time setup (already done once — for reference)

The signing keypair was generated with:
```
npx @tauri-apps/cli signer generate -w eaon-updater.key
```
The **public** half is committed in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`) — safe to be public, it can only verify, not sign.
The **private** half and its password must never be committed. They need to
live in this repo's GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (Settings → Secrets and
variables → Actions) — `.github/workflows/release.yml` reads them from
there for both the tag-push release build and manual `workflow_dispatch`
test builds (the bundler requires them whenever
`bundle.createUpdaterArtifacts` is on, even for a build that isn't
publishing a release).

**If the private key is ever lost**, every already-installed copy keeps
working, but you can never ship a signed update it will accept again —
you'd need to generate a new keypair, ship one *unsigned-relative-to-old-key*
release that users have to download manually, and update `pubkey` going
forward.

### Shipping a release

Nothing manual beyond the normal release process — `git tag vX.Y.Z && git
push origin vX.Y.Z` triggers `.github/workflows/release.yml`, which builds,
signs every bundle with the private key from secrets, and publishes
`latest.json` to the GitHub Release alongside the installers. Every
already-installed copy picks it up on its next check.

### Why GitHub Releases works here (unlike the Mac side)

The Mac section above hit a private-repo 404 problem and had to move
binaries to a separate public repo. That doesn't apply here: `eaon-desktop`
is a **public** repo, so anonymous `latest.json`/asset downloads from
`github.com/sanscreates/eaon-desktop/releases/...` work with no token. If
the repo's visibility ever changes to private, this breaks the same way the
Mac zip did, and the fix is the same — move release publishing to a public
repo.
