---
title: Eaon.dev and Eaon Labs website architecture
tags: [website, eaon-dev, deployment]
created: 2026-08-07T23:19:43.589Z
updated: 2026-08-07T23:26:41.610Z
---

Two separate static sites, not one:

- **eaon.dev** source at `~/Downloads/eaon-website`. Git repo, pushed to `github.com/sanscreates/Eaon-website` (private). Standing instruction: never add Claude as a contributor on that repo.
- **labs.eaon.dev** source at `~/Downloads/eaon-labs`. NOT under version control — flag this if asked to commit/push it.

Both are static HTML/CSS/JS with no build step, deployed as Cloudflare Workers (`eaon`, `eaon-labs`) via `~/Projects/Eaon/scripts/build-web.mjs` / `build-labs.mjs`. The backend API at `api.eaon.dev` is a separate worker (`eaon-api`, `wrangler deploy -c wrangler.api.jsonc`) in the same `~/Projects/Eaon` repo.

Local dev: plain python static servers are commonly left running across sessions — check `lsof -nP -iTCP -sTCP:LISTEN` before starting a new one. Established convention: eaon-website on `127.0.0.1:8792`, eaon-labs on `127.0.0.1:8791`.

Eaon ships two products, both advertised on eaon.dev: **Eaon desktop** (the chat app, this repo) and **Eaon ADE** (agentic terminal IDE, `github.com/sanscreates/Eaon-ADE`, source read-only at `~/Downloads/Eaon ADE/EaonADE` — see [[Eaon-ADE folder is read-only reference]]). The homepage has a dedicated `#ade` section, a product quick-nav strip right under the hero, and a second CTA in the `#download` block, specifically because an early version of the site only gave ADE a single small card and under-advertised it relative to the desktop app.

See also [[Eaon.dev design language]] and [[Appwrite production project mismatch]].

Related: [[The update manifest and how the self-updater works]]
