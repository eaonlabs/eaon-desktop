#!/usr/bin/env bash
#
# Puts llama-server for Windows into resources/llama/win32-<arch>/, from
# upstream llama.cpp's own release builds: x64 with Vulkan (runs on most GPUs,
# falls back to the CPU), arm64 CPU. These can't be compiled from a Mac, so
# they are upstream as-is — without the pull requests in native/llama-fork.json
# (build.json says so, and the Models page marks models that need them).
#
# Usage: ./scripts/fetch-llama-windows.sh [tag]   (default: the tag below)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-b11303}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # arch asset
  local arch="$1" asset="$2" out="$ROOT/resources/llama/win32-$1"
  echo "== llama.cpp $TAG for Windows $arch ($asset)"
  curl -fsSL -o "$TMP/$asset" "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$asset"
  rm -rf "$out" && mkdir -p "$out"
  unzip -q -o "$TMP/$asset" -d "$TMP/$arch"
  # The server and every DLL it loads (ggml backends, the C++ runtime).
  find "$TMP/$arch" \( -name 'llama-server.exe' -o -name '*.dll' \) -exec cp {} "$out/" \;
  [ -f "$out/llama-server.exe" ] || { echo "error: no llama-server.exe in $asset" >&2; exit 1; }
  printf '{ "base": "%s", "revision": "%s", "pulls": [] }\n' "$TAG" "$TAG" > "$out/build.json"
  echo "   $(ls "$out" | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1)"
}

fetch x64 "llama-$TAG-bin-win-vulkan-x64.zip"
fetch arm64 "llama-$TAG-bin-win-cpu-arm64.zip"
