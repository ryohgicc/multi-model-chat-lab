import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './worker.js'

function environment() {
  let saved = null
  return {
    PUBLISH_TOKEN: 'private-token',
    SHARED_CONFIG: {
      async get(_key, format) { return format === 'json' && saved ? JSON.parse(saved) : saved },
      async put(_key, value) { saved = value },
    },
    ASSETS: { fetch: async () => new Response('app', { status: 200 }) },
  }
}

const model = { id: 'm', name: 'Model', provider: 'openai', baseUrl: 'https://example.com/v1', modelId: 'model', stream: false }
const settings = { panelCount: 1, immersiveMode: false, promptDraft: '', welcomeInstruction: '', historyLimitDraft: 10, compressionPrompt: '', compressionLimit: 10, compressionInterval: 10, modelIds: ['m', '', '', '', ''] }
const request = (method, body, token) => new Request('https://example.workers.dev/api/models', { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })

test('publishing requires a token and never stores or returns API keys', async () => {
  const env = environment()
  assert.equal((await worker.fetch(request('PUT', { models: [model], settings }), env)).status, 401)
  const result = await worker.fetch(request('PUT', { models: [{ ...model, apiKey: 'secret' }], settings }, 'private-token'), env)
  assert.equal(result.status, 200)
  const published = await (await worker.fetch(request('GET'), env)).json()
  assert.equal(published.shared, true)
  assert.equal(published.models[0].apiKey, undefined)
  assert.equal(env.SHARED_CONFIG.get ? JSON.parse(await env.SHARED_CONFIG.get('workspace')).models[0].apiKey : 'secret', undefined)
  assert.equal((await worker.fetch(request('PUT', { models: [{ ...model, baseUrl: 'http://127.0.0.1:3001' }], settings }, 'private-token'), env)).status, 400)
})

test('chat requires a published model and the visitor key', async () => {
  const env = environment()
  await worker.fetch(request('PUT', { models: [model], settings }, 'private-token'), env)
  const chat = (config) => new Request('https://example.workers.dev/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, messages: [{ role: 'user', content: 'hi' }] }) })
  assert.equal((await worker.fetch(chat({ id: 'unknown', apiKey: 'visitor' }), env)).status, 400)
  assert.equal((await worker.fetch(chat({ id: 'm' }), env)).status, 400)
})

test('chat ignores forged model endpoint and uses only the visitor key', async () => {
  const env = environment()
  await worker.fetch(request('PUT', { models: [model], settings }, 'private-token'), env)
  const original = globalThis.fetch
  let seen
  globalThis.fetch = async (url, options) => {
    seen = { url, options }
    return Response.json({ choices: [{ message: { content: 'hello' } }] })
  }
  try {
    const response = await worker.fetch(new Request('https://example.workers.dev/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { id: 'm', apiKey: 'visitor-key', baseUrl: 'https://attacker.example/v1', modelId: 'forged' }, messages: [{ role: 'user', content: 'hi' }] }) }), env)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /hello/)
    assert.equal(seen.url, 'https://example.com/v1/chat/completions')
    assert.equal(seen.options.headers.Authorization, 'Bearer visitor-key')
    assert.equal(JSON.parse(seen.options.body).model, 'model')
  } finally { globalThis.fetch = original }
})
