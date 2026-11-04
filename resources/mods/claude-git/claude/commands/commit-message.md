---
description: Write a commit message for the staged changes
argument-hint: "[anything the message should mention]"
---
Write a commit message for the staged changes.

1. Run `git diff --cached`. If nothing is staged, use `git diff` and say that nothing was staged.
2. Run `git log --oneline -10` and match the style of the recent messages.
3. Write a summary line under 72 characters in the imperative mood ("Add", "Fix", not "Added"), a blank line, then a short body that says why the change was made, not just what changed.

Show me the message. Don't commit unless I ask.

$ARGUMENTS
