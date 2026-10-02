---
title: eaon.dev deploys: CI is broken, deploy with wrangler from a clean main
tags: [eaon-website, deploy, cloudflare, gotcha, marketing]
created: 2026-09-30T02:16:42.897Z
updated: 2026-09-30T02:16:42.897Z
---

# eaon.dev deploys: CI is broken, deploy with wrangler from a clean main

eaon.dev is the `eaon` Cloudflare Worker (static assets), built from `~/Downloads/eaon-website` (remote `origin` = `sanscreates/Eaon-website-`; `legacy` is an older repo). `.github/workflows/deploy.yml` deploys on push to `main`, but **every run fails**: the repo has no `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets, so wrangler says it isn't logged in. Pushing does not publish anything. The site is deployed by hand with the local, logged-in wrangler (`npm run deploy` = `scripts/stage-site.sh` then `wrangler deploy`).

## Deploying safely
- `wrangler deploy` **replaces the whole asset set**, so deploy from exactly what you mean to publish. The local checkout usually sits on a feature branch (e.g. `redesign/minimal-mono`). Use a detached worktree of `origin/main` instead: `git worktree add --detach <tmp> origin/main`, add your files, commit, push, `bash scripts/stage-site.sh` in the worktree, then run the main checkout's `node_modules/.bin/wrangler deploy` from the worktree.
- `preserved/` (the old Studio pages, login/invite, `tokenmaxxinglol/`, the 2026.1.8 dmg) **is tracked in git**, so a clean worktree still includes it.
- Before deploying, compare every staged file with live using `curl -L` + `cmp` (the dmg sends no Content-Length, so download it). In Sep 2026 all 104 files matched, and wrangler reported "5 new, 104 already uploaded". Wrangler's own new/modified list is the final check.
- **Don't probe a URL before it's deployed.** Cloudflare caches the 404 at the edge for a short while, so the new file still 404s right after a successful deploy. `?v=<now>` shows the truth.

Used for the Discord art — see [[Discord Rich Presence]].
