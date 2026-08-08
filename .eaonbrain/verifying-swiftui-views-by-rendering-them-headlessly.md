---
title: Verifying SwiftUI views by rendering them headlessly
tags: [desktop-app, convention, testing]
created: 2026-08-07T23:24:00.175Z
updated: 2026-08-07T23:24:00.175Z
---

A clean build proves a SwiftUI view compiles. It proves nothing about whether it looks right, and visual bugs here have repeatedly been invisible to the compiler and obvious in a render.

If a view has **no app-level dependencies** (no `AppFont`, no `themeColors`, no app singletons) it can be compiled standalone with `swiftc` and rendered to PNG with `ImageRenderer`:

```bash
mkdir -p "$SCRATCH/preview" && cd "$SCRATCH/preview"
cp <path>/TheView.swift .
# main.swift: @main struct P { @MainActor static func main() { … ImageRenderer … } }
swiftc -parse-as-library TheView.swift main.swift -o preview
./preview "$SCRATCH/preview"
```

Then `Read` the PNG. Render **both colour schemes** (`.environment(\.colorScheme, …)`) and both the shipping size and a blown-up size — small-size problems and structural problems are different problems.

Gotchas in the harness itself: `@main struct` is required (top-level statements are rejected under `-parse-as-library`), and avoid naming anything `tint` — it collides with SwiftUI's modifier.

## What this actually caught

- **`ThinkingOrb`** — the upstream library's small-size presets were far too sparse at Eaon's size; two of the four modes read as random specks. Also caught a `ring` mode whose wobble was deep enough that a still frame read as a *teardrop*, not a ring.
- **`BorderBeam`** — an `AngularGradient` swept round the composer looked fine in theory and was badly wrong in practice: on a ~6:1 element, equal *angles* cover wildly unequal *perimeter distances*, so the beam smeared down the short sides and collapsed to a stub along the long ones. The fix was `trim`, which is parameterised by path length. No amount of staring at the code would have shown this.
- Light mode needing an entirely different palette and bloom geometry from dark.

## Views that can't be rendered this way

`ThinkingSteps` depends on `AppFont`, `themeColors` and `FlowLayout`, so it can't. Either stub the dependencies in the copy, or accept that it needs checking in the running app — but say so rather than implying it was verified.

## Beware the cached second build

`swift build 2>&1 | grep error; swift build | tail -1` compiles on the **first** invocation; the second reports `Build complete! (0.09s)` from cache. That 0.09s is not evidence anything compiled. When it matters, `touch` the file and read the real output — a genuine compile of this target takes ~3–8s.
