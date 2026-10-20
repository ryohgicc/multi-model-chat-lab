import test from 'node:test'
import assert from 'node:assert/strict'
import { persistBrowserValue } from './storage.ts'

test('persists workspace JSON and plain preference values', () => {
  const entries = new Map<string, string>()
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) } }
  assert.equal(persistBrowserValue(storage, 'workspace', { chats: [{ id: 'new' }] }), true)
  assert.deepEqual(JSON.parse(entries.get('workspace')!), { chats: [{ id: 'new' }] })
  assert.equal(persistBrowserValue(storage, 'collapsed', 'false'), true)
  assert.equal(entries.get('collapsed'), 'false')
})

test('quota and permission failures do not crash or clear previous workspace data', () => {
  for (const name of ['QuotaExceededError', 'SecurityError']) {
    const entries = new Map([['workspace', '{"chats":[{"id":"previous"}]}']])
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: () => { throw new DOMException('Storage unavailable', name) } }
    assert.equal(persistBrowserValue(storage, 'workspace', { chats: [{ id: 'new' }] }), false)
    assert.equal(entries.get('workspace'), '{"chats":[{"id":"previous"}]}')
  }
})

test('serialization errors are contained without attempting a write', () => {
  let attempted = false
  const storage = { getItem: () => null, setItem: () => { attempted = true } }
  assert.equal(persistBrowserValue(storage, 'workspace', { value: BigInt(1) }), false)
  assert.equal(attempted, false)
})
