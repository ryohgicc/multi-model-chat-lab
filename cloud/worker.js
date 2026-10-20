import { buildRequest, extractDelta, extractFinal, extractUsage } from '../server/protocols.js'

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const providers = new Set(['openai', 'anthropic', 'gemini', 'custom', 'jev'])

function validWorkspace(models, settings) {
  if (!Array.isArray(models) || models.length > 100 || models.some((model) =>
    !model || typeof model.id !== 'string' || !model.id || typeof model.name !== 'string' || !model.name ||
    !providers.has(model.provider) || typeof model.baseUrl !== 'string' || !/^https:\/\//i.test(model.baseUrl) ||
    typeof model.modelId !== 'string' || !model.modelId || typeof model.stream !== 'boolean' ||
    [model.inputPerMillion, model.outputPerMillion].some((price) => price !== undefined && (!Number.isFinite(price) || price < 0))
  ) || new Set(models.map((model) => model.id)).size !== models.length) return false
  const ids = (value) => Array.isArray(value) && value.length === 5 && value.every((id) => typeof id === 'string' && (!id || models.some((model) => model.id === id)))
  const template = (value) => value && typeof value.sourceId === 'string' && !!value.sourceId &&
    typeof value.title === 'string' && value.title.length <= 200 &&
    typeof value.promptDraft === 'string' && value.promptDraft.length <= 100000 &&
    typeof value.welcomeInstruction === 'string' && value.welcomeInstruction.length <= 100000 &&
    Number.isInteger(value.historyLimitDraft) && value.historyLimitDraft >= 0 && value.historyLimitDraft <= 100 &&
    typeof value.compressionPrompt === 'string' && value.compressionPrompt.length <= 100000 &&
    Number.isInteger(value.compressionLimit) && value.compressionLimit >= 1 && value.compressionLimit <= 100 &&
    Number.isInteger(value.compressionInterval) && value.compressionInterval >= 0 && value.compressionInterval <= 100 && ids(value.modelIds)
  return !!settings && Number.isInteger(settings.panelCount) && settings.panelCount >= 1 && settings.panelCount <= 5 &&
    typeof settings.immersiveMode === 'boolean' && typeof settings.promptDraft === 'string' && settings.promptDraft.length <= 100000 &&
    typeof settings.welcomeInstruction === 'string' && settings.welcomeInstruction.length <= 100000 &&
    Number.isInteger(settings.historyLimitDraft) && settings.historyLimitDraft >= 0 && settings.historyLimitDraft <= 100 &&
    typeof settings.compressionPrompt === 'string' && settings.compressionPrompt.length <= 100000 &&
    Number.isInteger(settings.compressionLimit) && settings.compressionLimit >= 1 && settings.compressionLimit <= 100 &&
    Number.isInteger(settings.compressionInterval) && settings.compressionInterval >= 0 && settings.compressionInterval <= 100 &&
    ids(settings.modelIds) &&
    (settings.reviewModelId === undefined || typeof settings.reviewModelId === 'string' && (!settings.reviewModelId || models.some((model) => model.id === settings.reviewModelId))) &&
    (settings.reviewPrompt === undefined || typeof settings.reviewPrompt === 'string' && settings.reviewPrompt.length <= 100000) &&
    (settings.chatTemplates === undefined || Array.isArray(settings.chatTemplates) && settings.chatTemplates.length <= 200 && settings.chatTemplates.every(template) && new Set(settings.chatTemplates.map((item) => item.sourceId)).size === settings.chatTemplates.length) &&
    (settings.activeSourceId === undefined || typeof settings.activeSourceId === 'string' && (!settings.activeSourceId || settings.chatTemplates?.some((item) => item.sourceId === settings.activeSourceId)))
}

async function parseBody(request) {
  if (Number(request.headers.get('content-length') || 0) > 1024 * 1024) throw new Error('请求内容过大。')
  const body = await request.text()
  if (body.length > 1024 * 1024) throw new Error('请求内容过大。')
  return JSON.parse(body)
}

async function chat(request, env) {
  let data
  try { data = await parseBody(request) } catch { return json({ error: '请求参数无效。' }, 400) }
  const workspace = await env.SHARED_CONFIG.get('workspace', 'json') || { models: [] }
  const published = workspace.models.find((model) => model.id === data?.config?.id)
  if (!published) return json({ error: '模型未发布。' }, 400)
  const config = { ...published, apiKey: data.config?.apiKey, stream: data.config?.stream === false ? false : published.stream }
  const messages = data.messages
  if (typeof config.apiKey !== 'string' || !config.apiKey || !Array.isArray(messages) || messages.length > 100 || messages.some((message) => !['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string' || message.content.length > 100000)) return json({ error: '请求参数无效，请检查模型配置。' }, 400)
  let upstreamRequest
  try { upstreamRequest = buildRequest(config, messages, String(data.systemPrompt || '').slice(0, 100000)) } catch (error) { return json({ error: error.message }, 400) }
  try {
    const upstream = await fetch(upstreamRequest.url, { method: 'POST', headers: upstreamRequest.headers, body: JSON.stringify(upstreamRequest.body), signal: request.signal })
    if (!upstream.ok) {
      const raw = (await upstream.text()).slice(0, 1000)
      let message = raw
      try { const parsed = JSON.parse(raw); message = parsed.error?.message || parsed.message || raw } catch { /* text response */ }
      return json({ error: message || `接口错误 ${upstream.status}` }, upstream.status)
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        try {
          if (!config.stream || config.provider === 'jev') {
            const result = await upstream.json()
            const content = extractFinal(config.provider, result)
            if (!content) throw new Error('接口没有返回可显示的文本。')
            emit({ delta: content })
            const usage = extractUsage(config.provider, result)
            if (usage) emit({ usage })
          } else {
            const reader = upstream.body?.getReader()
            if (!reader) throw new Error('接口没有返回内容。')
            const decoder = new TextDecoder()
            let buffer = '', size = 0, textLength = 0
            const line = (value) => {
              if (!value.startsWith('data:')) return
              const payload = value.slice(5).trim()
              if (!payload || payload === '[DONE]') return
              let result
              try { result = JSON.parse(payload) } catch { return }
              const usage = extractUsage(config.provider, result)
              if (usage) emit({ usage })
              const delta = extractDelta(config.provider, result)
              if (delta) { textLength += delta.length; if (textLength > 1000000) throw new Error('模型回复超过长度限制。'); emit({ delta }) }
            }
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              size += value.byteLength
              if (size > 5000000) throw new Error('接口响应超过大小限制。')
              buffer += decoder.decode(value, { stream: true })
              const lines = buffer.split(/\r?\n/)
              buffer = lines.pop() || ''
              for (const item of lines) line(item)
            }
            if (buffer) line(buffer)
            if (!textLength) emit({ error: '接口没有返回可显示的文本。' })
          }
        } catch (error) { emit({ error: error.message || '请求失败。' }) }
        controller.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } })
  } catch (error) { return json({ error: error.message || '请求失败。' }, 502) }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/models' && request.method === 'GET') {
      const workspace = await env.SHARED_CONFIG.get('workspace', 'json') || { models: [], settings: null }
      return json({ shared: true, models: workspace.models, settings: workspace.settings || null })
    }
    if (url.pathname === '/api/models' && request.method === 'PUT') {
      if (!env.PUBLISH_TOKEN || request.headers.get('authorization') !== `Bearer ${env.PUBLISH_TOKEN}`) return json({ error: '无发布权限。' }, 401)
      let body
      try { body = await parseBody(request) } catch { return json({ error: '请求参数无效。' }, 400) }
      if (!validWorkspace(body.models, body.settings)) return json({ error: '工作台配置无效。' }, 400)
      const models = body.models.map(({ apiKey: _apiKey, ...model }) => { void _apiKey; return model })
      await env.SHARED_CONFIG.put('workspace', JSON.stringify({ models, settings: body.settings }))
      return json({ models })
    }
    if (url.pathname === '/api/chat' && request.method === 'POST') return chat(request, env)
    if (url.pathname.startsWith('/api/')) return json({ error: '接口不存在。' }, 404)
    return env.ASSETS.fetch(request)
  },
}
