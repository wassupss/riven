import type { TurnDone } from '../lib/cliChatLive'

// Finished CLI chat turns, as a dependency-free bus. The pet window imports
// this; pulling it from state/cliChats would drag the chat stores (askUser,
// roster) into the chunk shared with the pet entry and break the load order.
const listeners = new Set<(key: string, done: TurnDone) => void>()

/** Every finished CLI chat turn (the pet listens). */
export function onCliTurnDone(fn: (key: string, done: TurnDone) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitCliTurnDone(key: string, done: TurnDone): void {
  for (const fn of listeners) fn(key, done)
}
