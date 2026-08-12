## Manage MCP servers right in the app

Type `/mcp` in a chat and you now see the MCP servers configured for this workspace and their status (● in use / ○ needs auth). Right there you can:

- **Add**: paste whatever goes after `claude mcp add` and riven runs it, including forms like `--transport http ... --header "Authorization: Bearer ..."`.
- **Authenticate**: pick a server that needs auth and a browser opens to log in, no terminal required.
- **Remove**: pick a server to remove.

Everything happens in the app, and it reconnects automatically when done.

## Also

This screen appears the first time you launch after an update. You can reopen it any time from Settings → About.
