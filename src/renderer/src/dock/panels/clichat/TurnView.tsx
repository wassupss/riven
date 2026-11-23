import { memo, useEffect, useState } from 'react'
import { ChevronRight, FileText } from 'lucide-react'
import Markdown from '../../../components/Markdown'
import { viewImage } from '../../../components/ImageLightbox'
import { useT } from '../../../i18n'
import {
  recordOf,
  tokens,
  toolSummary,
  userParts,
  type AgentProgress,
  type Block,
  type Turn
} from '../../../lib/cliChat'

// One turn of a CLI chat: the person's message (text, file chips, image
// thumbnails) and everything the agent did for it.

// Thumbnails are read from the transcript on demand and kept for the page's
// life: the item list never carries image bytes.
const thumbs = new Map<string, Promise<string | null>>()
function thumb(chatKey: string, uuid: string, i: number): Promise<string | null> {
  const k = `${uuid}:${i}`
  let p = thumbs.get(k)
  if (!p) {
    p = window.api.cliChat.image(chatKey, uuid, i).catch(() => null)
    thumbs.set(k, p)
  }
  return p
}

function Thumb({ chatKey, uuid, index }: { chatKey: string; uuid: string; index: number }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void thumb(chatKey, uuid, index).then((s) => live && setSrc(s))
    return () => {
      live = false
    }
  }, [chatKey, uuid, index])
  if (!src) return <span className="cli-chat-thumb empty" />
  return (
    <img
      className="cli-chat-thumb"
      src={src}
      alt=""
      onClick={() => viewImage({ src, name: `image ${index + 1}` })}
    />
  )
}

function UserBubble({ chatKey, user }: { chatKey: string; user: NonNullable<Turn['user']> }): JSX.Element {
  const parts = user.command ? [{ kind: 'text' as const, text: user.text }] : userParts(user.text)
  return (
    <div className="chat-turn user">
      <div className={`chat-user-bubble${user.command ? ' cli-chat-command' : ''}`}>
        {user.images > 0 && (
          <div className="cli-chat-thumbs">
            {Array.from({ length: user.images }, (_, i) => (
              <Thumb key={i} chatKey={chatKey} uuid={recordOf(user.key)} index={i} />
            ))}
          </div>
        )}
        {parts.map((p, i) =>
          p.kind === 'text' ? (
            <span key={i}>{p.text}</span>
          ) : (
            <span key={i} className="cli-chat-file" title={p.path}>
              <FileText size={11} />
              {p.name}
            </span>
          )
        )}
      </div>
    </div>
  )
}

function AgentLine({ a }: { a: AgentProgress }): JSX.Element {
  const t = useT()
  return (
    <div className={`cli-chat-agent${a.done ? ' done' : ''}`}>
      <span className="cli-chat-agent-head">
        {a.done ? t('clichat.agent.done') : t('clichat.agent.running')} · {t('clichat.agent.tools', { n: a.tools })}
      </span>
      {!a.done && a.lastTool && <span className="cli-chat-agent-last">{a.lastTool}</span>}
      {a.lastText && <span className="cli-chat-agent-text">{a.lastText}</span>}
    </div>
  )
}

const ToolRowView = memo(function ToolRowView({
  block,
  agent
}: {
  block: Extract<Block, { kind: 'tool' }>
  agent?: AgentProgress
}): JSX.Element {
  const { tool } = block
  const summary = toolSummary(tool.name, tool.input)
  // A background agent's call returns at once; it is running until its
  // own files say it finished.
  const running = !tool.result || (agent != null && !agent.done)
  const state = running ? 'running' : tool.result?.isError ? 'error' : 'done'
  return (
    <details className={`cli-chat-tool ${state}`}>
      <summary>
        <ChevronRight size={12} className="cli-chat-chev" />
        <span className="cli-chat-tool-name">{tool.name}</span>
        {summary && <span className="cli-chat-tool-arg">{summary}</span>}
      </summary>
      {agent && <AgentLine a={agent} />}
      {tool.result && <pre className="cli-chat-tool-result">{tool.result.text || ' '}</pre>}
    </details>
  )
})

export const TurnView = memo(function TurnView({
  chatKey,
  turn,
  agents
}: {
  chatKey: string
  turn: Turn
  agents: Record<string, AgentProgress>
}): JSX.Element {
  const t = useT()
  return (
    <>
      {turn.user && <UserBubble chatKey={chatKey} user={turn.user} />}
      {(turn.blocks.length > 0 || turn.usage) && (
        <div className="chat-turn assistant cli-chat-assistant">
          {turn.blocks.map((b) => {
            switch (b.kind) {
              case 'text':
                return (
                  <div key={b.key} className="chat-assistant-text">
                    <Markdown text={b.text} />
                  </div>
                )
              case 'thinking':
                return (
                  <details key={b.key} className="cli-chat-thinking">
                    <summary>
                      <ChevronRight size={12} className="cli-chat-chev" />
                      {t('clichat.thinking')}
                    </summary>
                    <div className="cli-chat-thinking-body">{b.text || t('clichat.thinkingHidden')}</div>
                  </details>
                )
              case 'tool': {
                // Agent/Task calls carry their subagent's progress; the agent
                // map changes as it runs, so only those rows see it.
                const agent = agents[b.tool.toolId]
                return <ToolRowView key={b.tool.key} block={b} agent={agent} />
              }
              case 'note':
                return (
                  <div key={b.key} className={`cli-chat-note ${b.level}`}>
                    {b.text}
                  </div>
                )
              case 'compact':
                return (
                  <div key={b.key} className="cli-chat-compact">
                    {t('clichat.compact', { trigger: b.trigger, tokens: tokens(b.preTokens) })}
                  </div>
                )
            }
          })}
          {turn.usage && (
            <div className="cli-chat-usage">
              {t('clichat.usage', {
                n: turn.usage.requests,
                read: tokens(turn.usage.cacheRead),
                write: tokens(turn.usage.cacheWrite),
                out: tokens(turn.usage.output)
              })}
              {turn.durationMs != null && ` · ${(turn.durationMs / 1000).toFixed(1)}s`}
            </div>
          )}
        </div>
      )}
    </>
  )
})
