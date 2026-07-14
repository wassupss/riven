import { ipcMain } from 'electron'

// Inline-completion backend. Runs the HTTP call in main (no renderer CORS). The
// renderer passes a `mode` (wire protocol) so we don't duplicate the provider
// registry here. Returns '' on any failure → the editor silently shows nothing.
type AiMode =
  | 'ollama-fim'
  | 'openai-completions'
  | 'openai-chat'
  | 'mistral-fim'
  | 'anthropic'
  | 'gemini'

interface CompleteOpts {
  mode: AiMode
  endpoint: string
  model: string
  apiKey?: string
}

// Chat/instruct models wrap code in prose or fences — strip to the raw insertion.
function cleanInsertion(text: string): string {
  let t = text
  const fence = t.match(/```[a-zA-Z]*\n([\s\S]*?)```/)
  if (fence) t = fence[1]
  return t.replace(/\s+$/, '')
}

const CHAT_SYS =
  'You are a code autocomplete engine. Given the code before and after the cursor, output ONLY the code that should be inserted at the cursor position — no explanation, no markdown fences.'
function chatUser(prefix: string, suffix: string): string {
  return `Complete the code at the cursor.\n<before>\n${prefix}\n</before>\n<after>\n${suffix}\n</after>`
}

export function registerAiHandlers(): void {
  ipcMain.handle(
    'ai:complete',
    async (_e, prefix: string, suffix: string, opts: CompleteOpts): Promise<string> => {
      const endpoint = (opts.endpoint || '').replace(/\/+$/, '')
      const model = opts.model
      const key = opts.apiKey || ''
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const json = { 'Content-Type': 'application/json' }
      try {
        switch (opts.mode) {
          case 'ollama-fim': {
            const r = await fetch(`${endpoint || 'http://localhost:11434'}/api/generate`, {
              method: 'POST',
              headers: json,
              signal: ctrl.signal,
              body: JSON.stringify({
                model,
                prompt: prefix,
                suffix,
                stream: false,
                options: { temperature: 0.1, num_predict: 128, stop: ['\n\n', '```'] }
              })
            })
            if (!r.ok) return ''
            return cleanInsertion(((await r.json()) as { response?: string }).response ?? '')
          }
          case 'openai-completions': {
            const r = await fetch(`${endpoint}/completions`, {
              method: 'POST',
              headers: { ...json, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
              signal: ctrl.signal,
              body: JSON.stringify({
                model,
                prompt: prefix,
                suffix,
                max_tokens: 128,
                temperature: 0.1,
                stop: ['\n\n', '```']
              })
            })
            if (!r.ok) return ''
            return cleanInsertion(
              ((await r.json()) as { choices?: Array<{ text?: string }> }).choices?.[0]?.text ?? ''
            )
          }
          case 'mistral-fim': {
            const r = await fetch(`${endpoint}/v1/fim/completions`, {
              method: 'POST',
              headers: { ...json, Authorization: `Bearer ${key}` },
              signal: ctrl.signal,
              body: JSON.stringify({ model, prompt: prefix, suffix, max_tokens: 128, temperature: 0.1 })
            })
            if (!r.ok) return ''
            return cleanInsertion(
              ((await r.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
                ?.message?.content ?? ''
            )
          }
          case 'anthropic': {
            const r = await fetch(`${endpoint}/v1/messages`, {
              method: 'POST',
              headers: { ...json, 'x-api-key': key, 'anthropic-version': '2023-06-01' },
              signal: ctrl.signal,
              body: JSON.stringify({
                model,
                max_tokens: 128,
                system: CHAT_SYS,
                messages: [{ role: 'user', content: chatUser(prefix, suffix) }]
              })
            })
            if (!r.ok) return ''
            return cleanInsertion(
              ((await r.json()) as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''
            )
          }
          case 'gemini': {
            const r = await fetch(
              `${endpoint}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
              {
                method: 'POST',
                headers: json,
                signal: ctrl.signal,
                body: JSON.stringify({
                  systemInstruction: { parts: [{ text: CHAT_SYS }] },
                  contents: [{ parts: [{ text: chatUser(prefix, suffix) }] }],
                  generationConfig: { maxOutputTokens: 128, temperature: 0.1 }
                })
              }
            )
            if (!r.ok) return ''
            const d = (await r.json()) as {
              candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
            }
            return cleanInsertion(d.candidates?.[0]?.content?.parts?.[0]?.text ?? '')
          }
          case 'openai-chat':
          default: {
            const r = await fetch(`${endpoint}/chat/completions`, {
              method: 'POST',
              headers: { ...json, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
              signal: ctrl.signal,
              body: JSON.stringify({
                model,
                max_tokens: 128,
                temperature: 0.1,
                messages: [
                  { role: 'system', content: CHAT_SYS },
                  { role: 'user', content: chatUser(prefix, suffix) }
                ]
              })
            })
            if (!r.ok) return ''
            return cleanInsertion(
              ((await r.json()) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
                ?.message?.content ?? ''
            )
          }
        }
      } catch {
        return ''
      } finally {
        clearTimeout(timer)
      }
    }
  )
}
