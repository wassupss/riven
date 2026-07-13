import { useEffect, useState } from 'react'
import type { DockviewPanelApi } from 'dockview-core'
import { addTerminal } from '../registry'

interface Cli {
  name: string
  cmd: string
  group: string
  path: string
}

export default function CliPanel({ api }: { api?: DockviewPanelApi }): JSX.Element {
  const [clis, setClis] = useState<Cli[] | null>(null)

  useEffect(() => {
    window.api.cli.list().then(setClis)
  }, [])

  const launch = (cmd: string): void => {
    addTerminal(cmd)
    api?.close() // close the CLI panel after launching
  }

  const groups = new Map<string, Cli[]>()
  for (const c of clis ?? []) {
    if (!groups.has(c.group)) groups.set(c.group, [])
    groups.get(c.group)!.push(c)
  }

  return (
    <div className="cli-panel">
      <div className="panel-header">
        <span>설치된 CLI</span>
        <button className="btn-small" title="새로고침" onClick={() => window.api.cli.list().then(setClis)}>
          ↻
        </button>
      </div>
      <div className="cli-scroll">
        {clis == null ? (
          <div className="empty-hint">검색 중…</div>
        ) : clis.length === 0 ? (
          <div className="empty-hint">감지된 CLI가 없어.</div>
        ) : (
          [...groups.entries()].map(([group, items]) => (
            <div key={group}>
              <div className="section-label">{group}</div>
              {items.map((c) => (
                <div key={c.cmd} className="cli-row" title={c.path} onClick={() => launch(c.cmd)}>
                  <span className="cli-name">{c.name}</span>
                  <span className="cli-cmd">{c.cmd}</span>
                  <button
                    className="btn-small cli-run"
                    onClick={(e) => {
                      e.stopPropagation()
                      launch(c.cmd)
                    }}
                  >
                    실행 ▸
                  </button>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
