#!/usr/bin/env bash
# Rebuilds src/renderer/src/lib/ghostty/ghostty-vt.wasm from upstream Ghostty
# source. No third-party wrapper is involved: this is libghostty-vt exactly as
# ghostty-org/ghostty builds it, at a pinned commit.
#
# Needs zig matching the pinned commit's build.zig.zon (minimum_zig_version).
#   ZIG=/path/to/zig scripts/build-ghostty-vt.sh
#
# After bumping GHOSTTY_COMMIT, re-check the struct offsets and enum values in
# lib/ghostty/vt.ts against the new headers / ghostty_type_json().
set -euo pipefail

GHOSTTY_COMMIT=6ba144158577d033ccb6ed4b574e4013957c9161
ZIG=${ZIG:-zig}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/src/renderer/src/lib/ghostty"
WORK=${WORK:-$(mktemp -d)}

if [ ! -d "$WORK/ghostty/.git" ]; then
  git clone --filter=blob:none https://github.com/ghostty-org/ghostty.git "$WORK/ghostty"
fi
cd "$WORK/ghostty"
git fetch --quiet origin "$GHOSTTY_COMMIT"
git checkout --quiet --detach "$GHOSTTY_COMMIT"

"$ZIG" build -Demit-lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall

cp zig-out/bin/ghostty-vt.wasm "$OUT/ghostty-vt.wasm"
cp LICENSE "$OUT/LICENSE-ghostty"
shasum -a 256 "$OUT/ghostty-vt.wasm"
