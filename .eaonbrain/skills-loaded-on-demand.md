---
title: Skills loaded on demand
tags: [eaon-desktop, skills, agent, work-mode, tokens]
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-23T00:00:00.000Z
---

# Skills loaded on demand

`src/main/features/skills.ts` makes SKILL.md folders real (the old Skills tab
was a hard-coded list of names).

- **Discovery** runs in precedence order: Work folder `.eaon/skills`, then Work
  folder `.claude/skills`, then `~/.eaon/skills`, then `~/.claude/skills`. The
  first skill with a given name wins, so project skills shadow personal ones.
  `statSync` is used rather than `Dirent.isDirectory()` because
  `~/.claude/skills` is often a folder of symlinks. Home is read from
  `os.homedir()` on every call, so tests can point `$HOME` at a temp dir.
- **Token saving is the point.** The Work tool source adds one tool,
  `load_skill({name})`, and its `guidance` puts one line per enabled skill in
  the system prompt (name plus a description cut to about 150 characters,
  capped at 40 lines). Bodies are only read when the agent calls `load_skill`,
  which returns the body without frontmatter plus a list of the folder's other
  files. Chat mode gets nothing.
- `settings.disabledSkills` holds skill **names** and is matched
  case-insensitively. Discovery is cached for 5 s because `tools()` and
  `guidance()` are both called on every request of a turn.
- Frontmatter parsing is a small YAML subset (plain, quoted, `>`/`|` blocks,
  wrapped lines). Only `name` and `description` are read.
- Installing from GitHub uses the contents API one directory at a time (no
  git or tar). It uses the GitHub plugin's token if one is connected, to get
  past the anonymous limit of 60 requests an hour. It gathers every file
  before writing anything, and an existing install is moved to the Trash
  first, so reinstalling is how a skill is updated. A link to a folder of
  several skills gets an error that lists them rather than installing nothing
  useful.
- Skills IPC goes through the plugins preload bridge
  (`window.api.pluginAuth.skills.*`), so `src/preload/index.ts` needed no edit.

See [[MCP OAuth sign-in for plugins]].
