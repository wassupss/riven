#!/usr/bin/env bash
# Build and launch the Tauri flavour of riven (dev).
#   tauri/run.sh                 everything
#   tauri/run.sh --no-renderer   skip the renderer build (main/preload/shell only)
#
# Test launches (agents, scripts) add RIVEN_TAURI_BACKGROUND=1: the app then
# never takes focus or comes in front of the user's work (Accessory app,
# windows ordered behind everything). Not set here: normal dev use is in front.
#
# The binary runs from a minimal dev .app (src-tauri/target/debug/riven-tauri.app):
# notifications (UNUserNotificationCenter) need a bundle with an identifier and
# an icon, or they wear Script Editor's and a click can't come back. The
# wrapper holds only Info.plist, the binary and the icon; no Resources/app or
# Resources/node, so main.rs `bundled()` stays false and dev keeps running the
# live out-tauri with the local Node. RIVEN_TAURI_NO_APP=1 runs the bare binary.
# Its bundle id is riven-tauri, not tauri.conf.json's (see dev_app below).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
node tauri/build.mjs "$@"
(cd src-tauri && cargo build)

bin=src-tauri/target/debug/riven-tauri
if [ "$(uname)" != Darwin ] || [ "${RIVEN_TAURI_NO_APP:-}" = 1 ]; then
  exec "$bin"
fi

dev_app() {
  local app=src-tauri/target/debug/riven-tauri.app
  local stage=src-tauri/target/debug/.dev-app/riven-tauri.app
  local conf=src-tauri/tauri.conf.json
  local id name version
  # The bundle id is also where WebKit keeps the page's data (localStorage:
  # chat logs, pipelines, agent groups, ...): ~/Library/WebKit/<bundle id>.
  # The bare binary had no id, so WebKit used its name, riven-tauri; keeping
  # that id keeps the dev data where it was, and keeps dev apart from the
  # packaged app (tauri.conf.json's identifier). RIVEN_TAURI_DEV_ID overrides.
  id=${RIVEN_TAURI_DEV_ID:-riven-tauri}
  name=$(node -p "require('./$conf').productName") || return 1
  version=$(node -p "require('./$conf').version") || return 1
  rm -rf "$stage"
  mkdir -p "$stage/Contents/MacOS" "$stage/Contents/Resources" || return 1
  # A clone (APFS), not a symlink: the bundle is found from the executable's path.
  cp -c "$bin" "$stage/Contents/MacOS/riven-tauri" 2>/dev/null || cp "$bin" "$stage/Contents/MacOS/riven-tauri" || return 1
  cp build/icon.icns "$stage/Contents/Resources/icon.icns" || return 1
  cat >"$stage/Contents/Info.plist" <<PLIST || return 1
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>riven-tauri</string>
  <key>CFBundleIdentifier</key><string>$id</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
PLIST
  # Ad-hoc signature over the whole bundle, so its identity is the bundle id
  # (the linker's own signature names the bare binary and binds no Info.plist).
  codesign --force --sign - "$stage" >/dev/null 2>&1 || echo "run.sh: ad-hoc signing the dev app failed (continuing)" >&2
  # Swap in by rename: a running copy keeps its (unlinked) files.
  rm -rf "$app" && mv "$stage" "$app" || return 1
  rmdir "$(dirname "$stage")" 2>/dev/null || true
  # Tell Launch Services about it now, so the notification icon is ours from the first one.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" >/dev/null 2>&1 || true
  echo "$app/Contents/MacOS/riven-tauri"
}

if exe=$(dev_app); then
  exec "$exe"
fi
echo "run.sh: could not build the dev .app; running the bare binary (notifications fall back to osascript)" >&2
exec "$bin"
