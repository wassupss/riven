import type { ReactNode, SelectHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react'

// Shared form controls with ONE consistent look + height (var(--ctl-h)). Use
// these everywhere instead of hand-rolled input/button/select markup so every
// row lines up. Height, radius, border, focus ring all come from styles.css.

export function Button({
  variant = 'default',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost'
}): JSX.Element {
  return (
    <button className={`ui-btn ui-btn-${variant} ${className}`} {...rest}>
      {children}
    </button>
  )
}

export function TextInput({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input className={`ui-input ${className}`} {...rest} />
}

export function NumberInput({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return <input type="number" className={`ui-input ui-input-num ${className}`} {...rest} />
}

export function TextArea({
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={`ui-textarea ${className}`} {...rest} />
}

export function Select({
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return (
    <select className={`ui-select ${className}`} {...rest}>
      {children}
    </select>
  )
}

// A pill toggle switch. Use this for every on/off setting (no bare checkboxes).
export function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`ui-switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-knob" />
    </button>
  )
}

// Segmented control: a row of mutually-exclusive options.
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
    <div className="ui-seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`ui-seg-btn${value === o.value ? ' on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
