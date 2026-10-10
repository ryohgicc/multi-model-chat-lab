import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { conversationCost, formatUsd, replyCosts } from './pricing.ts'

test('computes input, output and total costs from per-million USD prices', () => {
  assert.deepEqual(replyCosts({ input: 2000, output: 500 }, { inputPerMillion: 0.5, outputPerMillion: 2 }), { input: 0.001, output: 0.001, total: 0.002 })
})

test('keeps missing usage or prices unknown instead of treating them as free', () => {
  assert.deepEqual(replyCosts({ output: 500 }, { outputPerMillion: 2 }), { input: null, output: 0.001, total: null })
  assert.deepEqual(conversationCost([{ attempted: true, usage: { input: 1000, output: 1000 }, pricing: { inputPerMillion: 1, outputPerMillion: 1 } }, { attempted: true, usage: { output: 5 }, pricing: { outputPerMillion: 2 } }]), { total: 0.002, incomplete: true })
})

test('formats very small USD amounts without rounding them to zero', () => {
  assert.equal(formatUsd(0.0000002), '$0.00000020')
})
