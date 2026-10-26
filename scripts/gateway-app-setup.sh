#!/usr/bin/env bash
#
# Stores Eaon's gateway app — made on gateway.eaon.dev under Access → Eaon
# apps — where release builds read it to sign their requests to the gateway
# (src/main/gatewaySignature.ts):
#
#   - this Mac's keychain, as "eaon-gateway-app", for scripts/release-mac.sh;
#   - the repository's GitHub secrets EAON_GATEWAY_APP_ID and
#     EAON_GATEWAY_APP_SECRET, for the Windows and Linux builds.
#
# Run it in your own terminal. It asks for the secret without showing it and
# hands it on through stdin, so it never appears on a command line or in your
# shell's history.
#
# Usage: ./scripts/gateway-app-setup.sh [owner/repo]   (default eaonlabs/eaon-desktop)

set -euo pipefail
REPO="${1:-eaonlabs/eaon-desktop}"

read -r -p "App ID (starts eaon_app_): " APP_ID
if [[ ! "$APP_ID" =~ ^eaon_app_[a-f0-9]+$ ]]; then
  echo "error: that isn't an app ID. Copy it from Access → Eaon apps; it starts with eaon_app_." >&2
  exit 1
fi
read -r -s -p "App secret (starts eaon_as_, not shown): " APP_SECRET
echo
if [[ ! "$APP_SECRET" =~ ^eaon_as_[A-Za-z0-9_-]+$ ]]; then
  echo "error: that isn't an app secret. The dashboard shows it once, when the app is made; it starts with eaon_as_." >&2
  exit 1
fi

# The keychain, through `security -i` so the secret goes in on stdin.
printf 'add-generic-password -U -s eaon-gateway-app -a %s -w %s\n' "$APP_ID" "$APP_SECRET" | security -i >/dev/null
echo "Saved in the keychain as eaon-gateway-app (for Mac releases)."

if command -v gh >/dev/null 2>&1; then
  printf '%s' "$APP_ID" | gh secret set EAON_GATEWAY_APP_ID --repo "$REPO"
  printf '%s' "$APP_SECRET" | gh secret set EAON_GATEWAY_APP_SECRET --repo "$REPO"
  echo "Saved as GitHub secrets on $REPO (for Windows and Linux builds)."
else
  echo "GitHub CLI (gh) isn't installed: add EAON_GATEWAY_APP_ID and EAON_GATEWAY_APP_SECRET to $REPO's secrets by hand." >&2
fi
unset APP_SECRET
