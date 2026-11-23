import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '../../../i18n'
import { useSession } from '../../../state/session'
import { ensureEditor } from '../../registry'

// A tool call's code in a chat: a one-line command, a highlighted block, or
// an edit as +/- bands with "변경 보기". Shared by the chat panes.

export const isEditName = (n: string): boolean => n === 'Edit' || n === 'MultiEdit'

// Lightweight, language-agnostic syntax highlighting (native ChatText.highlight):
// comments dim, strings green, numbers amber, keywords accent, a single regex
// pass, not a full grammar. Big blocks skip it (perf, like native's 2500 cap).
const HL_KW =
  'func|let|var|const|if|else|elif|for|while|do|return|import|from|as|class|struct|enum|protocol|extension|interface|type|def|function|lambda|public|private|internal|fileprivate|static|final|override|guard|switch|case|default|break|continue|new|delete|async|await|try|catch|finally|throw|throws|typealias|package|self|this|super|true|false|nil|null|none|undefined|True|False|None|and|or|not|in|is|export|module|namespace|use|fn|impl|mut|pub|match|where|with|yield|assert|print|echo'
const HL_RE = new RegExp(
  '(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)' + // comments
    '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`[^`]*`)' + // strings
    '|(\\b\\d[\\d_.eExXa-fA-F]*\\b)' + // numbers
    '|(\\b(?:' + HL_KW + ')\\b)', // keywords
  'g'
)
export function hl(code: string): ReactNode[] {
  if (code.length > 2500) return [code]
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  let m: RegExpExecArray | null
  HL_RE.lastIndex = 0
  while ((m = HL_RE.exec(code)) !== null) {
    if (m[0].length === 0) {
      HL_RE.lastIndex++
      continue
    }
    if (m.index > last) out.push(code.slice(last, m.index))
    const cls = m[1] ? 'tok-c' : m[2] ? 'tok-s' : m[3] ? 'tok-n' : 'tok-k'
    out.push(
      <span key={k++} className={cls}>
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

// Copy-to-clipboard icon button (native copyButton): flips to a check for 1.2s.
export function CopyBtn({ code, title }: { code: string; title?: string }): JSX.Element {
  const t = useT()
  const [done, setDone] = useState(false)
  return (
    <button
      className={`chat-code-btn${done ? ' ok' : ''}`}
      title={title ?? t('chat.copy')}
      onClick={() => {
        void navigator.clipboard.writeText(code)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

// Expandable code / diff body for a tool line, matching native ChatText.codeBlock:
// - short single-line non-diff commands render as a compact one-line lozenge;
// - everything else is a card: header (lang label + copy / "변경 보기") over a
//   syntax-highlighted body (or +/- diff bands for Edit).
export function ChatCode({
  code,
  diff,
  path
}: {
  code: string
  diff: boolean
  path?: string | null
}): JSX.Element {
  const t = useT()
  const openFile = useSession((s) => s.openFile)
  const oneLiner = !code.includes('\n') && code.length <= 110 && !diff
  if (oneLiner) {
    return (
      <div className="chat-code-compact">
        <code className="chat-code-compact-text">{hl(code)}</code>
        <CopyBtn code={code} />
      </div>
    )
  }
  const isEdit = diff && !!path
  return (
    <div className="chat-code-card">
      <div className="chat-code-head">
        <span className="chat-code-lang">{diff ? 'diff' : ''}</span>
        {isEdit ? (
          <button
            className="chat-code-viewdiff"
            onClick={() => {
              openFile(path as string)
              ensureEditor()
            }}
          >
            {t('chat.viewDiff')}
          </button>
        ) : (
          <CopyBtn code={code} />
        )}
      </div>
      {diff ? (
        <div className="chat-code-body diff">
          {code.split('\n').map((line, i) => {
            const add = line[0] === '+'
            const del = line[0] === '-'
            const content = add || del ? line.slice(1) : line
            const cls = add ? ' add' : del ? ' del' : ''
            const sign = add ? '+ ' : del ? '- ' : '  '
            return (
              <div key={i} className={`chat-code-line${cls}`}>
                <span className="sign">{sign}</span>
                {content ? hl(content) : ' '}
              </div>
            )
          })}
        </div>
      ) : (
        <pre className="chat-code-body">
          <code>{hl(code)}</code>
        </pre>
      )}
    </div>
  )
}

