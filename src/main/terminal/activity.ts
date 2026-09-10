// What an agent in a terminal is doing, as a small state machine.
//
// Two sources feed it. Agent hooks (Claude Code's UserPromptSubmit / Stop /
// Notification) are authoritative: they say exactly when a turn starts, ends,
// and when the agent is waiting on the user. The output heuristic (bytes are
// flowing → working; quiet for a while → idle) is the fallback for agents that
// have no hooks, and it is switched off the moment a hook speaks for a session,
// so a TUI's idle spinner can never be mistaken for work again.
//
// `attention` is a flag on top of idle, with a reason, so the tab can show "done"
// vs "needs you" and the notification can say which.

export type ActivityState = 'working' | 'idle'
export type AttentionReason = 'finished' | 'needs_input' | null

export interface ActivitySnapshot {
  state: ActivityState
  attention: AttentionReason
  // Only a transition the user should hear about sets this; the caller turns it
  // into a notification. Cleared on read.
  changedAt: number
}

export type HookEvent = 'working' | 'idle' | 'needs_input'

export class TerminalActivity {
  private state: ActivityState = 'idle'
  private attention: AttentionReason = null
  private changedAt = 0
  // Once true, the output heuristic is ignored for this terminal.
  hookDriven = false

  constructor(private readonly now: () => number = () => Date.now()) {}

  snapshot(): ActivitySnapshot {
    return { state: this.state, attention: this.attention, changedAt: this.changedAt }
  }

  // Apply a hook event. Returns the attention reason to notify about, if this
  // transition produced one, else null.
  hook(event: HookEvent): AttentionReason {
    this.hookDriven = true
    switch (event) {
      case 'working':
        return this.set('working', null)
      case 'idle':
        // Finishing is only news if it was working; a Stop after Stop is noise.
        return this.set('idle', this.state === 'working' ? 'finished' : this.attention)
      case 'needs_input':
        return this.set('idle', 'needs_input')
    }
  }

  // Output-flow heuristic. No-ops once hooks have been seen.
  heuristic(state: ActivityState): AttentionReason {
    if (this.hookDriven) return null
    if (state === 'working') return this.set('working', null)
    return this.set('idle', this.state === 'working' ? 'finished' : this.attention)
  }

  // The user looked: attention is delivered.
  clearAttention(): boolean {
    if (!this.attention) return false
    this.attention = null
    this.changedAt = this.now()
    return true
  }

  // The agent process is gone: whatever it was doing, it isn't any more.
  reset(): void {
    this.state = 'idle'
    this.attention = null
    this.hookDriven = false
    this.changedAt = this.now()
  }

  // The agent EXITED. Not the same as reset(): a one-shot run (`claude -p`)
  // finishes and quits in the same breath, and wiping its attention here meant a
  // completed run never showed as done — the Stop hook had just set 'finished'
  // and the exit erased it a moment later.
  //
  // State still goes idle, unconditionally: nothing is running, so a terminal
  // can never be left stuck "working" and notifying forever. Only an UNREAD
  // result survives, and only 'finished' — 'needs_input' dies with the process
  // it was waiting for, since there is no longer anything to answer.
  agentGone(): void {
    this.state = 'idle'
    this.hookDriven = false
    if (this.attention === 'needs_input') this.attention = null
    this.changedAt = this.now()
  }

  private set(state: ActivityState, attention: AttentionReason): AttentionReason {
    const wasState = this.state
    const wasAttention = this.attention
    if (state === wasState && attention === wasAttention) return null
    this.state = state
    this.attention = attention
    this.changedAt = this.now()
    // News = attention newly raised (not merely kept).
    return attention && attention !== wasAttention ? attention : null
  }
}

// Map a Claude Code hook name (+ its stdin payload) onto our events. Returns
// null for hooks that carry no activity meaning.
export function claudeHookToEvent(hook: string, _payload?: unknown): HookEvent | null {
  switch (hook) {
    case 'UserPromptSubmit':
      return 'working'
    case 'Stop':
    case 'StopFailure':
    case 'SessionEnd':
      return 'idle'
    case 'Notification': {
      // Claude Code's Notification payload is
      //   { session_id, transcript_path, cwd, hook_event_name, message }
      // — there is no notification_type/matcher/reason field ("matcher" is a
      // hook CONFIG key, not payload). Reading only those meant `kind` was
      // always "" and needs_input never fired: since the first UserPromptSubmit
      // also sets hookDriven (switching the heuristic off), every agent could
      // only ever report "finished".
      //
      // The event exists for exactly one reason — Claude wants the user, either
      // for a permission decision or because it has been idle waiting on input —
      // so the event ITSELF is the signal. Don't gate it on message wording,
      // which is prose and can be reworded or localised at any time.
      return 'needs_input'
    }
    default:
      return null
  }
}
