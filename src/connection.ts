export function parseConnectionResponse(body: string) {
  let reply = ''
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    let event: { delta?: string; error?: string }
    try { event = JSON.parse(line) } catch { throw new Error('接口返回了无效的测试结果。') }
    if (event.error) throw new Error(event.error)
    if (typeof event.delta === 'string') reply += event.delta
  }
  if (!reply.trim()) throw new Error('接口没有返回可显示的文本。')
  return reply.trim()
}
