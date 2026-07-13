import { useEffect, useState } from 'react'
import type { IDockviewPanelHeaderProps } from 'dockview-react'

// Custom dockview tab: double-click the title to rename the panel. The name is
// persisted with the layout (dockview serializes the title).
export default function RivenTab(props: IDockviewPanelHeaderProps): JSX.Element {
  const { api } = props
  const [title, setTitle] = useState(api.title ?? '')
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    const d = api.onDidTitleChange(() => setTitle(api.title ?? ''))
    return () => d.dispose()
  }, [api])

  const commit = (v: string): void => {
    const t = v.trim()
    if (t) api.setTitle(t)
    setEditing(false)
  }

  return (
    <div className="riven-tab" onDoubleClick={() => setEditing(true)} title="더블클릭하여 이름 변경">
      {editing ? (
        <input
          className="riven-tab-input"
          autoFocus
          defaultValue={title}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value)
            else if (e.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <span className="riven-tab-title">{title}</span>
      )}
      <span
        className="riven-tab-close"
        title="닫기"
        onClick={(e) => {
          e.stopPropagation()
          api.close()
        }}
      >
        ✕
      </span>
    </div>
  )
}
