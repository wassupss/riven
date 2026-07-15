import { promises as fs } from 'fs'

// Atomic + serialized JSON writes. Writes go through a temp file then rename
// (atomic on the same filesystem), and writes to the SAME target are chained so
// two overlapping saves can't interleave into a shared temp or land out of
// order — the last-queued write wins, which is what debounced autosaves want.

const chains = new Map<string, Promise<unknown>>()

export function atomicWriteJson(file: string, data: unknown): Promise<void> {
  const prev = chains.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => {}) // a failed prior write must not block later ones
    .then(async () => {
      const tmp = `${file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(data, null, 2))
      await fs.rename(tmp, file)
    })
  chains.set(file, next)
  // Drop the entry once this write is the tail, so the map can't grow forever.
  void next.catch(() => {}).finally(() => {
    if (chains.get(file) === next) chains.delete(file)
  })
  return next
}
