import { cn } from '@/lib/utils'

// shadcn/ui-style on/off switch (riven's values; was .ui-switch).
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  title
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** Its accessible name, where no visible label sits beside it. */
  label?: string
  title?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative box-border h-5 w-9 flex-none cursor-pointer rounded-[var(--radius-full)] border border-[var(--edge)] bg-[var(--bg-3)] p-0 transition-[background,border-color] duration-[var(--dur-fast)] ease-[ease] disabled:cursor-default disabled:opacity-45',
        checked && 'border-[var(--accent)] bg-[var(--accent)]'
      )}
    >
      {/* --on-accent is the theme's designated on-accent ink, so the knob always
          contrasts the accent track (white accents like Void included). */}
      <span
        className={cn(
          'absolute left-px top-px h-4 w-4 rounded-full transition-[transform,background] duration-[var(--dur-fast)] ease-[ease]',
          checked ? 'translate-x-4 bg-[var(--on-accent)]' : 'bg-[var(--fg-dim)]'
        )}
      />
    </button>
  )
}
