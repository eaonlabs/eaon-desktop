#!/usr/bin/env bash
#
# Puts llama-server for Linux into resources/llama/linux-<arch>/, from
# upstream llama.cpp's own release builds, like fetch-llama-windows.sh: the
# Vulkan build, which uses most GPUs and falls back to the CPU. Its GPU and CPU
# backends are separate libraries loaded at run time, so a machine without
# Vulkan still runs it. When this machine matches the arch, the server is
# started once to make sure; if it can't start, the CPU-only build is used.
# These are upstream as-is, without the pull requests in
# native/llama-fork.json (build.json says so, and the Models page marks models
# that need them).
#
# Usage: ./scripts/fetch-llama-linux.sh [x64|arm64|all] [tag]

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHES="${1:-all}"
TAG="${2:-b11303}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

host_arch() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo x64 ;;
    Linux-aarch64 | Linux-arm64) echo arm64 ;;
    *) echo other ;;
  esac
}

fetch() { # arch flavor ("vulkan-" or "")
  local arch="$1" flavor="$2" out="$ROOT/resources/llama/linux-$1"
  local asset="llama-$TAG-bin-ubuntu-$flavor$arch.tar.gz"
  echo "== llama.cpp $TAG for Linux $arch ($asset)"
  curl -fsSL -o "$TMP/$asset" "https://github.com/ggml-org/llama.cpp/releases/download/$TAG/$asset"
  rm -rf "$TMP/$arch" "$out" && mkdir -p "$TMP/$arch" "$out"
  tar -xzf "$TMP/$asset" -C "$TMP/$arch"
  # The server and every library beside it (ggml backends, llama). Links are
  # copied as the files they point to, so nothing dangles inside the package.
  find "$TMP/$arch" -maxdepth 2 \( -name 'llama-server' -o -name '*.so*' \) -exec cp -L {} "$out/" \;
  [ -f "$out/llama-server" ] || { echo "error: no llama-server in $asset" >&2; exit 1; }
  chmod 755 "$out/llama-server"
  printf '{ "base": "%s", "revision": "%s", "variant": "%s", "pulls": [] }\n' "$TAG" "$TAG" "${flavor:-cpu-}" > "$out/build.json"
  echo "   $(ls "$out" | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1)"
}

# Only checkable on a machine of that arch; elsewhere the build is taken as is.
starts() { # arch
  [ "$(host_arch)" = "$1" ] || return 0
  (cd "$ROOT/resources/llama/linux-$1" && ./llama-server --version >/dev/null 2>&1)
}

for arch in $([ "$ARCHES" = all ] && echo "x64 arm64" || echo "$ARCHES"); do
  fetch "$arch" "vulkan-"
  if ! starts "$arch"; then
    echo "   the Vulkan build doesn't start on this machine; using the CPU build"
    fetch "$arch" ""
    starts "$arch" || { echo "error: llama-server for $arch doesn't start" >&2; exit 1; }
  fi
done
