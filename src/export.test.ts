import assert from 'node:assert/strict'
import test from 'node:test'
import { panelConversationMarkdown } from './export.ts'

test('exports only the selected panel with markdown content and original turn numbers', () => {
  const turns: { turnIndex: number; turn: { user: string; replies: Record<number, { modelId: string; content: string }> } }[] = [
    { turnIndex: 2, turn: { user: '**你好**', replies: { 0: { modelId: 'a', content: '## 回答\n\n- 一' }, 1: { modelId: 'b', content: '其他回复' } } } },
    { turnIndex: 3, turn: { user: '再问', replies: { 0: { modelId: 'old', content: '旧模型回复' } } } },
  ]
  const markdown = panelConversationMarkdown('对话', '模型 A', 'a', 0, turns, { modelId: 'a', content: '欢迎' })
  assert.match(markdown, /^# 对话\n\n> 模型：模型 A\n\n## 欢迎语\n\n欢迎/)
  assert.match(markdown, /## 第 3 轮\n\n### 用户\n\n\*\*你好\*\*\n\n### 模型 A\n\n## 回答\n\n- 一/)
  assert.match(markdown, /## 第 4 轮\n\n### 用户\n\n再问/)
  assert.doesNotMatch(markdown, /其他回复|旧模型回复/)
})
