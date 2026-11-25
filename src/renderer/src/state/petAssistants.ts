import { create } from 'zustand'
import { t } from '../i18n'
import type { CliEvent, CliItem } from '../lib/cliChat'
import {
  emptyLive,
  foldLive,
  menuAsks,
  menuId,
  menuPick,
  notifyBody,
  permissionAsks,
  permissionDecision,
  questionAnswersFrom,
  questionAsks,
  type CliLive,
  type Labels
} from '../lib/cliChatLive'
import {
  actingWorkspace,
  bornAtOfKey,
  isAssistant,
  launchChange,
  personaPrompt,
  petChatKey,
  resolveScope,
  sanitizeSessions,
  type Launch,
  type SavedSessions
} from '../lib/petAssistant'
import { postToPets, serveAssistants, type AssistCard, type AssistPet, type AssistStatus } from '../lib/petAssistBus'
import { onNest } from '../lib/petCommand'
import { briefOf, normalizeNest, petTitle, speciesName, turnFood, type NestBrief, type PetBrief, type UsageRecord } from './pet'
import { setPetScope } from './petAssistScope'
import { pathOf, useSession, workspaceName } from './session'
import { claudeConfigDirFor, getSettings } from './settings'

// ---------------------------------------------------------------------------
// 펫 비서, the host: every pet assistant's Claude session, run in riven's main
// window on the CLI chat engine (services/clichat: the real interactive
// `claude` in a hidden pty, its transcript tailed, its hooks for permission
// requests), exactly as a CLI chat pane runs, under the key petchat-<birthday>.
//
// - The pet (its own window, or inside the app) talks to this over
//   lib/petAssistBus: a question goes in, the status, the reply and the cards
//   waiting on the person come back.
// - riven's MCP tools reach the session the same way they reach a CLI chat
//   pane (services/clichat launch_env: riven's MCP config, minus the tools
//   switched off in Settings > AI, and nothing else added). Its calls act on
//   the workspace its scope says (state/petAssistScope).
// - Lifecycle: nothing runs until the keeper first talks to that pet. An idle
//   process is parked after PARK_AFTER_SECS (Rust, life.rs), and resumed by
//   the next message. Switching the assistant off, letting the pet go and
//   quitting riven stop it (quit: services/clichat shutdown).
// - Food: the usage of its own turns feeds that pet alone (state/pet feedOwn);
//   the shared split among the pets out keeps the rest (deductOwed).
//
// No timers and no polling here: everything follows events.
// ---------------------------------------------------------------------------

/** A pet assistant waits less than a chat pane before its process is parked. */
export const PARK_AFTER_SECS = 10 * 60
const FILE = 'pet-assistants.json'
const PET_FILE = 'pet.json'

interface CardRec {
  card: AssistCard
  answer: (choices: string[]) => void
}

interface Run {
  bornAt: number
  key: string
  pet: AssistPet
  /** Rust holds a session under the key (running or parked). */
  inRust: boolean
  /** What that session was started with. */
  launch: Launch | null
  starting: Promise<boolean> | null
  live: CliLive
  blocked: boolean
  preview: string | null
  cards: Map<string, CardRec>
  menuSig: string | null
  /** Usage records already counted (its own food), by item key. */
  usageSeen: Set<string>
  /** New settings that need a new process, applied once this turn ends. */
  restartAfterTurn: boolean
  lastStatus: string
}

const runs = new Map<number, Run>()
let saved: SavedSessions | null = null
let lastNest: NestBrief | null = null
/** Which pets were assistants in the last nest heard (birthday -> on). */
let lastOn: Map<number, boolean> | null = null
let home: string | null = null

/** The conversation dialog (components/PetChatDialog) open in this window. */
// `seq` counts requests to open a conversation: asking again for one that is already
// open still moves the caret to its field.
export const usePetChat = create<{ open: number | null; seq: number }>(() => ({ open: null, seq: 0 }))

export function openPetChat(bornAt: number): void {
  usePetChat.setState((s) => ({ open: Math.floor(bornAt), seq: s.seq + 1 }))
}
export function closePetChat(): void {
  usePetChat.setState({ open: null })
}

// ---- what a pet is, from the nest -----------------------------------------------

function petOf(b: PetBrief): AssistPet | null {
  if (!b.assistant) return null
  return {
    bornAt: Math.floor(b.bornAt),
    title: petTitle(b, t),
    species: speciesName(b.species, t, b.custom),
    assistant: b.assistant
  }
}

async function nestNow(): Promise<NestBrief> {
  if (lastNest) return lastNest
  const raw = await window.api.config.load(PET_FILE).catch(() => null)
  return briefOf(normalizeNest(raw, Date.now()))
}

/** The pet with this birthday as the nest has it now (null: gone, or never an assistant). */
export async function assistantPet(bornAt: number): Promise<AssistPet | null> {
  const n = await nestNow()
  const b = n.pets.find((p) => Math.floor(p.bornAt) === Math.floor(bornAt))
  return b ? petOf(b) : null
}

// ---- the saved sessions -----------------------------------------------------------

async function loadSaved(): Promise<SavedSessions> {
  if (saved) return saved
  saved = sanitizeSessions(await window.api.config.load(FILE).catch(() => null))
  return saved
}

function writeSaved(): void {
  if (saved) void window.api.config.save(FILE, { version: 1, pets: saved })
}

function remember(bornAt: number, sessionId: string, cwd: string): void {
  if (!saved) return
  const k = String(bornAt)
  if (saved[k]?.sessionId === sessionId && saved[k]?.cwd === cwd) return
  saved[k] = { sessionId, cwd }
  writeSaved()
}

// ---- launching ------------------------------------------------------------------------

/**
 * Where an assistant over several workspaces runs: riven's own folder
 * (userData/pet-assistants), else the home folder. A folder of its own:
 * trusting it (the CLI asks once, as a card on the pet) trusts nothing else,
 * and no project's files are loaded into it.
 */
async function homeDir(): Promise<string> {
  if (home) return home
  const d = await window.api.env.defaults().catch(() => null)
  home = d?.petHome || d?.home || '/'
  return home
}

function launchFor(pet: AssistPet, homePath: string): Launch {
  const cfg = pet.assistant
  const ss = useSession.getState()
  const scope = resolveScope(cfg, ss.openWorkspaces)
  const named = cfg.allWorkspaces || !cfg.workspaces.length
  return {
    cwd: scope.cwd ?? homePath,
    prompt: personaPrompt({
      name: pet.title,
      species: pet.species,
      role: cfg.role,
      workspaces: named ? null : scope.workspaces.map((w) => `${workspaceName(w, ss.names)} (${pathOf(w)})`)
    }),
    model: cfg.model,
    permission: cfg.permission
  }
}

function startOpts(pet: AssistPet, l: Launch, resume: string | undefined, parked = false): Parameters<typeof window.api.cliChat.start>[1] {
  const st = getSettings()
  const one = !pet.assistant.allWorkspaces && pet.assistant.workspaces.length === 1 ? pet.assistant.workspaces[0] : null
  return {
    cwd: l.cwd,
    resume,
    configDir: claudeConfigDirFor(one),
    model: l.model && l.model !== 'default' ? l.model : undefined,
    permissionMode: l.permission,
    mcpDisabled: st.mcpDisabledTools,
    toolsDenied: st.deniedTools,
    // The keeper's own prompt (Settings > AI), then the pet's persona: a
    // system prompt, never a chat turn.
    globalPrompt: [st.globalPrompt?.trim(), l.prompt].filter(Boolean).join('\n\n'),
    cli: 'claude',
    parked: parked || undefined,
    parkAfterSecs: PARK_AFTER_SECS
  }
}

function runFor(pet: AssistPet): Run {
  const bornAt = Math.floor(pet.bornAt)
  let run = runs.get(bornAt)
  if (!run) {
    run = {
      bornAt,
      key: petChatKey(bornAt),
      pet,
      inRust: false,
      launch: null,
      starting: null,
      live: emptyLive(Date.now()),
      blocked: false,
      preview: null,
      cards: new Map(),
      menuSig: null,
      usageSeen: new Set(),
      restartAfterTurn: false,
      lastStatus: ''
    }
    runs.set(bornAt, run)
  } else run.pet = pet
  const r = run
  // Its tool calls act where its scope says, the one on screen first.
  setPetScope(r.key, () => {
    const ss = useSession.getState()
    return actingWorkspace(r.pet.assistant, ss.activeWorkspace, ss.openWorkspaces)
  })
  return r
}

/**
 * A process for this pet with the settings it has now: the saved
 * conversation resumed when it ran in the same folder. restart, not start:
 * it waits for a process this one replaces to be gone (same key).
 */
async function launch(run: Run, parked: boolean): Promise<boolean> {
  const want = launchFor(run.pet, await homeDir())
  const s = (await loadSaved())[String(run.bornAt)]
  const resume = s && s.cwd === want.cwd ? s.sessionId : undefined
  if (parked && !resume) return false
  try {
    const r = await window.api.cliChat.restart(run.key, startOpts(run.pet, want, resume, parked))
    if (!r.sessionId) return false
    run.inRust = true
    run.launch = want
    run.restartAfterTurn = false
    remember(run.bornAt, r.sessionId, want.cwd)
    return true
  } catch (err) {
    note(run, err instanceof Error ? err.message : String(err))
    return false
  }
}

function ensure(run: Run, parked: boolean): Promise<boolean> {
  if (run.inRust) return Promise.resolve(true)
  run.starting ??= launch(run, parked).finally(() => {
    run.starting = null
  })
  return run.starting
}

/** Ask this pet's assistant something: its session starts (or resumes) on the first one. */
export async function askPet(pet: AssistPet, text: string): Promise<void> {
  const msg = text.trim()
  if (!msg || !isAssistant(pet.assistant)) return
  const run = runFor(pet)
  if (run.starting) await run.starting
  if (run.inRust && run.launch) {
    const want = launchFor(pet, await homeDir())
    const change = launchChange(run.launch, want)
    if (change === 'flags') reconfigure(run, want)
    else if (change !== 'none') {
      // A new prompt or folder needs a new process; mid-turn it waits.
      if (run.live.busy || run.cards.size) run.restartAfterTurn = true
      else run.inRust = false
    }
  }
  if (!(await ensure(run, false))) return
  window.api.cliChat.send(run.key, msg)
}

function reconfigure(run: Run, want: Launch): void {
  // Applied by Rust at the turn boundary with --resume (never /model).
  window.api.cliChat.reconfigure(run.key, want.model === 'default' ? '' : want.model, want.permission)
  run.launch = want
}

/** Stop its process and forget the live state (the saved conversation stays unless `forget`). */
function stopRun(run: Run, forget: boolean): void {
  window.api.cliChat.stop(run.key)
  run.inRust = false
  run.launch = null
  run.live = emptyLive(Date.now())
  run.blocked = false
  run.preview = null
  run.cards.clear()
  run.menuSig = null
  run.restartAfterTurn = false
  publish(run, true)
  if (!forget) return
  runs.delete(run.bornAt)
  setPetScope(run.key, null)
  if (saved && saved[String(run.bornAt)]) {
    delete saved[String(run.bornAt)]
    writeSaved()
  }
}

/** Show the conversation: the session if Rust has it, else the saved one loaded without a process. */
export async function viewPetChat(bornAt: number): Promise<string | null> {
  const pet = runs.get(Math.floor(bornAt))?.pet ?? (await assistantPet(bornAt))
  if (!pet) return null
  const run = runFor(pet)
  if (run.starting) await run.starting
  if (run.inRust) {
    // Reattach: Rust sends everything again.
    await window.api.cliChat.start(run.key, startOpts(pet, run.launch ?? launchFor(pet, await homeDir()), undefined)).catch(() => {
      run.inRust = false
    })
  }
  if (!run.inRust) await ensure(run, true)
  return run.key
}

/** The dialog's composer: the same path as talking to the pet. */
export async function sendFromChat(bornAt: number, text: string): Promise<void> {
  const pet = runs.get(Math.floor(bornAt))?.pet ?? (await assistantPet(bornAt))
  if (pet) await askPet(pet, text)
}

// ---- what the pet sees --------------------------------------------------------------

function statusOf(run: Run): AssistStatus {
  return {
    bornAt: run.bornAt,
    busy: run.live.busy,
    waiting: run.cards.size > 0 || run.blocked,
    parked: run.live.parked,
    preview: run.live.busy ? run.preview : null,
    cards: [...run.cards.values()].map((c) => c.card)
  }
}

function publish(run: Run, force = false): void {
  const s = statusOf(run)
  const sig = JSON.stringify(s)
  if (!force && sig === run.lastStatus) return
  run.lastStatus = sig
  postToPets({ type: 'status', status: s })
}

function note(run: Run, text: string): void {
  postToPets({ type: 'note', bornAt: run.bornAt, text })
}

/** Whether the keeper can see this pet right now (out on screen). */
function petVisible(bornAt: number): boolean {
  return getSettings().petShow && !!lastNest?.shown.some((b) => Math.floor(b) === bornAt)
}

function notify(run: Run, body: string, kind: 'done' | 'failed' | 'waiting'): void {
  try {
    const cfg = getSettings()
    const wanted = kind === 'done' ? cfg.notifyOnDone : kind === 'failed' ? cfg.notifyOnFailure : cfg.notifyOnNeedsInput
    if (!cfg.notifications || !wanted || petVisible(run.bornAt)) return
    window.api.notify.show(run.pet.title, body, { force: true })
  } catch {
    /* notifications unavailable */
  }
}

const labels = (): Labels => ({
  allow: t('clichat.perm.allow'),
  deny: t('clichat.perm.deny'),
  permTitle: (tool) => t('clichat.perm.title', { tool })
})

function addCard(run: Run, e: Extract<CliEvent, { kind: 'permission' | 'question' }>): void {
  const key = run.key
  if (e.kind === 'permission') {
    const l = labels()
    run.cards.set(e.id, {
      card: { id: e.id, kind: 'permission', questions: permissionAsks(e.tool ?? '?', e.input, l) },
      answer: ([c]) => window.api.cliChat.answer(key, e.id, permissionDecision(c ?? '', l))
    })
    return
  }
  const asks = questionAsks(e.input)
  if (!asks.length) return
  run.cards.set(e.id, {
    card: { id: e.id, kind: 'question', questions: asks },
    answer: (choices) => {
      const answers = questionAnswersFrom(e.input, choices)
      if (answers) window.api.cliChat.question(key, e.id, answers)
    }
  })
}

function syncMenu(run: Run): void {
  const id = `menu:${run.key}`
  const menu = run.live.menu
  if (!menu) {
    run.menuSig = null
    run.cards.delete(id)
    return
  }
  const sig = menuId(menu)
  if (sig === run.menuSig) return
  run.menuSig = sig
  run.cards.set(id, {
    card: { id, kind: 'menu', questions: menuAsks(menu) },
    answer: ([c]) => {
      const pick = menuPick(menu, c ?? '')
      if (pick) window.api.cliChat.menu(run.key, pick.index, pick.text)
    }
  })
}

/** The pet's own food: usage records it has not been fed for yet (never a reset's old ones). */
function feed(run: Run, items: CliItem[], reset: boolean): void {
  const fresh: UsageRecord[] = []
  for (const it of items) {
    if (it.kind !== 'usage' || run.usageSeen.has(it.key)) continue
    run.usageSeen.add(it.key)
    // A reset is the whole conversation again (a relaunch, a reattach):
    // what is in it was eaten before, or happened before riven was watching.
    if (!reset) fresh.push(it)
  }
  if (run.usageSeen.size > 4000) run.usageSeen = new Set([...run.usageSeen].slice(-2000))
  const food = turnFood(fresh)
  if (Object.keys(food).length) postToPets({ type: 'fed', bornAt: run.bornAt, food })
}

function onEvent(e: CliEvent): void {
  const bornAt = bornAtOfKey(e.key)
  if (bornAt === null) return
  const run = runs.get(bornAt)
  if (!run) return
  const prevBusy = run.live.busy
  const { live, done } = foldLive(run.live, e, Date.now())
  run.live = live
  switch (e.kind) {
    case 'items':
      feed(run, e.items, e.reset)
      break
    case 'preview':
      run.preview = e.text ? notifyBody(e.text, '') || null : null
      break
    case 'permission':
    case 'question':
      addCard(run, e)
      notify(run, t('clichat.waiting'), 'waiting')
      break
    case 'permissionDone':
      run.cards.delete(e.id)
      break
    case 'state': {
      run.blocked = !!e.blocked && !e.dead
      if (e.sessionId && run.launch) remember(run.bornAt, e.sessionId, run.launch.cwd)
      const hadMenu = !!run.menuSig
      syncMenu(run)
      if (!hadMenu && run.menuSig) notify(run, t('clichat.waiting'), 'waiting')
      if (!e.busy) run.preview = null
      if (e.dead) run.inRust = run.inRust && !!e.parked
      break
    }
    case 'exit':
      run.inRust = false
      run.launch = null
      run.cards.clear()
      run.menuSig = null
      run.preview = null
      break
  }
  if (done) {
    run.preview = null
    for (const [id, c] of [...run.cards]) if (c.card.kind !== 'menu') run.cards.delete(id)
    if (!done.interrupted) {
      postToPets({ type: 'reply', bornAt, text: done.reply, error: done.error })
      notify(run, notifyBody(done.error ?? done.reply, t('chat.done')), done.error ? 'failed' : 'done')
    }
    // Settings changed mid-turn: the new process now, the conversation kept.
    if (run.restartAfterTurn) run.inRust = false
  }
  publish(run, prevBusy !== run.live.busy)
}

// ---- following the nest --------------------------------------------------------------

/**
 * The nest changed (the window showing the pets announces it, and Settings
 * when it edits pet.json itself): stop what was let go or switched off, and
 * bring a running session in line with new settings.
 */
function onNestBrief(b: NestBrief): void {
  lastNest = b
  const present = new Map(b.pets.map((p) => [Math.floor(p.bornAt), p]))
  // A session this window does not know (the page was reloaded while Rust
  // kept it) still goes when its pet is switched off or let go: once, on the
  // change (or on the first nest heard), never on every announcement.
  const prevOn = lastOn
  lastOn = new Map(b.pets.map((p) => [Math.floor(p.bornAt), isAssistant(p.assistant)]))
  for (const [bornAt, on] of lastOn)
    if (!on && prevOn?.get(bornAt) !== false && !runs.has(bornAt)) window.api.cliChat.stop(petChatKey(bornAt))
  for (const bornAt of prevOn?.keys() ?? [])
    if (!lastOn.has(bornAt) && !runs.has(bornAt)) window.api.cliChat.stop(petChatKey(bornAt))
  for (const run of [...runs.values()]) {
    const p = present.get(run.bornAt)
    if (!p) {
      // Let go (or started over under a new birthday): gone for good.
      stopRun(run, true)
      continue
    }
    const pet = petOf(p)
    if (!pet || !isAssistant(pet.assistant)) {
      // Switched off: its process goes (stop is a no-op when there is none).
      if (run.inRust || run.restartAfterTurn) stopRun(run, false)
      continue
    }
    run.pet = pet
    if (!run.inRust || !run.launch) continue
    void homeDir().then((h) => {
      if (!run.inRust || !run.launch) return
      const want = launchFor(pet, h)
      const change = launchChange(run.launch, want)
      if (change === 'flags') reconfigure(run, want)
      else if (change !== 'none') {
        if (run.live.busy || run.cards.size) run.restartAfterTurn = true
        else stopRun(run, false)
      }
    })
  }
  // A conversation of a pet no longer in the nest is not resumed by anyone.
  if (saved) {
    let changed = false
    for (const k of Object.keys(saved))
      if (!present.has(Number(k))) {
        delete saved[k]
        changed = true
      }
    if (changed) writeSaved()
  }
}

/** The pets' messages: questions, answers to cards, stop, the conversation. */
function onPet(m: Parameters<Parameters<typeof serveAssistants>[0]>[0]): void {
  switch (m.type) {
    case 'ask':
      void askPet(m.pet, m.text)
      break
    case 'choose': {
      const run = runs.get(Math.floor(m.bornAt))
      const c = run?.cards.get(m.card)
      if (!run || !c) return
      run.cards.delete(m.card)
      c.answer(m.choices)
      publish(run)
      break
    }
    case 'interrupt': {
      const run = runs.get(Math.floor(m.bornAt))
      if (run?.inRust) window.api.cliChat.interrupt(run.key)
      break
    }
    case 'open':
      openPetChat(m.bornAt)
      break
    case 'hello':
      for (const run of runs.values()) publish(run, true)
      break
  }
}

const LOCK = 'riven-pet-assist-host'

/**
 * Call once at startup in riven's window, next to startCliChats. riven can
 * have more than one app window; only one of them may host the pets'
 * sessions, or a question would start two. A Web Lock elects it: the others
 * wait, and the next one takes over when it goes away.
 */
export function startPetAssistants(): () => void {
  let off: (() => void) | null = null
  let stopped = false
  let release: (() => void) | null = null
  const serve = (): void => {
    const offEvents = window.api.cliChat.onEvent((e) => {
      if (bornAtOfKey(e.key) !== null) onEvent(e as unknown as CliEvent)
    })
    const offPets = serveAssistants(onPet)
    const offNest = onNest(onNestBrief)
    off = () => {
      offEvents()
      offPets()
      offNest()
    }
  }
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks?.request) {
    void locks
      .request(
        LOCK,
        () =>
          new Promise<void>((resolve) => {
            if (stopped) return resolve()
            serve()
            release = resolve
          })
      )
      .catch(() => {
        if (!stopped && !off) serve()
      })
  } else serve()
  return () => {
    stopped = true
    off?.()
    off = null
    release?.()
  }
}
