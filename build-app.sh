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
# Bundle the TypeScript language server (+ its `typescript` peer) so LSP features
# (go-to-definition / references / diagnostics) work WITHOUT a global or per-project
# install on the user's machine. cli.mjs is self-contained (imports only node built-ins)
# and loads `typescript` from a sibling in this node_modules, so both are copied here.
LSP_NM="$APP/Contents/Resources/Riven_Riven.bundle/Resources/lsp/node_modules"
if [ -d node_modules/typescript-language-server ] && [ -d node_modules/typescript ]; then
  mkdir -p "$LSP_NM"
  cp -R node_modules/typescript-language-server "$LSP_NM/"
  cp -R node_modules/typescript "$LSP_NM/"
  echo "▸ Bundled TypeScript language server ($(du -sh "$LSP_NM" | cut -f1))"
else
  echo "⚠︎ node_modules/typescript-language-server or typescript missing — LSP won't be bundled (run npm install)"
fi
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
  <!-- Declare the languages riven speaks. Without this the system doesn't consider the
       app Korean-capable and collapses the process language to English, so frameworks
       that draw their OWN UI from bundled .lproj files (Sparkle's update window ships
       ko.lproj) stayed English even when riven was set to Korean. -->
  <key>CFBundleDevelopmentRegion</key><string>ko</string>
  <key>CFBundleLocalizations</key>
  <array>
    <string>ko</string>
    <string>en</string>
  </array>
  <key>CFBundleIconFile</key><string>riven</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <!-- Declare the languages the app supports. Without these macOS limits the bundle to a
       single (development) localization, so EMBEDDED frameworks can't resolve their own
       localized strings — Sparkle ships ko.lproj but its update window came out in the
       wrong/mixed language. Declaring ko+en lets Sparkle localize per the user's language. -->
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key>
  <array><string>en</string><string>ko</string></array>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <!-- Allow plain-HTTP ONLY for local/dev servers (localhost, 127.0.0.1, ::1, *.local)
       so the Browser panel can preview e.g. http://localhost:3000. We deliberately do
       NOT set NSAllowsArbitraryLoadsInWebContent: that would drop ATS TLS enforcement for
       every remote site the Browser loads, enabling downgrade MITM. NSAllowsLocalNetworking
       covers the dev-server case while keeping full TLS hardening on remote URLs. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
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
  # Local dev: ad-hoc sign WITH the hardened runtime (--options runtime), inner-out.
  # WITHOUT the runtime flag the app's WKWebView WebContent process runs degraded
  # (no JIT / hardware acceleration for JavaScriptCore), which made Monaco's editor
  # extremely laggy in local ad-hoc builds even though notarized releases (which DO
  # have the hardened runtime) were smooth. Matching the runtime here makes local test
  # builds behave like the shipped app.
  FW="$APP/Contents/Frameworks/Sparkle.framework"
  if [ -d "$FW" ]; then
    for x in "$FW"/Versions/B/XPCServices/*.xpc; do
      [ -e "$x" ] && codesign --force --options runtime --sign - "$x"
    done
    [ -e "$FW/Versions/B/Autoupdate" ] && codesign --force --options runtime --sign - "$FW/Versions/B/Autoupdate"
    [ -e "$FW/Versions/B/Updater.app" ] && codesign --force --options runtime --sign - "$FW/Versions/B/Updater.app"
    codesign --force --options runtime --sign - "$FW"
  fi
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$APP/Contents/MacOS/riven"
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$APP"
  echo "▸ Built $APP (ad-hoc + hardened runtime)"
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
