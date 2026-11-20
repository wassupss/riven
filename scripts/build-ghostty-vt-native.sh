#!/usr/bin/env bash
# Builds libghostty-vt as a native static library for the Tauri shell
# (src-tauri/vendor/ghostty-vt/<rust target>/libghostty-vt.a). Same upstream
# source and commit as the renderer's wasm (scripts/build-ghostty-vt.sh), so a
# snapshot the Rust model encodes is one the renderer's terminal decodes.
#
# Needs zig matching the pinned commit's build.zig.zon (minimum_zig_version,
# 0.17.0 for this commit).
#   ZIG=/path/to/zig scripts/build-ghostty-vt-native.sh
set -euo pipefail

GHOSTTY_COMMIT=6ba144158577d033ccb6ed4b574e4013957c9161
ZIG=${ZIG:-zig}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/src-tauri/vendor/ghostty-vt"
WORK=${WORK:-$(mktemp -d)}

if [ ! -d "$WORK/ghostty/.git" ]; then
  git clone --filter=blob:none https://github.com/ghostty-org/ghostty.git "$WORK/ghostty"
fi
cd "$WORK/ghostty"
git fetch --quiet origin "$GHOSTTY_COMMIT"
git checkout --quiet --detach "$GHOSTTY_COMMIT"

# rust target triple -> zig target
for pair in aarch64-apple-darwin:aarch64-macos x86_64-apple-darwin:x86_64-macos; do
  rust=${pair%%:*}
  zig_target=${pair##*:}
  rm -rf zig-out
  "$ZIG" build -Demit-lib-vt -Demit-xcframework=false -Dtarget="$zig_target" -Doptimize=ReleaseFast
  mkdir -p "$OUT/$rust"
  # Debug info is most of the archive (12MB -> 3MB); the app strips it anyway.
  strip -S -o "$OUT/$rust/libghostty-vt.a" zig-out/lib/libghostty-vt.a
  shasum -a 256 "$OUT/$rust/libghostty-vt.a"
done
cp LICENSE "$OUT/LICENSE-ghostty"
