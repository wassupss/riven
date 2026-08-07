## Codex as a native chat

Pick Codex in ⌘O and you get the **native chat**, not a terminal. Streaming, approval cards, the Changes panel and token counts all work the same as they do for Claude.

- **Approval modes** apply to Codex too (Plan / Ask / Auto)
- Conversations **survive a restart**
- Tab and sidebar icons tell the two CLIs apart at a glance

## Usage, per CLI

The usage meter now shows Claude and Codex **separately**. It used to count only Claude, so Codex work never moved the needle.

- Choose **remaining % or used %** (Settings → General → Usage, or click a bar)
- Pinning it to the sidebar keeps the two apart as well

## Fixed

- **The same folder could split into two workspace cards.** It happened on long-lived sessions, and the two cards opened different panels. This launch merges them automatically — your open tabs are kept
- Restarting could open a different workspace than the one you were in
- In a Codex chat, `/cost`, `/status` and the session list showed **Claude account** data
- The usage freshness line was printed twice

## Settings

- Editor: **tab size, word wrap, minimap, font ligatures**
- Browser **search engine**
- **Default model and approval mode** for new conversations
- **Turn off auto-update**, reveal the settings file, reset settings, restore shortcuts
- The list of installed agent CLIs (path and version)
