---
title: Vetting third-party UI components for licence
tags: [policy, design, desktop-app]
created: 2026-08-07T23:25:19.989Z
updated: 2026-08-07T23:25:19.989Z
---

Eaon is **GPL-3.0**. The owner has said repeatedly and unprompted that he does not want legal exposure from borrowed UI. Check the licence *before* reading a component's source, not after.

MIT is compatible with GPL-3.0 — the MIT code can be included provided its notice is kept. Attribution goes in the ported file's header doc comment.

## Decisions made so far

| Source | Licence | Outcome |
|---|---|---|
| `Jakubantalik/thinking-orbs` | **MIT** | Ported to Swift as `ThinkingOrb.swift`, attributed |
| `Jakubantalik/border-beam` | **MIT** | Effect rebuilt in SwiftUI, attributed. Its shipped Swift port was unusable — [[SwiftPM does not compile .metal shaders]] |
| `fluidfunctionalism.com` | **none** | Source **not** used. Patterns rebuilt from scratch |
| Jan.ai | AGPL-3.0 | Declined to read or port its source |

## How to check

A showcase site with no licence is all-rights-reserved by default. For `fluidfunctionalism.com` the check was: no `LICENSE` text on the page, no GitHub or npm link anywhere in the site or its JS bundles, only a link to the author's X profile. That is a no.

```bash
curl -s https://api.github.com/repos/<owner>/<repo> | \
  python3 -c "import json,sys; print((json.load(sys.stdin).get('license') or {}).get('spdx_id'))"
```

## The distinction that matters

A **visual pattern** is not protectable — a labelled spinner, a stepped agent log, a glowing border are all conventions. The author's **source code** is. So an unlicensed component is not a dead end: build the same pattern natively against Eaon's own design system and data. That is what was done for `ThinkingSteps` and `ShimmerText`.

Related: [[Settings page layout conventions]] for the house style anything new has to match.
