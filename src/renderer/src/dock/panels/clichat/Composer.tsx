import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ArrowUp, FileText, Square, X as XIcon } from 'lucide-react'
import { viewImage } from '../../../components/ImageLightbox'
import { useT } from '../../../i18n'
import { compose, IMAGE_TYPES, isImagePath, outgoing, type Attachment } from '../../../lib/cliChat'
import { dropMentionQuery, insertMention, mentionHandle, mentionMatches, mentionQuery } from '../../../lib/mention'
import { rosterFor } from '../../../state/roster'
import { getSettings } from '../../../state/settings'
import { scrollWithin } from '../../../lib/scrollWithin'
import ScheduleControl from '../chatkit/Schedule'
import { DEFAULT_SLASH, menuCommands, slashDesc, slashMatches } from '../chatkit/slash'

// The CLI chat's input: text, plus images and files pasted or dropped in.
// Images go to the CLI as pasted file paths (it attaches them as images),
// other files as @-mentions; something without a file on disk (a pasted
// screenshot) is saved by Rust under the pane's temp folder first.
//
// Like the chat pane's composer: "/" opens the command menu (riven's own
// commands first), "@" the teammates of this workspace, the clock schedules
// the text for later, Enter sends (queued by the pane while a turn runs),
// Cmd/Ctrl+Enter pushes it into the running turn now.

const PREVIEW_MAX = 8 * 1024 * 1024

function readDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
}

/** What the composer hands the pane on Enter. */
export interface Outgoing {
  /** The text as the CLI gets it (files as @-mentions). */
  text: string
  /** Image paths pasted after the text. */
  images: string[]
  /** What was typed, and the attachments, to put back for an edit. */
  raw: string
  atts: Attachment[]
}

export interface ComposerHandle {
  focus: () => void
  /** Add text to the end of the input without sending (browser "send to chat"). */
  append: (text: string) => void
  /** Put a message back to change it (a queued one being edited). */
  load: (text: string, atts: Attachment[]) => void
  /** Files dropped anywhere on the pane. */
  drop: (e: React.DragEvent) => void
}

const Composer = forwardRef<
  ComposerHandle,
  {
    chatKey: string
    workspace: string
    cli: 'claude' | 'codex'
    cwd: string
    configDir?: string
    busy: boolean
    dead: boolean
    parked: boolean
    getTitle: () => string
    /** Enter (now = false) or Cmd/Ctrl+Enter (now = true). */
    onSubmit: (msg: Outgoing, now: boolean) => void
    onStop: () => void
  }
>(function Composer({ chatKey, workspace, cli, cwd, configDir, busy, dead, parked, getTitle, onSubmit, onStop }, ref): JSX.Element {
  const t = useT()
  const [input, setInput] = useState('')
  const [atts, setAtts] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  // Claude Code's command list for this folder, asked for the first time
  // "/" is typed (it is a CLI probe, cached by Rust; nothing runs before).
  const [sessionCommands, setSessionCommands] = useState<string[]>(DEFAULT_SLASH)
  const asked = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const attsRef = useRef<Attachment[]>([])
  const composing = useRef(false)
  const pendingEnter = useRef<boolean | null>(null)
  const slashRefs = useRef<Array<HTMLButtonElement | null>>([])

  const setText = (next: string): void => {
    setInput(next)
    const el = inputRef.current
    if (el) {
      el.value = next
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 168)}px`
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus({ preventScroll: true }),
      append: (text: string) => {
        const cur = inputRef.current?.value ?? ''
        setText((cur ? cur.replace(/\s*$/, '') + '\n' : '') + text + ' ')
        inputRef.current?.focus()
      },
      load: (text: string, list: Attachment[]) => {
        setText(text)
        put(list)
        inputRef.current?.focus()
      },
      drop: (e: React.DragEvent) => onDrop(e)
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const clear = (): void => {
    setText('')
    put([])
    setSlashIndex(0)
    setMentionIndex(0)
    setError(null)
    if (inputRef.current) inputRef.current.style.height = 'auto'
  }

  // The DOM value, not state: mid-IME the committed syllable is in the
  // textarea before React's onChange has run.
  const submit = (now = false): void => {
    const text = inputRef.current?.value ?? input
    const list = attsRef.current
    if (dead) return
    if (!outgoing(text) && list.length === 0) return
    const msg = compose(outgoing(text) ?? '', list)
    clear()
    onSubmit({ ...msg, raw: text, atts: list }, now)
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

  // "@teammate": every agent pane of this workspace but this one.
  const query = mentionQuery(input)
  const peers = query !== null ? rosterFor(workspace).filter((a) => a.id !== chatKey) : []
  const mentions = mentionMatches(peers, query)
  const mentionOpen = mentions.length > 0
  const mi = Math.min(mentionIndex, Math.max(0, mentions.length - 1))
  const pickMention = (title: string): void => {
    setText(insertMention(input, mentionHandle(title)))
    setMentionIndex(0)
    inputRef.current?.focus({ preventScroll: true })
  }

  // "/command": riven's own first (/resume, /mcp, /model, /config), then the
  // session's. Codex has its own commands, not Claude Code's.
  const slashOn = /^\/[^\s]*$/.test(input)
  useEffect(() => {
    if (!slashOn || asked.current || cli !== 'claude') return
    asked.current = true
    void window.api.chat
      .sessionInfo(cwd, configDir)
      .then((info) => {
        if (info.slashCommands.length) setSessionCommands(info.slashCommands)
      })
      .catch(() => {})
  }, [slashOn, cli, cwd, configDir])
  const native = cli === 'codex' ? ['resume', 'model', 'config'] : ['resume', 'mcp', 'model', 'config']
  const slash = slashOn && !mentionOpen ? slashMatches(input, menuCommands(cli === 'codex' ? [] : sessionCommands, native)) : []
  const slashOpen = slash.length > 0
  const si = Math.min(slashIndex, Math.max(0, slash.length - 1))
  const lang = getSettings().language
  // Pick fills the composer with "/name " (never runs it): Enter confirms.
  const pickSlash = (name: string): void => {
    setText(`/${name} `)
    setSlashIndex(0)
    inputRef.current?.focus({ preventScroll: true })
  }

  const menuKeys = (e: React.KeyboardEvent): boolean => {
    if (mentionOpen) {
      const len = mentions.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((mi + (e.key === 'ArrowDown' ? 1 : len - 1)) % len)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickMention(mentions[mi].title)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setText(dropMentionQuery(input))
        return true
      }
    }
    if (slashOpen) {
      const len = slash.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const ni = (si + (e.key === 'ArrowDown' ? 1 : len - 1)) % len
        setSlashIndex(ni)
        scrollWithin(slashRefs.current[ni])
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickSlash(slash[si])
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setText('')
        return true
      }
    }
    return false
  }

  return (
    <div
      className={`chat-composer${dragOver ? ' drag-over' : ''}${input.trim().startsWith('/') ? ' is-command' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.stopPropagation()
        onDrop(e)
      }}
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
      {mentionOpen && (
        <div className="slash-menu">
          {mentions.map((p, i) => (
            <button
              key={p.id}
              className={`slash-item${i === mi ? ' active' : ''}`}
              onMouseMove={() => mentionIndex !== i && setMentionIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pickMention(p.title)
              }}
            >
              <span className="slash-name">@{mentionHandle(p.title)}</span>
              <span className="slash-desc">
                {[p.kind === 'terminal' ? t('chat.mentionTerminal') : '', p.busy ? t('chat.tools.run') : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          ))}
        </div>
      )}
      {slashOpen && (
        <div className="slash-menu">
          {slash.map((c, i) => (
            <button
              key={c}
              ref={(el) => (slashRefs.current[i] = el)}
              className={`slash-item${i === si ? ' active' : ''}`}
              onMouseMove={() => slashIndex !== i && setSlashIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pickSlash(c)
              }}
            >
              <span className="slash-name">/{c}</span>
              <span className="slash-desc">{slashDesc(c, lang)}</span>
            </button>
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
        onCompositionEnd={() => {
          composing.current = false
          // Enter pressed mid-composition committed the syllable: send once,
          // after the committed char is in the textarea.
          if (pendingEnter.current !== null) {
            const now = pendingEnter.current
            pendingEnter.current = null
            setTimeout(() => submit(now), 0)
          }
        }}
        onKeyDown={(e) => {
          if (menuKeys(e)) return
          if (e.key !== 'Enter' || e.shiftKey) return
          const now = e.metaKey || e.ctrlKey
          if (composing.current || e.nativeEvent.isComposing) {
            pendingEnter.current = now
            return
          }
          e.preventDefault()
          submit(now)
        }}
      />
      <div className="chat-actions">
        <div className="chat-actions-spacer" />
        <ScheduleControl
          workspace={workspace}
          chatKey={chatKey}
          getTitle={getTitle}
          getText={() => inputRef.current?.value ?? input}
          onScheduled={clear}
        />
        {busy ? (
          <button className="chat-send stop" onClick={onStop} title={t('clichat.interrupt')}>
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="chat-send" onClick={() => submit(false)} title={t('clichat.send')} disabled={dead}>
            <ArrowUp size={15} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
})

export default Composer
