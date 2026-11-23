// ---------------------------------------------------------------------------
// One-shot AI help for the pet (the maker's "AI에게 맡기기" and the decoration
// layout's "AI에게 배치 맡기기"): the keeper's own Claude Code (or Codex) login,
// one call with no tools and nothing saved (Rust services/petai.rs). The page
// builds the prompt and checks the answer (lib/petAiPixels.ts,
// lib/petAiLayout.ts); this is the part they share.
// ---------------------------------------------------------------------------

export type PetAiModel = 'sonnet' | 'haiku' | 'opus' | 'codex'
export const PET_AI_MODELS: PetAiModel[] = ['sonnet', 'haiku', 'opus', 'codex']
const MODEL_KEY = 'riven.petAiModel'

/** The model last chosen (Sonnet until one is). A per-window convenience: storage may be missing. */
export function savedModel(): PetAiModel {
  try {
    const v = localStorage.getItem(MODEL_KEY)
    if (v && (PET_AI_MODELS as string[]).includes(v)) return v as PetAiModel
  } catch {
    // no storage: the default
  }
  return 'sonnet'
}

export function saveModel(m: PetAiModel): void {
  try {
    localStorage.setItem(MODEL_KEY, m)
  } catch {
    // not kept, still used for this call
  }
}

export interface PetAiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface PetAiAnswer {
  ok: boolean
  text?: string
  error?: 'notInstalled' | 'timeout' | 'cancelled' | 'failed'
  detail?: string
  usage?: PetAiUsage
  ms?: number
}

export interface PetAiRun {
  id: string
  done: Promise<PetAiAnswer>
  cancel: () => void
}

let seq = 0
const newId = (): string => `pa${Date.now().toString(36)}${(seq++).toString(36)}`

/** Start a call; `done` always resolves (a failure is an answer with ok false). */
export function startPetAi(req: { model: PetAiModel; system: string; prompt: string; images?: string[]; timeoutMs?: number }): PetAiRun {
  const id = newId()
  const codex = req.model === 'codex'
  const done = window.api.petAi
    .run({
      id,
      engine: codex ? 'codex' : 'claude',
      ...(codex ? {} : { model: req.model }),
      system: req.system,
      prompt: req.prompt,
      images: req.images ?? [],
      ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {})
    })
    .catch((e: unknown): PetAiAnswer => ({ ok: false, error: 'failed', detail: String(e).slice(0, 200) }))
  return { id, done, cancel: () => void window.api.petAi.cancel(id).catch(() => {}) }
}

/**
 * The JSON object in a model's answer: the whole text, or inside a ```json
 * fence, or from the first `{` to the last `}` (a sentence before or after
 * it is forgiven). Null when there is none that parses.
 */
export function extractJson(text: string): unknown {
  const t = text.trim()
  const tries: string[] = [t]
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) tries.push(fence[1].trim())
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1))
  for (const s of tries) {
    try {
      const v = JSON.parse(s) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) return v
    } catch {
      // the next way
    }
  }
  return null
}

/** '#abc', 'abc', '#AABBCC' as '#aabbcc'; null for anything else. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim())
  if (!m) return null
  const h = m[1].toLowerCase()
  return `#${h.length === 3 ? h.replace(/./g, (c) => c + c) : h}`
}

/** What the call cost, in tokens (for the line under the result). */
export const usageTokens = (u: PetAiUsage | undefined): number =>
  u ? Math.round(u.input + u.output + u.cacheRead + u.cacheWrite) : 0

/**
 * An RGBA picture as a PNG (base64, no data: prefix), each dot made a
 * `scale` x `scale` square (nearest neighbour), on a transparent ground.
 * Browser only (a canvas).
 */
export function pngOf(width: number, height: number, rgba: Uint8ClampedArray, scale = 1): string {
  const src = document.createElement('canvas')
  src.width = width
  src.height = height
  const sctx = src.getContext('2d')
  if (!sctx) return ''
  const img = sctx.createImageData(width, height)
  img.data.set(rgba)
  sctx.putImageData(img, 0, 0)
  const k = Math.max(1, Math.floor(scale))
  const out = document.createElement('canvas')
  out.width = width * k
  out.height = height * k
  const ctx = out.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(src, 0, 0, out.width, out.height)
  return out.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/** How much to scale an n-dot picture up so the model sees it at about `px` across. */
export const scaleFor = (n: number, px = 512): number => Math.max(1, Math.floor(px / Math.max(1, n)))
