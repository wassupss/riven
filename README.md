# riven

An AI-first desktop IDE built around agent orchestration. Left explorer · a center of dockable AI terminals/agents · a Monaco code editor and web preview — all as freely dockable panels.

Native macOS app (Swift/AppKit). The Electron build is preserved on the `0.0.10`
branch; `main` and version branches are native.

## Stack

- **Swift + AppKit** — native app shell, windowing, docking, explorer, git, LSP bridge
- **libghostty** (GhosttyKit.xcframework) — GPU-accelerated terminals
- **Monaco** in a WKWebView (`Sources/Riven/Resources/editor.html`) — the editor, with VS Code-style split groups, agent-diff review, and an LSP/AI message bridge to the native side
- **Shiki** for TextMate-grade syntax highlighting (tsx/jsx first-class), bundled offline
- **Multi-language LSP** over vscode-jsonrpc (completion, hover, definition, references, diagnostics) — TypeScript/JS today; more servers plug into `LSP/LSPManager.swift`
- **Supabase** account + settings sync (GitHub OAuth, PKCE)

## Build

Requires a Swift 6 toolchain (Xcode 15+) and the libghostty framework at
`ghostty-fw/GhosttyKit.xcframework` (gitignored — provisioned separately; see below).

```bash
./build-app.sh          # → ./riven.app (ad-hoc signed, for local dev)
```

### libghostty

The framework is too big to commit. Build it from source and drop it at `ghostty-fw/`:

```bash
# in a ghostty-org/ghostty checkout (Zig 0.15.2):
zig build -Doptimize=ReleaseFast -Demit-xcframework=true -Dxcframework-target=universal
# → zig-out/macos/GhosttyKit.xcframework  →  copy to riven/ghostty-fw/
```

In CI it's downloaded from the `ghostty-fw` GitHub release (built by
`.github/workflows/ghostty.yml`). A tagged `v*` push triggers the signed, notarized
dmg release (`.github/workflows/release.yml`).

## Features

- **Per-workspace sessions** — open multiple projects at once; each keeps its own tabs, layout, and terminals. Switching workspaces never kills terminals. Layout and open tabs are persisted and restored on restart.
- **Persistent terminals** — PTYs live in the main process and reconnect with a serialized screen snapshot, surviving `⌘R` and panel remounts.
- **Agent-aware terminals** — running-state and attention (bell / task-done) are detected from actual agent child processes, not raw output, so your own typing never trips a false "running".
- **AI ↔ context bridge** — send editor selections, files, or diagnostics to the focused terminal; `@`-mention files from the explorer.
- **Agent-edit review** — a file watcher detects edits made by agents and summarizes them in a Changes panel: a timeline of touched files with +/- line counts and relative time. Clicking a row opens that file with a multi-hunk inline diff (added/removed lines, per-hunk revert) against a cached or git baseline.
- **Full-text search**, live file tree, colored file-type icons, custom keybindings, and themes.

## Keybindings (defaults, rebindable via `⌥⌘K`)

| Action | Key |
| --- | --- |
| Switch workspace 1–9 | `⌘1`–`⌘9` |
| Focus editor / terminal | `⌘E` / `⌘J` |
| Cycle panels | `⌥⌘←` / `⌥⌘→` |
| New terminal | `⌘T` |
| Explorer / Search / Git / CLI | `⌘B` / `⌘⇧F` / `⌘⇧G` / `⌘⇧L` |
| Preview / Pop out panel | `⌘⇧V` / `⌘⇧P` |
| Settings / Keybindings | `⌘,` / `⌥⌘K` |
| Split editor (right / down) | `⌘\` / `⌥⌘\` |
