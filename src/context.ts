export type ContextReply = { modelId: string; content: string; error?: string; durationMs?: number }
export type ContextTurn = { user: string; replies: Partial<Record<number, ContextReply>> }

export function buildContext(turns: ContextTurn[], slotIndex: number, modelId: string, startedAt: number, currentTurnIndex: number, historyLimit: number, welcomeReply = '') {
  const count = Number.isFinite(historyLimit) ? Math.max(0, Math.floor(historyLimit)) : 0
  const first = Math.max(startedAt, currentTurnIndex - count)
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (count > 0 && first === startedAt && welcomeReply) messages.push({ role: 'assistant', content: welcomeReply })
  for (let i = first; i <= currentTurnIndex; i++) {
    const turn = turns[i]
    if (!turn) continue
    messages.push({ role: 'user', content: turn.user })
    if (i < currentTurnIndex) {
      const reply = turn.replies[slotIndex]
      if (reply?.modelId === modelId && reply.content && !reply.error) messages.push({ role: 'assistant', content: reply.content })
    }
  }
  return messages
}

export type PromptVariable = 'userInputPrevious' | 'aiOutputPrevious' | 'userInputlatest' | 'memory' | 'summary' | 'currentTime'

export function promptVariableValues(context: Array<{ role: 'user' | 'assistant'; content: string }>, latestUser: string, memory = '', summary = '', currentTime = new Date().toISOString()): Record<PromptVariable, string> {
  const userMessages = context.filter((message) => message.role === 'user')
  const previousUser = userMessages.at(-2)?.content || ''
  const previousAssistant = [...context].reverse().find((message) => message.role === 'assistant')?.content || ''
  return { userInputPrevious: previousUser, aiOutputPrevious: previousAssistant, userInputlatest: latestUser, memory, summary, currentTime }
}

export function renderSystemPrompt(template: string, context: Array<{ role: 'user' | 'assistant'; content: string }>, latestUser: string, memory = '', summary = '', currentTime = new Date().toISOString()) {
  const values = promptVariableValues(context, latestUser, memory, summary, currentTime)
  return (Object.entries(values) as Array<[PromptVariable, string]>).reduce((result, [name, value]) => result.replaceAll('${' + name + '}', value), template)
}
