#!/usr/bin/env bash
#
# Builds Eaon's own llama.cpp runtime: `llama-server`, from a pinned llama.cpp
# commit plus the pull requests Eaon needs before they are merged upstream
# (new model architectures), listed in native/llama-fork.json.
#
# That file *is* the fork: a base commit and a list of PRs, merged in order.
# Nothing is published anywhere; the checkout lives in native/llama.cpp
# (git-ignored) and the binaries land in resources/llama/<platform>-<arch>/,
# which electron-builder ships as extraResources.
#
# Usage:
#   ./scripts/build-llama.sh              # this machine's arch (arm64 or x64)
#   ./scripts/build-llama.sh x64          # cross-build the Intel binary on Apple silicon
#   ./scripts/build-llama.sh all          # both, for the universal app
#
# On Linux it builds for the machine's own arch only, CPU only, into
# resources/llama/linux-<arch>/. Built on the oldest Linux Eaon supports, so it
# runs wherever the app does (upstream's arm64 build needs a newer glibc than
# Ubuntu 22.04 has).
#
# Needs: git, cmake and a C++ compiler (macOS: brew install cmake, plus the
# Xcode command line tools; Linux: build-essential).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/llama.cpp"
FORK="$ROOT/native/llama-fork.json"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

OS="$(uname -s)"
host="$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
want="${1:-$host}"
[ "$want" = "all" ] && archs="arm64 x64" || archs="$want"
if [ "$OS" = "Linux" ] && [ "$archs" != "$host" ]; then
  echo "error: on Linux, llama-server is built for this machine's arch ($host) only" >&2; exit 1
fi

base="$(node -p "require('$FORK').base")"
prs="$(node -p "require('$FORK').pulls.map(p => p.number).join(' ')")"
# "file:base" pairs: conflicts in these files are resolved by keeping the base
# (master's) side — recorded per PR in llama-fork.json with the reason.
resolve_for() { node -p "Object.entries((require('$FORK').pulls.find(p => p.number == $1) || {}).resolve || {}).map(([f, s]) => f + ':' + s).join(' ')"; }

if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none https://github.com/ggml-org/llama.cpp "$SRC"
fi

echo "== Preparing llama.cpp $base + PRs: ${prs:-none}"
git -C "$SRC" fetch --quiet origin "$base"
git -C "$SRC" checkout --quiet --force --detach FETCH_HEAD
git -C "$SRC" merge --abort 2>/dev/null || true
git -C "$SRC" clean -fdq -e build-*
for pr in $prs; do
  git -C "$SRC" fetch --quiet origin "pull/$pr/head:eaon-pr-$pr" --force
  # Merged, not rebased: a PR branch is based on some older master, and a
  # merge keeps both histories intact. A conflict stops the build loudly.
  if ! git -C "$SRC" -c user.name=eaon -c user.email=build@eaon.dev merge --no-edit --quiet "eaon-pr-$pr" >/dev/null 2>"$SRC/.merge-err"; then
    if ! git -C "$SRC" rev-parse -q --verify MERGE_HEAD >/dev/null; then
      echo "error: merging PR #$pr failed before any conflict:" >&2; cat "$SRC/.merge-err" >&2; exit 1
    fi
    for pair in $(resolve_for "$pr"); do
      file="${pair%%:*}"; side="${pair##*:}"
      [ "$side" = "base" ] && git -C "$SRC" checkout --ours -- "$file" 2>/dev/null && git -C "$SRC" add -- "$file"
      [ "$side" = "pr" ] && git -C "$SRC" checkout --theirs -- "$file" 2>/dev/null && git -C "$SRC" add -- "$file"
    done
    left="$(git -C "$SRC" diff --name-only --diff-filter=U)"
    if [ -n "$left" ]; then
      echo "error: PR #$pr conflicts in files llama-fork.json does not resolve:" >&2; echo "$left" | sed 's/^/  /' >&2; exit 1
    fi
    git -C "$SRC" -c user.name=eaon -c user.email=build@eaon.dev commit --no-edit --quiet
    echo "   merged #$pr (conflicts resolved per llama-fork.json)"
  else
    echo "   merged #$pr"
  fi
done
for patch in "$ROOT"/native/llama-patches/*.patch; do
  [ -f "$patch" ] || continue
  git -C "$SRC" apply --whitespace=nowarn "$patch"
  echo "   applied $(basename "$patch")"
done
revision="$(git -C "$SRC" rev-parse --short HEAD)"

for arch in $archs; do
  platform=darwin
  osx=(-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3)
  case "$OS-$arch" in
    # Linux: no OpenMP, so the binary needs no libgomp on the user's machine.
    Linux-x64) platform=linux; osx=(); extra=(-DGGML_OPENMP=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON) ;;
    Linux-arm64) platform=linux; osx=(); extra=(-DGGML_OPENMP=OFF) ;;
    *-arm64) cmake_arch=arm64; extra=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON) ;;
    # Intel Macs: CPU only, with the AVX2/FMA every Mac since 2013 has. Metal
    # on Intel GPUs is slower than the CPU path for most models.
    *-x64) cmake_arch=x86_64; extra=(-DGGML_METAL=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON) ;;
    *) echo "error: unknown arch $arch" >&2; exit 1 ;;
  esac
  build="$SRC/build-$arch"
  echo "== Building llama-server for $platform $arch"
  [ "$platform" = darwin ] && osx+=(-DCMAKE_OSX_ARCHITECTURES="$cmake_arch")
  cmake -S "$SRC" -B "$build" \
    -DCMAKE_BUILD_TYPE=Release \
    ${osx[@]+"${osx[@]}"} \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DLLAMA_OPENSSL=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    ${extra[@]+"${extra[@]}"} >/dev/null
  cmake --build "$build" --config Release --target llama-server -j "$JOBS" 2>&1 | grep -E "error|warning: unused|Built target llama-server" || true

  out="$ROOT/resources/llama/$platform-$arch"
  mkdir -p "$out"
  cp "$build/bin/llama-server" "$out/llama-server"
  chmod +x "$out/llama-server"
  printf '{ "base": "%s", "revision": "%s", "pulls": [%s] }\n' "$base" "$revision" "$(echo $prs | sed 's/ /, /g')" > "$out/build.json"
  echo "   $(file -b "$out/llama-server" | cut -c1-60)"
  "$out/llama-server" --version 2>&1 | head -2 | sed 's/^/   /' || true
done
