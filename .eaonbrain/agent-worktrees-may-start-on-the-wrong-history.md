---
title: Agent worktrees may start on the wrong history
tags: [eaon-desktop, git, worktrees, gotchas, process]
created: 2026-09-23T21:30:00.000Z
updated: 2026-09-23T21:30:00.000Z
---

# Agent worktrees may start on the wrong history

When parallel agents were spawned into `.claude/worktrees/agent-*`, every
worktree branch started at `8795a69` ("Update README.md"). That commit belongs
to a different, unrelated history: the old multi-app repo with `Eaon-desktop/`,
`eaon-cli/` and `Package.swift`. The work was meant to start from
`eaon-2026.6` (`9b64429`). `git merge-base` finds no common ancestor. See
[[The GitHub eaon-desktop repo is not this codebase]].

Check before doing anything: `git log --oneline -1` and `ls` at the worktree
root. If there's no `package.json` or `src/`, you're on the wrong tree. The fix
on a clean worktree branch is `git reset --hard <intended base>`. It only
touches your own branch.

Also: `node_modules` is a symlink to the main checkout. The `node_modules/`
ignore pattern doesn't match a symlink, so it shows as untracked. Stage paths
explicitly and never `git add -A`.
