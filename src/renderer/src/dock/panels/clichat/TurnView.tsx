import { memo, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FileText, Forward, Wrench } from 'lucide-react'
import Markdown from '../../../components/Markdown'
import { viewImage } from '../../../components/ImageLightbox'
import { useT } from '../../../i18n'
import { wakeTitles } from '../../../lib/wake'
import { wakeNotices } from '../../../state/cliChats'
import { ChatCode, CopyBtn } from '../chatkit/Code'
import {
  recordOf,
  tokens,
  toolCode,
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

// A message nobody typed: the answer of work this pane handed off in the
// background, brought back (returnToCaller). Drawn as what happened, the way
// the chat pane opens that turn, not as a bubble of the person's.
function WakeNotices({ notices }: { notices: string[] }): JSX.Element {
  const t = useT()
  return (
    <div className="chat-turn assistant">
      {notices.map((what, i) => (
        <div key={i} className="chat-notice info">
          <Forward size={12} />
          <span className="chat-notice-text">{t('chat.delegationDone', { what })}</span>
        </div>
      ))}
    </div>
  )
}

function UserBubble({ chatKey, user }: { chatKey: string; user: NonNullable<Turn['user']> }): JSX.Element {
  const woke = user.command ? null : (wakeNotices(user.text) ?? wakeTitles(user.text))
  if (woke) return <WakeNotices notices={woke} />
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
  const code = toolCode(tool.name, tool.input)
  const isAgent = tool.name === 'Agent' || tool.name === 'Task'
  const t = useT()
  const lines = tool.result ? (tool.result.text ? tool.result.text.split('\n').length : 0) : 0
  return (
    // data-agent-id: the running-agents strip scrolls to it.
    <details className={`cli-chat-tool ${state}`} data-agent-id={isAgent ? tool.toolId : undefined}>
      <summary>
        <ChevronRight size={12} className="cli-chat-chev" />
        <span className={`cli-chat-tool-dot ${state}`} aria-hidden />
        <span className="cli-chat-tool-name">{tool.name}</span>
        {summary && <span className="cli-chat-tool-arg">{summary}</span>}
        {lines > 0 && <span className="cli-chat-tool-lines">{t('clichat.toolLines', { n: lines })}</span>}
      </summary>
      {agent && <AgentLine a={agent} />}
      {code && <ChatCode code={code.code} diff={code.diff} path={code.path} />}
      {tool.result && <pre className="cli-chat-tool-result">{tool.result.text || ' '}</pre>}
    </details>
  )
})

type ToolBlock = Extract<Block, { kind: 'tool' }>
const isSubagentTool = (name: string): boolean => name === 'Agent' || name === 'Task'
// The verb a running call reads as (native ToolGroup's header), by tool.
const TOOL_VERB: Record<string, string> = {
  Read: 'chat.tools.read',
  LS: 'chat.tools.read',
  Edit: 'chat.tools.edit',
  Write: 'chat.tools.edit',
  MultiEdit: 'chat.tools.edit',
  NotebookEdit: 'chat.tools.edit',
  Bash: 'chat.tools.run',
  BashOutput: 'chat.tools.run',
  Grep: 'chat.tools.search',
  Glob: 'chat.tools.search',
  WebFetch: 'chat.tools.web',
  WebSearch: 'chat.tools.web',
  TodoWrite: 'chat.tools.todo'
}

/**
 * Consecutive tool calls of a turn, folded into one accordion like the native
 * chat's ToolGroup: while one runs the header says what it is doing; once they
 * are done, "N commands · N changed · +A -B"; a finished group still at the end
 * of a live turn keeps saying what ran last. Opened, it lists the calls.
 */
const ToolGroupView = memo(function ToolGroupView({
  blocks,
  agents,
  trailing
}: {
  blocks: ToolBlock[]
  agents: Record<string, AgentProgress>
  trailing: boolean
}): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const runningOf = (b: ToolBlock): boolean => !b.tool.result || (agents[b.tool.toolId] != null && !agents[b.tool.toolId].done)
  const running = blocks.some(runningOf)
  const latest = blocks[blocks.length - 1].tool
  const head = `${t(TOOL_VERB[latest.name] ?? 'chat.tools.run')}${toolSummary(latest.name, latest.input) ? ` · ${toolSummary(latest.name, latest.input)}` : ''}`
  let changed = 0
  let added = 0
  let removed = 0
  for (const b of blocks) {
    const code = toolCode(b.tool.name, b.tool.input)
    if (b.tool.name === 'Write' || b.tool.name === 'NotebookEdit' || code?.diff) changed++
    if (code?.diff)
      for (const l of code.code.split('\n')) {
        if (l[0] === '+') added++
        else if (l[0] === '-') removed++
      }
  }
  return (
    <div className={`chat-toolgroup ${running ? 'running' : 'done'}`}>
      <button type="button" className="chat-toolgroup-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="chat-tool-ico">
          <Wrench size={12} />
        </span>
        {running ? (
          <span className="chat-shimmer-text">{head}</span>
        ) : trailing ? (
          <span className="tg-title tg-last">{head}</span>
        ) : (
          <span className="tg-title">
            {t('chat.toolCount', { n: blocks.length })}
            {changed > 0 ? ' · ' + t('chat.tools.changed', { n: changed }) : ''}
            {(added > 0 || removed > 0) && (
              <span className="tg-counts">
                {'  '}
                {added > 0 && <span className="add">+{added}</span>}
                {removed > 0 && <span className="del">{added > 0 ? ' ' : ''}-{removed}</span>}
              </span>
            )}
          </span>
        )}
        <ChevronDown size={13} className={`tg-chevron${open ? ' open' : ''}`} aria-hidden />
      </button>
      {open && (
        <div className="chat-toolgroup-body">
          {blocks.map((b) => (
            <ToolRowView key={b.tool.key} block={b} agent={agents[b.tool.toolId]} />
          ))}
        </div>
      )}
    </div>
  )
})

export const TurnView = memo(function TurnView({
  chatKey,
  turn,
  agents,
  hidden,
  tail
}: {
  chatKey: string
  turn: Turn
  agents: Record<string, AgentProgress>
  /** Text blocks drawn by the live preview instead (lib/cliChat previewHides). */
  hidden?: ReadonlySet<string>
  /** The live preview of the reply in flight: drawn where its transcript text goes. */
  tail?: ReactNode
}): JSX.Element {
  const t = useT()
  // The turn's answer, for the copy button.
  const reply = turn.blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
  // Consecutive tool calls (not subagents, which keep their own row) fold into one group.
  type Part = { kind: 'block'; block: Block } | { kind: 'tools'; key: string; blocks: ToolBlock[] }
  const parts: Part[] = []
  for (const b of turn.blocks) {
    if (b.kind === 'tool' && !isSubagentTool(b.tool.name)) {
      const last = parts[parts.length - 1]
      if (last?.kind === 'tools') last.blocks.push(b)
      else parts.push({ kind: 'tools', key: b.tool.key, blocks: [b] })
    } else parts.push({ kind: 'block', block: b })
  }
  return (
    <>
      {turn.user && <UserBubble chatKey={chatKey} user={turn.user} />}
      {(turn.blocks.length > 0 || turn.usage || tail) && (
        <div className="chat-turn assistant cli-chat-assistant">
          {parts.map((p, i) => {
            if (p.kind === 'tools')
              return <ToolGroupView key={p.key} blocks={p.blocks} agents={agents} trailing={!!tail && i === parts.length - 1} />
            const b = p.block
            switch (b.kind) {
              case 'text':
                if (hidden?.has(b.key)) return null
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
                    <div className="cli-chat-thinking-body">{b.text}</div>
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
          {tail}
          {turn.usage && (
            <div className="cli-chat-usage">
              {t('clichat.usage', {
                n: turn.usage.requests,
                read: tokens(turn.usage.cacheRead),
                write: tokens(turn.usage.cacheWrite),
                out: tokens(turn.usage.output)
              })}
              {turn.durationMs != null && ` · ${(turn.durationMs / 1000).toFixed(1)}s`}
              {reply && <CopyBtn code={reply} title={t('chat.copyMessage')} />}
            </div>
          )}
        </div>
      )}
    </>
  )
})
