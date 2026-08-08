---
title: Grounding marketing UI in real app source
tags: [design, eaon-dev, desktop-app]
created: 2026-08-07T23:20:29.328Z
updated: 2026-08-07T23:27:14.679Z
---

Standing practice on eaon.dev: any "demo" UI shown on the marketing site is built from the real product's actual source, never invented from impression or memory.

The hero's fake-but-functional Eaon chat window pulls every label from Eaon-desktop's own Swift source: `EaonMode.title` (Chat / Eaon Work / Code), `SidebarView` section labels (Pinned / Chats / Repositories), `AppFeature` (Projects / Models), `composerPlaceholder` ("Message Eaon…"), and `Theme/ThemeColors` for the exact hex palette. It isn't just a static picture either — the composer really posts to `api.eaon.dev/v1/chat/completions` and renders the real reply.

The Eaon ADE section's embedded pane-grid screenshot (in `#ade`, `.adeapp`/`.adepanes` classes) is grounded the same way: the agent handles (Fen/Jax/Cove/Pia), their working/waiting/idle states, and the caption text are copied verbatim from the already-shipped interactive demo at labs.eaon.dev/ade.html, not invented fresh for the main site — keeps the two properties consistent.

CSS pattern for these embedded "screenshot" windows: define an isolated set of custom properties on the window's own wrapper class (e.g. `.app` uses `--a-bg`, `--a-side`, `--a-t1/2/3`, `--a-accent`) rather than reusing the site's own `--bg`/`--text` tokens. Rationale, stated directly in a code comment: "a macOS app does not restyle itself to match the website showing it" — the pictured app should look like the real app regardless of whether the site itself is in light or dark mode. The ADE demo panel reuses the exact same `.app`/`.app__bar`/`.app__status` CSS rules as the desktop hero by just overriding those custom properties on a second class (`.adeapp`) to ADE's real palette (from labs.eaon.dev's default theme: bg `#101012`, accent `#f5654a`, working-state teal `#4fc8ae`) — this avoided duplicating the window-chrome CSS for a second app.

See also [[Eaon.dev design language]].

Related: [[Eaon desktop app map]]
