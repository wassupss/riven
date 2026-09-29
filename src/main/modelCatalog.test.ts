import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { parseModelsLine } from './modelCatalog'

describe('parseModelsLine', () => {
  it('reads the models out of the initialize response', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'riven-models',
        response: {
          commands: [],
          models: [
            { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'x' },
            { value: 'broken' } // no displayName: skipped rather than shown blank
          ]
        }
      }
    })
    expect(parseModelsLine(line)).toEqual([
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'x' }
    ])
  })

  it('ignores everything that is not the answer to this probe', () => {
    expect(parseModelsLine('{"type":"system","subtype":"init"}')).toBeNull()
    expect(
      parseModelsLine(JSON.stringify({ type: 'control_response', response: { request_id: 'other' } }))
    ).toBeNull()
    expect(parseModelsLine('not json')).toBeNull()
  })
})
