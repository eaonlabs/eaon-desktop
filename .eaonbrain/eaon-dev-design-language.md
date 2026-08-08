---
title: Eaon.dev design language
tags: [design, eaon-dev]
created: 2026-08-07T23:20:02.856Z
updated: 2026-08-07T23:20:02.856Z
---

Redesign history, in order: openclaw.ai-inspired look → a YouTuber called it "scamy" → rebuilt to match onorca.dev's monochrome look, which is current. Don't reintroduce hype-SaaS patterns (countdown/promo banners, follower-count flexes, repeated pricing CTAs) without checking — that's specifically the tone the site moved away from.

Current palette is genuinely monochrome: dark `--bg:#000000`, light `--bg:#ffffff`. The `--coral` custom property name was kept for backward compatibility with roughly 600 `var(--coral)` references sitewide, but it no longer means literally coral/orange — don't assume the name implies the color.

Fonts: Space Grotesk 700 (display), DM Sans (body), JetBrains Mono (chrome/mono labels/eyebrows). Corner radius 12px (`--r`).

Theme mechanism: `[data-theme]` attribute + `@media (prefers-color-scheme)` fallback + a pre-paint inline `<script>` in `<head>` reading `localStorage` before first paint, so there's no flash of the wrong theme. Key is `"eaon-theme"` on eaon.dev, `"labs-theme"` on labs.eaon.dev. Testing tip: `localStorage.setItem('eaon-theme','light')` then reload — clicking the toggle button cycles a 3-state system (dark/light/unset-follows-OS) so one click doesn't always produce a visible change if the OS default already matches.

Sections use `.block--rt` ("reverse theme") for bands that stay dark regardless of the page's overall light/dark toggle, for visual rhythm — don't mistake a dark `.block--rt` section for a broken theme toggle.

Hairline-row convention: a small content cluster in a bordered flex row (e.g. the supporters strip, `.supp__row`) should get `max-width: fit-content` above the mobile-stack breakpoint, not stretch to the full `.wrap` width — otherwise a flex row sized to its content leaves a large empty gap once the container is full page width, which reads as "too large, empty space."

CSS gotcha (breakpoint isolation): a shared `@media` query block containing many unrelated selectors must never be moved wholesale to fix one component's breakpoint. Extract only the affected selectors into their own isolated query instead. Concrete case: adding a 6th nav item overflowed the download button at 768px; the fix was a new isolated `@media (max-width: 840px)` block for just the 6 nav-collapse selectors, while the original shared 640px block (which also covered grids, hero sizing, and the app-demo sidebar) stayed untouched.

See also [[Grounding marketing UI in real app source]].
