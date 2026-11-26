import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useHost } from '../lib/hostWindow'
import { useT } from '../i18n'
import { Button } from '@/components/ui/button'

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
  const host = useHost() // a popped-out panel's window, not always main's
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
            <Button size="sm" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" variant="primary" onClick={submit}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    host.doc.body
  )
}
