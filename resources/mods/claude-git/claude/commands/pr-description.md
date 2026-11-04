---
description: Write a pull request description for this branch
argument-hint: "[base branch, if not main]"
---
Write a pull request description for the current branch.

1. Find the base branch: use `$ARGUMENTS` if I gave one, otherwise `main` (or `master` if there's no `main`).
2. Read `git log --oneline <base>..HEAD` and `git diff <base>...HEAD --stat`, and look at the diff where you need detail.
3. Write: a title under 70 characters, a short "What" section, a "Why" section, and a "How to test" checklist. Mention anything a reviewer should look at closely.

Show me the description. Don't push or open the pull request unless I ask.
