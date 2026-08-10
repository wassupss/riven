## Restart agents on the latest CLI (keeping the conversation)

The `claude` CLI updates itself even while riven is running. Agents already open then keep the **old** binary in memory — and an older version's bug could keep burning CPU.

- riven now notices the update and **offers to restart on the latest** — `[all / this chat / later]`. The conversation continues where it left off.
- Do it yourself with `/restart` (this chat) or `/restart all`. `/status` shows the version too.

## Leftover sockets and processes are cleaned up automatically

Each native chat uses a unix socket and a headless process. These used to pile up (hundreds) when riven crashed or was force-quit without cleaning them.

- **On quit**, chat sessions are torn down properly (sockets released, child processes ended).
- **On launch**, dead sockets left by a previous run are reclaimed. Live ones are never touched.

## Also

This screen appears the first time you launch after an update. You can reopen it any time from Settings → About.
