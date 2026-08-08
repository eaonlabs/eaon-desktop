---
title: Mac release tags are prefixed mac-v
tags: [desktop-app, release, gotcha]
created: 2026-08-07T23:23:38.277Z
updated: 2026-08-07T23:23:38.277Z
---

The Mac app and the Windows/Linux app share one GitHub repo (`sanscreates/eaon-desktop`) and **two overlapping version series**. They collided.

- Mac historically tagged `v2026.3.1`, `v2026.3.2`, `v2026.3.5`, `v2026.3.6`
- Windows/Linux took **`v2026.4.0`** (commit `846be24`, "Ship the Windows/Linux app rebuild") and uses `2026.5.x` in the changelog

So when the Mac app reached 2026.4.0 by its own rule (MINOR bump for a major release), the plain `v2026.4.0` tag was already taken. The Mac release is tagged **`mac-v2026.4.0`**.

The **app version** and the **git tag** are independent — `AppVersion.current` is still `2026.4.0`. Only the tag carries the prefix.

Consequence worth remembering: the manifest's `downloadURL` embeds the tag, so it must read `.../download/mac-v2026.4.0/...`. Using `v2026.4.0` there silently 404s for every user. See [[The update manifest and how the self-updater works]].

Adopt `mac-v*` for future Mac releases rather than trying to reclaim the plain series — the Windows tag is already published and rewriting it would break anyone who pinned it.

Part of [[Releasing the Mac app end to end]].
