#!/bin/bash
# Sign Nino.app, wrap it in a .dmg and, when Apple credentials are configured,
# notarize and staple it. Without them the app is signed ad hoc: macOS then asks
# the user to confirm the first opening (Réglages > Confidentialité et sécurité).
#
# Optional environment (GitHub secrets):
#   MACOS_CERTIFICATE_P12      base64 of the "Developer ID Application" .p12
#   MACOS_CERTIFICATE_PASSWORD password of that .p12
#   APPLE_ID, APPLE_APP_PASSWORD (app-specific password), APPLE_TEAM_ID
set -euo pipefail
app="$1"; output_dir="$2"; name="$3"
here="$(cd "$(dirname "$0")" && pwd)"
dmg="$output_dir/$name.dmg"
mkdir -p "$output_dir"

if [ -n "${MACOS_CERTIFICATE_P12:-}" ]; then
  for variable in MACOS_CERTIFICATE_PASSWORD APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID; do
    [ -n "${!variable:-}" ] || { echo "Secret manquant pour la signature Apple : $variable" >&2; exit 1; }
  done
  keychain="$RUNNER_TEMP/nino-signing.keychain-db"; keychain_password="$(uuidgen)"
  echo "$MACOS_CERTIFICATE_P12" | base64 --decode > "$RUNNER_TEMP/nino-signing.p12"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 3600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$RUNNER_TEMP/nino-signing.p12" -k "$keychain" -P "$MACOS_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
  security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
  rm -f "$RUNNER_TEMP/nino-signing.p12"
  identity="$(security find-identity -v -p codesigning "$keychain" | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -1)"
  [ -n "$identity" ] || { echo "Aucun certificat « Developer ID Application » dans le .p12." >&2; exit 1; }
  echo "Signature Developer ID : $identity"
  # Every Mach-O file (Node, MediaMTX, native npm modules) needs the hardened runtime and a timestamp.
  while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q 'Mach-O'; then
      codesign --force --timestamp --options runtime --entitlements "$here/entitlements.plist" --sign "$identity" "$file"
    fi
  done < <(find "$app/Contents/Resources" -type f -print0)
  codesign --force --timestamp --options runtime --entitlements "$here/entitlements.plist" --sign "$identity" "$app"
else
  echo "Aucun certificat Apple configuré : signature ad hoc (ouverture à confirmer par l’utilisateur)."
  codesign --force --sign - "$app"
fi
codesign --verify --strict --verbose=2 "$app"

staging="$(mktemp -d)"
ditto "$app" "$staging/Nino.app"
ln -s /Applications "$staging/Applications"
hdiutil create -volname "Nino" -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$dmg"
rm -rf "$staging"

if [ -n "${MACOS_CERTIFICATE_P12:-}" ]; then
  codesign --force --timestamp --sign "$identity" "$dmg"
  xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
  security delete-keychain "$keychain" || true
fi
(cd "$output_dir" && shasum -a 256 "$name.dmg" > "$name.dmg.sha256")
echo "$dmg"
