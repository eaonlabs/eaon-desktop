---
title: Eaon-ADE folder is read-only reference
tags: [ade, policy]
created: 2026-08-07T23:20:51.612Z
updated: 2026-08-07T23:20:51.612Z
---

`/Users/sanshraychada/Downloads/Eaon ADE/EaonADE` is the actual Eaon ADE product source. Standing, explicit user instruction: never edit code in that folder — it's read-only, used only as a reference to ground eaon.dev copy and UI in the real product (see [[Grounding marketing UI in real app source]]).

Known discrepancy in that repo, flagged to the user but deliberately not fixed (out of scope given the read-only instruction): `package.json` says `"license": "MIT"`, but the `LICENSE` file contains GPL-3.0 text. eaon.dev's product pages correctly say GPL-3.0, matching `LICENSE` — if `package.json` or an npm/GitHub license badge is ever the source of truth for something, expect it to disagree with the actual license.

`src/shared/themes.ts` has 18 real named themes (ade, ade-bone, signal, void, cyber-wave, ember, graphite, deep-sea, dracula, gruvbox-dark, nord, tokyo-night, catppuccin-mocha, one-dark, rose-pine, daylight, solarized-light, catppuccin-latte). The repo's own README claims "16 themes," which is stale — eaon.dev's "18 themes" copy is the correct, verified count.

Latest published release at time of writing: v1.0.8 (confirmed via GitHub API, real dmg/exe assets present).
