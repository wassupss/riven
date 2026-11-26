import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

// shadcn/ui-style button. The values are riven's own (the control height, text
// size, radius, border and hover tokens), so it looks exactly like the old
// .ui-btn it replaces; see styles.css for the rules this stands in for.
export const buttonVariants = cva(
  'inline-flex h-[var(--ctl-h)] box-border cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--edge)] bg-[var(--bg-2)] px-2.5 font-[inherit] text-[length:var(--text-sm)] text-[var(--fg)] transition-[background,border-color,box-shadow] duration-[var(--dur-fast)] ease-[ease] active:translate-y-[0.5px] disabled:translate-y-0 disabled:cursor-default disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'hover:border-[var(--edge-strong)] hover:bg-[var(--hover-strong)]',
        primary: 'border-[var(--accent)] bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)]',
        ghost: 'border-transparent bg-transparent hover:bg-[var(--hover)]'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export function Button({ variant, className, ...rest }: ButtonProps): JSX.Element {
  return <button className={cn(buttonVariants({ variant }), className)} {...rest} />
}
