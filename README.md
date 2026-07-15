# riven

An AI-first desktop IDE built around agent orchestration. Left explorer · a center of dockable AI terminals/agents · a Monaco code editor and web preview — all as freely dockable panels.

## Stack

- **Electron** + electron-vite + React + TypeScript
- **Monaco** editor with direct model management (one editor, many models keyed by file URI)
- **xterm.js** + **node-pty** — real PTYs, kept alive in the main process so terminals survive renderer reloads
- **dockview** — VSCode-style fluid docking; every area (explorer / editor / preview / terminal) is a draggable panel, poppable into its own window
- **Shiki** for TextMate-grade syntax highlighting (tsx/jsx as first-class languages)
- **Multi-language LSP** over vscode-jsonrpc (completion, hover, go-to-definition, diagnostics). TypeScript/JS, Python (Pyright), YAML, and Bash servers are bundled and work with zero setup; C/C++ (clangd), Go (gopls), and Rust (rust-analyzer) light up automatically when installed on PATH. JSON/CSS/HTML use Monaco's built-in workers.
- zustand for state

## Run

```bash
npm install      # postinstall rebuilds node-pty against the Electron ABI
npm run dev
```

If the node-pty rebuild fails:

```bash
npm run rebuild
```

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

## LSP smoke test

```bash
node scripts/test-lsp.mjs
```
