#!/usr/bin/env bash
#
# Puts Eaon's local speech-to-text runtime — whisper.cpp's `whisper-server` —
# into resources/whisper/<platform>-<arch>/, which electron-builder ships as
# extraResources, the way scripts/build-llama.sh does for llama-server.
#
# macOS and Linux are built from a pinned whisper.cpp tag (static, so the
# binary needs nothing beside it); Windows takes upstream's own release
# builds, which can't be compiled from a Mac.
#
# Usage:
#   ./scripts/build-whisper.sh              # this machine's arch
#   ./scripts/build-whisper.sh x64          # the Intel binary, on Apple silicon
#   ./scripts/build-whisper.sh all          # macOS arm64 + x64, for the universal app
#   ./scripts/build-whisper.sh windows      # win32-x64 and win32-arm64, from upstream's releases
#
# Needs: git, cmake and a C++ compiler (macOS: brew install cmake, plus the
# Xcode command line tools; Linux: build-essential). Windows: curl and unzip.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/whisper.cpp"
# The source tag, and upstream's binary release of the same code for Windows.
TAG="v1.9.5"
BIN_TAG="b5454"
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

OS="$(uname -s)"
host="$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
want="${1:-$host}"

if [ "$want" = "windows" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  fetch() { # arch asset
    local arch="$1" asset="$2" out="$ROOT/resources/whisper/win32-$1"
    echo "== whisper.cpp $BIN_TAG for Windows $arch ($asset)"
    curl -fsSL -o "$TMP/$asset" "https://github.com/ggml-org/whisper.cpp/releases/download/$BIN_TAG/$asset"
    rm -rf "$out" && mkdir -p "$out"
    unzip -q -o "$TMP/$asset" -d "$TMP/$arch"
    # The server and the DLLs it loads (whisper, the ggml backends).
    find "$TMP/$arch" \( -name 'whisper-server.exe' -o -name 'whisper.dll' -o -name 'ggml*.dll' \) -exec cp {} "$out/" \;
    [ -f "$out/whisper-server.exe" ] || { echo "error: no whisper-server.exe in $asset" >&2; exit 1; }
    printf '{ "tag": "%s" }\n' "$BIN_TAG" > "$out/build.json"
    echo "   $(ls "$out" | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1)"
  }
  fetch x64 "whisper-bin-x64.zip"
  fetch arm64 "whisper-bin-win-cpu-arm64.zip"
  exit 0
fi

[ "$want" = "all" ] && archs="arm64 x64" || archs="$want"
if [ "$OS" = "Linux" ] && [ "$archs" != "$host" ]; then
  echo "error: on Linux, whisper-server is built for this machine's arch ($host) only" >&2; exit 1
fi

if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none https://github.com/ggml-org/whisper.cpp "$SRC"
fi
echo "== Preparing whisper.cpp $TAG"
git -C "$SRC" fetch --quiet --tags origin
git -C "$SRC" checkout --quiet --force --detach "$TAG"
revision="$(git -C "$SRC" rev-parse --short HEAD)"

# Source paths baked into the binary (its assert and abort messages name
# the file) start at the checkout, not at the builder's home folder.
# Quoted inside the flag: CMake splits its flags at spaces, and the
# checkout can be in a folder like "Eaon Desktop".
prefix_map="-ffile-prefix-map=\"$SRC\"=."

for arch in $archs; do
  platform=darwin
  osx=(-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3)
  case "$OS-$arch" in
    Linux-x64) platform=linux; osx=(); extra=(-DGGML_OPENMP=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON) ;;
    Linux-arm64) platform=linux; osx=(); extra=(-DGGML_OPENMP=OFF) ;;
    # Apple silicon: Metal, with its shaders built into the binary.
    *-arm64) cmake_arch=arm64; extra=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON) ;;
    # Intel Macs: CPU, as llama-server is built there.
    *-x64) cmake_arch=x86_64; extra=(-DGGML_METAL=OFF -DGGML_AVX=ON -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON) ;;
    *) echo "error: unknown arch $arch" >&2; exit 1 ;;
  esac
  build="$SRC/build-$arch"
  echo "== Building whisper-server for $platform $arch"
  [ "$platform" = darwin ] && osx+=(-DCMAKE_OSX_ARCHITECTURES="$cmake_arch")
  cmake -S "$SRC" -B "$build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$prefix_map" -DCMAKE_CXX_FLAGS="$prefix_map" -DCMAKE_OBJC_FLAGS="$prefix_map" \
    ${osx[@]+"${osx[@]}"} \
    -DBUILD_SHARED_LIBS=OFF \
    -DGGML_NATIVE=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_SERVER=ON \
    -DWHISPER_SDL2=OFF \
    -DWHISPER_CURL=OFF \
    ${extra[@]+"${extra[@]}"} >/dev/null
  cmake --build "$build" --config Release --target whisper-server -j "$JOBS" 2>&1 | grep -E "error|Built target whisper-server" || true

  out="$ROOT/resources/whisper/$platform-$arch"
  mkdir -p "$out"
  cp "$build/bin/whisper-server" "$out/whisper-server"
  chmod +x "$out/whisper-server"
  printf '{ "tag": "%s", "revision": "%s" }\n' "$TAG" "$revision" > "$out/build.json"
  echo "   $(file -b "$out/whisper-server" | cut -c1-60)"
done
