import type { TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui-style textarea (riven's values; was .ui-textarea).
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return (
    <textarea
      className={cn(
        'box-border min-h-[72px] w-full resize-y rounded-[var(--radius-sm)] border border-[var(--edge)] bg-[var(--bg-2)] px-2.5 py-2 font-[inherit] text-[length:var(--text-sm)] leading-[1.5] text-[var(--fg)] transition-[border-color,box-shadow,background] duration-[var(--dur-fast)] ease-[ease] placeholder:text-[var(--fg-dim)] placeholder:opacity-70 focus:border-[var(--accent-border)] focus:shadow-[0_0_0_3px_var(--accent-muted)] focus:outline-none',
        className
      )}
      {...rest}
    />
  )
}
