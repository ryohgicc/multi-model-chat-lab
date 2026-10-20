import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExpressionStorage } from './expressionStorage.ts'

function setup(options: { databaseFailure?: boolean; localFailure?: boolean; delay?: number } = {}) {
  const entries = new Map<string, string>()
  const legacy = new Map<string, string>()
  const database = {
    transaction() {
      const transaction = {
        error: options.databaseFailure ? new DOMException('Database unavailable', 'UnknownError') : null,
        oncomplete: () => {}, onabort: () => {}, onerror: () => {},
        objectStore: () => ({
          put(value: string, key: string) { if (!options.databaseFailure) entries.set(key, value) },
          get(key: string) {
            const request = { result: entries.get(key), onsuccess: () => {} }
            queueMicrotask(() => request.onsuccess())
            return request
          },
        }),
      }
      setTimeout(() => options.databaseFailure ? transaction.onabort() : transaction.oncomplete(), options.delay || 0)
      return transaction
    },
  }
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {
    open() {
      const request = { result: database, onsuccess: () => {} }
      queueMicrotask(() => request.onsuccess())
      return request
    },
  } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => legacy.get(key) ?? null,
    setItem(key: string, value: string) {
      if (options.localFailure) throw new DOMException('Storage full', 'QuotaExceededError')
      legacy.set(key, value)
    },
  } })
  return { entries, legacy }
}

test('独立存储在 localStorage 写满时仍保存，并由新实例恢复草稿和历史', async () => {
  const { legacy } = setup({ localFailure: true })
  legacy.set('unrelated-history', '保留原数据')
  const storage = createExpressionStorage()
  await storage.setItem('draft', '回复 Prompt')
  await storage.setItem('tasks', '历史结果')
  const restored = createExpressionStorage()
  await restored.load(['draft', 'tasks'])
  assert.equal(restored.getItem('draft'), '回复 Prompt')
  assert.equal(restored.getItem('tasks'), '历史结果')
  assert.equal(legacy.get('unrelated-history'), '保留原数据')
})

test('兼容读取旧存储，不删除或覆盖旧数据', async () => {
  const { legacy } = setup()
  legacy.set('draft', '原有表单')
  const storage = createExpressionStorage()
  await storage.load(['draft'])
  assert.equal(storage.getItem('draft'), '原有表单')
  await storage.setItem('draft', '新表单')
  assert.equal(legacy.get('draft'), '原有表单')
})

test('所有存储均失败时返回具体异常，当前输入保留在内存', async () => {
  setup({ localFailure: true, databaseFailure: true })
  const storage = createExpressionStorage()
  await assert.rejects(storage.setItem('draft', '不能丢失'), /UnknownError.*QuotaExceededError/)
  assert.equal(storage.getItem('draft'), '不能丢失')
})

test('连续编辑按顺序提交，以最后输入恢复', async () => {
  setup()
  const storage = createExpressionStorage()
  await Promise.all(['第一个', '第二个', '最终输入'].map((value) => storage.setItem('draft', value)))
  const restored = createExpressionStorage()
  await restored.load(['draft'])
  assert.equal(restored.getItem('draft'), '最终输入')
})

test('异步读取旧数据不会覆盖读取期间的新输入', async () => {
  const { entries } = setup({ delay: 5 })
  entries.set('draft', '旧输入')
  const storage = createExpressionStorage()
  const loading = storage.load(['draft'])
  const saving = storage.setItem('draft', '新输入')
  await Promise.all([loading, saving])
  assert.equal(storage.getItem('draft'), '新输入')
})
