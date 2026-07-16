import { promises as fs } from 'fs'

// Atomic + serialized writes. Writes go through a temp file then rename (atomic
// on the same filesystem), and writes to the SAME target are chained so two
// overlapping saves can't interleave into a shared temp or land out of order —
// the last-queued write wins, which is what debounced autosaves want.
//
// The temp suffix is deliberately distinctive so the file watcher (bridge.ts)
// and the workspace walk can ignore it and not flicker it into the Explorer or
// trigger a spurious git refresh during a source save.
export const TMP_SUFFIX = '.riven-tmp'

const chains = new Map<string, Promise<unknown>>()

function enqueue(file: string, content: string): Promise<void> {
  const prev = chains.get(file) ?? Promise.resolve()
  const next = prev
    .catch(() => {}) // a failed prior write must not block later ones
    .then(async () => {
      const tmp = `${file}${TMP_SUFFIX}`
      await fs.writeFile(tmp, content)
      await fs.rename(tmp, file)
    })
  chains.set(file, next)
  // Drop the entry once this write is the tail, so the map can't grow forever.
  void next.catch(() => {}).finally(() => {
    if (chains.get(file) === next) chains.delete(file)
  })
  return next
}

// Atomic, serialized write of raw text (e.g. an editor save).
export function atomicWriteText(file: string, content: string): Promise<void> {
  return enqueue(file, content)
}

export function atomicWriteJson(file: string, data: unknown): Promise<void> {
  return enqueue(file, JSON.stringify(data, null, 2))
}
