---
title: Building the Linux installers on GitHub Actions
tags: [release, build, linux, eaon-desktop]
created: 2026-10-02T01:09:15.598Z
updated: 2026-10-02T01:09:15.598Z
---

The Electron app's Linux installers (an AppImage and a `.deb`, for x64 and arm64) are built by `.github/workflows/linux.yml`, first shipped with 2026.6.0-rc.1 (Oct 1 2026). They can't be built from the Mac: node-pty has no Linux prebuild, and `llama-server` has to be compiled on Linux. So each arch builds on a GitHub runner of that arch: `ubuntu-22.04` and `ubuntu-22.04-arm`. The workflow runs on a push to `release/**`, on `v*` tags, or by hand. It attaches the files to the GitHub release for `package.json`'s version (`gh release upload … --clobber`) if that release exists, and keeps them as run artifacts either way. Locally, the equivalent is `npm run dist:linux` on a Linux machine.

## Things that cost a failed run each
- **Upstream llama.cpp's arm64 Linux release binary doesn't start on Ubuntu 22.04.** It needs a newer glibc, and the workflow failed with "llama-server for arm64 doesn't start". Downloading upstream's builds (a short-lived `scripts/fetch-llama-linux.sh`) was dropped. Instead, `scripts/build-llama.sh` compiles Eaon's own fork (see [[Eaon's own llama.cpp runtime (no Ollama)]]) on the runner, host arch only, CPU only, into `resources/llama/linux-<arch>/`. Building on 22.04 matters because a binary runs only on a glibc at least as new as the one it was built against. Use the oldest Ubuntu runner, not `ubuntu-latest`.
- **`-DGGML_OPENMP=OFF`** so the binary doesn't depend on `libgomp.so.1`, which isn't guaranteed on the user's machine and isn't bundled. x64 also gets AVX/AVX2/FMA/F16C.
- **electron-builder's bundled fpm (which makes the `.deb`) is an x86 program.** On arm64 it fails with "cannot execute … lib/ruby/bin.real/ruby". The fix is to install the system's own fpm (`apt install ruby ruby-dev build-essential`, `gem install fpm`) and set `USE_SYSTEM_FPM=true`. The AppImage target doesn't need fpm.

## The smoke test
The workflow extracts the AppImage (`--appimage-extract`) and runs the bundled `resources/llama/linux-<arch>/llama-server --version`. It then starts `squashfs-root/eaon --no-sandbox --disable-gpu` under `xvfb-run` with `timeout 25`. Exit code 124 (still running when the timeout killed it) means the app came up. Anything else fails the job and prints the log tail. This checks that the app starts; it doesn't exercise the UI.

## Names and packaging
`electron-builder.yml`'s `linux:` section sets `executableName: eaon`, so the binary is `eaon`, not `Eaon`. The extra resource `resources/llama/linux-${arch}` ships into `llama/linux-${arch}`. Asset names: `Eaon-<ver>.AppImage` (x64), `Eaon-<ver>-arm64.AppImage`, `eaon-desktop_<ver>_amd64.deb`, `eaon-desktop_<ver>_arm64.deb`, plus `latest-linux.yml` and `latest-linux-arm64.yml` for the updater (only the AppImage updates itself). AppImages need FUSE 2 on the user's machine (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04). The old Tauri workflows also made an `.rpm`; this one doesn't yet.

Mac and Windows still build on the Mac, as in [[Building installers on an Apple silicon Mac (no Rosetta)]]. The release flow around all three is in [[Releasing Eaon Desktop: release branches, rc tags and a public repo]].
