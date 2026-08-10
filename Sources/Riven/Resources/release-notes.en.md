## Fixed in this release

- **Delegating to an agent** now shows **"in progress…" → "done"** in the lead conversation, so you can tell whether async-delegated work is still running.
- **Where documents are saved.** Docs created with `riven_doc_write` now land in **that workspace's `.claude/docs`** and show in the Docs tab (they used to go to the wrong place and never appear).
- **Idle members no longer show as "busy"** — only a genuinely running session is marked busy.
- **Workspace card clicks** — fixed the 3rd card jumping to the 1st (a folder could split into two cards; that's gone).
- **Macs set to always show scroll bars** no longer get a stray horizontal scrollbar in the settings window and other panels.
- **Release notes after an update** now show on signed-in machines (they could be suppressed by cloud-synced state).

## Also

This screen appears the first time you launch after an update. You can reopen it any time from Settings → About.
