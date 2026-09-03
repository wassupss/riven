import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Markdown renderer for agent-chat messages: GFM tables/lists/headings + fenced
// code. Memoized on `text` so only the streaming message re-parses each frame,
// not every message in the transcript (that churn spiked memory/CPU).
function MarkdownImpl({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} onClick={(e) => e.preventDefault()} title={href}>
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownImpl)
