import { History, MessageSquare, RotateCcw, SquareTerminal } from 'lucide-react'
import ModelOptions from '../../../components/ModelOptions'
import { useT } from '../../../i18n'
import { prettyModelId } from '../../../lib/models'
import { MODES, modeValue, type CliState } from '../../../lib/cliChat'

// The CLI chat's bar: state, the conversation, model and permission mode,
// the session list and the terminal view. Background work is the strip
// above the composer.
//
// Model and mode are flags of the CLI process: a change restarts it with
// --resume at the end of the turn (services/clichat/life.rs). /model is never
// typed, because the CLI saves that as the person's global default.

export const MODE_KEY: Record<string, string> = {
  default: 'chat.mode.ask',
  acceptEdits: 'chat.mode.acceptEdits',
  plan: 'chat.mode.plan',
  auto: 'clichat.mode.auto',
  bypassPermissions: 'clichat.mode.codexFull'
}

/**
 * Codex's modes, as the sandbox + approval policy services/clichat/codex.rs
 * maps them to: workspace-write asking on request, read-only, full access.
 */
export const CODEX_MODES = ['acceptEdits', 'plan', 'bypassPermissions'] as const

export default function Header({
  cli = 'claude',
  state,
  title,
  usedModel,
  model,
  mode,
  configDir,
  sessionsOpen,
  onSessions,
  onModel,
  onMode,
  onTerminal,
  onRestart
}: {
  cli?: 'claude' | 'codex'
  state: CliState
  title: string | null
  /** The model the last reply came from, per the transcript. */
  usedModel: string | null
  /** What the pane asked for ('default' = the account's). */
  model: string
  mode: string
  configDir?: string
  sessionsOpen: boolean
  onSessions: () => void
  onModel: (m: string) => void
  onMode: (m: string) => void
  onTerminal: () => void
  onRestart: () => void
}): JSX.Element {
  const t = useT()
  const status = state.dead
    ? t('clichat.exited')
    : state.parked
      ? t('clichat.parked')
      : state.blocked
        ? ''
        : !state.ready
          ? t('clichat.starting')
          : state.waiting
            ? t('clichat.waiting')
            : state.busy
              ? t('clichat.working')
              : ''
  const codex = cli === 'codex'
  const shownMode = codex ? mode : modeValue(state.mode ?? mode)
  const base: readonly string[] = codex ? CODEX_MODES : MODES
  const modes: string[] = base.includes(shownMode) ? [...base] : [...base, shownMode]
  return (
    <div className="cli-chat-bar">
      <span
        className={`cli-chat-dot${state.busy ? ' busy' : state.waiting ? ' waiting' : state.dead ? ' dead' : state.parked ? ' parked' : ''}`}
      />
      <span className="cli-chat-status">{status}</span>
      {title ? (
        <span className="cli-chat-title" title={state.sessionId ?? ''}>
          {title}
        </span>
      ) : (
        state.sessionId && <span className="cli-chat-session">{state.sessionId.slice(0, 8)}</span>
      )}
      {state.restartPending && <span className="cli-chat-bg">{t('clichat.restartPending')}</span>}
      <span className="cli-chat-spacer" />
      <select
        className="chat-chip"
        value={shownMode}
        disabled={state.dead}
        title={t('clichat.modeTitle')}
        onChange={(e) => onMode(e.target.value)}
      >
        {modes.map((m) => (
          <option key={m} value={m}>
            {MODE_KEY[m] ? t(MODE_KEY[m]) : m}
          </option>
        ))}
      </select>
      <select
        className="chat-chip"
        value={model}
        disabled={state.dead}
        title={usedModel ? t('clichat.modelUsed', { model: prettyModelId(usedModel) }) : t('chat.modelTitle')}
        onChange={(e) => onModel(e.target.value)}
      >
        <ModelOptions cli={cli} configDir={configDir} current={model} />
      </select>
      {/* Claude Code's projects, or Codex's rollouts for this folder. */}
      <button className={`cli-chat-btn${sessionsOpen ? ' primary' : ''}`} onClick={onSessions} title={t('chat.resumeTitle')}>
        <History size={13} />
      </button>
      {state.dead ? (
        <button className="cli-chat-btn" onClick={onRestart}>
          <RotateCcw size={13} /> {t('clichat.restart')}
        </button>
      ) : (
        <button className="cli-chat-btn" onClick={onTerminal} disabled={state.parked}>
          {state.terminal ? <MessageSquare size={13} /> : <SquareTerminal size={13} />}{' '}
          {state.terminal ? t('clichat.showChat') : t('clichat.showTerminal')}
        </button>
      )}
    </div>
  )
}
