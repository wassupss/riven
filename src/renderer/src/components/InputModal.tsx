import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n'

export default function InputModal({
  title,
  initial = '',
  placeholder,
  onSubmit,
  onCancel
}: {
  title: string
  initial?: string
  placeholder?: string
  onSubmit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const t = useT()
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = (): void => {
    const v = value.trim()
    if (v) onSubmit(v)
  }

  return createPortal(
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal input-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
        </div>
        <div className="input-modal-body">
          <input
            ref={inputRef}
            className="url-input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              else if (e.key === 'Escape') onCancel()
            }}
          />
          <div className="input-modal-actions">
            <button className="btn-small" onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button className="btn-small primary" onClick={submit}>
              {t('common.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
