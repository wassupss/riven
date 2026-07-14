import { useEffect, useState } from 'react'
import { useUI } from '../state/ui'
import { addTerminal } from '../dock/registry'
import { contextBus } from '../bridge/contextBus'
import { useT } from '../i18n'

interface Cli {
  name: string
  cmd: string
  group: string
  path: string
}

// Shown when the user sends code to "the LLM" but no agent is running. Lists the
// installed LLM CLIs; picking one opens a terminal running it, and the queued
// text is delivered once the agent comes up (contextBus.flushPending).
export default function AgentPicker(): JSX.Element | null {
  const t = useT()
  const workspace = useUI((s) => s.agentPicker)
  const setAgentPicker = useUI((s) => s.setAgentPicker)
  const [clis, setClis] = useState<Cli[] | null>(null)

  useEffect(() => {
    if (!workspace) return
    let alive = true
    window.api.cli.list().then((list: Cli[]) => {
      if (alive) setClis(list.filter((c) => c.group === 'AI'))
    })
    return () => {
      alive = false
    }
  }, [workspace])

  if (!workspace) return null

  const cancel = (): void => {
    contextBus.clearPending(workspace)
    setAgentPicker(null)
  }
  const launch = (c: Cli): void => {
    addTerminal(c.cmd) // opens a terminal running the LLM; pending flushes on agent-up
    setAgentPicker(null)
  }

  return (
    <div className="modal-overlay" onMouseDown={cancel}>
      <div className="agent-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="agent-picker-head">
          <span>{t('agentPicker.title')}</span>
          <span className="agent-picker-sub">{t('agentPicker.sub')}</span>
        </div>
        <div className="agent-picker-list">
          {clis === null && <div className="agent-picker-empty">{t('agentPicker.checking')}</div>}
          {clis?.length === 0 && (
            <div className="agent-picker-empty">{t('agentPicker.empty')}</div>
          )}
          {clis?.map((c) => (
            <div key={c.cmd} className="agent-picker-item" onClick={() => launch(c)}>
              <span className="agent-picker-name">{c.name}</span>
              <span className="agent-picker-cmd">{c.cmd}</span>
            </div>
          ))}
        </div>
        <div className="agent-picker-foot">
          <button className="btn-small" onClick={cancel}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
