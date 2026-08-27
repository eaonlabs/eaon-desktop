#!/usr/bin/env bash
#
# Builds, signs and notarizes the macOS app.
#
# Notarization credentials are read out of the login keychain at build time,
# so the Apple ID and app-specific password never appear in this repository,
# in a shell profile, or in the environment of any unrelated process. Create
# the keychain entry once with:
#
#   security add-generic-password -U -s eaon-notarize \
#     -a "<apple-id>" -w "<app-specific-password>"
#
# The password is an app-specific password from appleid.apple.com — never the
# Apple ID password itself. Revoke and regenerate it there if it ever leaks.
#
# Signing itself needs no configuration here: electron-builder selects the
# "Developer ID Application" certificate from the keychain automatically.
#
# Usage:
#   ./scripts/release-mac.sh            # build locally, do not publish
#   ./scripts/release-mac.sh --publish  # build and publish to GitHub releases

set -euo pipefail

CRED_SERVICE="eaon-notarize"
TEAM_ID="W9MHT9V982"

if ! security find-generic-password -s "$CRED_SERVICE" >/dev/null 2>&1; then
  echo "error: no '$CRED_SERVICE' entry in the login keychain." >&2
  echo "       See the comment at the top of this script to create one." >&2
  exit 1
fi

# `-w` prints the secret alone; the attribute dump is parsed separately for the
# account, so neither value has to be hardcoded here.
APPLE_ID="$(security find-generic-password -s "$CRED_SERVICE" 2>/dev/null | awk -F'"' '/"acct"/ {print $4}')"
APPLE_APP_SPECIFIC_PASSWORD="$(security find-generic-password -s "$CRED_SERVICE" -w 2>/dev/null)"
APPLE_TEAM_ID="$TEAM_ID"

if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
  echo "error: found the keychain entry but could not read both fields from it." >&2
  exit 1
fi

export APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID

PUBLISH="never"
if [ "${1:-}" = "--publish" ]; then
  PUBLISH="always"
fi

echo "Building Eaon for macOS (notarizing as ${APPLE_ID%%@*}@…, publish=$PUBLISH)"
npx electron-vite build
npx electron-builder --mac --publish "$PUBLISH"

# The in-build Gatekeeper assessment is disabled because it runs before
# stapling; this is the check that actually means something.
APP="dist/mac-universal/Eaon.app"
[ -d "$APP" ] || APP="$(find dist -maxdepth 2 -name 'Eaon.app' -print -quit 2>/dev/null || true)"
if [ -n "$APP" ] && [ -d "$APP" ]; then
  echo
  echo "== Verifying $APP =="
  spctl -a -vvv -t install "$APP" 2>&1 | sed 's/^/  /' || true
  codesign -dv --verbose=4 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|flags" | sed 's/^/  /' || true
fi
