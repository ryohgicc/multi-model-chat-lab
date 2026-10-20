export function buildRequest(config, messages, systemPrompt) {
  const { provider, baseUrl, apiKey, modelId, stream } = config
  const base = new URL(baseUrl)
  if (!['https:', 'http:'].includes(base.protocol) || (base.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(base.hostname))) throw new Error('接口地址需使用 HTTPS；本机地址可使用 HTTP。')
  if (provider === 'gemini') {
    const model = modelId.replace(/^models\//, '')
    const url = `${base.toString().replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
    return {
      url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      },
    }
  }
  const url = provider === 'custom' ? base.toString() : provider === 'jev' ? `${base.toString().replace(/\/+$/, '').replace(/\/v1$/i, '')}/typesafe/v1/systemone` : `${base.toString().replace(/\/+$/, '')}/${provider === 'anthropic' ? 'messages' : 'chat/completions'}`
  if (provider === 'anthropic') {
    return { url, headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: { model: modelId, max_tokens: 4096, stream, system: systemPrompt || undefined, messages: messages.map((m) => ({ role: m.role, content: m.content })) } }
  }
  if (provider === 'jev') {
    let questions
    try { const template = JSON.parse(systemPrompt); questions = template?.questions || template } catch { throw new Error('JEV 的系统 Prompt 需填写包含 questions 的 JSON 对象。') }
    if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) throw new Error('JEV 的系统 Prompt 需填写非空 questions JSON 对象。')
    const state = messages.length === 1 ? messages[0].content : messages.map((message) => `${message.role === 'assistant' ? '助手' : '用户'}：${message.content}`).join('\n')
    return { url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: { model: modelId, state, questions } }
  }

  return { url, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: { model: modelId, stream, ...(stream ? { stream_options: { include_usage: true } } : {}), messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), ...messages] } }
}

export function extractUsage(provider, data) {
  if (provider === 'gemini') {
    const usage = data?.usageMetadata
    if (!usage) return null
    const input = usage.promptTokenCount
    const output = usage.candidatesTokenCount
    const total = usage.totalTokenCount
    if (![input, output, total].some(Number.isFinite)) return null
    return { ...(Number.isFinite(input) ? { input } : {}), ...(Number.isFinite(output) ? { output } : {}), ...(Number.isFinite(total) ? { total } : {}) }
  }
  const usage = provider === 'anthropic' ? data?.usage || data?.message?.usage : data?.usage
  if (!usage) return null
  const input = provider === 'anthropic' ? usage.input_tokens : usage.prompt_tokens
  const output = provider === 'anthropic' ? usage.output_tokens : usage.completion_tokens
  const total = provider === 'anthropic' ? undefined : usage.total_tokens
  if (!Number.isFinite(input) && !Number.isFinite(output) && !Number.isFinite(total)) return null
  return {
    ...(Number.isFinite(input) ? { input } : {}),
    ...(Number.isFinite(output) ? { output } : {}),
    ...(Number.isFinite(total) ? { total } : {}),
  }
}

export function extractFinal(provider, data) {
  if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message || '接口返回错误')
  if (provider === 'jev') return typeof data === 'string' ? data : JSON.stringify(data)
  if (provider === 'gemini') return data.candidates?.[0]?.content?.parts?.filter((part) => typeof part.text === 'string' && !part.thought).map((part) => part.text).join('') || ''
  if (provider === 'anthropic') return data.content?.filter((part) => part.type === 'text').map((part) => part.text).join('') || ''
  const content = data.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part.type === 'text').map((part) => part.text).join('') : ''
}

export function extractDelta(provider, data) {
  if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message || '接口返回错误')
  if (provider === 'gemini') return extractFinal(provider, data)
  if (provider === 'anthropic') return data.type === 'content_block_delta' && data.delta?.type === 'text_delta' ? data.delta.text : ''
  const content = data.choices?.[0]?.delta?.content
  return typeof content === 'string' ? content : ''
}
