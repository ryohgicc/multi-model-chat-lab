import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProxyAgent } from 'undici'
import { buildRequest, extractDelta, extractFinal, extractUsage } from './protocols.js'
import { publicModels, readSharedWorkspace, saveSharedWorkspace } from './shared-models.js'

const app = express()
app.use(express.json({ limit: '1mb' }))
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT || 3001)
const lanMode = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1'
const isLocalRequest = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
app.get('/api/models', (_req, res) => {
  const workspace = readSharedWorkspace()
  res.json({ shared: lanMode, models: lanMode ? publicModels(workspace.models) : [], settings: lanMode ? workspace.settings : null })
})
app.put('/api/models', async (req, res) => {
  const origin = req.get('origin')
  const localOrigins = ['localhost', '127.0.0.1'].flatMap((name) => [`http://${name}:${port}`, `http://${name}:5173`])
  if (!isLocalRequest(req) || !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname) || !localOrigins.includes(origin)) return res.status(403).json({ error: '只能从主机的 localhost 页面发布模型配置。' })
  try {
    saveSharedWorkspace(req.body?.models, req.body?.settings)
    const models = publicModels(readSharedWorkspace().models)
    if (process.env.CLOUD_PUBLISH_URL && process.env.CLOUD_PUBLISH_TOKEN) {
      const target = new URL('/api/models', process.env.CLOUD_PUBLISH_URL)
      if (target.protocol !== 'https:') throw new Error('云端发布地址必须使用 HTTPS。')
      const proxy = process.env.CLOUD_PUBLISH_PROXY
      const cloud = await fetch(target, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CLOUD_PUBLISH_TOKEN}` }, body: JSON.stringify({ models, settings: req.body.settings }), ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}) })
      if (!cloud.ok) throw new Error(`本机已保存，云端发布失败：${(await cloud.text()).slice(0, 300)}`)
      return res.json({ models, cloudPublished: true })
    }
    res.json({ models, cloudPublished: false })
  } catch (error) { res.status(400).json({ error: error.message }) }
})
app.post('/api/chat', async (req, res) => {
  let { config, messages, systemPrompt = '' } = req.body || {}
  if (lanMode) {
    const published = readSharedWorkspace().models.find((model) => model.id === config?.id)
    config = published && { ...published, apiKey: config?.apiKey || '', stream: config?.stream === false ? false : published.stream }
    if (!config) return res.status(400).json({ error: '模型未发布到局域网服务。' })
  }
  if (!config || !['openai', 'anthropic', 'gemini', 'custom', 'jev'].includes(config.provider) || !config.apiKey || !config.baseUrl || !config.modelId || !Array.isArray(messages) || messages.length > 100 || messages.some((m) => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 100000)) return res.status(400).json({ error: '请求参数无效，请检查模型配置。' })
  let request
  try { request = buildRequest(config, messages, String(systemPrompt).slice(0, 100000)) }
  catch (error) { return res.status(400).json({ error: error.message }) }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120000)
  req.on('aborted', () => controller.abort())
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  try {
    const upstream = await fetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal })
    if (!upstream.ok) {
      const raw = (await upstream.text()).slice(0, 1000)
      let message = raw
      try { const parsed = JSON.parse(raw); message = parsed.error?.message || parsed.message || raw } catch { /* leave text */ }
      return res.status(upstream.status).json({ error: message || `接口错误 ${upstream.status}` })
    }
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    if (!config.stream || config.provider === 'jev') {
      const data = await upstream.json()
      const text = extractFinal(config.provider, data)
      if (!text) throw new Error('接口没有返回可显示的文本。')
      res.write(`${JSON.stringify({ delta: text })}\n`)
      const usage = extractUsage(config.provider, data)
      if (usage) res.write(`${JSON.stringify({ usage })}\n`)
      res.end()
      return
    }
    const reader = upstream.body?.getReader()
    if (!reader) throw new Error('接口没有返回内容。')
    const decoder = new TextDecoder()
    let buffer = ''
    let count = 0
    let textLength = 0
    const emit = (line) => {
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      let data
      try { data = JSON.parse(payload) } catch { return }
      const usage = extractUsage(config.provider, data)
      if (usage) res.write(`${JSON.stringify({ usage })}\n`)
      const delta = extractDelta(config.provider, data)
      if (delta) { textLength += delta.length; if (textLength > 1000000) throw new Error('模型回复超过长度限制。'); res.write(`${JSON.stringify({ delta })}\n`) }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > 5000000) throw new Error('接口响应超过大小限制。')
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) emit(line)
    }
    if (buffer) emit(buffer)
    if (!textLength) res.write(`${JSON.stringify({ error: '接口没有返回可显示的文本。' })}\n`)
    res.end()
  } catch (error) {
    const message = error.name === 'AbortError' ? '请求超时。' : error.message || '请求失败。'
    if (res.headersSent) res.end(`${JSON.stringify({ error: message })}\n`)
    else res.status(502).json({ error: message })
  } finally { clearTimeout(timeout) }
})
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
app.use(express.static(dist))
app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
app.listen(port, host, () => console.log(`Model Studio: http://${host}:${port}`))
