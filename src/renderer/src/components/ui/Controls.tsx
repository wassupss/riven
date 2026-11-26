import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react'
import { Button as UiButton } from './button'
import { Input } from './input'
import { Textarea } from './textarea'
import { Switch as UiSwitch } from './switch'
import { Segmented as UiSegmented } from './segmented'
import { Select as UiSelect } from './select'

// Shared form controls with ONE consistent look + height (var(--ctl-h)). Use
// these everywhere instead of hand-rolled input/button/select markup so every
// row lines up. Height, radius, border, focus ring come from the shadcn-style
// components in this folder (and their tokens in styles.css).

export function Button({
  variant = 'default',
  size = 'default',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost'
  /** sm is the old btn-small chip. */
  size?: 'default' | 'sm'
}): JSX.Element {
  return (
    <UiButton variant={variant} size={size} className={className} {...rest}>
      {children}
    </UiButton>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <Input {...props} />
}

export function NumberInput(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <Input type="number" variant="num" {...props} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <Textarea {...props} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <UiSelect {...props} />
}

// A pill toggle switch. Use this for every on/off setting (no bare checkboxes).
export function Switch(props: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  /** Its accessible name, where no visible label sits beside it. */
  label?: string
  title?: string
}): JSX.Element {
  return <UiSwitch {...props} />
}

// Segmented control: a row of mutually-exclusive options.
export function Segmented<T extends string>(props: {
  value: T
  options: Array<{ value: T; label: ReactNode }>
  onChange: (v: T) => void
}): JSX.Element {
  return <UiSegmented {...props} />
}
