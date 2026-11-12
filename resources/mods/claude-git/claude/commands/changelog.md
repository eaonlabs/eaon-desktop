---
description: Draft changelog entries since the last tag
argument-hint: "[from tag]"
---
Draft changelog entries for what changed since the last release.

1. Find the starting point: `$ARGUMENTS` if I gave a tag, otherwise `git describe --tags --abbrev=0`.
2. Read `git log --oneline <tag>..HEAD`.
3. Group the changes under Added, Changed and Fixed, one line each, written for the people who use the project rather than its developers. Leave out merge commits and internal refactors that change nothing for users.

If the project has a CHANGELOG.md, match its format and show me the new section. Don't edit the file unless I ask.
