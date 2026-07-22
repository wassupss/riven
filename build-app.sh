#!/bin/bash
# Package the SwiftPM build into a proper riven.app bundle (resources + Info.plist).
# Usage: ./build-app.sh  →  ./riven.app
set -euo pipefail
cd "$(dirname "$0")"

echo "▸ Building (release)…"
swift build -c release

BIN=".build/release/Riven"
RES_BUNDLE=".build/release/Riven_Riven.bundle"
APP="riven.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BIN" "$APP/Contents/MacOS/riven"
# Copy the SwiftPM resource bundle (editor.html + monaco/) into the app.
[ -d "$RES_BUNDLE" ] && cp -R "$RES_BUNDLE" "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>riven</string>
  <key>CFBundleDisplayName</key><string>riven</string>
  <key>CFBundleIdentifier</key><string>com.wassupss.riven</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>riven</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

# Ad-hoc sign so Gatekeeper/Metal are happy locally.
codesign --force --deep --sign - "$APP" 2>/dev/null || true
echo "▸ Built $APP"
