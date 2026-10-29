import type { ModelRequest } from './automation.ts'

async function sendModelRequest(model: Parameters<ModelRequest>[0], prompt: string, content: string, messages?: Parameters<ModelRequest>[3], signal?: AbortSignal, onUsage?: Parameters<ModelRequest>[5], debug = false) {
  const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...model, stream: false }, messages: messages || [{ role: 'user', content }], systemPrompt: prompt, ...(debug ? { debug: true } : {}) }), signal })
  if (!response.ok) { const body = await response.json(); throw Object.assign(new Error(body.error || `请求失败 (${response.status})`), { status: response.status, debugResponse: body.debugResponse }) }
  const raw = await response.text(); let text = ''
  for (const line of raw.split('\n')) { if (!line.trim()) continue; const event = JSON.parse(line) as { delta?: string; error?: string; debugResponse?: unknown; usage?: { input?: number; output?: number; total?: number } }; if (event.error) throw Object.assign(new Error(event.error), { debugResponse: event.debugResponse }); if (event.usage) onUsage?.(event.usage); text += event.delta || '' }
  return text
}

export const requestModel: ModelRequest = (model, prompt, content, messages, signal, onUsage) => sendModelRequest(model, prompt, content, messages, signal, onUsage)
export const requestModelDebug: ModelRequest = (model, prompt, content, messages, signal, onUsage) => sendModelRequest(model, prompt, content, messages, signal, onUsage, true)
