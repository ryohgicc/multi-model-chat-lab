import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildCompressionInput, buildCompressionRequestContent, DEFAULT_COMPRESSION_PROMPT, modelCompressionTurns, parseCompressionResult, shouldAutoCompress } from './compression.ts'

test('compression input takes recent turns once and includes each model reply', () => {
  const turns = [
    { user: 'old', replies: { 0: { modelId: 'a', content: 'old answer', durationMs: 100 } } },
    { user: 'new', replies: { 0: { modelId: 'a', content: 'A', durationMs: 100 }, 1: { modelId: 'b', content: 'B', durationMs: 100 } } },
  ]
  const input = buildCompressionInput(turns, 1, { a: 'Alpha', b: 'Beta' })
  assert.equal(input.includes('old'), false)
  assert.match(input, /用户：new/)
  assert.match(input, /AI（Alpha）：A/)
  assert.match(input, /AI（Beta）：B/)
})
test('compression result requires both structured fields', () => {
  assert.deepEqual(parseCompressionResult('```json\n{"memory":"remember","summary":"recent"}\n```'), { memory: 'remember', summary: 'recent' })
  assert.deepEqual(parseCompressionResult('{"memory":null,"summary":"recap"}'), { memory: null, summary: 'recap' })
  assert.throws(() => parseCompressionResult('{"memory":"only"}'), /summary/)
})
test('one exchange requires one user message and at least one successful AI reply', () => {
  const completed = { user: 'hi', replies: { 0: { modelId: 'a', content: 'hello', durationMs: 100 } } }
  const failed = { user: 'hi', replies: { 0: { modelId: 'a', content: '', error: 'failed', durationMs: 100 } } }
  const pending = { user: 'hi', replies: { 0: { modelId: 'a', content: '' } } }
  assert.equal(shouldAutoCompress([completed, failed], 2, 0), false)
  assert.equal(shouldAutoCompress([completed, pending], 2, 0), false)
  assert.equal(shouldAutoCompress([completed, completed], 2, 0), true)
  assert.equal(shouldAutoCompress([completed, completed], 2, 2), false)
  assert.equal(shouldAutoCompress([completed, completed, completed], 2, 1), true)
  assert.equal(shouldAutoCompress([completed], 0, 0), false)
})

test('default prompt and request content follow the memory format', () => {
  const prompt = JSON.parse(DEFAULT_COMPRESSION_PROMPT)
  assert.equal(prompt.Role, '聊天记忆概括助手')
  assert.equal(prompt.Examples[0].输入.memory, '对方喜欢动漫，最喜欢的食物是披萨。')
  assert.deepEqual(JSON.parse(buildCompressionRequestContent('dialogue', 'old memory')), { content: 'dialogue', memory: 'old memory' })
})
test('each model compression uses only its own replies', () => {
  const turns = [{ user: 'question', replies: { 0: { modelId: 'a', content: 'A', durationMs: 1 }, 1: { modelId: 'b', content: 'B', durationMs: 1 } } }]
  const first = buildCompressionInput(modelCompressionTurns(turns, 0, 'a', 0), 1)
  const second = buildCompressionInput(modelCompressionTurns(turns, 1, 'b', 0), 1)
  assert.match(first, /AI（a）：A/)
  assert.doesNotMatch(first, /B/)
  assert.match(second, /AI（b）：B/)
  assert.doesNotMatch(second, /AI（a）：A/)
})
