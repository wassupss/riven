import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui-style segmented control: one option is on (riven's values; was
// .ui-seg / .ui-seg-btn).
export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: ReactNode }>
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="inline-flex h-[var(--ctl-h)] box-border gap-0.5 rounded-[var(--radius-sm)] border border-[var(--edge)] bg-[var(--bg-2)] p-0.5">
      {options.map((o) => {
        const on = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-w-[34px] cursor-pointer rounded-[calc(var(--radius-sm)_-_1px)] border-none px-3 font-[inherit] text-[length:var(--text-sm)] text-[var(--fg-dim)] transition-[background,color] duration-[var(--dur-fast)] ease-[ease]',
              on
                ? 'bg-[color-mix(in_srgb,var(--accent)_20%,var(--bg-2))] font-medium text-[var(--accent)]'
                : 'bg-transparent hover:bg-[var(--hover)] hover:text-[var(--fg)]'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
