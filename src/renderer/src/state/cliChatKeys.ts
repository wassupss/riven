// The pane keys that are CLI chats (services/clichat) in this window. Kept in a
// module of its own so the roster can ask without importing the CLI chat hub
// (which imports the roster).
//
// A CLI chat runs in a hidden pty, and its hooks reach the terminal side too
// (pty:status). The roster takes a CLI chat's state from its own events
// (state/cliChats) and ignores the pty's view of it.

const keys = new Set<string>()

export function markCliChat(key: string): void {
  keys.add(key)
}

export function forgetCliChat(key: string): void {
  keys.delete(key)
}

export function isCliChat(key: string): boolean {
  return keys.has(key)
}
