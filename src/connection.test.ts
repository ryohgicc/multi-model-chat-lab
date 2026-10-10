import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseConnectionResponse } from './connection.ts'

test('connection test combines streamed text and ignores usage events', () => {
  assert.equal(parseConnectionResponse('{"delta":"连接"}\n{"usage":{"input":2}}\n{"delta":"成功"}\n'), '连接成功')
})

test('connection test reports upstream and empty response errors', () => {
  assert.throws(() => parseConnectionResponse('{"error":"无效的 API Key"}\n'), /无效的 API Key/)
  assert.throws(() => parseConnectionResponse('{"usage":{"input":2}}\n'), /没有返回可显示/)
})
