---
title: The update manifest and how the self-updater works
tags: [desktop-app, release, deployment]
created: 2026-08-07T23:23:25.563Z
updated: 2026-08-07T23:23:25.563Z
---

`UpdateChecker` fetches `https://downloads.eaon.dev/update-manifest.json` on launch, compares `latestVersion` against `AppVersion.current`, and offers the update. **Until that file changes, nobody is offered anything** — publishing a GitHub release on its own reaches zero existing users.

## Where it is hosted

A Cloudflare **Pages** project called `eaon-downloads`, custom domain `downloads.eaon.dev`, **direct upload, no git provider**. It is *not* in `~/Projects/Eaon` (whose workers serve eaon.dev, www, api and labs) and there is no local copy of the deploy folder anywhere on the machine — this took a while to find. See [[Eaon.dev and Eaon Labs website architecture]] for the rest of the estate.

The whole site is **two files**: `update-manifest.json` and `robots.txt`. A direct-upload deploy replaces everything, so recreate both or `robots.txt` disappears.

```bash
npx wrangler pages deploy <dir> --project-name eaon-downloads --branch main --commit-dirty=true
```

## Schema

```json
{
  "latestVersion": "2026.4.0",
  "downloadURL": "https://github.com/sanscreates/eaon-desktop/releases/download/mac-v2026.4.0/Eaon-2026.4.0.zip",
  "sha256": "<lowercase hex of the .zip>",
  "releaseNotes": "• bullet\n• bullet"
}
```

`sha256` is **optional but enforced when present**. It pins the exact bytes, so a compromised CDN or a truncated download is stopped before install. Two consequences:

- Never replace a release asset in place without updating the hash — every user's updater will refuse the mismatched download.
- Because the hash pins the artifact, shipping a fix always means a **new version**, never re-uploading over an old one.

The `downloadURL` points at the **`.zip`**, not the `.dmg`, and its tag segment is `mac-v…` — see [[Mac release tags are prefixed mac-v]]. Getting that wrong 404s for everyone.

`releaseNotes` is what users read in the update banner. Keep it short and bullet-style.

## Cache

Responses are `cf-cache-status: DYNAMIC` with `max-age=0, must-revalidate`, but an edge can still serve the old file for ~30s after a deploy. Verify with a cache-buster (`?cb=$RANDOM`) before concluding the deploy failed.

Part of [[Releasing the Mac app end to end]].
