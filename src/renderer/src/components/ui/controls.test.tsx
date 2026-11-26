import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NumberInput, Segmented, Select, Switch, TextArea, TextInput } from './Controls'

describe('shared controls', () => {
  it('text input keeps riven height, border and the accent focus ring', () => {
    const html = renderToStaticMarkup(<TextInput placeholder="name" className="extra" />)
    expect(html).toContain('h-[var(--ctl-h)]')
    expect(html).toContain('focus:shadow-[0_0_0_3px_var(--accent-muted)]')
    expect(html).toContain('extra')
    expect(html).toContain('placeholder="name"')
  })

  it('number input is the fixed-width right-aligned size', () => {
    const html = renderToStaticMarkup(<NumberInput value={3} onChange={() => {}} />)
    expect(html).toContain('type="number"')
    expect(html).toContain('w-[84px]')
    expect(html).toContain('text-right')
  })

  it('select keeps the control height, the arrow hook and the accent focus', () => {
    const html = renderToStaticMarkup(
      <Select value="a" onChange={() => {}}>
        <option value="a">A</option>
      </Select>
    )
    expect(html).toContain('ui-select')
    expect(html).toContain('h-[var(--ctl-h)]')
    expect(html).toContain('appearance-none')
    expect(html).toContain('pr-[26px]')
  })

  it('textarea keeps its minimum height and vertical resize', () => {
    const html = renderToStaticMarkup(<TextArea rows={3} />)
    expect(html).toContain('min-h-[72px]')
    expect(html).toContain('resize-y')
  })

  it('switch shows the accent track and the on-accent knob only when on', () => {
    const on = renderToStaticMarkup(<Switch checked onChange={() => {}} label="auto" />)
    const off = renderToStaticMarkup(<Switch checked={false} onChange={() => {}} label="auto" />)
    expect(on).toContain('aria-checked="true"')
    expect(on).toContain('translate-x-4')
    expect(off).toContain('aria-checked="false"')
    expect(off).not.toContain('translate-x-4')
    expect(off).toContain('aria-label="auto"')
  })

  it('segmented marks only the selected option', () => {
    const html = renderToStaticMarkup(
      <Segmented
        value="b"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' }
        ]}
        onChange={() => {}}
      />
    )
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-pressed="true"')
    expect(html.indexOf('aria-pressed="true"')).toBeGreaterThan(html.indexOf('aria-pressed="false"'))
  })
})
