// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Turn } from '../../../lib/cliChat'

// Some modules listen on the document when they load; a bare node run has none.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).document ??= { addEventListener() {}, removeEventListener() {}, hasFocus: () => false }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).window ??= { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const { TurnView } = await import('./TurnView')

const tool = (key: string, name: string, input: unknown, result: string | null) => ({
  kind: 'tool' as const,
  tool: { key, toolId: key, name, input, result: result == null ? null : { text: result, isError: false } }
})

describe('TurnView tool groups', () => {
  it('folds consecutive tool calls into one group with a count, as the native chat did', () => {
    const turn = {
      user: null,
      blocks: [
        tool('t1', 'Read', { file_path: '/w/a.ts' }, 'x'),
        tool('t2', 'Bash', { command: 'ls' }, 'y'),
        { kind: 'text' as const, key: 'm:0', text: 'done' },
        tool('t3', 'Read', { file_path: '/w/b.ts' }, 'z')
      ],
      usage: null,
      durationMs: null
    } as unknown as Turn
    const html = renderToStaticMarkup(createElement(TurnView, { chatKey: 'k', turn, agents: {}, hidden: undefined, tail: null }))
    // The first two calls share one group; the one after the text is its own group.
    expect(html.match(/chat-toolgroup /g)?.length).toBe(2)
    expect(html).toContain('명령 2개')
    expect(html).toContain('명령 1개')
    // Collapsed by default: the calls themselves are not drawn until it is opened.
    expect(html).not.toContain('cli-chat-tool-name')
  })
})
