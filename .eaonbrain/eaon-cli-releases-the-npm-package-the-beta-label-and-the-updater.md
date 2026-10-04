---
title: Eaon CLI releases: the npm package, the beta label and the updater
tags: [eaon-cli, release, process]
created: 2026-10-04T00:32:21.241Z
updated: 2026-10-04T00:32:21.241Z
---

The CLI ([[Eaon CLI: the desktop's main process in a terminal]]) ships on npm as **`eaon`**, first as `0.1.0-beta.1` (Oct 3, 2026).

## Decisions (the user's, Oct 3, 2026)
- **Package name `eaon`, not `eaon-cli`.** `eaon-cli` on npm is the user's *older* CLI, an opencode fork (0.3.0, also with an `eaon` bin), published from their own npm account. Publishing there would silently move its users onto this CLI. The README tells people who have it to `npm uninstall -g eaon-cli` first, because both install an `eaon` bin.
- **Licence `GPL-3.0-only`.** It matches `LICENSE.md` and `NOTICE` on `main`, and both ship in the package. The app's root `package.json` still says MIT. That inconsistency is still open for the co-founder (see [[Releasing Eaon Desktop: release branches, rc tags and a public repo]]).
- **Beta label:** the version carries `-beta.N`. `CLI_BETA` (from `core/version.ts`) adds a BETA badge in the header, "(beta)" in `--help` and `doctor`, and a beta line in the update popup. The README opens with a beta callout.

## How a release is built
- `cli/package.json` is the published manifest. It is also the CLI's source of truth for name and version: `scripts/build-cli.mjs` defines `__EAON_CLI_VERSION__` and `__EAON_CLI_PACKAGE__` from it. The app's root `package.json` version has nothing to do with the CLI's.
- `npm run pack:cli` (`build-cli.mjs --package`) writes `out/cli-package`: the bundle without its 7 MB source map, the manifest, `cli/README.md`, `LICENSE.md` and `NOTICE`. About 800 kB packed.
  - Runtime dependencies: `@xterm/headless`, and `node-pty` as an *optional* dependency. Only the `/claude` screen loads them; node-pty 1.1 ships prebuilds for macOS and Windows, and on Linux it compiles or is skipped.
  - Everything else is bundled.
- Publish with `npm publish out/cli-package --tag latest`; for betas also `npm dist-tag add eaon@<v> beta`. A `prepublishOnly` in the manifest refuses to publish `cli/` itself.
- **Gotcha: a symlinked `node_modules` leaks the builder's home path.** In a worktree with `node_modules` symlinked to the main checkout, esbuild resolves the real path and names every module `../../../../Users/<name>/…/node_modules/…`: 746 occurrences. `--package` now refuses a bundle that contains `os.homedir()`. Use a real copy instead; on APFS, `cp -Rc` clones 430 packages in about 3 s.

## The updater (`cli/src/core/update.ts`, `cli/src/tui/update.ts`, `eaon update`)
- **The check:**
  - Asks `GET <registry>/-/package/eaon/dist-tags` at most every 6 h (30 min after a failure). The answer is cached in `<profile>/update.json`, along with "skip this version" and "later" (24 h).
  - A prerelease follows `latest`, `beta` and `next`; a stable version follows only `latest`. Versions are compared with a small semver comparator that handles prereleases.
  - Turned off by `EAON_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER` or `CI`.
  - `EAON_UPDATE_REGISTRY` points the check *and* the install at another registry.
- **How it installs** depends on where the bundle runs:
  - `…/lib/node_modules/eaon/` (or `…\node_modules\eaon\` on Windows): it runs `npm install --global --prefix <that prefix> eaon@<v>`, so it updates *this* copy even when npm's default prefix differs, as with nvm.
  - pnpm, yarn and bun: their own global add command.
  - npx and source checkouts: it shows the command instead of running it.
  - Failures give a reason plus a copyable command (`sudo …` for EACCES).
- **The popup:**
  - Shown about 2.5 s after start, once no other modal is open, the user isn't on the Claude Code screen, and no key has been pressed for 2 s.
  - It ignores keys for 700 ms after it appears, so a keystroke meant for the chat can't pick update or skip.
  - Installing doesn't restart anything; the new version starts on the next launch. The header shows `⬆ <v> · /update`, then `✓ restart for the update`. `/update` reopens the popup or checks at once.
  - One-shot commands print a one-line notice from the cache, without any network.

## How it was verified (Oct 3, 2026)
- The packed beta.1 tarball was installed into a throwaway `--prefix`. It ran outside the repo (`--version`, `--help`, `doctor`).
- A stand-in registry (a small Node server) offered a beta.2 made by patching the version strings. It served the dist-tags, the packument and the tarball, and proxied every other path to registry.npmjs.org for the dependencies.
- Driving the installed TUI through node-pty: the popup appeared, ⏎ installed beta.2, the header changed, and `eaon --version` read 0.1.0-beta.2.
- `eaon update --check` and `eaon update` were checked the same way. Unit tests are in `test/cli-update.test.ts`.
