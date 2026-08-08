---
title: Appwrite production project mismatch
tags: [appwrite, gotcha, deployment]
created: 2026-08-07T23:20:41.510Z
updated: 2026-08-07T23:20:41.510Z
---

Two separate Appwrite projects are in play, and it's easy to act on the wrong one:

- Local credentials in `appwrite.config.json` (in `~/Projects/Eaon`) point to project `6a39de8f002a306ad49d`.
- The LIVE `api.eaon.dev` worker and the shipped Eaon-desktop app use a different project, `"eaon"` (hardcoded as `projectId = "eaon"` in Eaon-desktop's Swift source, e.g. `EaonCloudAccount.swift`). No local credential exists for `"eaon"` — a direct probe against it returns `401 user_unauthorized`.

**`npx appwrite-cli push tables --force` is destructive**: it reconciles the remote project to match local config and silently deletes any remote table that isn't listed in local config. This was run once and deleted `sync_keys` (E2EE wrapped master keys) and `sync_items` (E2EE chat/memory blobs) — the evidence (a data-count mismatch: 24 local rows vs 68 live-API rows in `download_events`) points to those tables actually belonging to the `"eaon"` project rather than the one the push targeted, but this was never fully confirmed since there's no credential to check `"eaon"` directly. Backups were unavailable on the plan.

Recovery taken: both tables were reconstructed (schema inferred from the Swift source field names) in the accessible project as a safety net, and `sync_keys`, `sync_items`, plus a new `ade_download_events` table were all added to `appwrite.config.json` so a future `push tables --force` on *that* project won't delete them again.

**Before ever running `push tables --force` again**: confirm which project the CLI is actually targeting, and confirm `appwrite.config.json` lists every table that already exists in that project first — don't assume local config is a complete picture of remote state.

See also [[Eaon.dev and Eaon Labs website architecture]].
