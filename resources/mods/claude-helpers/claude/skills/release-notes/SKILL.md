---
name: release-notes
description: Writes release notes for users from the commits and merged pull requests since the last tag. Use when preparing a release or a changelog entry.
---
# Release notes

1. Find the last tag with `git describe --tags --abbrev=0` and list what changed since: `git log --oneline <tag>..HEAD`.
2. Read the commits and, where a line isn't clear, the diff behind it.
3. Group the changes under **Added**, **Changed** and **Fixed**. One line each, in plain words for the people who use the project. Lead with what they can now do or what no longer goes wrong.
4. Leave out merge commits, version bumps and refactors that change nothing for users.
5. Link each line to its pull request when the commit names one (`#123`).

Show the notes for review. Don't tag, publish or edit files unless asked.
