import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button as ControlButton } from './Controls'
import { Button, buttonVariants } from './button'

describe('Button', () => {
  it('keeps riven control height and the shared border on every variant', () => {
    for (const variant of ['default', 'primary', 'ghost'] as const) {
      const cls = buttonVariants({ variant })
      expect(cls).toContain('h-[var(--ctl-h)]')
      expect(cls).toContain('border-[var(--edge)]')
      expect(cls).toContain('text-[length:var(--text-sm)]')
    }
  })

  it('gives primary the accent fill and the other variants none', () => {
    expect(buttonVariants({ variant: 'primary' })).toContain('bg-[var(--accent)]')
    expect(buttonVariants({ variant: 'default' })).not.toContain('bg-[var(--accent)]')
    expect(buttonVariants({ variant: 'ghost' })).toContain('bg-transparent')
  })

  it('merges a caller className last, so it can override one utility', () => {
    const html = renderToStaticMarkup(<Button variant="ghost" className="px-6" />)
    expect(html).toContain('px-6')
    expect(html).not.toContain('px-2.5')
    expect(html).toContain('bg-transparent')
  })

  it('is what the shared Controls Button renders', () => {
    const html = renderToStaticMarkup(<ControlButton variant="primary">Save</ControlButton>)
    expect(html).toContain('bg-[var(--accent)]')
    expect(html).toContain('>Save</button>')
    expect(html).not.toContain('ui-btn')
  })
})
