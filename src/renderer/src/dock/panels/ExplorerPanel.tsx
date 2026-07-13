import { useEffect, useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import type { DirEntry } from '../../../../preload'
import { useSession } from '../../state/session'
import { useTree } from '../../state/tree'
import { useAgentEdits } from '../../state/agentEdits'
import { useSelection } from '../../state/selection'
import { contextBus } from '../../bridge/contextBus'
import { closeDocument } from '../../lsp/client'
import { ensureEditor } from '../registry'
import ContextMenu, { type MenuItem } from '../../components/ContextMenu'
import InputModal from '../../components/InputModal'

const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'
const join = (dir: string, name: string): string => `${dir}/${name}`

type Menu = { x: number; y: number; entry: DirEntry | null }
type Edit =
  | { kind: 'new-file' | 'new-folder'; dir: string }
  | { kind: 'rename'; target: DirEntry }
  | null

/* ---- icons (colored by file type, VSCode-like) --------------------------- */
const FILE_COLORS: Record<string, string> = {
  ts: '#3178c6',
  tsx: '#3178c6',
  js: '#e8d44d',
  jsx: '#e8d44d',
  mjs: '#e8d44d',
  cjs: '#e8d44d',
  json: '#cbcb41',
  css: '#519aba',
  scss: '#cd6799',
  less: '#cd6799',
  html: '#e34c26',
  vue: '#41b883',
  svelte: '#ff3e00',
  md: '#6a9fb5',
  mdx: '#6a9fb5',
  py: '#4b8bbe',
  rs: '#dea584',
  go: '#00add8',
  java: '#cc3e44',
  kt: '#a97bff',
  rb: '#cc342d',
  php: '#a074c4',
  c: '#599eff',
  h: '#a074c4',
  cpp: '#599eff',
  cs: '#68217a',
  swift: '#f05138',
  sh: '#89e051',
  zsh: '#89e051',
  bash: '#89e051',
  yml: '#cb8f3f',
  yaml: '#cb8f3f',
  toml: '#9c4221',
  ini: '#6d8086',
  sql: '#dad8d8',
  png: '#a074c4',
  jpg: '#a074c4',
  jpeg: '#a074c4',
  gif: '#a074c4',
  svg: '#ffb13b',
  webp: '#a074c4',
  ico: '#a074c4',
  lock: '#8f8f8f',
  gitignore: '#e8534f',
  env: '#e8d44d',
  txt: '#c5c5c5'
}
function fileColor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return FILE_COLORS[ext] ?? '#b6bcc4'
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg className={`ex-chevron${open ? ' open' : ''}`} width="16" height="16" viewBox="0 0 16 16">
      <path fill="currentColor" d="M5.7 3.3L10.4 8l-4.7 4.7-.7-.7L8.9 8 5 4z" />
    </svg>
  )
}
function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg className="ex-icon" width="16" height="16" viewBox="0 0 16 16" style={{ color: '#8bb3d9' }}>
      {open ? (
        <path fill="currentColor" d="M1.5 3h4l1 1.5H14a.5.5 0 01.48.63l-1.2 4.5A1 1 0 0112.3 14H2a1 1 0 01-1-1V3.5A.5.5 0 011.5 3z" />
      ) : (
        <path fill="currentColor" d="M1.5 3h4l1 1.5H14a1 1 0 011 1V13a1 1 0 01-1 1H1.5a.5.5 0 01-.5-.5v-10A.5.5 0 011.5 3z" />
      )}
    </svg>
  )
}
const CONFIG_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'jsconfig.json',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'makefile',
  'cargo.toml',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'pyproject.toml'
])
function isConfigFile(name: string): boolean {
  const n = name.toLowerCase()
  if (n.startsWith('.')) return true // dotfiles (.gitignore, .env, .eslintrc, …)
  if (CONFIG_NAMES.has(n)) return true
  if (n.includes('tsconfig') || n.includes('.config.') || n.endsWith('.lock')) return true
  return false
}

function ConfigIcon(): JSX.Element {
  return (
    <svg className="ex-icon" width="16" height="16" viewBox="0 0 16 16" style={{ color: '#8b9bb0' }}>
      <path
        fill="currentColor"
        d="M8 5.2A2.8 2.8 0 108 10.8 2.8 2.8 0 008 5.2zm0 1.5a1.3 1.3 0 110 2.6 1.3 1.3 0 010-2.6zM7 1l-.3 1.6a5.5 5.5 0 00-1.2.7L4 2.7 2.7 4l.6 1.5c-.3.4-.5.8-.7 1.2L1 7v2l1.6.3c.2.4.4.8.7 1.2L2.7 12 4 13.3l1.5-.6c.4.3.8.5 1.2.7L7 15h2l.3-1.6c.4-.2.8-.4 1.2-.7l1.5.6L13.3 12l-.6-1.5c.3-.4.5-.8.7-1.2L15 9V7l-1.6-.3a5.5 5.5 0 00-.7-1.2L13.3 4 12 2.7l-1.5.6a5.5 5.5 0 00-1.2-.7L9 1H7z"
      />
    </svg>
  )
}
function FileGlyph(): JSX.Element {
  return (
    <svg className="ex-icon" width="16" height="16" viewBox="0 0 16 16" style={{ color: '#b6bcc4' }}>
      <path fill="currentColor" d="M9.5 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V4.5L9.5 1zM9 5V2l3 3H9z" />
    </svg>
  )
}
function FileChip({ name }: { name: string }): JSX.Element {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return (
    <span className="ex-chip" style={{ background: fileColor(name) }}>
      {ext.slice(0, 3).toUpperCase()}
    </span>
  )
}
function FileNode({ name }: { name: string }): JSX.Element {
  if (isConfigFile(name)) return <ConfigIcon />
  const dot = name.lastIndexOf('.')
  if (dot > 0) return <FileChip name={name} />
  return <FileGlyph />
}
function ActionIcon({ type }: { type: 'new-file' | 'new-folder' | 'refresh' | 'collapse' }): JSX.Element {
  const p =
    type === 'new-file'
      ? 'M9.5 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V4.5L9.5 1zM9 5V2l3 3H9zM7.5 8v1.5H6v1h1.5V12h1v-1.5H10v-1H8.5V8z'
      : type === 'new-folder'
        ? 'M1.5 3h4l1 1.5H14a1 1 0 011 1V13a1 1 0 01-1 1H1.5a.5.5 0 01-.5-.5v-10A.5.5 0 011.5 3zm6 4v1.5H6v1h1.5V11h1V9.5H10v-1H8.5V7z'
        : type === 'refresh'
          ? 'M8 3V1L5 4l3 3V5a3 3 0 11-3 3H4a4 4 0 104-5z'
          : 'M4 6l4 4 4-4H4z'
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path fill="currentColor" d={p} />
    </svg>
  )
}

/* ---- tree node ----------------------------------------------------------- */
function TreeNode({
  entry,
  depth,
  onMenu,
  onNew
}: {
  entry: DirEntry
  depth: number
  onMenu: (e: ReactMouseEvent, entry: DirEntry) => void
  onNew: (kind: 'new-file' | 'new-folder', dir: string) => void
}): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const activePath = useSession((s) =>
    s.activeWorkspace ? (s.sessions[s.activeWorkspace]?.activePath ?? null) : null
  )
  const openFile = useSession((s) => s.openFile)
  const version = useTree((s) => s.versions[entry.path] ?? 0)
  const collapseToken = useTree((s) => s.collapseToken)
  const edited = useAgentEdits((s) => entry.path in s.edits)
  const isSelected = useSelection((s) => s.selected.includes(entry.path))
  const single = useSelection((s) => s.single)
  const toggleSel = useSelection((s) => s.toggle)

  const load = useCallback(async () => {
    setChildren(await window.api.workspace.readDir(entry.path))
  }, [entry.path])

  const toggle = useCallback(
    async (e: ReactMouseEvent) => {
      // ⌘/Ctrl+click a file toggles it in the multi-selection.
      if (!entry.isDirectory && (e.metaKey || e.ctrlKey)) {
        toggleSel(entry.path)
        return
      }
      if (entry.isDirectory) {
        if (!expanded && children === null) await load()
        setExpanded((x) => !x)
      } else {
        openFile(entry.path)
        ensureEditor()
        single(entry.path)
      }
    },
    [entry, expanded, children, load, openFile, single, toggleSel]
  )

  useEffect(() => {
    if (entry.isDirectory && expanded) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  useEffect(() => {
    if (collapseToken > 0) setExpanded(false)
  }, [collapseToken])

  return (
    <div>
      <div
        className={`ex-row${activePath === entry.path ? ' active' : ''}${isSelected ? ' selected' : ''}${edited ? ' edited' : ''}`}
        onClick={toggle}
        onContextMenu={(e) => onMenu(e, entry)}
      >
        {Array.from({ length: depth }).map((_, i) => (
          <span key={i} className="ex-guide" />
        ))}
        <span className="ex-twist">{entry.isDirectory ? <Chevron open={expanded} /> : null}</span>
        {entry.isDirectory ? <FolderIcon open={expanded} /> : <FileNode name={entry.name} />}
        <span className="ex-label">{entry.name}</span>
        {edited && <span className="ex-edit-dot" title="에이전트가 수정함">●</span>}
        {entry.isDirectory && (
          <span className="ex-row-actions">
            <button
              title="새 파일"
              onClick={(e) => {
                e.stopPropagation()
                onNew('new-file', entry.path)
              }}
            >
              <ActionIcon type="new-file" />
            </button>
            <button
              title="새 폴더"
              onClick={(e) => {
                e.stopPropagation()
                onNew('new-folder', entry.path)
              }}
            >
              <ActionIcon type="new-folder" />
            </button>
          </span>
        )}
      </div>
      {expanded &&
        children?.map((child) => (
          <TreeNode key={child.path} entry={child} depth={depth + 1} onMenu={onMenu} onNew={onNew} />
        ))}
    </div>
  )
}

/* ---- panel --------------------------------------------------------------- */
export default function ExplorerPanel({ workspace }: { workspace: string }): JSX.Element {
  const [roots, setRoots] = useState<DirEntry[]>([])
  const [menu, setMenu] = useState<Menu | null>(null)
  const [edit, setEdit] = useState<Edit>(null)
  const bump = useTree((s) => s.bump)
  const collapseAll = useTree((s) => s.collapseAll)
  const rootVersion = useTree((s) => s.versions[workspace] ?? 0)
  const openFile = useSession((s) => s.openFile)
  const closeTab = useSession((s) => s.closeTab)
  const activeWorkspace = useSession((s) => s.activeWorkspace)
  const selection = useSelection((s) => s.selected)

  useEffect(() => {
    window.api.workspace.readDir(workspace).then(setRoots)
  }, [workspace, rootVersion])

  useEffect(() => {
    return window.api.bridge.onFsChanged(({ type, path }) => {
      if (workspace !== activeWorkspace) return
      if (type === 'add' || type === 'unlink') bump(dirname(path))
    })
  }, [workspace, activeWorkspace, bump])

  const openMenu = useCallback((e: ReactMouseEvent, entry: DirEntry | null) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const onNew = useCallback((kind: 'new-file' | 'new-folder', dir: string) => setEdit({ kind, dir }), [])

  const targetDir = (entry: DirEntry | null): string =>
    entry ? (entry.isDirectory ? entry.path : dirname(entry.path)) : workspace

  const rel = (p: string): string => (p.startsWith(workspace) ? p.slice(workspace.length + 1) : p)

  const sendMentions = (paths: string[]): void => {
    contextBus.sendText(workspace, '\n' + paths.map((p) => '@' + rel(p)).join(' ') + ' ')
  }
  const sendContents = async (paths: string[]): Promise<void> => {
    const parts: string[] = []
    for (const p of paths) {
      const content = await window.api.workspace.readFile(p).catch(() => null)
      if (content != null) parts.push(`[파일 ${rel(p)}]\n\`\`\`\n${content}\n\`\`\``)
    }
    if (parts.length) contextBus.sendText(workspace, '\n' + parts.join('\n\n') + '\n')
  }

  // Files to send: the multi-selection if the clicked file is part of it, else just this file.
  const sendTargets = (entry: DirEntry | null): string[] => {
    if (!entry || entry.isDirectory) return selection.length ? selection : []
    return selection.includes(entry.path) && selection.length > 1 ? selection : [entry.path]
  }

  const menuItems = (entry: DirEntry | null): MenuItem[] => {
    const dir = targetDir(entry)
    const items: MenuItem[] = [
      { label: '새 파일', onClick: () => setEdit({ kind: 'new-file', dir }) },
      { label: '새 폴더', onClick: () => setEdit({ kind: 'new-folder', dir }) }
    ]
    const targets = sendTargets(entry)
    if (targets.length) {
      const n = targets.length
      items.push(
        { label: '', onClick: () => {}, separator: true },
        { label: `터미널로 @멘션 (${n})`, onClick: () => sendMentions(targets) },
        { label: `터미널로 내용 전송 (${n})`, onClick: () => sendContents(targets) }
      )
    }
    if (entry) {
      items.push(
        { label: '', onClick: () => {}, separator: true },
        { label: '이름 변경', onClick: () => setEdit({ kind: 'rename', target: entry }) },
        { label: '삭제', danger: true, onClick: () => doDelete(entry) },
        { label: '', onClick: () => {}, separator: true },
        { label: 'Finder에서 보기', onClick: () => window.api.workspace.reveal(entry.path) }
      )
    }
    return items
  }

  const doDelete = async (entry: DirEntry): Promise<void> => {
    if (!window.confirm(`'${entry.name}' 을(를) 삭제할까? 되돌릴 수 없어.`)) return
    await window.api.workspace.delete(entry.path)
    if (!entry.isDirectory) {
      closeTab(entry.path)
      closeDocument(entry.path)
    }
    bump(dirname(entry.path))
  }

  const submitEdit = async (name: string): Promise<void> => {
    if (!edit) return
    if (edit.kind === 'new-file') {
      const p = join(edit.dir, name)
      await window.api.workspace.createFile(p)
      bump(edit.dir)
      openFile(p)
      ensureEditor()
    } else if (edit.kind === 'new-folder') {
      await window.api.workspace.createFolder(join(edit.dir, name))
      bump(edit.dir)
    } else if (edit.kind === 'rename') {
      const dir = dirname(edit.target.path)
      const newPath = join(dir, name)
      await window.api.workspace.rename(edit.target.path, newPath)
      if (!edit.target.isDirectory) {
        closeTab(edit.target.path)
        closeDocument(edit.target.path)
        openFile(newPath)
      }
      bump(dir)
    }
    setEdit(null)
  }

  return (
    <div className="explorer-panel" onContextMenu={(e) => openMenu(e, null)}>
      <div className="ex-header">
        <span className="ex-title">{workspace.split('/').pop()}</span>
        <span className="ex-header-actions">
          <button title="새 파일" onClick={() => onNew('new-file', workspace)}>
            <ActionIcon type="new-file" />
          </button>
          <button title="새 폴더" onClick={() => onNew('new-folder', workspace)}>
            <ActionIcon type="new-folder" />
          </button>
          <button title="새로고침" onClick={() => bump(workspace)}>
            <ActionIcon type="refresh" />
          </button>
          <button title="모두 접기" onClick={collapseAll}>
            <ActionIcon type="collapse" />
          </button>
        </span>
      </div>
      <div className="tree-scroll">
        {roots.map((entry) => (
          <TreeNode key={entry.path} entry={entry} depth={0} onMenu={openMenu} onNew={onNew} />
        ))}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} />
      )}
      {edit && (
        <InputModal
          title={
            edit.kind === 'new-file' ? '새 파일 이름' : edit.kind === 'new-folder' ? '새 폴더 이름' : '이름 변경'
          }
          initial={edit.kind === 'rename' ? edit.target.name : ''}
          placeholder="이름 입력"
          onSubmit={submitEdit}
          onCancel={() => setEdit(null)}
        />
      )}
    </div>
  )
}
