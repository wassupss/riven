import { useEffect } from 'react'
import { create } from 'zustand'
import type { ModelInfo } from '../lib/models'

// The CLI's model list, per account profile (config dir), fetched on first use.
// Every picker reads it through useClaudeCatalog so there is one fetch per
// profile, not one per open pane.

interface CatalogState {
  /** undefined = not asked yet; a failed ask leaves it undefined so it is retried. */
  byDir: Record<string, ModelInfo[] | undefined>
}

const useCatalog = create<CatalogState>(() => ({ byDir: {} }))
const inflight = new Set<string>()

export function ensureClaudeCatalog(configDir?: string): void {
  const key = configDir ?? ''
  if (useCatalog.getState().byDir[key] !== undefined || inflight.has(key)) return
  inflight.add(key)
  window.api.models
    .claude(configDir)
    .then((models) => {
      if (models) useCatalog.setState((s) => ({ byDir: { ...s.byDir, [key]: models } }))
    })
    .catch(() => {
      /* labels fall back to the aliases */
    })
    .finally(() => inflight.delete(key))
}

export function useClaudeCatalog(configDir?: string): ModelInfo[] | null {
  const models = useCatalog((s) => s.byDir[configDir ?? ''])
  useEffect(() => ensureClaudeCatalog(configDir), [configDir])
  return models ?? null
}
