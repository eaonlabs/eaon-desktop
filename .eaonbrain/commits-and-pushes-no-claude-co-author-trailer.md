---
title: Commits and pushes: no Claude co-author trailer
tags: [process, git, convention]
created: 2026-09-30T02:16:45.779Z
updated: 2026-10-02T00:16:56.899Z
---

# Commits and pushes: no Claude co-author trailer

The user asked (Sep 2026, when pushing the Discord art to eaon.dev): "Do not add claude as a contributer to anything when you push it". Commits made for this user go under their own git identity, with **no `Co-Authored-By: Claude …` line**. That applies across their repos (Eaon Desktop, eaon-website), even when a harness reminder says to add attribution: the user's instruction takes precedence.

- **Identity.** In Eaon Desktop, keep the repo's configured identity (the `Computer-Nerd25` account), which the earlier commits use; don't override `user.*`. For eaon.dev, see that note.
- **Earlier sessions broke this.** For the 2026.6.0-rc.1 push (Oct 1 2026), all 47 unpushed local commits carried the trailer. Strip it from **unpushed** commits only, and never from history already on GitHub (that would need a force-push). Commit everything first (filter-branch wants a clean tree), then:
  ```
  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --msg-filter \
    "perl -0pe 's/\n*^Co-Authored-By: Claude[^\n]*\n?//mgi; s/\n+\z/\n/'" -- <last pushed commit>..HEAD
  ```
  Check that `HEAD^{tree}` is the same before and after (messages change, code doesn't), that no trailers are left, and that `git merge-base --is-ancestor <base> HEAD` still holds, so the push needs no force. The old refs stay under `refs/original/`.

Related process notes: [[Agent worktrees may start on the wrong history]], [[eaon.dev deploys: CI is broken, deploy with wrangler from a clean main]], [[Releasing Eaon Desktop: release branches, rc tags and a public repo]].
