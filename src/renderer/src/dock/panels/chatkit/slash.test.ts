import { describe, expect, it } from 'vitest'
import { menuCommands, modelCommand, nativeCommand, slashDesc, slashMatches } from './slash'

describe('slash menu', () => {
  it("puts riven's commands first, once", () => {
    expect(menuCommands(['model', 'compact'], ['resume', 'model'])).toEqual(['resume', 'model', 'compact'])
  })
  it('matches a bare /query only', () => {
    expect(slashMatches('/co', ['compact', 'context', 'clear'])).toEqual(['compact', 'context'])
    expect(slashMatches('/compact now', ['compact'])).toEqual([])
    expect(slashMatches('hi', ['compact'])).toEqual([])
  })
  it('answers a bare native command, not one with arguments', () => {
    expect(nativeCommand('/model', ['model'])).toBe('model')
    expect(nativeCommand(' /model ', ['model'])).toBe('model')
    expect(nativeCommand('/model opus', ['model'])).toBeNull()
    expect(nativeCommand('/compact', ['model'])).toBeNull()
  })
  it('describes the commands it knows', () => {
    expect(slashDesc('compact', 'en')).toMatch(/Summarize/)
    expect(slashDesc('nope', 'ko')).toBe('')
  })
})

describe('/model', () => {
  it('is caught with or without a name', () => {
    expect(modelCommand('/model')).toBeNull()
    expect(modelCommand('/model  opus ')).toBe('opus')
    expect(modelCommand('/models')).toBeUndefined()
    expect(modelCommand('use /model')).toBeUndefined()
  })
})
