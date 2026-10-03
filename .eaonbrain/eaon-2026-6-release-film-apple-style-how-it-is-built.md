---
title: Eaon 2026.6 release film (Apple style): how it is built
tags: [eaon-desktop, marketing, video, hyperframes, release]
created: 2026-10-02T12:54:56.017Z
updated: 2026-10-02T14:44:29.150Z
---

# Eaon 2026.6 release film (Apple style): how it is built

A 198 s, 16:9 film for 2026.6.0, made in HyperFrames at
`~/Downloads/eaon-2026-6-release` (outside this repo). It follows the Apple keynote
grammar:
- Pure black, with centred statements building word by word and one gradient-lit
  phrase (peach → coral → rose → violet).
- A hard cut to the real app acting in a floating window, with cuts on the beat.
- A wall of features ("And so much more.").
- An "In real time" section of uncut recordings, then an end card.

It succeeds the earlier launch film (see
[[Re-hosting real Eaon UI in videos and docs]]). Deliverables are in `renders/`:
a 4K60 master and 1080p. Credits are in `CREDITS.md`.

## Structure (16 frames, `tools/build-index.mjs` has the schedule)
- **Opening:** cold open, then Chat is the agent, then the live transcript, then the
  + menu.
- **Chat's reach:** its own browser (real recording), then email and chat apps.
- **Workers:** "Meet Eaon Workers" on the music's breakdown (the real face SVGs, eyes
  driven with the `wf-*` keyframe values), then Workers at work.
- **ADE:** "The ADE." on the riser, then the ADE on the big drop (real recording),
  then trading, then models and sign-in.
- **The wall:** "And so much more.", a typographic list of the smaller features.
- **In real time:** one agent task uncut, which runs across the frame cut into a
  3×2 wall of six live sessions that the camera glides through.
- **Close:** the end card.

## Sources
- **App screens:** the `v2026.6.0-rc.1` tag, exported with `git archive` to
  `~/Downloads/eaon-rc1-build` and built there. Use `npm ci --legacy-peer-deps`; the
  betterwright peer range on electron fails a plain `npm ci`. 71 states were
  captured over CDP into `capture/app/`, and `MANIFEST.md` says which are seeded or
  FAKE.
- **Real-time footage:** the same build, in an isolated profile, driven over CDP and
  recorded with `Page.startScreencast` at 2x, then assembled to constant 30 fps.
  - **Record a visible on-screen window, not the offscreen capture harness.**
    Offscreen, the compositor dropped to about 19 fps whenever the app was busy.
  - Approvals stayed on throughout.
  - Shells used a neutral `PROMPT`, and folders were reached through `/tmp`
    symlinks, so no username or hostname shows. Claude Code was kept out because its
    trust prompt prints the full path.
- **Models:** as of Oct 2026, the Ollama cloud models `glm-5.1`/`deepseek-v4-flash`
  are retired and `deepseek-v4-pro`/`minimax-m3` need paid credits.
  `gpt-oss:120b-cloud` (free tier) handled every agent run. A local model takes the
  whole GPU and makes screen recordings choppy.
- **Type:** Inter variable with optical sizing stands in for SF Pro, whose licence
  only covers Apple-platform mock-ups. The app's own UI keeps the system font.
- **Music:** "AMALGAM" by Rockot (Pixabay 217007), edited to 198 s.
  - The beat grid was measured with librosa: 110 BPM.
  - Before the edit seam, beat n falls at 0.0333 + n·0.54545 s; after it, at
    0.2124 + n·0.54545 s.

## How the project works
- **Parallel builders:** `FRAME_BRIEF.md` is the brief for frame builders working
  in parallel. Each builds into its own `previews/<name>` with
  `node tools/build-index.mjs --out previews/<name> <ids>`, which symlinks assets
  and compositions, so builders never overwrite each other's index.html.
- **Design kit:** `assets/kit/kit.css` holds the Apple-black kit (`.ap-*`).
  Gradient phrases are one `.ap-w` unit so nothing measures web-font text; the sweep
  animates background-size from 300% to 100%.
- **Recorded clips:** each lives inside its frame's own composition, with
  frame-local `data-start` and `data-media-start`. That lets one clip run uncut
  across a frame cut: 13's clip ends at media 41.68 and 14's starts there. The lint
  warning `nested_media_start_basis_ambiguous` is expected for this.

## Gotchas
- Long agent runs stall when the Mac sleeps. Run `caffeinate -is -t <secs>` for long
  captures, recordings and 4K renders.
- Several frame builders plus an Electron recording at once pushed the load average
  past 40 on a 10-core Mac. Keep snapshot batches small while recording.
- **Rendering many 2540×1594 clips:**
  - With `--video-frame-format png`, the extraction hit ffmpeg's default 300 s
    process timeout (`VIDEO_EXTRACTION_FAILED; ffmpeg_timeout`).
  - `--video-frame-format jpg` plus `FFMPEG_PROCESS_TIMEOUT_MS=1800000` fixed it.
  - A 1080p30 draft took about 18 min with 2 workers.
- Eaon's own browser rendered Wikipedia's Main Page without its stylesheet (articles
  were fine). Worth a look in the BetterWright browser.
- The renderer keeps its own copy of settings, so patching settings over IPC during
  a capture needs a page reload to show.

Related: [[Capture harness wipes the real profile unless --user-data-dir is set]]

Related: [[Pets are not an official feature — keep them out of marketing]]
