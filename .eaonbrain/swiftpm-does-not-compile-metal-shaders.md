---
title: SwiftPM does not compile .metal shaders
tags: [desktop-app, gotcha, build]
created: 2026-08-07T23:22:38.351Z
updated: 2026-08-07T23:22:38.351Z
---

**SwiftPM copies `.metal` files into the resource bundle as raw source. It does not compile them, and no `.metallib` is produced anywhere.**

Verified directly in this repo rather than inferred:

```
.build/arm64-apple-macosx/release/SwiftTerm_SwiftTerm.bundle/Shaders.metal   ← the source, copied
find .build -name "*.metallib"                                              → nothing
```

Only Xcode's build system compiles Metal — and that is precisely the build system Eaon **cannot** use, because of [[Universal builds must be per-arch and lipo'd]]. So both paths are closed: SwiftPM leaves the shader uncompiled, xcbuild can't reach the toolchain.

## What this rules out

Any dependency whose rendering goes through a `.metal` shader will build fine, ship, and then do nothing at runtime. This is why `BorderBeamKit` (the SwiftUI port in Jakub Antalík's `border-beam` repo) was rejected — its own README says as much, and the check above confirmed it. The effect was rebuilt on plain SwiftUI primitives instead.

If Metal ever becomes genuinely necessary, the options are a SwiftPM **build-tool plugin** that shells out to `xcrun metal` + `metallib`, or compiling the metallib in `build-installer.sh` and loading it at runtime — but note the second breaks dev builds, since `swift build` alone would not produce it.

## Related trap

`SwiftTerm_SwiftTerm.bundle` was for a long time **never copied into the shipped app**. SwiftPM's generated `Bundle.module` accessor calls `fatalError` when its resource bundle is missing, so the first user to open the terminal view in a downloaded build hit a hard crash, not a missing texture. Fixed in `build-installer.sh` — copy *both* resource bundles, not just `Eaon-desktop_Eaon-desktop.bundle`.
