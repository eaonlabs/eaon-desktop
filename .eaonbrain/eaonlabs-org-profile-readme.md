---
title: eaonlabs org profile README
tags: [eaonlabs, github, org-profile, readme, brand]
created: 2026-08-26T23:29:57.784Z
updated: 2026-08-26T23:29:57.784Z
---

# eaonlabs org profile README

`https://github.com/eaonlabs` now shows a home page. GitHub renders an org's
public profile from a special public repo literally named `.github` with the
content at `profile/README.md` inside it (a root `README.md` in that same repo
is just an ordinary repo readme, shown only if someone opens the `.github` repo
directly — it does not affect what renders on the org page). That repo didn't
exist before Aug 2026; created it with `gh repo create eaonlabs/.github
--public --source=. --push`, pushing straight to `main` since a brand-new repo
has no PR step before its first commit.

Org: [[The GitHub eaon-desktop repo is not this codebase|eaonlabs]] has 3
public repos as of Aug 2026, all GPL-3.0, all with a `good first issue` label:

- **eaon-desktop** — same monorepo covered in [[The GitHub eaon-desktop repo
  is not this codebase]] (Swift macOS app + eaon-tauri + eaon-cli). Under the
  org it's lowercase `eaon-desktop`; the earlier note was about
  `sanscreates/eaon-desktop`, same content, so this may be a transfer or a
  synced copy.
- **Eaon-ADE** — "Eaon ADE," a genuinely well-documented Electron app: a
  terminal grid running up to 12 CLI coding agents (Claude Code, Codex, etc.)
  side by side, each pane a real pty. Notable pieces: sessions self-resume
  after restart by naming the pane with a UUID at spawn time and starting
  `claude --session-id <uuid>`; a shared `.eaonbrain/` MCP server so agents in
  the same project share memory (this is the same brain pattern this very repo
  uses); on-device Whisper dictation with remote loading hard-disabled; spoken
  alerts via the system TTS; a plan-usage meter read from Claude Code's own
  transcripts on disk, not from Anthropic's API. Its README is the house
  style to imitate for this org: short declarative sentences, heavy but
  deliberate em-dash use, precise engineering detail over marketing language.
- **Eaon-RP** — "R.E\D.", a roleplay site at rp.eaon.dev. NOT part of the core
  brand pitch on eaon.dev (which only markets the desktop app + ADE as "two
  native apps") — treat it as a separate side project when writing org-level
  copy, not as a third flagship product.

Brand facts, sourced from eaon.dev (fetched, not guessed — it's the org's own
`blog` field in the GitHub API): tagline is "Every model, on your machine,"
core pitch is "Two native apps that put AI where you already work. Run them on
your own keys, or on a model that never leaves your machine." Org contact:
developer@eaon.dev.

Wrote the profile README in the org's own established voice (matching
Eaon-ADE's README as the sample) rather than running it through `/humanize`
since it wasn't invoked this session — `sloplint score` flagged only em-dash
density (39/100), which is the deliberate, sourced house style here, not
accidental AI slop.
