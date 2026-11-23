import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { ArrowUp, FileText, Square, X as XIcon } from 'lucide-react'
import { viewImage } from '../../../components/ImageLightbox'
import { useT } from '../../../i18n'
import { compose, IMAGE_TYPES, isImagePath, outgoing, type Attachment } from '../../../lib/cliChat'

// The CLI chat's input: text, plus images and files pasted or dropped in.
// Images go to the CLI as pasted file paths (it attaches them as images),
// other files as @-mentions; something without a file on disk (a pasted
// screenshot) is saved by Rust under the pane's temp folder first.

const PREVIEW_MAX = 8 * 1024 * 1024

function readDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
}

export interface ComposerHandle {
  focus: () => void
  /** Add text to the end of the input without sending (browser "send to chat"). */
  append: (text: string) => void
}

const Composer = forwardRef<
  ComposerHandle,
  {
    chatKey: string
    busy: boolean
    dead: boolean
    parked: boolean
    onSent: () => void
  }
>(function Composer({ chatKey, busy, dead, parked, onSent }, ref): JSX.Element {
  const t = useT()
  const [input, setInput] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const attsRef = useRef<Attachment[]>([])
  const composing = useRef(false)
  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      append: (text: string) => {
        const el = inputRef.current
        const cur = el?.value ?? ''
        const next = (cur ? cur.replace(/\s*$/, '') + '\n' : '') + text + ' '
        setInput(next)
        if (el) {
          el.value = next
          el.focus()
        }
      }
    }),
    []
  )

  const put = (next: Attachment[]): void => {
    attsRef.current = next
    setAtts(next)
  }
  const add = (a: Attachment): void => put([...attsRef.current, a])

  // A file with a real path is used where it is; anything else is saved.
  const addFile = async (file: File, path: string | null): Promise<void> => {
    const image = IMAGE_TYPES.includes(file.type) || (!!path && isImagePath(path))
    const preview = image && file.size <= PREVIEW_MAX ? ((await readDataUrl(file)) ?? undefined) : undefined
    let p = path
    if (!p) {
      const data = preview ?? (await readDataUrl(file))
      if (!data) return
      try {
        p = await window.api.cliChat.attach(chatKey, file.name || (image ? 'image.png' : 'file'), data)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        return
      }
    }
    add({ id: crypto.randomUUID(), name: file.name || p.split('/').pop() || 'file', path: p, image, preview })
  }

  const submit = (): void => {
    const text = inputRef.current?.value ?? input
    const list = attsRef.current
    if (dead) return
    if (!outgoing(text) && list.length === 0) return
    const msg = compose(outgoing(text) ?? '', list)
    window.api.cliChat.send(chatKey, msg.text, msg.images)
    setInput('')
    put([])
    setError(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    onSent()
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === 'file')
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f)
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files) void addFile(f, null)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    const dropped = Array.from(e.dataTransfer.files)
    for (const f of dropped) void addFile(f, window.api.pathForFile(f) || null)
    if (dropped.length === 0) {
      // Paths dragged from riven's own explorer arrive as text.
      const txt = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list')
      for (const line of txt.split('\n')) {
        const p = line.trim().replace(/^file:\/\//, '')
        if (!p.startsWith('/')) continue
        const path = decodeURI(p)
        add({ id: crypto.randomUUID(), name: path.split('/').pop() || path, path, image: isImagePath(path) })
      }
    }
  }

  return (
    <div
      className={`chat-composer${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {atts.length > 0 && (
        <div className="chat-attachments">
          {atts.map((a) => (
            <div key={a.id} className={`chat-attachment${a.image ? '' : ' cli-chat-file-att'}`} title={a.path}>
              {a.image && a.preview ? (
                <img src={a.preview} alt={a.name} onClick={() => viewImage({ src: a.preview!, name: a.name })} />
              ) : (
                <span className="cli-chat-file">
                  <FileText size={11} />
                  {a.name}
                </span>
              )}
              <button
                className="chat-attachment-x"
                aria-label={t('chat.removeAttachment')}
                title={t('chat.removeAttachment')}
                onClick={() => put(attsRef.current.filter((x) => x.id !== a.id))}
              >
                <XIcon size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <div className="cli-chat-note error">{error}</div>}
      <textarea
        ref={inputRef}
        className="chat-input"
        value={input}
        rows={1}
        disabled={dead}
        placeholder={parked ? t('clichat.parkedPlaceholder') : t('clichat.placeholder')}
        onChange={(e) => {
          setInput(e.target.value)
          const el = e.target
          el.style.height = 'auto'
          el.style.height = `${Math.min(el.scrollHeight, 168)}px`
        }}
        onPaste={onPaste}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          // Enter sends; never mid-IME (Korean) and never with Shift.
          if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="chat-actions">
        <div className="chat-actions-spacer" />
        {busy ? (
          <button className="chat-send stop" onClick={() => window.api.cliChat.interrupt(chatKey)} title={t('clichat.interrupt')}>
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="chat-send" onClick={submit} title={t('clichat.send')} disabled={dead}>
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
})

export default Composer
