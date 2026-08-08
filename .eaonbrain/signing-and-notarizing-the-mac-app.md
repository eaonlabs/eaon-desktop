---
title: Signing and notarizing the Mac app
tags: [desktop-app, release, gotcha]
created: 2026-08-07T23:22:21.289Z
updated: 2026-08-07T23:22:21.289Z
---

Eaon ships Developer ID signed and notarized, so a download opens with no Gatekeeper warning. `build-installer.sh` does it all; this is what it is doing and why.

## The account

Paid team is **`W9MHT9V982`** (Vishnu Chada, individual enrolment), Apple ID `chadavishnu@outlook.com`. There is also an old *free personal* team `5JHLF3C7SQ` whose `Apple Development` cert sits in the same keychain — do **not** read the team ID off that one, it is wrong for notarization.

Because the enrolment is individual, the signature reads `Developer ID Application: Vishnu Chada (W9MHT9V982)`. That personal name is what users see in the Gatekeeper dialog. Changing it to a company name requires re-enrolling as an Organization (needs a D-U-N-S number), and switching later makes existing users see a "new developer" signature on the next update.

## Identity selection is by SHA-1, not by name

Every Developer ID Application cert you own shares an **identical common name**. The moment a second one exists (renewing before expiry guarantees this), `codesign` given that name calls it ambiguous and refuses to sign at all. The script picks by hash, and among several picks the longest-lived so a fresh cert automatically wins. Override with `EAON_SIGN_IDENTITY=<sha1>`.

## The current cert expires 2027-02-01

It was issued on the **previous Sub-CA**, not G2 — confirmed by its OCSP endpoint (`ocsp03-devid06`) and its validity window. G2 certs issued today run ~5 years. Anything already signed, notarized and **timestamped** stays valid forever regardless, so this only blocks *future* releases. The script warns under 200 days.

## Entitlements are deliberately short

`installer/Eaon.entitlements` grants exactly two:

- `com.apple.security.automation.apple-events` — `DesktopControl` and `BrowserControl` drive other apps
- `com.apple.security.device.audio-input` — `EaonVoice`

Notably **absent**, and this was checked rather than assumed: JIT, unsigned-executable-memory, and disable-library-validation. All inference is out-of-process (Ollama, llama.cpp, MLX and node are spawned as separate programs), so nothing third-party is loaded in-process. If that ever changes, revisit.

After any signing change, test **Device Control and voice** first — they are the two paths the hardened runtime gates, and a wrong entitlement fails silently rather than erroring.

## Nested binaries must be found by content

See [[Notarization rejects unsigned nested binaries]] — this is the single most likely reason a notarization submission comes back Invalid.

## Credentials

`xcrun notarytool store-credentials "eaon" --apple-id <id> --team-id W9MHT9V982 --password <app-specific>`. Stored in the keychain, never in the repo. The script checks the profile exists and degrades to signed-but-not-notarized rather than failing the build.

Part of [[Releasing the Mac app end to end]].
