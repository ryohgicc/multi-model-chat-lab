import test from 'node:test'
import assert from 'node:assert/strict'
import { parseImmersiveReply } from './immersive.ts'

test('splits a structured reply into ordered dialogue items', () => {
  assert.deepEqual(parseImmersiveReply('[{"type":"correction","content":"Use went."},{"type":"text","content":"What happened next?"},{"type":"topic_change","opener":"By the way, how was your weekend?"}]'), [
    { type: 'correction', content: 'Use went.' },
    { type: 'text', content: 'What happened next?' },
    { type: 'topic_change', content: 'By the way, how was your weekend?' },
  ])
})

test('shows a single object without requiring array brackets', () => {
  assert.deepEqual(parseImmersiveReply('{"type":"text","content":"Hey Joey, have you seen any good movies lately?"}'), [
    { type: 'text', content: 'Hey Joey, have you seen any good movies lately?' },
  ])
})

test('accepts fenced JSON and quotation marks in the prompt examples', () => {
  assert.deepEqual(parseImmersiveReply('```json\n[{"type": "correction", "content": "Try saying: "I went to the park yesterday." 注意过去时态。"}]\n```'), [
    { type: 'correction', content: 'Try saying: "I went to the park yesterday." 注意过去时态。' },
  ])
})

test('keeps unstructured or incomplete replies as raw text', () => {
  assert.equal(parseImmersiveReply('Hello there!'), null)
  assert.equal(parseImmersiveReply('[{"type":"text","content":"Still streaming'), null)
  assert.equal(parseImmersiveReply('[{"type":"text"}]'), null)
})
