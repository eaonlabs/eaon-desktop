---
title: Settings page layout conventions
tags: [desktop-app, design, convention]
created: 2026-08-07T23:24:22.391Z
updated: 2026-08-07T23:27:20.734Z
---

Every page under Settings follows the same shell. It is never written down in code, and `StatisticsView` had drifted off it in a way that read as sloppy rather than as a deliberate variant.

```
VStack(alignment: .leading, spacing: 0) {
    Text(title)          .font(AppFont.mono(20, weight: .bold))
                         .padding(.horizontal, 32).padding(.top, 28).padding(.bottom, 8)
    Text(description)    .font(AppFont.sans(12)).foregroundColor(colors.textSecondary)
                         .fixedSize(horizontal: false, vertical: true).lineSpacing(3)
                         .padding(.horizontal, 32).padding(.bottom, 20)
    ScrollView {
        VStack(alignment: .leading, spacing: 16) { …cards… }
            .padding(.horizontal, 32).padding(.bottom, 32)
    }
}
```

- **32pt horizontal gutters**, everywhere. 28 looks misaligned against the sidebar.
- **`SettingsCard`** for every group, **16pt** between cards, **16pt** padding inside.
- Card header: icon in a 30×30 `backgroundSubtle` rounded chip, then `AppFont.mono(14, weight: .semibold)` title and an optional `AppFont.sans(12)` subtitle.
- Toggles live **inside** a card with a title and an explanatory subtitle, never loose on the page.
- Wrapping paragraphs take `.lineSpacing(3)`. Without it a description reads as one solid block — this was applied to ~115 paragraphs across Settings.

Anti-patterns that were removed and should not come back: all-caps 10pt mono section labels (used nowhere else), controls on the page-title line, and metrics laid out in three fixed columns — the pane is only ~616pt wide, so three columns truncate their own labels. Use `LazyVGrid(.adaptive(minimum: 268))` instead.

## Copy style

Settings copy was rewritten throughout to drop em dashes and split run-on sentences. The house style is short sentences, no rule-of-three constructions, no "not just X but Y". When adding a new setting, match that.

A grep for user-facing em dashes needs care: `"[^"]{20,}—"` misses short leads like `"No token data yet — …"`. Anchor on `Text("`/`help("`/`description: "` instead.

Related: [[Vetting third-party UI components for licence]]
