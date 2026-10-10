import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRequest, extractDelta, extractFinal, extractUsage } from './protocols.js'
const messages = [{ role: 'user', content: '你好' }]
const config = { provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'secret', modelId: 'model-a', stream: true }
test('OpenAI compatible request includes system and context', () => {
  const request = buildRequest(config, messages, '指令')
  assert.equal(request.url, 'https://api.example.com/v1/chat/completions')
  assert.deepEqual(request.body.messages, [{ role: 'system', content: '指令' }, ...messages])
  assert.deepEqual(request.body.stream_options, { include_usage: true })
})
test('Anthropic request uses messages endpoint and separate system', () => {
  const request = buildRequest({ ...config, provider: 'anthropic' }, messages, '指令')
  assert.equal(request.url, 'https://api.example.com/v1/messages')
  assert.equal(request.body.system, '指令')
  assert.equal(request.headers['x-api-key'], 'secret')
})
test('Custom endpoint is used exactly', () => {
  const request = buildRequest({ ...config, provider: 'custom', baseUrl: 'https://api.example.com/direct' }, messages, '')
  assert.equal(request.url, 'https://api.example.com/direct')
})
test('Gemini request maps system instruction and conversation roles', () => {
  const request = buildRequest({ ...config, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', modelId: 'models/gemini-2.5-flash' }, [...messages, { role: 'assistant', content: '你好！' }], '指令')
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
  assert.equal(request.headers['x-goog-api-key'], 'secret')
  assert.deepEqual(request.body.systemInstruction, { parts: [{ text: '指令' }] })
  assert.deepEqual(request.body.contents, [{ role: 'user', parts: [{ text: '你好' }] }, { role: 'model', parts: [{ text: '你好！' }] }])
  assert.equal(buildRequest({ ...config, provider: 'gemini', stream: false }, messages, '').url, 'https://api.example.com/v1/models/model-a:generateContent')
})
test('Response parsers cover streaming and complete responses', () => {
  assert.equal(extractDelta('anthropic', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'hi')
  assert.equal(extractDelta('openai', { choices: [{ delta: { content: 'hi' } }] }), 'hi')
  assert.equal(extractFinal('anthropic', { content: [{ type: 'text', text: 'hi' }] }), 'hi')
  assert.equal(extractFinal('openai', { choices: [{ message: { content: 'hi' } }] }), 'hi')
  const gemini = { candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }, { text: 'hi' }, { text: ' there' }] } }] }
  assert.equal(extractDelta('gemini', gemini), 'hi there')
  assert.equal(extractFinal('gemini', gemini), 'hi there')
})
test('Usage parser accepts OpenAI final or stream usage and Anthropic usage', () => {
  assert.deepEqual(extractUsage('openai', { usage: { prompt_tokens: 12, completion_tokens: 8 } }), { input: 12, output: 8 })
  assert.deepEqual(extractUsage('anthropic', { type: 'message_start', usage: { input_tokens: 10 } }), { input: 10 })
  assert.deepEqual(extractUsage('anthropic', { type: 'message_start', message: { usage: { input_tokens: 10 } } }), { input: 10 })
  assert.deepEqual(extractUsage('anthropic', { type: 'message_delta', usage: { output_tokens: 7 } }), { output: 7 })
  assert.deepEqual(extractUsage('openai', { usage: { total_tokens: 19 } }), { total: 19 })
  assert.deepEqual(extractUsage('gemini', { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 } }), { input: 12, output: 8, total: 20 })
  assert.equal(extractUsage('custom', { choices: [] }), null)
})
