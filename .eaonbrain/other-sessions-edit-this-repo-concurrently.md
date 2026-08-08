---
title: Other sessions edit this repo concurrently
tags: [gotcha, policy, desktop-app]
created: 2026-08-07T23:25:36.218Z
updated: 2026-08-07T23:25:36.218Z
---

This working tree is edited by more than one agent session at a time. It is not a hypothetical — it has repeatedly caused confusion and at least one hard build break.

## What it looks like

- Files appear in `git status` that this session never touched (`AgentPlan.swift`, `BackgroundJobs.swift`, `WorkFolder.swift`, `EaonMascot.swift`, `WorkContextBar.swift`, `Tests/`, `browser-extension/` all arrived mid-session).
- A file you edited comes back changed underneath you.
- **The build breaks for reasons unrelated to your change.** Concretely: `AppearanceSettings.swift` was rewritten to a single `monochromeAccent`, removing `AccentColorOption`, while `AppearanceSettingsView.swift` still referenced it in three places. Whole target failed to compile.

## What to do

- `find Eaon-desktop -name "*.swift" -mmin -20` identifies what moved recently when a build breaks inexplicably.
- **Disclose it rather than absorbing it.** Say plainly that the tree changed underneath you and which files.
- **Do not "fix" someone else's half-finished refactor.** They likely have the matching change in flight, and guessing at it either collides with their work or silently reverts a deliberate decision. Stop and ask.
- When reporting a release or a diff, check whether the changes you are describing are actually yours. Around 79 uncommitted files at 2026.4.0 spanned several sessions' work.

The corollary for releases: commit and push to a branch **early**, before doing anything else. A large uncommitted tree shared between sessions is the single biggest risk to the work — see [[Releasing the Mac app end to end]].
