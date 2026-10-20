type ExportReply = { modelId: string; content: string; error?: string }
type ExportTurn = { user: string; replies: Record<number, ExportReply> }

export function panelConversationMarkdown(
  title: string,
  modelName: string,
  modelId: string,
  panelIndex: number,
  turns: { turn: ExportTurn; turnIndex: number }[],
  welcome?: ExportReply,
): string {
  const sections = [`# ${title}`, `> 模型：${modelName}`]

  if (welcome?.modelId === modelId && (welcome.content || welcome.error)) {
    sections.push(`## 欢迎语\n\n${welcome.error ? `> 请求失败：${welcome.error}` : welcome.content}`)
  }

  for (const { turn, turnIndex } of turns) {
    sections.push(`## 第 ${turnIndex + 1} 轮\n\n### 用户\n\n${turn.user}`)
    const reply = turn.replies[panelIndex]
    if (reply?.modelId === modelId && (reply.content || reply.error)) {
      sections.push(`### ${modelName}\n\n${reply.error ? `> 请求失败：${reply.error}` : reply.content}`)
    }
  }

  return `${sections.join('\n\n')}\n`
}
