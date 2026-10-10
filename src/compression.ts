import type { ContextTurn } from './context'

export const DEFAULT_COMPRESSION_PROMPT = JSON.stringify({
  Role: '聊天记忆概括助手',
  Background: '你负责整合两人的旧总结与新对话，提炼可供后续聊天使用的重要记忆。',
  Goals: [
    '将近期聊天记录融合为不超过400字的连贯摘要，尽可能精简。',
    '保留双方身份、重要信息、偏好习惯、共同经历，以及关键时间、事件顺序、关系情绪变化和决策。',
  ],
  Rules: [
    '客观、中立，不编造信息；去除重复、寒暄和无关细节。',
    '信息明确更新时以最新内容为准；无法确认的矛盾保留不确定性。',
    '有值得记住的新信息或重要共同记忆时，memory增加内容，否则输出null。',
    'memory只包含合并摘要，不加解释或评价，总长度不超过400字。',
    '只输出合法 JSON 对象，包含 summary 字符串和 memory 字符串或 null；不要输出 Markdown。',
  ],
  Skills: ['识别重要信息，压缩并整合上下文，准确区分双方身份与时间线。'],
  Examples: [{
    输入: { content: '近 50 条上下文', memory: '对方喜欢动漫，最喜欢的食物是披萨。' },
    输出: { summary: '对方喜欢动漫，最喜欢的食物是披萨；双方约好周六一起看动漫。', memory: '对方喜欢动漫，最喜欢的食物是披萨；双方约好周六一起看动漫。' },
  }],
}, null, 2)

export const LEGACY_DEFAULT_COMPRESSION_PROMPT = '请压缩以下对话上下文，输出严格 JSON 对象，且只包含两个字符串字段：memory 和 summary。memory 保留长期有效的用户偏好、事实、约束和未完成事项；summary 概述近期对话的重点与进展。不要编造信息。'

type CompressionTurn = ContextTurn

export function isCompletedExchange(turn: CompressionTurn) {
  const replies = Object.values(turn.replies)
  return replies.length > 0 && replies.every((reply) => reply?.durationMs !== undefined) && replies.some((reply) => reply && !reply.error && !!reply.content)
}

export function shouldAutoCompress(turns: CompressionTurn[], interval: number, lastAttemptedTurn: number) {
  if (!Number.isInteger(interval) || interval <= 0 || !turns.length) return false
  const latestReplies = Object.values(turns.at(-1)!.replies)
  if (!latestReplies.length || latestReplies.some((reply) => reply?.durationMs === undefined)) return false
  return turns.slice(lastAttemptedTurn).filter(isCompletedExchange).length >= interval
}

export function buildCompressionInput(turns: CompressionTurn[], limit: number, modelNames: Record<string, string> = {}) {
  const count = Number.isInteger(limit) ? Math.max(0, Math.min(100, limit)) : 0
  const selected = count === 0 ? [] : turns.filter(isCompletedExchange).slice(-count)
  return selected.map((turn, index) => {
    const replies = Object.values(turn.replies)
      .filter((reply) => reply && reply.content && !reply.error)
      .map((reply) => `AI（${modelNames[reply!.modelId] || reply!.modelId}）：${reply!.content}`)
    return [`第 ${index + 1} 轮`, `用户：${turn.user}`, ...replies].join('\n')
  }).join('\n\n')
}

export function modelCompressionTurns(turns: CompressionTurn[], slotIndex: number, modelId: string, startedAt: number): CompressionTurn[] {
  return turns.slice(startedAt).map((turn) => ({
    user: turn.user,
    replies: turn.replies[slotIndex]?.modelId === modelId ? { [slotIndex]: turn.replies[slotIndex] } : {},
  }))
}

export function buildCompressionRequestContent(content: string, memory: string) {
  return JSON.stringify({ content, memory })
}

export function parseCompressionResult(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let value: unknown
  try { value = JSON.parse(cleaned) } catch { throw new Error('压缩模型没有返回有效 JSON，请检查压缩 Prompt。') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('压缩结果需要是包含 memory 和 summary 的 JSON 对象。')
  const result = value as Record<string, unknown>
  if ((typeof result.memory !== 'string' && result.memory !== null) || typeof result.summary !== 'string') throw new Error('压缩结果必须包含字符串类型的 summary，以及字符串或 null 类型的 memory。')
  return { memory: result.memory === null ? null : result.memory.trim(), summary: result.summary.trim() }
}
