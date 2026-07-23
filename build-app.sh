#!/bin/bash
# Package the SwiftPM build into a proper riven.app bundle (resources + icon +
# Info.plist), then sign it. Local runs ad-hoc sign; CI passes a Developer ID.
#
# Usage:
#   ./build-app.sh                      → ad-hoc signed riven.app (local dev)
#   RIVEN_VERSION=0.1.0 \
#   RIVEN_SIGN_ID="Developer ID Application: … (TEAMID)" ./build-app.sh
#                                       → release build: versioned + hardened-runtime
#                                         signed with the Developer ID (for notarization)
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${RIVEN_VERSION:-0.0.1}"
SIGN_ID="${RIVEN_SIGN_ID:--}"   # default "-" = ad-hoc
# Supabase account/sync config (public client values). Baked into Info.plist; when
# absent the account feature shows its "not configured" state and nothing breaks.
SB_URL="${RIVEN_SUPABASE_URL:-}"
SB_KEY="${RIVEN_SUPABASE_ANON_KEY:-}"
SB_REDIRECT="${RIVEN_SUPABASE_REDIRECT:-}"

echo "▸ Building (release)… version=$VERSION"
swift build -c release

BIN=".build/release/Riven"
RES_BUNDLE=".build/release/Riven_Riven.bundle"
ICON="build/icon.icns"
ENTITLEMENTS="build/entitlements.native.plist"
APP="riven.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/riven"
# Copy the SwiftPM resource bundle (editor.html + monaco/ + shiki.js) into the app.
[ -d "$RES_BUNDLE" ] && cp -R "$RES_BUNDLE" "$APP/Contents/Resources/"
# App icon (shared ember mark, reused from the Electron build assets).
[ -f "$ICON" ] && cp "$ICON" "$APP/Contents/Resources/riven.icns"
# Sparkle auto-update framework → embedded in Contents/Frameworks (binary rpaths to it).
SPARKLE_FW=".build/release/Sparkle.framework"
if [ -d "$SPARKLE_FW" ]; then
  mkdir -p "$APP/Contents/Frameworks"
  cp -R "$SPARKLE_FW" "$APP/Contents/Frameworks/"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>riven</string>
  <key>CFBundleDisplayName</key><string>riven</string>
  <key>CFBundleIdentifier</key><string>com.wassupss.riven</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>riven</string>
  <key>CFBundleIconFile</key><string>riven</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key><true/>
  </dict>
  <key>SupabaseURL</key><string>$SB_URL</string>
  <key>SupabaseAnonKey</key><string>$SB_KEY</string>
  <key>SupabaseRedirect</key><string>$SB_REDIRECT</string>
  <key>SUFeedURL</key><string>${RIVEN_SPARKLE_FEED:-https://github.com/wassupss/riven/releases/download/appcast/appcast.xml}</string>
  <key>SUPublicEDKey</key><string>uXt3SWNuAg7MpkTHj/U4I5V2fah42RB7tezvr2xdTio=</string>
  <key>SUEnableAutomaticChecks</key><true/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>
</dict>
</plist>
PLIST

if [ "$SIGN_ID" = "-" ]; then
  # Local dev: ad-hoc sign so Gatekeeper/Metal are happy on this machine.
  codesign --force --deep --sign - "$APP" 2>/dev/null || true
  echo "▸ Built $APP (ad-hoc signed)"
else
  # Release: hardened runtime + entitlements, signed with the Developer ID so the
  # app can be notarized. Sign inner-out: Sparkle helpers → framework → binary → app.
  FW="$APP/Contents/Frameworks/Sparkle.framework"
  if [ -d "$FW" ]; then
    for x in "$FW/Versions/B/XPCServices/Downloader.xpc" "$FW/Versions/B/XPCServices/Installer.xpc"; do
      [ -e "$x" ] && codesign --force --options runtime --timestamp --preserve-metadata=entitlements --sign "$SIGN_ID" "$x"
    done
    [ -e "$FW/Versions/B/Autoupdate" ] && codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$FW/Versions/B/Autoupdate"
    [ -e "$FW/Versions/B/Updater.app" ] && codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$FW/Versions/B/Updater.app"
    codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$FW"
  fi
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID" "$APP/Contents/MacOS/riven"
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID" "$APP"
  codesign --verify --strict --verbose=2 "$APP"
  echo "▸ Built $APP (signed: $SIGN_ID)"
fi
