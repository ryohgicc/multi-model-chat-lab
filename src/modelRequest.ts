import type { ModelRequest } from './automation.ts'

export const requestModel: ModelRequest = async (model, prompt, content, messages, signal, onUsage) => {
  const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...model, stream: false }, messages: messages || [{ role: 'user', content }], systemPrompt: prompt }), signal })
  if (!response.ok) { const body = await response.json(); throw Object.assign(new Error(body.error || `请求失败 (${response.status})`), { status: response.status }) }
  const raw = await response.text(); let text = ''
  for (const line of raw.split('\n')) { if (!line.trim()) continue; const event = JSON.parse(line) as { delta?: string; error?: string; usage?: { input?: number; output?: number; total?: number } }; if (event.error) throw new Error(event.error); if (event.usage) onUsage?.(event.usage); text += event.delta || '' }
  return text
}
