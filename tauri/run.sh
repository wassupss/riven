#!/usr/bin/env bash
# Build and launch the Tauri flavour of riven (dev, unbundled).
#   tauri/run.sh                 everything
#   tauri/run.sh --no-renderer   skip the renderer build (main/preload/shell only)
#
# Test launches (agents, scripts) add RIVEN_TAURI_BACKGROUND=1: the app then
# never takes focus or comes in front of the user's work (Accessory app,
# windows ordered behind everything). Not set here: normal dev use is in front.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
node tauri/build.mjs "$@"
(cd src-tauri && cargo build)
exec src-tauri/target/debug/riven-tauri
