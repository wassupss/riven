// AI inline-completion providers. Selecting a provider auto-fills its endpoint +
// default model; `mode` tells the main process which wire protocol to speak.
// FIM (fill-in-the-middle) modes are best for code completion; chat modes work
// everywhere but are a touch slower/looser.
export type AiMode =
  | 'ollama-fim' // Ollama /api/generate with suffix
  | 'openai-completions' // /v1/completions with suffix (DeepSeek beta, etc.)
  | 'openai-chat' // /v1/chat/completions (OpenAI, Groq, OpenRouter, custom…)
  | 'mistral-fim' // Mistral /v1/fim/completions (Codestral)
  | 'anthropic' // /v1/messages
  | 'gemini' // /v1beta …:generateContent

export interface AiProvider {
  id: string
  label: string
  endpoint: string
  mode: AiMode
  keyless?: boolean
  models: string[]
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'ollama',
    label: 'Ollama (로컬 · 무료)',
    endpoint: 'http://localhost:11434',
    mode: 'ollama-fim',
    keyless: true,
    models: ['qwen2.5-coder:1.5b', 'qwen2.5-coder:7b', 'deepseek-coder:6.7b', 'codellama:7b', 'starcoder2:3b']
  },
  {
    id: 'openai',
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    mode: 'openai-chat',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini']
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    endpoint: 'https://api.anthropic.com',
    mode: 'anthropic',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest']
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com',
    mode: 'gemini',
    models: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro']
  },
  {
    id: 'deepseek',
    label: 'DeepSeek (FIM)',
    endpoint: 'https://api.deepseek.com/beta',
    mode: 'openai-completions',
    models: ['deepseek-coder', 'deepseek-chat']
  },
  {
    id: 'mistral',
    label: 'Mistral (Codestral · FIM)',
    endpoint: 'https://api.mistral.ai',
    mode: 'mistral-fim',
    models: ['codestral-latest']
  },
  {
    id: 'groq',
    label: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1',
    mode: 'openai-chat',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-coder-32b']
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    mode: 'openai-chat',
    models: ['qwen/qwen-2.5-coder-32b-instruct', 'anthropic/claude-3.5-haiku', 'deepseek/deepseek-chat']
  },
  {
    id: 'custom',
    label: '커스텀 (OpenAI 호환)',
    endpoint: '',
    mode: 'openai-chat',
    models: []
  }
]

export function getProvider(id: string): AiProvider {
  return AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0]
}
