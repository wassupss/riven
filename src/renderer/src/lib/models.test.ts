import { describe, it, expect } from 'vitest'
import {
  modelsFor,
  modelForCli,
  modelLabel,
  pinnedModels,
  prettyModelId,
  CLAUDE_MODELS,
  CODEX_MODELS,
  type ModelInfo
} from './models'

describe('modelsFor', () => {
  it('offers every Claude model, fable included', () => {
    expect(CLAUDE_MODELS).toContain('fable')
    expect(modelsFor('claude')).toEqual(CLAUDE_MODELS)
    expect(modelsFor(undefined)).toEqual(CLAUDE_MODELS) // no cli = claude
  })

  it('offers Codex its own models', () => {
    expect(modelsFor('codex')).toEqual(CODEX_MODELS)
  })
})

describe('modelForCli', () => {
  it('keeps a model the CLI actually has', () => {
    expect(modelForCli('fable', 'claude')).toBe('fable')
    expect(modelForCli('gpt-5.5', 'codex')).toBe('gpt-5.5')
  })

  it('falls back when the CLI changes under it', () => {
    expect(modelForCli('opus', 'codex')).toBe('default')
    expect(modelForCli('gpt-5.5', 'claude')).toBe('default')
    expect(modelForCli(null, 'claude')).toBe('default')
  })
})

// The list the CLI answered `initialize` with on 2026-09-29, trimmed to what the
// labels depend on.
const CATALOG: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5' },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5' },
  { value: 'claude-fable-5', resolvedModel: 'claude-fable-5', displayName: 'Fable 5' },
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' }
]

describe('modelLabel', () => {
  it('names each alias by the version it resolves to', () => {
    expect(modelLabel('opus', CATALOG)).toBe('Opus 5.5')
    expect(modelLabel('sonnet', CATALOG)).toBe('Sonnet 5.5')
    expect(modelLabel('haiku', CATALOG)).toBe('Haiku 4.5')
  })

  it('finds fable, which the CLI lists only by its pinned id', () => {
    expect(modelLabel('fable', CATALOG)).toBe('Fable 5.1')
  })

  it('says what default means, by that model\'s own name', () => {
    expect(modelLabel('default', CATALOG)).toBe('default · Opus 5.5')
  })

  it('labels a pinned version', () => {
    expect(modelLabel('claude-opus-4-8', CATALOG)).toBe('Opus 4.8')
  })

  it('falls back to the alias when there is no catalog', () => {
    expect(modelLabel('opus', null)).toBe('opus')
    expect(modelLabel('default', null)).toBe('default')
    expect(modelLabel('claude-opus-5-5', null)).toBe('Opus 5.5')
  })
})

describe('prettyModelId', () => {
  it('reads a version as a version, not as words', () => {
    // The old formatter gave "opus 5 5".
    expect(prettyModelId('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModelId('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(prettyModelId('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(prettyModelId('claude-sonnet-5')).toBe('Sonnet 5')
  })
})

describe('pinnedModels', () => {
  it('offers the versions no alias already reaches', () => {
    const pinned = pinnedModels(CATALOG).map((e) => e.value)
    expect(pinned).toEqual(['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8'])
    // Fable 5.1 is what "fable" already runs, so it is not listed twice.
    expect(pinned).not.toContain('claude-fable-5-1')
  })

  it('is empty without a catalog', () => {
    expect(pinnedModels(null)).toEqual([])
  })
})

describe('modelForCli with pinned versions', () => {
  it('keeps a pinned Claude version, and drops it for Codex', () => {
    expect(modelForCli('claude-opus-4-8', 'claude')).toBe('claude-opus-4-8')
    expect(modelForCli('claude-opus-4-8', 'codex')).toBe('default')
  })
})
