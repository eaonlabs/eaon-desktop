#!/usr/bin/env bash
#
# Builds and signs the Windows installer via Azure Artifact Signing.
#
# Prerequisites, once per machine:
#   brew install dotnet                    # .NET SDK (the `sign` tool needs it)
#   dotnet tool install --global sign      # Microsoft's Artifact Signing CLI
#   export PATH="$PATH:$HOME/.dotnet/tools"
#   az login                               # as the account holding the certificate
#   export WIN_SIGN_PUBLISHER_NAME="..."   # the certificate's CN — never hardcode this
#
# Signing itself needs no secrets in this repo beyond that env var:
# scripts/sign-win.cjs shells out to `sign code trusted-signing`, which
# authenticates with whatever `az login` session is active
# (--azure-credential-type azure-cli) rather than a hardcoded service
# principal. The signed-in account must hold the "Artifact Signing
# Certificate Profile Signer" role on the eaon-signing account's
# eaon-desktop certificate profile.
#
# Usage:
#   ./scripts/release-windows.sh            # build locally, do not publish
#   ./scripts/release-windows.sh --publish  # build and publish to GitHub releases

set -euo pipefail

if ! command -v sign >/dev/null 2>&1; then
  echo "error: the 'sign' CLI is not on PATH." >&2
  echo "       dotnet tool install --global sign" >&2
  echo "       export PATH=\"\$PATH:\$HOME/.dotnet/tools\"" >&2
  exit 1
fi

if ! az account show >/dev/null 2>&1; then
  echo "error: not logged in to Azure CLI. Run 'az login' as the account" >&2
  echo "       that holds the eaon-signing certificate first." >&2
  exit 1
fi

if [ -z "${WIN_SIGN_PUBLISHER_NAME:-}" ]; then
  echo "error: WIN_SIGN_PUBLISHER_NAME is not set. It must be the exact CN on" >&2
  echo "       the eaon-desktop certificate profile — never hardcode it here." >&2
  exit 1
fi

AZ_USER="$(az account show --query user.name -o tsv)"

PUBLISH="never"
if [ "${1:-}" = "--publish" ]; then
  PUBLISH="always"
fi

echo "Building Eaon for Windows (signing as $AZ_USER, publish=$PUBLISH)"
npx electron-vite build
npx electron-builder --win --publish "$PUBLISH"

VERSION="$(node -p "require('./package.json').version")"
SETUP="dist/Eaon-${VERSION}-setup.exe"

echo
echo "== Manifest values =="
if [ -f "$SETUP" ]; then
  echo "  latestVersion: $VERSION"
  echo "  sha256:        $(shasum -a 256 "$SETUP" | awk '{print $1}')"
else
  echo "  warning: $SETUP not found — check the electron-builder output above." >&2
fi
