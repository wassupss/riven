import { describe, it, expect } from 'vitest'
import { resumeCommand } from './agentResume'

const id = '019fda6a-3125-73b0-9bcb-3ef1304e0210'

describe('resumeCommand', () => {
  it('resumes a conversation with the CLI that had it', () => {
    expect(resumeCommand(id, 'codex')).toBe(`codex resume ${id}`)
    expect(resumeCommand(id, 'claude')).toBe(`claude --resume ${id}`)
  })

  it('treats a pane recorded before Codex support as Claude', () => {
    expect(resumeCommand(id, undefined)).toBe(`claude --resume ${id}`)
  })

  it('never types anything but a UUID', () => {
    expect(resumeCommand('x; rm -rf ~', 'claude')).toBeNull()
    expect(resumeCommand(null, 'codex')).toBeNull()
  })
})
