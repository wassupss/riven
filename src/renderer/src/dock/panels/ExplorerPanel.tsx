import { useEffect, useState, useRef, useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import type { DirEntry } from '../../../../preload'
import { useSession, pathOf } from '../../state/session'
import { useTree } from '../../state/tree'
import { useAgentEdits } from '../../state/agentEdits'
import { useGitStatus, GIT_BADGE } from '../../state/gitStatus'
import { useSelection } from '../../state/selection'
import { useExplorerReveal } from '../../state/explorerReveal'
import { contextBus } from '../../bridge/contextBus'
import { closeDocument } from '../../lsp/client'
import { ensureEditor } from '../registry'
import ContextMenu, { type MenuItem } from '../../components/ContextMenu'
import { FilePlus, FolderPlus, RefreshCw, ChevronsDownUp } from 'lucide-react'
import InputModal from '../../components/InputModal'
import { FileIcon } from '../../components/FileIcon'
import { useT } from '../../i18n'

const dirname = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'
const join = (dir: string, name: string): string => `${dir}/${name}`

type Menu = { x: number; y: number; entry: DirEntry | null }
type Edit =
  | { kind: 'new-file' | 'new-folder'; dir: string }
  | { kind: 'rename'; target: DirEntry }
  | null

/* ---- icons ---------------------------------------------------------------- */
function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg className={`ex-chevron${open ? ' open' : ''}`} width="16" height="16" viewBox="0 0 16 16">
      <path fill="currentColor" d="M5.7 3.3L10.4 8l-4.7 4.7-.7-.7L8.9 8 5 4z" />
    </svg>
  )
}
// Consistent lucide icons (the app's icon set) instead of hand-drawn SVG paths.
function ActionIcon({ type }: { type: 'new-file' | 'new-folder' | 'refresh' | 'collapse' }): JSX.Element {
  const size = 14
  if (type === 'new-file') return <FilePlus size={size} />
  if (type === 'new-folder') return <FolderPlus size={size} />
  if (type === 'refresh') return <RefreshCw size={size} />
  return <ChevronsDownUp size={size} />
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
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const revealTarget = useExplorerReveal((s) => s.target)
  const activePath = useSession((s) =>
    s.activeWorkspace ? (s.sessions[s.activeWorkspace]?.activePath ?? null) : null
  )
  const openFile = useSession((s) => s.openFile)
  const version = useTree((s) => s.versions[entry.path] ?? 0)
  const collapseToken = useTree((s) => s.collapseToken)
  const edited = useAgentEdits((s) => entry.path in s.edits)
  const gitCat = useGitStatus((s) => (entry.isDirectory ? s.dirs[entry.path] : s.files[entry.path]))
  const isSelected = useSelection((s) => s.selected.includes(entry.path))
  const single = useSelection((s) => s.single)
  const toggleSel = useSelection((s) => s.toggle)
  const setRange = useSelection((s) => s.setRange)

  const load = useCallback(async () => {
    setChildren(await window.api.workspace.readDir(entry.path))
  }, [entry.path])

  const toggle = useCallback(
    async (e: ReactMouseEvent) => {
      // ⇧+click selects the visible range between the anchor and this row. Read
      // the rendered rows in document order (only visible/expanded ones, like
      // NSOutlineView) so the range spans exactly what the user sees.
      const anchor = useSelection.getState().anchor
      if (e.shiftKey && anchor) {
        const scroll = rowRef.current?.closest('.tree-scroll')
        const paths = scroll
          ? Array.from(scroll.querySelectorAll<HTMLElement>('.ex-row[data-path]')).map(
              (el) => el.dataset.path as string
            )
          : []
        const a = paths.indexOf(anchor)
        const b = paths.indexOf(entry.path)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setRange(paths.slice(lo, hi + 1))
          return
        }
      }
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
    [entry, expanded, children, load, openFile, single, toggleSel, setRange]
  )

  useEffect(() => {
    if (entry.isDirectory && expanded) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  useEffect(() => {
    if (collapseToken > 0) setExpanded(false)
  }, [collapseToken])

  // Reveal: auto-expand folders on the path to the target file; scroll it in view.
  useEffect(() => {
    if (!revealTarget) return
    if (entry.isDirectory) {
      if (revealTarget.startsWith(entry.path + '/') && !expanded) {
        void (async () => {
          if (children === null) await load()
          setExpanded(true)
        })()
      }
    } else if (revealTarget === entry.path) {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget, entry.path, entry.isDirectory])

  return (
    <div>
      <div
        ref={rowRef}
        data-path={entry.path}
        className={`ex-row${activePath === entry.path ? ' active' : ''}${isSelected ? ' selected' : ''}${edited ? ' edited' : ''}${gitCat ? ' git-' + gitCat : ''}`}
        onClick={toggle}
        onContextMenu={(e) => onMenu(e, entry)}
        draggable={!entry.isDirectory}
        onDragStart={(e) => {
          // Drag a file onto the native chat to attach its path.
          e.dataTransfer.setData('text/plain', entry.path)
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        {Array.from({ length: depth }).map((_, i) => (
          <span key={i} className="ex-guide" />
        ))}
        <span className="ex-twist">{entry.isDirectory ? <Chevron open={expanded} /> : null}</span>
        <span
          className="ex-icon"
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <FileIcon name={entry.name} dir={entry.isDirectory} open={expanded} />
        </span>
        <span className="ex-label">{entry.name}</span>
        {edited && <span className="ex-edit-dot" title={t('explorer.agentEdited')}>●</span>}
        {gitCat && !entry.isDirectory && <span className="ex-git-badge">{GIT_BADGE[gitCat]}</span>}
        {entry.isDirectory && (
          <span className="ex-row-actions">
            <button
              title={t('explorer.newFile')}
              onClick={(e) => {
                e.stopPropagation()
                onNew('new-file', entry.path)
              }}
            >
              <ActionIcon type="new-file" />
            </button>
            <button
              title={t('explorer.newFolder')}
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
  const t = useT()
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
  const clearSelection = useSelection((s) => s.clear)
  const activePath = useSession((s) => s.sessions[workspace]?.activePath ?? null)
  const reveal = useExplorerReveal((s) => s.reveal)
  const refreshGit = useGitStatus((s) => s.refresh)
  const gitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleGit = useCallback(() => {
    if (workspace !== activeWorkspace) return
    if (gitTimer.current) clearTimeout(gitTimer.current)
    gitTimer.current = setTimeout(() => void refreshGit(pathOf(workspace)), 300)
  }, [workspace, activeWorkspace, refreshGit])

  // Keep the tree in sync with the open file: reveal it (expand ancestors, scroll).
  useEffect(() => {
    if (activePath && workspace === activeWorkspace) reveal(activePath)
  }, [activePath, workspace, activeWorkspace, reveal])

  // Working-tree decorations: refresh on activation, on git HEAD/index changes,
  // and (debounced) whenever files change on disk.
  useEffect(() => {
    if (workspace === activeWorkspace) void refreshGit(pathOf(workspace))
  }, [workspace, activeWorkspace, rootVersion, refreshGit])
  useEffect(() => window.api.git.onChanged(() => scheduleGit()), [scheduleGit])

  useEffect(() => {
    window.api.workspace.readDir(pathOf(workspace)).then(setRoots)
  }, [workspace, rootVersion])

  useEffect(() => {
    return window.api.bridge.onFsChanged(({ type, path }) => {
      if (workspace !== activeWorkspace) return
      if (type === 'add' || type === 'unlink') bump(dirname(path))
      scheduleGit()
    })
  }, [workspace, activeWorkspace, bump, scheduleGit])

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
      { label: t('explorer.newFile'), onClick: () => setEdit({ kind: 'new-file', dir }) },
      { label: t('explorer.newFolder'), onClick: () => setEdit({ kind: 'new-folder', dir }) }
    ]
    const targets = sendTargets(entry)
    if (targets.length) {
      const n = targets.length
      items.push(
        { label: '', onClick: () => {}, separator: true },
        { label: t('explorer.mentionInTerminal', { n }), onClick: () => sendMentions(targets) },
        { label: t('explorer.sendToTerminal', { n }), onClick: () => sendContents(targets) }
      )
    }
    if (entry) {
      items.push(
        { label: '', onClick: () => {}, separator: true },
        { label: t('explorer.rename'), onClick: () => setEdit({ kind: 'rename', target: entry }) },
        { label: t('explorer.copyPath'), onClick: () => void navigator.clipboard.writeText(entry.path) },
        { label: t('explorer.delete'), danger: true, onClick: () => doDelete(entry) },
        { label: '', onClick: () => {}, separator: true },
        { label: t('explorer.revealInFinder'), onClick: () => window.api.workspace.reveal(entry.path) }
      )
    }
    return items
  }

  const deletePaths = async (targets: string[], name?: string): Promise<void> => {
    if (!targets.length) return
    const ok =
      targets.length > 1
        ? window.confirm(t('explorer.deleteConfirmN', { n: targets.length }))
        : window.confirm(
            t('explorer.deleteConfirm', { name: name ?? targets[0].split('/').pop() ?? targets[0] })
          )
    if (!ok) return
    const dirs = new Set<string>()
    for (const p of targets) {
      await window.api.workspace.delete(p)
      closeTab(p) // no-op for a path that isn't an open tab (dirs included)
      closeDocument(p)
      dirs.add(dirname(p))
    }
    for (const d of dirs) bump(d)
    clearSelection()
  }

  // Delete the whole selection when the right-clicked row is part of it (Finder
  // rule), otherwise just that one entry.
  const doDelete = (entry: DirEntry): Promise<void> =>
    deletePaths(
      selection.includes(entry.path) && selection.length > 1 ? selection : [entry.path],
      entry.name
    )

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
          <button title={t('explorer.newFile')} onClick={() => onNew('new-file', workspace)}>
            <ActionIcon type="new-file" />
          </button>
          <button title={t('explorer.newFolder')} onClick={() => onNew('new-folder', workspace)}>
            <ActionIcon type="new-folder" />
          </button>
          <button title={t('common.refresh')} onClick={() => bump(workspace)}>
            <ActionIcon type="refresh" />
          </button>
          <button title={t('explorer.collapseAll')} onClick={collapseAll}>
            <ActionIcon type="collapse" />
          </button>
        </span>
      </div>
      <div
        className="tree-scroll"
        tabIndex={0}
        onKeyDown={(e) => {
          // Delete / ⌘⌫ removes the current selection (the tree holds focus after
          // a row click). Confirmed in deletePaths.
          if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
            e.preventDefault()
            void deletePaths(selection)
          }
        }}
      >
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
            edit.kind === 'new-file'
              ? t('explorer.newFileName')
              : edit.kind === 'new-folder'
                ? t('explorer.newFolderName')
                : t('explorer.rename')
          }
          initial={edit.kind === 'rename' ? edit.target.name : ''}
          placeholder={t('explorer.namePlaceholder')}
          onSubmit={submitEdit}
          onCancel={() => setEdit(null)}
        />
      )}
    </div>
  )
}
