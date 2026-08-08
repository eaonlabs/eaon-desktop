---
title: Universal builds must be per-arch and lipo'd
tags: [desktop-app, gotcha, build]
created: 2026-08-07T23:22:51.951Z
updated: 2026-08-07T23:22:51.951Z
---

The obvious way to build universal is wrong here:

```bash
swift build -c release --arch arm64 --arch x86_64   # FAILS
```

A multi-arch invocation routes through **Xcode's build system**, which as of Xcode 26 cannot reach the Metal toolchain — it now ships as a separately-downloaded cryptex. SwiftTerm has a `.metal` shader, so the entire build dies on it:

```
error: cannot execute tool 'metal' due to missing Metal Toolchain
```

**Downloading the toolchain does not fix it.** After `xcodebuild -downloadComponent MetalToolchain`, `xcrun metal --version` works and `xcodebuild -showComponent MetalToolchain` reports `Status: installed` — and xcbuild still fails with the identical error. Clearing `.build/apple/Intermediates.noindex/XCBuildData` does not help either. Do not spend time on this path; it was tried.

## What works

Build each architecture separately, then `lipo`. Single-arch builds use SwiftPM's own build system, which finds `metal` fine:

```bash
swift build -c release --arch arm64
swift build -c release --arch x86_64
lipo -create -output "$APP/Contents/MacOS/Eaon" \
  .build/arm64-apple-macosx/release/Eaon-desktop \
  .build/x86_64-apple-macosx/release/Eaon-desktop
```

Verify with `lipo -info` — expect `x86_64 arm64`. This is what `build-installer.sh` does.

Resource bundles are taken from the arm64 build; their contents are resources, not code. Note this does **not** mean the shader gets compiled — see [[SwiftPM does not compile .metal shaders]] for what SwiftPM actually does with it.

Part of [[Releasing the Mac app end to end]].
