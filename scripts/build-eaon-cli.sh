#!/usr/bin/env bash
#
# Builds Eaon CLI — Eaon's fork of OpenCode, which codes with the models
# downloaded in Eaon — for this machine, into
# resources/eaon-cli/<platform>-<arch>/eaon-cli. The app runs it from there
# (main/features/eaonCli.ts) and electron-builder ships it from there.
#
#   scripts/build-eaon-cli.sh             build from ../eaon-opencode
#   EAON_CLI_SRC=/path/to/fork scripts/build-eaon-cli.sh
#
# Needs Bun (the fork's build is Bun's compiler). The binary is a single file
# of about 100 MB with Bun inside it; nothing else is needed to run it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="${EAON_CLI_SRC:-$root/../eaon-opencode}"
pkg="$src/packages/opencode"

if [ ! -f "$pkg/script/build.ts" ]; then
  echo "eaon-cli: the fork's source isn't at $src. Clone it there, or set EAON_CLI_SRC to where it is." >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "eaon-cli: Bun is needed to build Eaon CLI (https://bun.sh)." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) echo "eaon-cli: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  *) arch=x64 ;;
esac
# Bun names Windows `windows`; the app's resource folders use Node's `win32`.
platform="$([ "$os" = windows ] && echo win32 || echo "$os")-$arch"
exe="eaon-cli$([ "$os" = windows ] && echo .exe || true)"

[ -d "$src/node_modules" ] || (cd "$src" && bun install)

base="$(cd "$pkg" && bun -e 'console.log(require("./package.json").version)')"
version="${EAON_CLI_VERSION:-$base+eaon}"
echo "Building Eaon CLI $version for $platform from $src"

# `latest` keeps sessions in eaon-cli/opencode.db, where the ADE looks for them;
# the web UI isn't embedded (Eaon CLI has no `web` command).
(cd "$pkg" && OPENCODE_CHANNEL=latest OPENCODE_VERSION="$version" bun run script/build.ts --single --skip-embed-web-ui --skip-install)

built="$pkg/dist/opencode-$os-$arch/bin/$exe"
[ -f "$built" ] || { echo "eaon-cli: the build finished but $built is missing." >&2; exit 1; }

out="$root/resources/eaon-cli/$platform"
mkdir -p "$out"
# A new file renamed into place, never a copy over the old one: macOS caches a
# binary's signature by inode, and kills (SIGKILL) a signed binary whose pages
# changed under it — the old Eaon CLI may well be running in an ADE pane.
cp "$built" "$out/$exe.new"
chmod +x "$out/$exe.new"
mv -f "$out/$exe.new" "$out/$exe"
echo "Eaon CLI: $out/$exe ($("$out/$exe" --version))"
