import { ipcMain, app } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'

// Scratch markdown notes (riven's Notes panel). Kept OUT of the repo — stored per
// workspace under userData — so agents can jot summaries/plans without polluting
// git. `doc_write` / `note_save_file` are the explicit escape hatches that write a
// real .md into the workspace. Backs the renderer Notes panel and note_* MCP tools.

function notesDir(ws: string): string {
  const key = createHash('sha1').update(ws).digest('hex').slice(0, 16)
  return path.join(app.getPath('userData'), 'notes', key)
}

const slug = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\w가-힣\- ]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40) || 'note'

function titleOf(content: string, fallback: string): string {
  const m = content.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : content.split('\n').find((l) => l.trim())?.slice(0, 60) || fallback
}

export interface NoteMeta {
  name: string // file name without .md — the stable id
  title: string
  mtime: number
}

async function listNotes(ws: string): Promise<NoteMeta[]> {
  const dir = notesDir(ws)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }
  const out: NoteMeta[] = []
  for (const f of files) {
    if (!f.endsWith('.md')) continue
    const full = path.join(dir, f)
    try {
      const [content, stat] = await Promise.all([fs.readFile(full, 'utf8'), fs.stat(full)])
      const name = f.slice(0, -3)
      out.push({ name, title: titleOf(content, name), mtime: stat.mtimeMs })
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// Resolve a note reference (name / title / file name) to a file name (no .md).
async function resolveName(ws: string, ref: string): Promise<string | null> {
  const bare = ref.replace(/\.md$/, '')
  const notes = await listNotes(ws)
  const byName = notes.find((n) => n.name === bare)
  if (byName) return byName.name
  const byTitle = notes.find((n) => n.title === ref)
  return byTitle ? byTitle.name : null
}

async function readNote(ws: string, ref: string): Promise<string | null> {
  const name = await resolveName(ws, ref)
  if (!name) return null
  try {
    return await fs.readFile(path.join(notesDir(ws), name + '.md'), 'utf8')
  } catch {
    return null
  }
}

async function writeNote(
  ws: string,
  ref: string | null,
  title: string,
  body: string
): Promise<string> {
  const dir = notesDir(ws)
  await fs.mkdir(dir, { recursive: true })
  const content = body.trimStart().startsWith('#') ? body : `# ${title}\n\n${body}`
  let name = ref ? await resolveName(ws, ref) : null
  if (!name) name = `${slug(title)}-${Date.now().toString(36)}`
  await fs.writeFile(path.join(dir, name + '.md'), content)
  return name
}

async function appendNote(ws: string, ref: string, body: string): Promise<string | null> {
  const name = await resolveName(ws, ref)
  if (!name) return null
  const file = path.join(notesDir(ws), name + '.md')
  const prev = await fs.readFile(file, 'utf8').catch(() => '')
  await fs.writeFile(file, prev.replace(/\s*$/, '') + '\n\n' + body + '\n')
  return name
}

// Write a real .md into the workspace (doc_write / note_save_file). Refuses to
// clobber unless overwrite, and never escapes the workspace.
async function writeWorkspaceFile(
  ws: string,
  relPath: string,
  body: string,
  overwrite: boolean
): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Bare name (no dir) → default under .claude/docs, matching native doc_write.
  const rel = relPath.includes('/') ? relPath : path.join('.claude', 'docs', relPath)
  const abs = path.resolve(ws, rel)
  if (!abs.startsWith(path.resolve(ws) + path.sep))
    return { ok: false, error: 'path escapes the workspace' }
  if (!overwrite) {
    try {
      await fs.access(abs)
      return { ok: false, error: 'file exists (set overwrite to replace)' }
    } catch {
      /* doesn't exist — good */
    }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body)
  return { ok: true, path: abs }
}

export function registerNotesHandlers(): void {
  ipcMain.handle('notes:list', (_e, ws: string) => listNotes(ws))
  ipcMain.handle('notes:read', (_e, ws: string, ref: string) => readNote(ws, ref))
  ipcMain.handle('notes:write', (_e, ws: string, ref: string | null, title: string, body: string) =>
    writeNote(ws, ref, title, body)
  )
  ipcMain.handle('notes:append', (_e, ws: string, ref: string, body: string) =>
    appendNote(ws, ref, body)
  )
  ipcMain.handle('notes:delete', async (_e, ws: string, ref: string) => {
    const name = await resolveName(ws, ref)
    if (!name) return false
    await fs.rm(path.join(notesDir(ws), name + '.md'), { force: true })
    return true
  })
  ipcMain.handle(
    'notes:writeFile',
    (_e, ws: string, relPath: string, body: string, overwrite: boolean) =>
      writeWorkspaceFile(ws, relPath, body, overwrite)
  )
  // note_save_file: save an existing note's content to a workspace .md file.
  ipcMain.handle(
    'notes:saveToFile',
    async (_e, ws: string, ref: string, relPath: string, overwrite: boolean) => {
      const content = await readNote(ws, ref)
      if (content == null) return { ok: false, error: 'note not found' }
      return writeWorkspaceFile(ws, relPath, content, overwrite)
    }
  )
}
