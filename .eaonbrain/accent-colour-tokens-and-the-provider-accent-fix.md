---
title: Accent colour tokens and the provider-accent fix
tags: [eaon-desktop, ui, css, theming, tokens, accent]
created: 2026-08-26T02:16:11.417Z
updated: 2026-08-26T02:16:11.417Z
---

# Accent colour tokens and the provider-accent fix

## The bug

Primary buttons ("Start Server", "Save & Enable", "Save"), the provider enable
toggle, radio dots and System Monitor usage bars all rendered a warm salmon in
an otherwise blue app. Reported with screenshots of Local API Server, Claude
Code and Model Providers.

Root cause was a single declaration in `tokens.css`:

```css
--provider-accent: #d97757;
--provider-accent-strong: #c8684a;
--provider-accent-soft: rgba(217, 119, 87, 0.14);
```

Originally deliberate — the comment said it was "a deliberately distinct warm
tone from the app's blue accent, matching the reference design rather than the
user's chosen theme accent." In practice it read as a bug, and worse, it
**ignored the accent the user picked in Appearance**: change the accent to
anything and these surfaces stayed salmon.

## The fix

Derive them from `--accent` like every other accented token:

```css
--provider-accent: var(--accent);
--provider-accent-strong: color-mix(in srgb, var(--accent), #000 12%);
--provider-accent-soft: color-mix(in srgb, var(--accent), transparent 86%);
```

One change, ~13 call sites across `settings.css` and `chat.css`, no component
edits. The mixes deliberately match `.btn--accent`'s hover convention in
`controls.css` (`color-mix(in srgb, var(--toggle-on), #000 12%)`) so the two
button variants stay visually identical.

Kept as their own token names rather than inlining `--accent` everywhere: the
grouping still documents which surfaces these are, and diverging again later is
a one-line change.

## Token architecture worth knowing

- `--accent` is declared **per theme block** in `tokens.css` (`:root,
  [data-theme='dark']` and `[data-theme='light']`), and overridden at runtime by
  `useTheme()` in `App.tsx` via `root.style.setProperty('--accent', …)` from
  `settings.appearance[mode].accent`.
- The `--provider-accent*` tokens live in the **base `:root` block**, which is
  declared *before* the theme blocks. This is fine: custom properties resolve
  lazily at use time against the element's computed value, and both are declared
  on `:root`, so declaration order does not matter. Don't "fix" this by
  duplicating them into each theme block.
- Everything accented should follow this pattern: `--toggle-on`, `--link`,
  `--focus-ring` all derive from `--accent` with `color-mix`.

## Colours that are legitimately hardcoded — do not "theme" these

Audited every non-neutral hex in the stylesheets. These stay fixed on purpose:

- `--danger` `#ff453a` (dark) / `#e5342a` (light) — semantic red.
- `#30d158`, `#4ade80` — success / status dots.
- `.tok-*` syntax highlighting: `#c792ea` (key), `#7ec699` (string),
  `#f78c6c` (number), `#82aaff` (name). `#f78c6c` is warm and will show up in a
  grep for orange — it is a code-block token colour, not UI chrome.

## Verification

`capture.ts` step `35-light-provider-accent` switches to the light theme and
logs a `THEME {...}` line with the computed `--accent`, `--provider-accent`,
`--provider-accent-strong` and the resolved `.btn--provider` background. Assert
`providerAccent === accent`. It runs last because it persists a theme switch.

Confirmed in both themes. Notably the light run picked up the user's *custom*
accent (`#5A6472`, not the `#0A84FF` default) and the buttons followed it —
which is the behaviour that was missing before.

See [[Popover sizing and overflow rules]] for the other UI fixes in this area,
and [[Eaon Desktop architecture]] for how theming is wired end to end.
