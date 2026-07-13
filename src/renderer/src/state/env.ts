// Cached environment defaults (resolved once at startup) so both UI components
// and keybinding actions can create claude panes without re-fetching.
let claudePath: string | null = null

export async function loadEnv(): Promise<void> {
  const d = await window.api.env.defaults()
  claudePath = d.claudePath
}

export function getClaudePath(): string | null {
  return claudePath
}
