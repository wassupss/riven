import type { ReactNode } from 'react'

// Lightweight, language-agnostic syntax highlighting (native ChatText.highlight):
// comments dim, strings green, numbers amber, keywords accent — a single regex
// pass, not a full grammar. Shared by the chat code blocks and the search results.

const HL_KW =
  'func|let|var|const|if|else|elif|for|while|do|return|import|from|as|class|struct|enum|protocol|extension|interface|type|def|function|lambda|public|private|internal|fileprivate|static|final|override|guard|switch|case|default|break|continue|new|delete|async|await|try|catch|finally|throw|throws|typealias|package|self|this|super|true|false|nil|null|none|undefined|True|False|None|and|or|not|in|is|export|module|namespace|use|fn|impl|mut|pub|match|where|with|yield|assert|print|echo'

const HL_RE = new RegExp(
  '(\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)' + // comments
    '|("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`[^`]*`)' + // strings
    '|(\\b\\d[\\d_.eExXa-fA-F]*\\b)' + // numbers
    '|(\\b(?:' + HL_KW + ')\\b)', // keywords
  'g'
)

export function highlightCode(code: string, keyOffset = 0): ReactNode[] {
  if (!code) return []
  if (code.length > 4000) return [code] // perf guard on huge lines/blocks
  const out: ReactNode[] = []
  let last = 0
  let k = keyOffset
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
