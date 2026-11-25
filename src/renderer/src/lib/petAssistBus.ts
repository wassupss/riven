import type { AssistantConfig } from './petAssistant'

// ---------------------------------------------------------------------------
// The pet and its assistant session, across windows. The sessions run in
// riven's main window (state/petAssistants.ts, the host), next to every other
// CLI chat; the pet may be in its own window. They talk over a
// BroadcastChannel, which reaches every other channel object of the same name
// (in the same window too, so a pet inside the app hears it as well), like
// lib/petCommand.
//
// Dependency-free on purpose: the pet window imports this, and pulling the
// host (askUser, roster, sessions) into the chunk shared with the pet entry
// breaks the load order (see state/cliTurnBus.ts).
// ---------------------------------------------------------------------------

const NAME = 'riven-pet-assist'

/** What the host needs to know about a pet to run it as an assistant. */
export interface AssistPet {
  bornAt: number
  /** Its name, or its species when it has none. */
  title: string
  /** Its species in the keeper's language. */
  species: string
  assistant: AssistantConfig
}

/** One question of a card waiting on the person, with its choices. */
export interface AssistQuestion {
  question: string
  options: string[]
}

/** A permission request, an AskUserQuestion or a menu on screen. */
export interface AssistCard {
  id: string
  kind: 'permission' | 'question' | 'menu'
  questions: AssistQuestion[]
}

export interface AssistStatus {
  bornAt: number
  busy: boolean
  /** A card waits on the person. */
  waiting: boolean
  /** Its process is stopped for being idle (the next message resumes it). */
  parked: boolean
  /** The reply as it streams (best effort), while busy. */
  preview: string | null
  cards: AssistCard[]
}

type Msg =
  // pet -> host
  | { type: 'ask'; pet: AssistPet; text: string }
  | { type: 'choose'; bornAt: number; card: string; choices: string[] }
  | { type: 'interrupt'; bornAt: number }
  | { type: 'open'; bornAt: number }
  | { type: 'toggle'; bornAt: number }
  | { type: 'view'; bornAt: number }
  | { type: 'newChat'; bornAt: number }
  | { type: 'resumeChat'; bornAt: number; sessionId: string }
  | { type: 'hello' }
  // host -> pet
  | { type: 'status'; status: AssistStatus }
  | { type: 'reply'; bornAt: number; text: string; error: string | null }
  | { type: 'fed'; bornAt: number; food: Record<string, number> }
  | { type: 'note'; bornAt: number; text: string }

export type PetSideMsg = Extract<Msg, { type: 'status' | 'reply' | 'fed' | 'note' }>
export type HostSideMsg = Extract<
  Msg,
  { type: 'ask' | 'choose' | 'interrupt' | 'open' | 'hello' | 'view' | 'newChat' | 'resumeChat' }
>

const has = (): boolean => typeof BroadcastChannel !== 'undefined'

let out: BroadcastChannel | null = null
function post(m: Msg): void {
  if (!has()) return
  out ??= new BroadcastChannel(NAME)
  out.postMessage(m)
}

// ---- the pet's side ----

export function askAssistant(pet: AssistPet, text: string): void {
  post({ type: 'ask', pet, text })
}
export function chooseAssistant(bornAt: number, card: string, choices: string[]): void {
  post({ type: 'choose', bornAt, card, choices })
}
export function interruptAssistant(bornAt: number): void {
  post({ type: 'interrupt', bornAt })
}
/**
 * Open or close a pet's conversation, wherever its pet is: the window that hosts
 * the pet (riven's, or the pet's own) answers; the others ignore it.
 */
export function requestAssistantChat(bornAt: number): void {
  post({ type: 'toggle', bornAt })
}
/** Show a pet's conversation (the host attaches it, sending its events to every window). */
export function viewAssistant(bornAt: number): void {
  post({ type: 'view', bornAt })
}
/** Start a new conversation: the current one is set aside in the history. */
export function newAssistantChat(bornAt: number): void {
  post({ type: 'newChat', bornAt })
}
/** Pick a set-aside conversation up again. */
export function resumeAssistantChat(bornAt: number, sessionId: string): void {
  post({ type: 'resumeChat', bornAt, sessionId })
}
/** Ask the host for every assistant's status (a pet window that just opened). */
export function helloAssistants(): void {
  post({ type: 'hello' })
}

/** Follow the assistants. Returns the unsubscribe. */
export function onAssistants(cb: (m: PetSideMsg) => void): () => void {
  if (!has()) return () => {}
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data
    if (m && (m.type === 'status' || m.type === 'reply' || m.type === 'fed' || m.type === 'note')) cb(m)
  }
  return () => ch.close()
}

// ---- the host's side ----

export function postToPets(m: PetSideMsg): void {
  post(m)
}

/** Where the sessions run: hear the pets. Returns the unsubscribe. */
export function serveAssistants(cb: (m: HostSideMsg) => void): () => void {
  if (!has()) return () => {}
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data
    if (
      m &&
      (m.type === 'ask' ||
        m.type === 'choose' ||
        m.type === 'interrupt' ||
        m.type === 'open' ||
        m.type === 'hello' ||
        m.type === 'view' ||
        m.type === 'newChat' ||
        m.type === 'resumeChat')
    )
      cb(m)
  }
  return () => ch.close()
}

/** Hear requests to open or close a conversation. Returns the unsubscribe. */
export function onAssistantChatRequest(cb: (bornAt: number) => void): () => void {
  if (!has()) return () => {}
  const ch = new BroadcastChannel(NAME)
  ch.onmessage = (e: MessageEvent<Msg>) => {
    const m = e.data
    if (m && m.type === 'toggle') cb(m.bornAt)
  }
  return () => ch.close()
}

/** Stop posting (tests, and a window going away). */
export function closeAssistBus(): void {
  out?.close()
  out = null
}
