import { describe, it, expect } from 'vitest'
import { modelsFor, modelForCli, CLAUDE_MODELS, CODEX_MODELS } from './models'

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
