export type ImmersiveItem = { type: 'text' | 'correction' | 'topic_change'; content: string }

export function parseImmersiveReply(raw: string): ImmersiveItem[] | null {
  const source = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```$/, '').trim()
  const wrapped = source.startsWith('[') && source.endsWith(']')
  if (!wrapped && !(source.startsWith('{') && source.endsWith('}'))) return null
  let items: unknown
  try { const parsed = JSON.parse(source); items = Array.isArray(parsed) ? parsed : [parsed] } catch {
    // Some prompts produce unescaped quotation marks inside content. Recover the
    // simple object format without changing the raw reply stored for context.
    const body = wrapped ? source.slice(1, -1) : source
    const objects = body.match(/\{[^{}]*\}/gs)
    if (!objects?.length || body.replace(/\{[^{}]*\}/gs, '').replace(/[\s,]/g, '')) return null
    items = objects.map((object) => {
      const type = object.match(/"type"\s*:\s*"([^"\n]+)"/)?.[1]
      const value = object.match(/"(?:content|opener)"\s*:\s*"([\s\S]*)"\s*\}$/)?.[1]
      return { type, content: value }
    })
  }
  if (!Array.isArray(items) || !items.length) return null
  const parsed: ImmersiveItem[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') return null
    const value = item as Record<string, unknown>
    const type = value.type === 'topic\\_change' ? 'topic_change' : value.type
    if (type !== 'text' && type !== 'correction' && type !== 'topic_change') return null
    const content = type === 'topic_change' ? value.opener ?? value.content : value.content
    if (typeof content !== 'string' || !content.trim()) return null
    parsed.push({ type, content: content.trim() })
  }
  return parsed
}
