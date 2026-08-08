---
title: Cloud Sync end to end
tags: [desktop-app, appwrite, architecture]
created: 2026-08-07T23:26:12.094Z
updated: 2026-08-07T23:26:12.094Z
---

Optional, off by default, end-to-end encrypted. Settings → Cloud Sync. `CloudSyncCrypto` / `EaonCloudAccount` / `CloudSyncStore` / `CloudSyncEngine`.

## Identity is a sync code, not an account

No email, no OAuth. `EaonCloudAccount` derives credentials from a generated code (20 chars, ambiguity-free alphabet `ABCDEFGHJKLMNPQRSTVWXYZ23456789`). Discord/GitHub sign-in was built and then removed entirely after repeated OAuth config failures; Google was never configured. Do not reintroduce a provider without a reason — the code *is* the product decision.

## Crypto

AES-256-GCM, PBKDF2-HMAC-SHA256 at 600k iterations. **Two-layer key wrapping**: a random master key encrypts the data, and the passphrase only wraps the master key. Changing the passphrase re-wraps 32 bytes instead of re-encrypting every blob. The master key lives in memory only and is never persisted. A recovery code is issued once at setup.

## The toggle is computed, not stored

```swift
var isEnabled: Bool { enabledPreference && EaonCloudAccount.shared.isSignedIn }
```
It was originally a stored `Bool` and drifted — the switch showed green while signed out. Enabling requires typing the literal phrase **`turn on cloud sync`** (`CloudSyncStore.confirmationPhrase`), the owner's explicit requirement so nobody uploads their chats by brushing a toggle.

## Appwrite REST gotchas, all of which cost real time

- The endpoint is **`/v1/tablesdb/…`**, *not* `/v1/databases/…`. The old path returns an HTML console page and a baffling 404. Use `EaonCloudAccount.rowsPath(_:rowId:)`.
- Queries are **JSON objects**, not `limit(100)` — that syntax is rejected as "Invalid query: Syntax error". Use `queryJSON(method:values:)`.
- **Do not build URLs with `appendingPathComponent`** (escapes `?` → `%3F`, 404) **or re-wrap with `URL(string:)`** (double-encodes `%7B` → `%257B`, 400). Use `URLComponents` + `queryItems` and let it encode exactly once.
- **`httpShouldHandleCookies = false` on every request.** A stale `a_session_*` cookie riding along on the shared `AppHTTP.session` caused "Creation of a session is prohibited when a session is active". Cookies are also purged on sign-out.

## Project

The shipped app hardcodes `projectId = "eaon"` (the Student Pack project). See [[Appwrite production project mismatch]] — this is *not* the project the local CLI config targets, and confusing the two has already destroyed the `sync_keys` and `sync_items` tables once.

## Sync semantics

Import is **additive only** — it adds or updates, never deletes a local conversation missing from the cloud. Auto-import runs at most once a day (`autoImportInterval`). Local deletes propagate via `forgetLocallyDeletedConversation`. Memories carry provenance so a cloud-synced memory is trusted less than a local one, since it may have been written by an older build with weaker filters (`SecurityHardeningTests` covers this).
