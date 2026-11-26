import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Check, Loader2, RotateCw, Server } from 'lucide-react'
import { useT } from '../../../i18n'
import { useUI } from '../../../state/ui'
import { addTerminal } from '../../registry'
import { promptInput } from '../../../components/promptInput'
import { scrollWithin } from '../../../lib/scrollWithin'
import { Button } from '@/components/ui/button'

// Inline cards a chat answers a riven command with (/mcp, /model), drawn in
// the transcript and keyboard-navigable. Shared by the chat panes.

interface McpRow {
  name: string
  url: string
  status: 'connected' | 'needs-auth' | 'pending' | 'other'
}
// `custom` = a server the user configured themselves (user/project/local scope,
// i.e. what `claude mcp add` writes). Everything else, claude.ai connectors and
// plugin-provided servers, riven did not get told about and cannot rewrite, so
// the card keeps the two apart instead of implying they are the same thing.
interface McpSrv extends McpRow {
  origin: 'custom' | 'managed'
}

// Keyboard nav for inline command cards: ↑/↓ move, Enter confirms, Esc dismisses.
// The card container autofocuses so keys work right after "/command", no click.
export function useCardNav(
  count: number,
  onEnter: (i: number) => void,
  onDismiss: () => void
): {
  index: number
  setIndex: (i: number) => void
  ref: React.RefObject<HTMLDivElement>
  onKeyDown: (e: React.KeyboardEvent) => void
} {
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])
  const clamped = count > 0 ? Math.min(index, count - 1) : 0
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onDismiss()
      return
    }
    if (count === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((clamped + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((clamped - 1 + count) % count)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onEnter(clamped)
    }
  }
  return { index: clamped, setIndex, ref, onKeyDown }
}

export function CardSkeleton(): JSX.Element {
  return (
    <div className="card-skeleton">
      <span />
      <span />
      <span />
    </div>
  )
}

// Quote a value for the shell so server names with spaces ("claude.ai Notion")
// and URLs with query strings survive the terminal command we build below.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function mcpStatus(raw: string): McpSrv['status'] {
  if (/^connected$/i.test(raw)) return 'connected'
  if (/needs?[-_ ]?auth/i.test(raw)) return 'needs-auth'
  if (/pending/i.test(raw)) return 'pending'
  return 'other'
}

// `claude mcp list` and a real session DISAGREE, and the session is the one that
// matters: list reports a claude.ai connector as connected from stored
// credentials that the session then rejects as needs-auth, and it omits some
// connectors and every plugin-provided server. So take the set and the status
// from the session, and use list only for the URL it alone knows.
function mergeMcp(rows: McpRow[], session: Array<{ name: string; status: string }>): McpSrv[] {
  const urls = new Map(rows.map((r) => [r.name, r.url]))
  // `mcp list` reports the user's own servers AND the claude.ai connectors; only
  // the former are theirs to edit, and only they can be named apart this way.
  const configured = new Set(rows.filter((r) => !/^claude\.ai /i.test(r.name)).map((r) => r.name))
  const origin = (name: string): McpSrv['origin'] => (configured.has(name) ? 'custom' : 'managed')
  const merged: McpSrv[] = session.map((s) => ({
    name: s.name,
    url: urls.get(s.name) ?? '',
    status: mcpStatus(s.status),
    origin: origin(s.name)
  }))
  const seen = new Set(merged.map((s) => s.name))
  // Locally configured servers a probe session did not report still belong here.
  for (const r of rows) if (!seen.has(r.name)) merged.push({ ...r, origin: origin(r.name) })
  // The user's own servers first, that is the half they can act on.
  return [
    ...merged.filter((s) => s.origin === 'custom'),
    ...merged.filter((s) => s.origin === 'managed')
  ]
}

// Inline /mcp card: real server status from `claude mcp list`, rendered in the
// transcript (not a modal) and keyboard-navigable.
//
// Auth and add run in a REAL terminal, never a hidden spawn. `claude mcp login`
// is interactive by construction (it can ask you to press a key or to paste a
// code back), and `claude mcp add` reports whether it took on stdout, with
// stdin ignored and nothing on screen both silently do nothing, which is what
// made the buttons look dead. So we do what the account sign-in does: open a
// terminal running the command, then poll `mcp list` until the result lands and
// bring it back here.
export function McpCard({
  cwd,
  configDir,
  onDismiss
}: {
  cwd: string
  configDir?: string
  onDismiss: () => void
}): JSX.Element {
  const t = useT()
  const [servers, setServers] = useState<McpSrv[] | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Anything async here reports back INTO this card, so it has to die with it -
  // otherwise dismissing the card mid-login leaves a `claude mcp list` firing
  // every 2s for the rest of the window.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const session = useRef<Array<{ name: string; status: string }>>([])
  // TWO steps on purpose. The session probe is a real CLI session, ~7s once
  // plugins are in play, and holding the card on a skeleton for that long
  // reads as a hang. So paint `mcp list` the moment it lands, then upgrade to
  // the session's own answer when it arrives. Both are caught: a rejected IPC
  // must not leave the card stuck loading forever.
  const load = useCallback(
    async (fresh = false): Promise<void> => {
      setServers(null)
      const rows = await window.api.chat.mcpList(cwd, configDir).catch(() => [])
      if (!alive.current) return
      setServers(mergeMcp(rows, session.current))
      const info = await window.api.chat.mcpSession(cwd, configDir, fresh).catch(() => [])
      if (!alive.current) return
      session.current = info
      setServers(mergeMcp(rows, info))
    },
    [cwd, configDir]
  )
  useEffect(() => void load(), [load])
  // Poll `mcp list` until the terminal's command has actually landed, then bring
  // the answer back here. ~3 minutes, a slow but realistic browser flow; each
  // check is one short `claude mcp list` and the loop stops the moment `done`
  // says the state changed, so the card reports the result instead of leaving
  // the user to guess whether the redirect worked.
  const watch = async (name: string, done: (s?: McpRow) => boolean): Promise<void> => {
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000))
      if (!alive.current) return
      const rows = await window.api.chat.mcpList(cwd, configDir).catch(() => [])
      if (!alive.current) return
      if (done(rows.find((r) => r.name === name))) break
    }
    setBusyName(null)
    await load(true)
  }
  // Run `claude mcp …` in a REAL terminal, then watch for the result. The
  // command is interactive by construction, and the terminal is also where its
  // errors are legible, so nothing is reported here that the panel does not
  // already show better.
  const run = (command: string, label: string, done: (s?: McpRow) => boolean): Promise<void> => {
    setBusyName(label)
    setError(null)
    // The pane's profile has to carry into the terminal, or the login lands in a
    // DIFFERENT config dir than the one this chat runs under.
    addTerminal(configDir ? `CLAUDE_CONFIG_DIR=${shq(configDir)} ${command}` : command)
    return watch(label, done)
  }
  const login = (name: string): Promise<void> =>
    run(`claude mcp login ${shq(name)}`, name, (s) => s?.status === 'connected')
  // Approving a .mcp.json server is a stored decision, not a conversation, so it
  // stays here: riven writes the record the CLI would only take interactively.
  const approve = async (name: string): Promise<void> => {
    setBusyName(name)
    setError(null)
    const r = await window.api.chat
      .mcpApprove(cwd, name, configDir)
      .catch((e: unknown) => ({ ok: false, output: String(e) }))
    if (!alive.current) return
    setBusyName(null)
    if (!r.ok) setError(r.output)
    await load(true)
  }
  const add = async (): Promise<void> => {
    const name = (await promptInput({ title: t('chat.mcpAddName'), placeholder: 'sentry' }))?.trim()
    if (!name) return
    const target = (
      await promptInput({
        title: t('chat.mcpAddTarget'),
        placeholder: 'https://mcp.sentry.dev/mcp'
      })
    )?.trim()
    if (!target) return
    // Server setup pages hand out a ready-made `claude mcp add …` line, and that
    // is what gets pasted here. Treating it as a stdio command wrapped it in a
    // SECOND add, `claude mcp add <name> -- claude mcp add --transport http …` -
    // which registers a "server" whose command is the add line itself: it cannot
    // speak MCP, so its tools silently never load (and the bearer token lands in
    // the config as a plain argv entry). A pasted add line is run as-is instead.
    const pastedAdd = /^claude\s+mcp\s+add(\s|$)/i.test(target)
    // A URL is an HTTP server; anything else is the stdio command to run.
    const command = pastedAdd
      ? target
      : /^https?:\/\//i.test(target)
        ? `claude mcp add --transport http ${shq(name)} ${shq(target)}`
        : `claude mcp add ${shq(name)} -- ${target}`
    // `add` is done the moment the server exists at all, its status afterwards
    // is a separate question the card answers on the next row.
    await run(command, name, (s) => !!s)
  }
  const logout = async (name: string): Promise<void> => {
    setBusyName(name)
    await window.api.chat.mcpLogout(cwd, name, configDir)
    setBusyName(null)
    await load(true)
  }
  const list = servers ?? []
  // Nav rows = servers, then the two footer actions.
  const count = servers ? list.length + 2 : 0
  const enter = (i: number): void => {
    if (i < list.length) {
      const s = list[i]
      if (s.status === 'connected') void logout(s.name)
      else if (s.status === 'pending') void approve(s.name)
      else void login(s.name)
    } else if (i === list.length) useUI.getState().openSettings('ai')
    else void add()
  }
  const { index, setIndex, ref, onKeyDown } = useCardNav(count, enter, onDismiss)
  useEffect(() => {
    if (servers) scrollWithin(ref.current, 'end')
  }, [servers, ref])

  return (
    <div className="chat-card" tabIndex={0} ref={ref} onKeyDown={onKeyDown}>
      <div className="chat-card-head">
        <Server size={14} />
        <span>{t('chat.mcpTitle')}</span>
        <button
          className="chat-card-refresh"
          title={t('common.refresh')}
          onClick={() => void load(true)}
        >
          <RotateCw size={12} />
        </button>
      </div>
      {servers === null ? (
        <CardSkeleton />
      ) : list.length === 0 ? (
        <div className="set-note">{t('chat.mcpEmpty')}</div>
      ) : (
        list.map((s, i) => (
          <div key={s.name}>
            {/* The list is sorted by origin, so a change of origin starts a group. */}
            {(i === 0 || list[i - 1].origin !== s.origin) && (
              <div className="mcp-group">
                {t(s.origin === 'custom' ? 'chat.mcpGroupCustom' : 'chat.mcpGroupManaged')}
              </div>
            )}
            <div
              className={`mcp-item${index === i ? ' active' : ''}`}
              onMouseMove={() => index !== i && setIndex(i)}
            >
              <span className={`mcp-dot ${s.status}`} />
              <span className="mcp-name" title={s.url}>
                {s.name}
              </span>
              {busyName === s.name ? (
                <span className="mcp-status">
                  <Loader2 size={12} className="spin" />
                </span>
              ) : s.status === 'connected' ? (
                <Button size="sm" onClick={() => void logout(s.name)}>
                  {t('chat.mcpLogout')}
                </Button>
              ) : s.status === 'pending' ? (
                <Button size="sm" onClick={() => void approve(s.name)}>
                  {t('chat.mcpApprove')}
                </Button>
              ) : (
                <Button size="sm" onClick={() => void login(s.name)}>
                  {t('chat.mcpLoginBtn')}
                </Button>
              )}
            </div>
          </div>
        ))
      )}
      <div className="mcp-actions">
        <Button
          size="sm"
          className={servers && index === list.length ? 'active' : undefined}
          onMouseMove={() => setIndex(list.length)}
          onClick={() => useUI.getState().openSettings('ai')}
        >
          {t('chat.mcpRivenTools')}
        </Button>
        <Button
          size="sm"
          className={servers && index === list.length + 1 ? 'active' : undefined}
          onMouseMove={() => setIndex(list.length + 1)}
          onClick={() => void add()}
        >
          {t('chat.mcpAdd')}
        </Button>
      </div>
      <div className={error ? 'set-note mcp-error' : 'set-note'}>
        {error || t('chat.mcpAuthNote')}
      </div>
    </div>
  )
}

// Inline /model card: pick the model with the keyboard (↑/↓/Enter), Esc cancels.
export function ModelCard({
  models,
  label,
  current,
  onPick,
  onDismiss
}: {
  models: string[]
  label: (m: string) => string
  current: string
  onPick: (m: string) => void
  onDismiss: () => void
}): JSX.Element {
  const t = useT()
  const start = Math.max(0, models.indexOf(current))
  const { index, setIndex, ref, onKeyDown } = useCardNav(
    models.length,
    (i) => onPick(models[i]),
    onDismiss
  )
  useEffect(() => {
    setIndex(start)
    scrollWithin(ref.current, 'end')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="chat-card" tabIndex={0} ref={ref} onKeyDown={onKeyDown}>
      <div className="chat-card-head">
        <Bot size={14} />
        <span>{t('chat.modelTitle')}</span>
      </div>
      {models.map((m, i) => (
        <button
          key={m}
          className={`picker-item model-row${index === i ? ' active' : ''}`}
          onMouseMove={() => index !== i && setIndex(i)}
          onClick={() => onPick(m)}
        >
          <span className="picker-title">{label(m)}</span>
          {m === current && <Check size={13} className="model-check" />}
        </button>
      ))}
    </div>
  )
}

