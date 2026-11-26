import { cva, type VariantProps } from 'class-variance-authority'
import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui-style text input (riven's values; was .ui-input / .ui-input-num).
export const inputVariants = cva(
  'box-border h-[var(--ctl-h)] rounded-[var(--radius-sm)] border border-[var(--edge)] bg-[var(--bg-2)] px-2.5 font-[inherit] text-[length:var(--text-sm)] text-[var(--fg)] transition-[border-color,box-shadow,background] duration-[var(--dur-fast)] ease-[ease] placeholder:text-[var(--fg-dim)] placeholder:opacity-70 focus:border-[var(--accent-border)] focus:shadow-[0_0_0_3px_var(--accent-muted)] focus:outline-none',
  {
    variants: {
      // Not `size`: that is an <input> attribute (a number) already.
      variant: {
        default: '',
        num: 'w-[84px] text-right'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export type InputProps = InputHTMLAttributes<HTMLInputElement> & VariantProps<typeof inputVariants>

export function Input({ variant, className, ...rest }: InputProps): JSX.Element {
  return <input className={cn(inputVariants({ variant }), className)} {...rest} />
}
