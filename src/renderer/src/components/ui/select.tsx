import type { SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui-style select (riven's values). The dropdown arrow is a background
// image, and .ui-fontfield sizes the select by class, so the `ui-select` class
// stays for those two rules in styles.css; everything else is utilities.
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return (
    <select
      className={cn(
        'ui-select box-border h-[var(--ctl-h)] cursor-pointer appearance-none rounded-[var(--radius-sm)] border border-[var(--edge)] bg-[var(--bg-2)] py-0 pr-[26px] pl-2.5 font-[inherit] text-[length:var(--text-sm)] text-[var(--fg)] transition-[border-color,box-shadow,background] duration-[var(--dur-fast)] ease-[ease] focus:border-[var(--accent-border)] focus:shadow-[0_0_0_3px_var(--accent-muted)] focus:outline-none',
        className
      )}
      {...rest}
    >
      {children}
    </select>
  )
}
