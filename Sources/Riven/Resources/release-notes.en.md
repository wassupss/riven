## PDF and spreadsheets open in tabs

`.pdf`, `.xlsx`, `.csv` and `.tsv` open as tabs from the explorer. Tabs, closing and splitting work the same as any other file.

- PDFs keep page navigation, zoom, search and text selection
- Spreadsheets show **dates, thousands separators, percentages, merged cells, column widths and bold** (read-only)
- Large images open now too (anything over 10MB used to be refused)

## Drop files onto the explorer to import them

Dragging from Finder **copies** into that folder. If the name is taken it becomes `name 2.txt` — nothing is overwritten.

## Fixed

- **Sidebar resizing.** The sidebar grew with the window, and clicking the divider snapped it narrower. The 1pt divider was also nearly impossible to grab
- **The same folder could split into two workspace cards** (fixed in v0.1.56 — they merge automatically on launch)
- **Places that ignored a theme change** — the top strip, the sidebar header, the settings sidebar, the pinned usage panel, the update pill
- **Plain terminals looked permanently "busy"**
- **Commit details were cut off with blank space below**
- In a Codex chat, `/cost`, `/status` and the session list showed Claude account data

## Settings

- Changing a setting now shows **"✓ Saved"**
- **Default model per CLI** (Claude / Codex)
- **17 browser shortcuts** are listed in the shortcuts screen
- Read usage as **remaining % or used %** (clicking a bar switches too)
- Cloud sync now happens once, on quit

## Also

This screen appears the first time you launch after an update. You can reopen it any time from Settings → About.
