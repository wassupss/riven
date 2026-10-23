import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpToLine, ChevronDown, ChevronUp } from 'lucide-react'
import type { ColumnDetail, QueryColumn } from '../../../../../main/db/types'
import type { ViewFilter } from '../../../../../main/db/sqlText'
import { useT } from '../../../i18n'
import ContextMenu, { type MenuItem } from '../../../components/ContextMenu'
import { typeTone, type Tone } from './tone'

type Cell = string | number | boolean | null

const ROW_H = 24
// Two-line header (name over type); the sticky header covers this much of the viewport.
const HEAD_H = 36
const NUM_W = 48
const OVERSCAN = 8

const show = (v: Cell): string => (v === null ? 'NULL' : typeof v === 'string' ? v : String(v))

// First line only, capped: a multi-KB json cell must not lay out in full.
const cellText = (v: Cell): string => {
  const s = show(v)
  const nl = s.indexOf('\n')
  const one = nl < 0 ? s : s.slice(0, nl) + ' …'
  return one.length > 300 ? one.slice(0, 300) + '…' : one
}

function csvField(v: Cell, sep: string): string {
  if (v === null) return ''
  const s = String(v)
  return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
}

export function toDelimited(columns: QueryColumn[], rows: Cell[][], sep: string): string {
  const lines = [columns.map((c) => csvField(c.name, sep)).join(sep)]
  for (const r of rows) lines.push(r.map((v) => csvField(v, sep)).join(sep))
  return lines.join('\n')
}

function initialWidths(columns: QueryColumn[], rows: Cell[][]): number[] {
  return columns.map((c, i) => {
    // Header is two lines (name over type), so it needs the wider of the two, never their sum.
    let len = Math.max(c.name.length * 1.08, c.type.length * 0.9)
    for (let r = 0; r < Math.min(rows.length, 60); r++) len = Math.max(len, cellText(rows[r][i]).length)
    return Math.round(Math.min(Math.max(len * 7.3 + 24, 72), 380))
  })
}

type Sort = { col: number; desc: boolean }
type Menu = { x: number; y: number; col: number; row?: number }

/** Editing hooks, by display row (inserted rows come first). */
export interface GridEdit {
  canEdit: (c: number) => boolean
  set: (r: number, c: number, v: Cell) => void
  revert: (r: number, c: number) => void
  toggleDelete: (r: number) => void
  mark: (r: number) => 'ins' | 'del' | undefined
  dirty: (r: number, c: number) => boolean
  /** How many inserted rows lead the list (they're numbered '+'). */
  inserted: number
}

// Values that don't fit a one-line input are edited in the viewer instead.
const multiLine = (v: Cell): boolean => typeof v === 'string' && (v.includes('\n') || v.length > 500)

// A row-virtualized result table: only the rows in view are in the
// DOM, so a 100k-row result scrolls like a 10-row one. `onMore` is passed while
// the source has more rows; it fires once the view nears the bottom.
// Sorting, filtering and edits are the owner's (it re-queries, keeps the
// pending changes); the grid only asks.
export default function ResultGrid({
  columns,
  rows,
  onMore,
  loadingMore,
  sort,
  onSort,
  onFilter,
  onAskFilter,
  columnInfo,
  epoch,
  edit
}: {
  columns: QueryColumn[]
  rows: Cell[][]
  onMore?: () => void
  loadingMore?: boolean
  sort?: Sort
  /** null clears the sort. */
  onSort?: (s: Sort | null) => void
  onFilter?: (f: ViewFilter) => void
  /** Ask for a value to filter the column by (contains / equals). */
  onAskFilter?: (col: number, op: 'like' | 'eq') => void
  /** Source-table detail of a column, for the header menu. */
  columnInfo?: (c: QueryColumn) => Promise<ColumnDetail | null>
  /** Bumped when the rows were replaced under the same columns (a re-sort). */
  epoch?: number
  edit?: GridEdit
}): JSX.Element {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(0)
  const [height, setHeight] = useState(300)
  const [widths, setWidths] = useState(() => initialWidths(columns, rows))
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  // The cell value viewer; with `at`, it edits that cell.
  const [viewer, setViewer] = useState<{ text: string; at?: { r: number; c: number } } | null>(null)
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  // Column detail per column index: undefined not asked, 'loading', null none.
  const [details, setDetails] = useState<Record<number, ColumnDetail | null | 'loading' | 'error'>>({})
  // Set while a column is being resized, so the release doesn't count as a click (sort).
  const resizing = useRef(false)
  const closeMenu = useCallback(() => setMenu(null), [])

  // A new result always brings new columns; appended pages keep them, so
  // scroll position, selection and widths survive a load-more.
  useEffect(() => {
    setWidths(initialWidths(columns, rows))
    setDetails({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns])
  useEffect(() => {
    setSel(null)
    setTop(0)
    setMenu(null)
    setEditing(null)
    setViewer(null)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [columns, epoch])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    setHeight(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const tones = useMemo<Tone[]>(() => columns.map((c) => typeTone(c.type)), [columns])
  const totalW = useMemo(() => NUM_W + widths.reduce((a, b) => a + b, 0), [widths])
  const template = useMemo(() => `${NUM_W}px ${widths.map((w) => `${w}px`).join(' ')}`, [widths])
  const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN)
  const more = !!onMore || !!loadingMore

  // Prefetch one screen ahead so the next page usually lands before the bottom.
  useEffect(() => {
    if (!onMore || loadingMore) return
    if (Math.ceil((top + height) / ROW_H) + Math.ceil(height / ROW_H) >= rows.length) onMore()
  }, [onMore, loadingMore, top, height, rows.length])

  const startResize = (i: number, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    resizing.current = true
    const x0 = e.clientX
    const w0 = widths[i]
    const move = (ev: MouseEvent): void =>
      setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(40, w0 + ev.clientX - x0) : w)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setTimeout(() => (resizing.current = false))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Header click cycles the sort: ascending, descending, off.
  const clickHead = (i: number): void => {
    if (!onSort || resizing.current) return
    if (sort?.col !== i) onSort({ col: i, desc: false })
    else if (!sort.desc) onSort({ col: i, desc: true })
    else onSort(null)
  }

  const scrollTo = (r: number): void => {
    const el = scrollRef.current
    if (!el) return
    const y = r * ROW_H
    if (y < el.scrollTop) el.scrollTop = y
    else if (y + ROW_H + HEAD_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H + HEAD_H - el.clientHeight
  }

  const canEdit = (r: number, c: number): boolean => !!edit && c >= 0 && edit.mark(r) !== 'del' && edit.canEdit(c)

  // Opens the editor on a cell: inline for one-line values, else the viewer.
  const startEdit = (r: number, c: number, initial?: string): void => {
    if (!canEdit(r, c)) return
    const v = rows[r]?.[c] ?? null
    setSel({ r, c })
    if (initial === undefined && multiLine(v)) setViewer({ text: show(v), at: { r, c } })
    else setEditing({ r, c, value: initial ?? (v === null ? '' : String(v)) })
  }

  const commitEdit = (then?: 'down' | 'right' | 'left'): void => {
    if (!editing || !edit) return
    const { r, c, value } = editing
    const old = rows[r]?.[c] ?? null
    if (old === null ? value !== '' : value !== String(old)) edit.set(r, c, value)
    setEditing(null)
    const next = then === 'down' ? { r: Math.min(r + 1, rows.length - 1), c } : then === 'right' ? { r, c: Math.min(c + 1, columns.length - 1) } : then === 'left' ? { r, c: Math.max(c - 1, 0) } : { r, c }
    setSel(next)
    scrollTo(next.r)
    gridRef.current?.focus()
  }

  const openMenu = (e: React.MouseEvent, col: number, row?: number): void => {
    e.preventDefault()
    // Keep the window listener from closing the menu this same event opens.
    e.stopPropagation()
    if (row !== undefined) setSel({ r: row, c: col })
    setMenu({ x: e.clientX, y: e.clientY, col, row })
    const c = columns[col]
    if (row === undefined && columnInfo && c.table && c.attnum && details[col] === undefined) {
      setDetails((d) => ({ ...d, [col]: 'loading' }))
      columnInfo(c)
        .then((info) => setDetails((d) => ({ ...d, [col]: info })))
        .catch(() => setDetails((d) => ({ ...d, [col]: 'error' })))
    }
  }

  const menuItems = (m: Menu): MenuItem[] => {
    const c = columns[m.col]
    const items: MenuItem[] = []
    const info = (label: string, detail?: string): void => {
      items.push({ label, detail, info: true, onClick: () => {} })
    }
    const sep = (): void => {
      if (items.length && !items[items.length - 1].separator) items.push({ label: '', separator: true, onClick: () => {} })
    }
    const copy = (s: string): void => void navigator.clipboard.writeText(s)
    if (m.row !== undefined) {
      const v = rows[m.row]?.[m.col] ?? null
      if (onFilter) {
        if (v === null) {
          items.push({ label: t('db.flt.isNull'), onClick: () => onFilter({ col: c.name, op: 'null' }) })
          items.push({ label: t('db.flt.notNull'), onClick: () => onFilter({ col: c.name, op: 'notnull' }) })
        } else {
          const short = cellText(v).slice(0, 40)
          items.push({ label: t('db.flt.eqValue', { v: short }), onClick: () => onFilter({ col: c.name, op: 'eq', value: show(v) }) })
          items.push({ label: t('db.flt.neValue', { v: short }), onClick: () => onFilter({ col: c.name, op: 'ne', value: show(v) }) })
        }
        sep()
      }
      items.push({ label: t('db.copyValue'), onClick: () => copy(show(v)) })
      items.push({ label: t('db.cellValue'), onClick: () => setViewer({ text: show(v) }) })
      if (edit) {
        const row = m.row
        sep()
        if (canEdit(row, m.col)) {
          items.push({ label: t('db.ed.edit'), onClick: () => startEdit(row, m.col) })
          if (v !== null) items.push({ label: t('db.ed.setNull'), onClick: () => edit.set(row, m.col, null) })
        }
        if (edit.dirty(row, m.col)) items.push({ label: t('db.ed.revertCell'), onClick: () => edit.revert(row, m.col) })
        const mk = edit.mark(row)
        items.push({
          label: mk === 'ins' ? t('db.ed.removeNew') : mk === 'del' ? t('db.ed.undelete') : t('db.ed.deleteRow'),
          onClick: () => edit.toggleDelete(row)
        })
      }
      return items
    }
    // Column header: what the column is, then sort / filter.
    const d = details[m.col]
    info(t('db.ci.type'), d && typeof d === 'object' ? d.type : c.type || '?')
    if (d === 'loading') info(t('db.loading'))
    else if (d === 'error') info(t('db.ci.failed'))
    else if (d) {
      const pk = d.constraints.find((x) => x.type === 'p')
      if (pk) info('PRIMARY KEY', pk.name)
      info(d.nullable ? 'NULL' : 'NOT NULL')
      if (d.identity) info('IDENTITY', d.identity)
      if (d.default !== null) info('DEFAULT', d.default)
      for (const x of d.constraints) {
        if (x.type === 'u') info('UNIQUE', x.name)
        else if (x.type === 'f') info('FOREIGN KEY', x.def.replace(/^FOREIGN KEY \([^)]*\)\s*/i, ''))
        else if (x.type === 'c') info('CHECK', x.def.replace(/^CHECK\s*/i, ''))
      }
      if (d.indexes.length) info(t('db.ci.index'), d.indexes.join(', '))
      info(t('db.ci.table'), d.column === c.name ? d.table : `${d.table}.${d.column}`)
      if (d.comment) info(t('db.ci.comment'), d.comment)
    } else info(t('db.ci.computed'))
    if (onSort) {
      sep()
      items.push({ label: t('db.sortAsc'), onClick: () => onSort({ col: m.col, desc: false }) })
      items.push({ label: t('db.sortDesc'), onClick: () => onSort({ col: m.col, desc: true }) })
      if (sort) items.push({ label: t('db.sortClear'), onClick: () => onSort(null) })
    }
    if (onFilter) {
      sep()
      if (onAskFilter) {
        items.push({ label: t('db.flt.contains'), onClick: () => onAskFilter(m.col, 'like') })
        items.push({ label: t('db.flt.equals'), onClick: () => onAskFilter(m.col, 'eq') })
      }
      items.push({ label: t('db.flt.isNull'), onClick: () => onFilter({ col: c.name, op: 'null' }) })
      items.push({ label: t('db.flt.notNull'), onClick: () => onFilter({ col: c.name, op: 'notnull' }) })
    }
    sep()
    items.push({ label: t('db.copyName'), onClick: () => copy(c.name) })
    return items
  }

  const onKey = useCallback(
    (e: React.KeyboardEvent): void => {
      if (e.target !== e.currentTarget) return
      const mod = e.metaKey || e.ctrlKey
      // Jump to the first / last row (the last loaded one).
      if ((mod && e.key === 'ArrowUp') || e.key === 'Home') {
        e.preventDefault()
        if (sel) setSel({ r: 0, c: sel.c })
        if (scrollRef.current) scrollRef.current.scrollTop = 0
        return
      }
      if ((mod && e.key === 'ArrowDown') || e.key === 'End') {
        e.preventDefault()
        if (sel && rows.length) setSel({ r: rows.length - 1, c: sel.c })
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        return
      }
      if (!sel) return
      if (mod && e.key === 'c') {
        e.preventDefault()
        void navigator.clipboard.writeText(sel.c < 0 ? rows[sel.r].map(show).join('\t') : show(rows[sel.r][sel.c]))
        return
      }
      const move = (r: number, c: number): void => {
        e.preventDefault()
        const nr = Math.min(Math.max(r, 0), rows.length - 1)
        const nc = Math.min(Math.max(c, 0), columns.length - 1)
        setSel({ r: nr, c: nc })
        scrollTo(nr)
      }
      if (e.key === 'ArrowDown') move(sel.r + 1, sel.c)
      else if (e.key === 'ArrowUp') move(sel.r - 1, sel.c)
      else if (e.key === 'ArrowRight') move(sel.r, sel.c + 1)
      else if (e.key === 'ArrowLeft') move(sel.r, sel.c - 1)
      else if ((e.key === 'Enter' || e.key === 'F2') && sel.c >= 0) {
        e.preventDefault()
        if (canEdit(sel.r, sel.c)) startEdit(sel.r, sel.c)
        else if (e.key === 'Enter') setViewer({ text: show(rows[sel.r][sel.c]) })
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && edit) {
        e.preventDefault()
        if (sel.c < 0) edit.toggleDelete(sel.r)
        else if (canEdit(sel.r, sel.c)) startEdit(sel.r, sel.c, '')
      } else if (e.key.length === 1 && !mod && !e.altKey && sel.c >= 0 && canEdit(sel.r, sel.c)) {
        // Typing over a cell starts editing it with that character.
        e.preventDefault()
        startEdit(sel.r, sel.c, e.key)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sel, rows, columns.length, edit]
  )

  const numLabel = (r: number): string => {
    if (!edit?.inserted) return String(r + 1)
    return r < edit.inserted ? '+' : String(r - edit.inserted + 1)
  }

  return (
    <div className="dbx-grid" tabIndex={0} onKeyDown={onKey} ref={gridRef}>
      <div className="dbx-grid-scroll" ref={scrollRef} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        <div style={{ width: totalW, minWidth: '100%' }}>
          <div className="dbx-grid-head" style={{ gridTemplateColumns: template, height: HEAD_H }}>
            <div className="dbx-grid-num">#</div>
            {columns.map((c, i) => (
              <div
                key={i}
                className={`dbx-grid-th tone-${tones[i]}${onSort ? ' sortable' : ''}${sort?.col === i ? ' sorted' : ''}`}
                title={`${c.name} ${c.type}`}
                onClick={() => clickHead(i)}
                onContextMenu={(e) => openMenu(e, i)}
              >
                <span className="dbx-grid-th-name">
                  {sort?.col === i && (sort.desc ? <ChevronDown size={11} /> : <ChevronUp size={11} />)}
                  {c.name}
                </span>
                {c.type && <span className="dbx-grid-th-type">{c.type}</span>}
                <span className="dbx-grid-resize" onMouseDown={(e) => startResize(i, e)} onClick={(e) => e.stopPropagation()} />
              </div>
            ))}
          </div>
          <div style={{ height: (rows.length + (more ? 1 : 0)) * ROW_H, position: 'relative' }}>
            {rows.slice(first, last).map((row, k) => {
              const r = first + k
              const mk = edit?.mark(r)
              return (
                <div
                  key={r}
                  className={`dbx-grid-row${r % 2 ? ' odd' : ''}${sel?.r === r ? ' sel-row' : ''}${mk ? ` ${mk}` : ''}`}
                  style={{ top: r * ROW_H, gridTemplateColumns: template }}
                >
                  <div className="dbx-grid-num" onClick={() => setSel({ r, c: -1 })} onContextMenu={(e) => edit && openMenu(e, 0, r)}>
                    {numLabel(r)}
                  </div>
                  {row.map((v, c) =>
                    editing && editing.r === r && editing.c === c ? (
                      <div key={c} className="dbx-grid-td editing">
                        <input
                          className="dbx-cell-input"
                          autoFocus
                          spellCheck={false}
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onBlur={() => commitEdit()}
                          onKeyDown={(e) => {
                            e.stopPropagation()
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commitEdit('down')
                            } else if (e.key === 'Tab') {
                              e.preventDefault()
                              commitEdit(e.shiftKey ? 'left' : 'right')
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              setEditing(null)
                              gridRef.current?.focus()
                            }
                          }}
                        />
                      </div>
                    ) : (
                      <div
                        key={c}
                        className={`dbx-grid-td tone-${tones[c]}${v === null ? ' null' : ''}${
                          typeof v === 'number' || tones[c] === 'num' ? ' num' : ''
                        }${typeof v === 'boolean' ? (v ? ' yes' : ' no') : ''}${sel?.r === r && sel.c === c ? ' sel' : ''}${
                          edit?.dirty(r, c) ? ' dirty' : ''
                        }`}
                        onClick={() => setSel({ r, c })}
                        onDoubleClick={() => (canEdit(r, c) ? startEdit(r, c) : setViewer({ text: show(v) }))}
                        onContextMenu={(e) => openMenu(e, c, r)}
                      >
                        {cellText(v)}
                      </div>
                    )
                  )}
                </div>
              )
            })}
            {more && (
              <div className="dbx-grid-more" style={{ top: rows.length * ROW_H }}>
                {loadingMore ? t('db.loadingMore') : ''}
              </div>
            )}
          </div>
        </div>
        {rows.length === 0 && <div className="dbx-empty">{t('db.noRows')}</div>}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />}
      {top > height && !viewer && (
        <button
          className="dbx-grid-top"
          title={t('db.toTop')}
          onClick={() => {
            if (scrollRef.current) scrollRef.current.scrollTop = 0
            gridRef.current?.focus()
          }}
        >
          <ArrowUpToLine size={14} />
        </button>
      )}
      {viewer !== null && (
        <CellViewer
          key={viewer.at ? `${viewer.at.r}:${viewer.at.c}` : 'view'}
          text={viewer.text}
          onSave={
            viewer.at && edit
              ? (v) => {
                  const at = viewer.at!
                  if (v !== viewer.text || rows[at.r]?.[at.c] === null) edit.set(at.r, at.c, v)
                  setViewer(null)
                  gridRef.current?.focus()
                }
              : undefined
          }
          onClose={() => {
            setViewer(null)
            gridRef.current?.focus()
          }}
        />
      )}
    </div>
  )
}

function CellViewer({ text, onSave, onClose }: { text: string; onSave?: (v: string) => void; onClose: () => void }): JSX.Element {
  const t = useT()
  const [value, setValue] = useState(text)
  return (
    <div className="dbx-viewer">
      <div className="dbx-viewer-bar">
        <span>{onSave ? t('db.ed.editValue') : t('db.cellValue')}</span>
        <button className="dbx-link" onClick={() => void navigator.clipboard.writeText(value)}>
          {t('db.copy')}
        </button>
        {onSave && (
          <button className="dbx-link" onClick={() => onSave(value)}>
            {t('db.ed.done')}
          </button>
        )}
        <button className="dbx-link" onClick={onClose}>
          {onSave ? t('common.cancel') : t('common.close')}
        </button>
      </div>
      {onSave ? (
        <textarea
          className="dbx-viewer-body dbx-viewer-edit"
          autoFocus
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') onClose()
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(value)
          }}
        />
      ) : (
        <pre className="dbx-viewer-body">{text}</pre>
      )}
    </div>
  )
}
