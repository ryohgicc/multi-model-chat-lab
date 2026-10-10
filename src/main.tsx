import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, ChevronDown, Copy, KeyRound, LayoutGrid, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Send, Settings2, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react'
import { buildContext, promptVariableValues, renderSystemPrompt } from './context'
import type { PromptVariable } from './context'
import { buildCompressionInput, buildCompressionRequestContent, modelCompressionTurns, DEFAULT_COMPRESSION_PROMPT, LEGACY_DEFAULT_COMPRESSION_PROMPT, parseCompressionResult, shouldAutoCompress } from './compression'
import { conversationCost, formatUsd, replyCosts } from './pricing'
import { parseConnectionResponse } from './connection'
import './style.css'

type Provider = 'openai' | 'anthropic' | 'gemini' | 'custom'
type Model = { id: string; name: string; provider: Provider; baseUrl: string; apiKey: string; modelId: string; stream: boolean; inputPerMillion?: number; outputPerMillion?: number }
type Reply = { modelId: string; content: string; error?: string; firstTokenMs?: number; durationMs?: number; usage?: { input?: number; output?: number; total?: number }; pricing?: { inputPerMillion?: number; outputPerMillion?: number }; attempted?: boolean }
type Turn = { id: string; prompt: string; user: string; replies: Record<number, Reply>; historyLimit?: number; memorySnapshot?: Record<number, string>; summarySnapshot?: Record<number, string> }
type Slot = { modelId: string; startedAt: number }
type Chat = { id: string; title: string; turns: Turn[]; slots: Slot[]; promptDraft: string; welcomeInstruction?: string; welcomeReplies?: Record<number, Reply>; historyLimitDraft?: number; compressionPrompt?: string; compressionLimit?: number; compressionInterval?: number; lastAutoCompressionTurn?: Record<number, number>; memory?: Record<number, string>; summary?: Record<number, string> }
type Store = { models: Model[]; chats: Chat[]; activeId: string; panelCount: number }
type ConnectionResult = { ok: boolean; message: string; signature: string; durationMs?: number }
const uid = () => Math.random().toString(36).slice(2, 10)
const freshChat = (models: Model[] = []): Chat => ({ id: uid(), title: '新对话', turns: [], slots: Array.from({ length: 5 }, (_, i) => ({ modelId: models[i]?.id || '', startedAt: 0 })), promptDraft: '', historyLimitDraft: 10, compressionPrompt: DEFAULT_COMPRESSION_PROMPT, compressionLimit: 10, compressionInterval: 0, lastAutoCompressionTurn: {} })
const initial = (): Store => { const chat = freshChat(); return { models: [], chats: [chat], activeId: chat.id, panelCount: 3 } }
function load(): Store { try { const saved = JSON.parse(localStorage.getItem('model-studio-v1') || 'null') as Store; if (saved?.chats?.length) return { ...saved, panelCount: Math.min(5, Math.max(1, saved.panelCount || 3)), chats: saved.chats.map((chat) => ({ ...chat, compressionPrompt: chat.compressionPrompt === LEGACY_DEFAULT_COMPRESSION_PROMPT ? DEFAULT_COMPRESSION_PROMPT : chat.compressionPrompt, memory: typeof chat.memory === 'string' ? {} : chat.memory, summary: typeof chat.summary === 'string' ? {} : chat.summary, lastAutoCompressionTurn: typeof chat.lastAutoCompressionTurn === 'number' ? {} : chat.lastAutoCompressionTurn, slots: Array.from({ length: 5 }, (_, i) => chat.slots?.[i] || { modelId: '', startedAt: chat.turns.length }) })) } } catch { /* new store */ } return initial() }
const providerLabel: Record<Provider, string> = { openai: 'OpenAI 兼容协议', anthropic: 'Anthropic 兼容协议', gemini: 'Gemini 原生协议', custom: '自定义 · 直接请求' }
const providerDefault: Record<Provider, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta', custom: '' }

function App() {
  const [store, setStore] = useState<Store>(load)
  const [page, setPage] = useState<'chat' | 'settings'>('chat')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ provider: 'openai' as Provider, name: '', apiKey: '', baseUrl: providerDefault.openai, modelIds: '', stream: true, inputPerMillion: '', outputPerMillion: '' })
  const [connectionBusy, setConnectionBusy] = useState<Record<string, boolean>>({})
  const [connectionResults, setConnectionResults] = useState<Record<string, ConnectionResult>>({})
  const [draft, setDraft] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const [previewVariable, setPreviewVariable] = useState<PromptVariable | null>(null)
  const [previewAnchor, setPreviewAnchor] = useState<{ left: number; top: number } | null>(null)
  const [previewTime, setPreviewTime] = useState(() => new Date().toISOString())
  const [compressionBusy, setCompressionBusy] = useState<Record<string, boolean>>({})
  const [autoCompressionKeys, setAutoCompressionKeys] = useState<string[]>([])
  const compressionBusyRef = useRef<Set<string>>(new Set())
  const autoQueuedRef = useRef<Set<string>>(new Set())
  const [picker, setPicker] = useState<number | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState('')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('model-studio-sidebar-collapsed') === 'true')
  const active = store.chats.find((c) => c.id === store.activeId) || store.chats[0]
  const bottomRefs = useRef<Array<HTMLDivElement | null>>([])
  const busyKey = (chatId: string, index: number) => `${chatId}:${index}`
  const activeCompressionBusy = Object.values(compressionBusy).some(Boolean)
  const isBusy = (index: number) => !!busy[busyKey(active.id, index)]
  const anyBusy = Array.from({ length: store.panelCount }, (_, i) => isBusy(i)).some(Boolean)
  const promptVariables: PromptVariable[] = ['userInputPrevious', 'aiOutputPrevious', 'userInputlatest', 'memory', 'summary', 'currentTime']
  const variablePreviews = Array.from({ length: store.panelCount }, (_, index) => {
    const slot = active.slots[index]
    const model = store.models.find((item) => item.id === slot.modelId)
    if (!model) return { index, modelName: '未选择模型', configured: false, values: promptVariableValues([], draft.trim(), active.memory?.[index] || '', active.summary?.[index] || '', previewTime) }
    const currentInput = draft.trim()
    const hasDraft = !!currentInput
    const previewTurns = hasDraft ? [...active.turns, { user: currentInput, replies: {} }] : active.turns
    const currentIndex = previewTurns.length - 1
    const welcome = active.welcomeReplies?.[index]
    const context = currentIndex < slot.startedAt ? [] : buildContext(previewTurns, index, model.id, slot.startedAt, currentIndex, active.historyLimitDraft ?? 10, welcome?.modelId === model.id && !welcome.error ? welcome.content : '')
    const latestUser = hasDraft ? currentInput : context.filter((message) => message.role === 'user').at(-1)?.content || ''
    return { index, modelName: model.name, configured: true, values: promptVariableValues(context, latestUser, active.memory?.[index] || '', active.summary?.[index] || '', previewTime) }
  })
  useEffect(() => localStorage.setItem('model-studio-v1', JSON.stringify(store)), [store])
  useEffect(() => localStorage.setItem('model-studio-sidebar-collapsed', String(sidebarCollapsed)), [sidebarCollapsed])
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(''), 3200); return () => clearTimeout(t) } }, [notice])
  useEffect(() => { bottomRefs.current.forEach((el) => el?.scrollIntoView({ behavior: 'smooth', block: 'end' })) }, [active.turns])
  useEffect(() => {
    for (const chat of store.chats) {
      if (!chat.compressionInterval) continue
      chat.slots.forEach((slot, index) => {
        const model = store.models.find((item) => item.id === slot.modelId)
        if (!model) return
        const key = busyKey(chat.id, index)
        const turns = modelCompressionTurns(chat.turns, index, model.id, slot.startedAt)
        const last = chat.lastAutoCompressionTurn?.[index] ?? slot.startedAt
        if (shouldAutoCompress(turns, chat.compressionInterval ?? 0, Math.max(0, last - slot.startedAt)) && !autoQueuedRef.current.has(key) && !compressionBusyRef.current.has(key)) {
          autoQueuedRef.current.add(key)
          void compressPanel(chat.id, index, true)
        }
      })
    }
  }, [store.chats, store.models])
  useEffect(() => { const onKey = (e: globalThis.KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat() } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey) })
  function updateChat(chatId: string, fn: (chat: Chat) => Chat) { setStore((s) => ({ ...s, chats: s.chats.map((c) => c.id === chatId ? fn(c) : c) })) }
  function newChat() {
    const previous = active
    const chat = freshChat(store.models)
    chat.promptDraft = previous.promptDraft
    chat.welcomeInstruction = previous.welcomeInstruction
    chat.slots = previous.slots.map((slot) => ({ modelId: slot.modelId, startedAt: 0 }))
    setStore((s) => ({ ...s, chats: [chat, ...s.chats], activeId: chat.id }))
    setDraft(''); setPage('chat'); setPromptOpen(false)
    if (chat.welcomeInstruction?.trim()) generateWelcome(chat)
  }
  function deleteChat(id: string) { setStore((s) => { const chats = s.chats.filter((c) => c.id !== id); if (!chats.length) chats.push(freshChat(s.models)); return { ...s, chats, activeId: s.activeId === id ? chats[0].id : s.activeId } }) }
  function selectModel(index: number, modelId: string) { if (anyBusy) return; updateChat(active.id, (c) => { if (c.slots[index].modelId === modelId) return c; const slots = [...c.slots]; slots[index] = { modelId, startedAt: c.turns.length }; return { ...c, slots, welcomeReplies: { ...c.welcomeReplies, [index]: undefined } as Record<number, Reply>, memory: { ...c.memory, [index]: '' }, summary: { ...c.summary, [index]: '' }, lastAutoCompressionTurn: { ...c.lastAutoCompressionTurn, [index]: c.turns.length } } }); setPicker(null) }
  function showForm(model?: Model) { setEditing(model?.id || null); setForm(model ? { provider: model.provider, name: model.name, apiKey: model.apiKey, baseUrl: model.baseUrl, modelIds: model.modelId, stream: model.stream, inputPerMillion: model.inputPerMillion?.toString() ?? '', outputPerMillion: model.outputPerMillion?.toString() ?? '' } : { provider: 'openai', name: '', apiKey: '', baseUrl: providerDefault.openai, modelIds: '', stream: true, inputPerMillion: '', outputPerMillion: '' }); setConnectionResults((current) => { const { form: _form, ...rest } = current; void _form; return rest }); setModal(true) }
  function connectionSignature(model: Pick<Model, 'provider' | 'baseUrl' | 'apiKey' | 'modelId' | 'stream'>) { return JSON.stringify([model.provider, model.baseUrl, model.apiKey, model.modelId, model.stream]) }
  async function testConnection(key: string, model: Model) {
    if (connectionBusy[key]) return
    const signature = connectionSignature(model)
    const startedAt = performance.now()
    setConnectionResults((current) => { const next = { ...current }; delete next[key]; return next })
    setConnectionBusy((current) => ({ ...current, [key]: true }))
    try {
      const url = new URL(model.baseUrl)
      if (!['https:', 'http:'].includes(url.protocol) || !model.apiKey || !model.modelId) throw new Error('请填完 API Key、接口地址和模型 ID。')
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: model, messages: [{ role: 'user', content: '请回复“连接成功”。' }], systemPrompt: '' }), signal: AbortSignal.timeout(30000) })
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error || `请求失败 (${response.status})`)
      }
      const reply = parseConnectionResponse(await response.text())
      setConnectionResults((current) => ({ ...current, [key]: { ok: true, message: reply, durationMs: Math.round(performance.now() - startedAt), signature } }))
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError' ? '测试超时（30 秒）。' : error instanceof Error ? error.message : '测试失败。'
      setConnectionResults((current) => ({ ...current, [key]: { ok: false, message, signature } }))
    } finally { setConnectionBusy((current) => ({ ...current, [key]: false })) }
  }
  function testFormConnection() {
    const modelId = form.modelIds.split(/[\n,，]/).map((value) => value.trim()).find(Boolean) || ''
    void testConnection('form', { id: editing || '', name: form.name || modelId, provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), modelId, stream: form.stream })
  }
  function saveModels(e: FormEvent) {
    e.preventDefault()
    const ids = form.modelIds.split(/[\n,，]/).map((x) => x.trim()).filter(Boolean)
    if (!ids.length || !form.apiKey.trim() || !form.baseUrl.trim()) { setNotice('请填完 API Key、接口地址和模型 ID'); return }
    try { const url = new URL(form.baseUrl); if (!['https:', 'http:'].includes(url.protocol)) throw new Error() } catch { setNotice('接口地址不是有效 URL'); return }
    const inputPrice = form.inputPerMillion.trim() === '' ? undefined : Number(form.inputPerMillion)
    const outputPrice = form.outputPerMillion.trim() === '' ? undefined : Number(form.outputPerMillion)
    if ([inputPrice, outputPrice].some((price) => price !== undefined && (!Number.isFinite(price) || price < 0))) { setNotice('价格需为不小于 0 的数字'); return }
    const models = ids.map((modelId) => ({ id: editing || uid(), name: ids.length === 1 && form.name.trim() ? form.name.trim() : modelId, provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), modelId, stream: form.stream, inputPerMillion: inputPrice, outputPerMillion: outputPrice }))
    setStore((s) => ({ ...s, models: editing ? s.models.map((m) => m.id === editing ? models[0] : m) : [...s.models, ...models], chats: editing ? s.chats : s.chats.map((chat) => ({ ...chat, slots: chat.slots.map((slot, i) => slot.modelId ? slot : { ...slot, modelId: models[i]?.id || '' }) })) }))
    setModal(false); setNotice(editing ? '模型已更新' : `已添加 ${models.length} 个模型`)
  }
  function removeModel(id: string) { setStore((s) => ({ ...s, models: s.models.filter((m) => m.id !== id), chats: s.chats.map((c) => ({ ...c, slots: c.slots.map((slot) => slot.modelId === id ? { modelId: '', startedAt: c.turns.length } : slot), welcomeReplies: Object.fromEntries(Object.entries(c.welcomeReplies || {}).filter(([, reply]) => reply?.modelId !== id)) })) })) }
  function visibleTurns(chat: Chat, index: number) { return chat.turns.map((turn, turnIndex) => ({ turn, turnIndex })).filter(({ turnIndex }) => turnIndex >= chat.slots[index].startedAt) }
  function retryWelcome(index: number) {
    const instruction = active.welcomeInstruction?.trim()
    const model = store.models.find((item) => item.id === active.slots[index].modelId)
    if (!instruction || !model || isBusy(index) || active.turns.length) return
    const context = [{ role: 'user' as const, content: instruction }]
    updateChat(active.id, (chat) => ({ ...chat, welcomeReplies: { ...chat.welcomeReplies, [index]: { modelId: model.id, content: '', attempted: true, pricing: { inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion } } } }))
    void requestModel(active.id, null, index, model, context, renderSystemPrompt(active.promptDraft, context, instruction, active.memory?.[index] || '', active.summary?.[index] || ''))
  }
  async function requestModel(chatId: string, turnId: string | null, index: number, model: Model, context: { role: string; content: string }[], prompt: string) {
    const startedAt = performance.now()
    let receivedText = false
    setBusy((s) => ({ ...s, [busyKey(chatId, index)]: true }))
    const updateReply = (change: (reply: Reply) => Reply) => updateChat(chatId, (chat) => turnId === null
      ? { ...chat, welcomeReplies: { ...chat.welcomeReplies, [index]: change(chat.welcomeReplies?.[index] || { modelId: model.id, content: '', attempted: true, pricing: { inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion } }) } }
      : { ...chat, turns: chat.turns.map((turn) => turn.id !== turnId ? turn : { ...turn, replies: { ...turn.replies, [index]: change(turn.replies[index] || { modelId: model.id, content: '', attempted: true, pricing: { inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion } }) } }) })
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: model, messages: context, systemPrompt: prompt }) })
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || `请求失败 (${response.status})`) }
      const reader = response.body?.getReader(); if (!reader) throw new Error('接口响应为空')
      const decoder = new TextDecoder(); let buffer = ''
      const parse = (line: string) => {
        if (!line.trim()) return
        const event = JSON.parse(line) as { delta?: string; error?: string; usage?: { input?: number; output?: number; total?: number } }
        if (event.error) throw new Error(event.error)
        if (event.delta) {
          const firstTokenMs = !receivedText ? Math.round(performance.now() - startedAt) : undefined
          receivedText = true
          updateReply((reply) => ({ ...reply, content: reply.content + event.delta, firstTokenMs: reply.firstTokenMs ?? firstTokenMs }))
        }
        if (event.usage) updateReply((reply) => ({ ...reply, usage: { ...reply.usage, ...event.usage } }))
      }
      while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(parse) }
      if (buffer) parse(buffer)
    } catch (error) { updateReply((reply) => ({ ...reply, error: error instanceof Error ? error.message : '请求失败' })) }
    finally {
      updateReply((reply) => ({ ...reply, durationMs: Math.round(performance.now() - startedAt) }))
      setBusy((s) => ({ ...s, [busyKey(chatId, index)]: false }))
    }
  }
  function generateWelcome(chat: Chat) {
    const instruction = chat.welcomeInstruction?.trim()
    if (!instruction || chat.turns.length) return
    const targets = chat.slots.slice(0, store.panelCount).map((slot, index) => ({ index, model: store.models.find((m) => m.id === slot.modelId) })).filter((target) => target.model)
    if (!targets.length) { if (chat.id === active.id) setNotice('先选择至少一个模型'); return }
    const chatId = chat.id
    const context = [{ role: 'user' as const, content: instruction }]
    updateChat(chatId, (chat) => ({ ...chat, welcomeReplies: Object.fromEntries(targets.map(({ index, model }) => [index, { modelId: model!.id, content: '', attempted: true, pricing: { inputPerMillion: model!.inputPerMillion, outputPerMillion: model!.outputPerMillion } }])) }))
    targets.forEach(({ index, model }) => void requestModel(chatId, null, index, model!, context, renderSystemPrompt(chat.promptDraft, context, instruction, chat.memory?.[index] || '', chat.summary?.[index] || '')))
  }
  function send() {
    const user = draft.trim(); if (!user || anyBusy) return
    const targets = active.slots.slice(0, store.panelCount).map((slot, index) => ({ slot, index, model: store.models.find((m) => m.id === slot.modelId) })).filter((target) => target.model)
    if (!targets.length) { setNotice('先选择至少一个模型'); return }
    const chatId = active.id; const prompt = active.promptDraft; const historyLimit = active.historyLimitDraft ?? 10; const turnId = uid(); const turn: Turn = { id: turnId, user, prompt, historyLimit, memorySnapshot: { ...active.memory }, summarySnapshot: { ...active.summary }, replies: Object.fromEntries(targets.map(({ index, model }) => [index, { modelId: model!.id, content: '', attempted: true, pricing: { inputPerMillion: model!.inputPerMillion, outputPerMillion: model!.outputPerMillion } }])) }
    const contexts = targets.map(({ slot, index, model }) => { const welcome = active.welcomeReplies?.[index]; return { index, model: model!, context: buildContext([...active.turns, turn], index, model!.id, slot.startedAt, active.turns.length, historyLimit, welcome?.modelId === model!.id && !welcome.error ? welcome.content : '') } })
    updateChat(chatId, (chat) => ({ ...chat, title: chat.title === '新对话' ? user.slice(0, 24) : chat.title, turns: [...chat.turns, turn] }))
    setDraft(''); setPromptOpen(false)
    contexts.forEach(({ index, model, context }) => void requestModel(chatId, turnId, index, model, context, renderSystemPrompt(prompt, context, user, active.memory?.[index] || '', active.summary?.[index] || '')))
  }
  function retry(index: number, turnIndex: number) {
    if (isBusy(index)) return
    const model = store.models.find((m) => m.id === active.turns[turnIndex].replies[index]?.modelId)
    if (!model) { setNotice('这个模型已从配置中删除'); return }
    const turn = active.turns[turnIndex]
    const welcome = active.welcomeReplies?.[index]
    const context = buildContext(active.turns, index, model.id, active.slots[index].startedAt, turnIndex, turn.historyLimit ?? 10, welcome?.modelId === model.id && !welcome.error ? welcome.content : '')
    updateChat(active.id, (chat) => ({ ...chat, turns: chat.turns.map((old) => old.id === turn.id ? { ...old, replies: { ...old.replies, [index]: { modelId: model.id, content: '', attempted: true, pricing: { inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion } } } } : old) }))
    void requestModel(active.id, turn.id, index, model, context, renderSystemPrompt(turn.prompt, context, turn.user, turn.memorySnapshot?.[index] || '', turn.summarySnapshot?.[index] || ''))
  }
  async function compressPanel(chatId: string, index: number, automatic = false) {
    const key = busyKey(chatId, index)
    if (compressionBusyRef.current.has(key)) return false
    const chat = store.chats.find((item) => item.id === chatId)
    const slot = chat?.slots[index]
    const model = store.models.find((item) => item.id === slot?.modelId)
    if (!chat || !slot || !model) return false
    const turns = modelCompressionTurns(chat.turns, index, model.id, slot.startedAt)
    const input = buildCompressionInput(turns, chat.compressionLimit ?? 10, { [model.id]: model.name })
    if (!input) return false
    compressionBusyRef.current.add(key)
    setCompressionBusy((current) => ({ ...current, [key]: true }))
    if (automatic) {
      updateChat(chatId, (current) => ({ ...current, lastAutoCompressionTurn: { ...current.lastAutoCompressionTurn, [index]: current.turns.length } }))
      setAutoCompressionKeys((current) => [...current, key])
    }
    try {
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...model, stream: false }, messages: [{ role: 'user', content: buildCompressionRequestContent(input, chat.memory?.[index] || '') }], systemPrompt: chat.compressionPrompt ?? DEFAULT_COMPRESSION_PROMPT }) })
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || `压缩失败 (${response.status})`) }
      const text = await response.text()
      let output = ''
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as { delta?: string; error?: string }
        if (event.error) throw new Error(event.error)
        output += event.delta || ''
      }
      const result = parseCompressionResult(output)
      updateChat(chatId, (current) => ({ ...current, summary: { ...current.summary, [index]: result.summary }, memory: result.memory === null ? current.memory : { ...current.memory, [index]: result.memory } }))
      return true
    } catch (error) { setNotice(`${model.name}：${error instanceof Error ? error.message : '压缩失败'}`); return false }
    finally {
      compressionBusyRef.current.delete(key)
      autoQueuedRef.current.delete(key)
      setCompressionBusy((current) => ({ ...current, [key]: false }))
      if (automatic) setAutoCompressionKeys((current) => current.filter((item) => item !== key))
    }
  }
  async function manualCompress() {
    const targets = store.chats.flatMap((chat) => chat.slots.map((slot, index) => ({ chat, index, model: store.models.find((item) => item.id === slot.modelId) }))).filter(({ chat, index, model }) => model && modelCompressionTurns(chat.turns, index, model.id, chat.slots[index].startedAt).some((turn) => Object.values(turn.replies).some((reply) => reply?.content && !reply.error)))
    if (!targets.length) { setNotice('没有可压缩的模型对话'); return }
    const results = await Promise.all(targets.map(({ chat, index }) => compressPanel(chat.id, index)))
    const completed = results.filter(Boolean).length
    setNotice(completed ? `已压缩 ${completed} 个模型对话${completed < targets.length ? '，其余请求失败' : ''}` : '模型对话压缩失败')
  }
  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
  return <div className="app"><aside className={`sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}><div className="brand"><div className="brand-icon"><MessageSquare size={20} /></div><div><strong>Model Studio</strong><span>对话调试工作台</span></div><button className="sidebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></div><button className="new-chat" onClick={newChat} title="新建对话"><Plus size={17} /> 新建对话 <kbd>⌘ K</kbd></button><div className="side-label">工作空间</div><button className={`side-link ${page === 'chat' ? 'active' : ''}`} onClick={() => setPage('chat')} title="对比工作台"><LayoutGrid size={18} /> 对比工作台</button><button className={`side-link ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')} title="模型与设置"><Settings2 size={18} /> 模型与设置 <span className="count">{store.models.length}</span></button><div className="side-label layout-label">对话布局</div><div className="side-layout" aria-label="对话面板数量">{[1, 2, 3, 4, 5].map((count) => <button key={count} className={store.panelCount === count ? 'active' : ''} onClick={() => setStore((current) => ({ ...current, panelCount: count }))} aria-label={`${count} 个对话面板`} title={`${count} 个对话面板`}>{count}</button>)}</div><div className="side-divider" /><div className="side-label history-label">最近对话</div><div className="history">{store.chats.map((chat) => <div className={`history-row ${active.id === chat.id && page === 'chat' ? 'selected' : ''}`} key={chat.id}><button onClick={() => { setStore((s) => ({ ...s, activeId: chat.id })); setPage('chat') }}><MessageSquare size={15} /><span>{chat.title}</span></button><button className="delete-chat" title="删除对话" onClick={() => deleteChat(chat.id)}><Trash2 size={14} /></button></div>)}</div><div className="sidebar-footer"><div className="profile"><span className="profile-icon">M</span><span><strong>本地工作台</strong><small>仅保存在当前浏览器</small></span></div></div></aside><main className="main">{page === 'settings' && <header className="topbar"><div className="breadcrumbs"><span>工作空间</span><span>/</span><strong>模型与设置</strong></div></header>}{page === 'chat' ? <div className="workspace"><div className="panels" style={{ gridTemplateColumns: `repeat(${store.panelCount}, minmax(220px, 1fr))` }}>{Array.from({ length: store.panelCount }, (_, index) => { const slot = active.slots[index]; const model = store.models.find((m) => m.id === slot.modelId); const turns = visibleTurns(active, index); const welcome: Reply = active.welcomeReplies?.[index] || { modelId: '', content: '' }; const showWelcome = welcome?.modelId === model?.id && (welcome.content || welcome.error || isBusy(index)); const costSummary = conversationCost([...(welcome.modelId === model?.id ? [welcome] : []), ...active.turns.map((turn) => turn.replies[index]).filter(Boolean)].map((reply) => ({ ...reply, attempted: reply.attempted ?? Boolean(reply.content || reply.error || reply.durationMs) }))); return <section className="panel" key={`${active.id}-${index}`}><div className="panel-top"><span className="panel-index">0{index + 1}</span><div className="picker-wrap"><button className="picker-button" onClick={() => setPicker(picker === index ? null : index)}><span className={`model-icon ${model ? '' : 'no-model'}`}>{model ? model.name.slice(0, 1).toUpperCase() : <Plus size={16} />}</span><span>{model?.name || '选择模型'}</span><ChevronDown size={15} /></button>{picker === index && <div className="picker-menu"><div className="picker-label">选择模型</div>{store.models.map((item) => <button key={item.id} onClick={() => selectModel(index, item.id)}><span className="model-icon">{item.name.slice(0, 1).toUpperCase()}</span><span className="picker-name"><strong>{item.name}</strong><small>{providerLabel[item.provider]}</small></span>{item.id === model?.id && <Check size={16} />}</button>)}{!store.models.length && <div className="picker-empty">还没有配置模型</div>}<button className="picker-add" onClick={() => { setPicker(null); setPage('settings'); showForm() }}><Plus size={16} /> 添加模型</button></div>}</div></div><div className="panel-scroll">{turns.length || showWelcome ? <div className="messages">{showWelcome && <div className="turn welcome-turn"><div className={`message ai-message ${welcome.error ? 'has-error' : ''}`}><div className="msg-head"><span className="model-icon">{model?.name.slice(0, 1).toUpperCase() || 'AI'}</span><strong>{model?.name || '模型'}</strong><span className="prompt-mark">欢迎语</span></div><div className="msg-content">{welcome.error ? <><span className="error-title">请求失败</span><span>{welcome.error}</span></> : welcome.content || <span className="reply-loading"><span className="loading-spinner" />等待模型响应…</span>}</div><div className="msg-actions">{welcome.error && !active.turns.length ? <button onClick={() => retryWelcome(index)}><RotateCcw size={13} /> 重试</button> : welcome.content && <button onClick={() => { navigator.clipboard.writeText(welcome.content); setNotice('已复制回复') }}><Copy size={13} /> 复制</button>}</div></div></div>}{turns.map(({ turn, turnIndex }) => { const reply = turn.replies[index]; const pending = isBusy(index) && turnIndex === active.turns.length - 1; const shouldShow = reply?.modelId && (reply.content || reply.error || pending); const costs = replyCosts(reply?.usage, reply?.pricing); return <div className="turn" key={turn.id}><div className="message user-message"><div className="msg-head"><span className="user-icon">你</span><strong>你</strong><span>第 {turnIndex + 1} 轮</span></div><div className="msg-content">{turn.user}</div></div>{shouldShow && <div className={`message ai-message ${reply.error ? 'has-error' : ''}`}><div className="msg-head"><span className="model-icon">{model?.name.slice(0, 1).toUpperCase() || 'AI'}</span><strong>{model?.name || '模型'}</strong>{turn.prompt && <span className="prompt-mark" title={`本轮 Prompt：${turn.prompt}`}>Prompt</span>}</div><div className="msg-content">{reply.error ? <><span className="error-title">请求失败</span><span>{reply.error}</span></> : reply.content || (pending ? <span className="reply-loading" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" />等待模型响应…</span> : <span className="reply-loading">未收到回复</span>)}</div><div className="reply-metrics">{isBusy(index) && turnIndex === active.turns.length - 1 ? <span>{reply.content ? '正在生成…' : '等待响应…'}</span> : <><span>耗时 {reply.durationMs === undefined ? '—' : `${(reply.durationMs / 1000).toFixed(2)}s`}</span><span>首字 {reply.firstTokenMs === undefined ? '—' : `${(reply.firstTokenMs / 1000).toFixed(2)}s`}</span><span title="由模型接口返回的实际用量；未提供时显示 —">Token 输入 {reply.usage?.input ?? '—'} / 输出 {reply.usage?.output ?? '—'} / 总计 {reply.usage?.total ?? (reply.usage?.input !== undefined && reply.usage?.output !== undefined ? reply.usage.input + reply.usage.output : '—')}</span><span title="本次回复的输出 token 成本；缺少用量或价格时显示 —">输出成本 {costs.output === null ? '—' : formatUsd(costs.output)}</span></>}</div><div className="msg-actions">{reply.error ? <button onClick={() => retry(index, turnIndex)}><RotateCcw size={13} /> 重试</button> : reply.content && <button onClick={() => { navigator.clipboard.writeText(reply.content); setNotice('已复制回复') }}><Copy size={13} /> 复制</button>}</div></div>}</div> })}<div ref={(el) => { bottomRefs.current[index] = el }} /></div> : <div className="empty-state"><div className="empty-graphic"><Sparkles size={27} /></div><h3>{model ? '等待你的第一个问题' : '选择一个模型开始'}</h3><p>{model ? '在下方输入问题，一次发送给所有模型。' : '点击上方菜单，选择已配置的模型。'}</p>{!model && <button onClick={() => { setPage('settings'); showForm() }}>配置模型 <ArrowRight size={14} /></button>}</div>}</div><div className="panel-bottom"><span><i className={isBusy(index) ? 'pulse' : ''} />{isBusy(index) ? ((turns.at(-1)?.turn.replies[index]?.content || welcome?.content) ? '正在生成' : '等待响应') : model ? '准备就绪' : '尚未配置'}</span><span className="panel-cost" title="本面板整个对话的输入加输出成本；统计不完整时标记部分未知">本次总成本 {formatUsd(costSummary.total)}{costSummary.incomplete ? ' · 部分未知' : ''}</span></div></section> })}</div><div className="composer-area">{promptOpen && <div className="prompt-editor"><div><strong>本轮系统 Prompt</strong><span>下一轮默认沿用 · 支持变量</span></div><div className="prompt-variables" onMouseLeave={() => setPreviewVariable(null)}>{promptVariables.map((name) => <button type="button" key={name} className={previewVariable === name ? 'active' : ''} onMouseEnter={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPreviewTime(new Date().toISOString()); setPreviewVariable(name); setPreviewAnchor({ left: rect.left, top: rect.top }) }} onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPreviewTime(new Date().toISOString()); setPreviewVariable(name); setPreviewAnchor({ left: rect.left, top: rect.top }) }} onBlur={() => setPreviewVariable(null)} aria-label={`预览变量 ${name}`}>{'${' + name + '}'}</button>)}</div><textarea rows={3} value={active.promptDraft} onChange={(e) => updateChat(active.id, (c) => ({ ...c, promptDraft: e.target.value }))} placeholder="给所有模型的系统指令，例如：请简洁、准确地回答问题。" /><label className="context-limit">携带最近 <input type="number" min="0" max="100" step="1" value={active.historyLimitDraft ?? 10} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value <= 100) updateChat(active.id, (c) => ({ ...c, historyLimitDraft: value })) }} /> 轮上下文 <span>0 表示只发送本轮消息；最多 100 轮</span></label><div className="welcome-settings"><div className="welcome-heading"><strong>欢迎语</strong><span>仅新对话生成一次；指令不会进入聊天记录或压缩</span></div><div className="welcome-input-row"><textarea rows={2} value={active.welcomeInstruction || ''} onChange={(e) => updateChat(active.id, (c) => ({ ...c, welcomeInstruction: e.target.value }))} placeholder="输入生成欢迎语的指令；与本轮系统 Prompt 一起发送给 AI" /><button type="button" onClick={() => generateWelcome(active)} disabled={!active.welcomeInstruction?.trim() || !!active.turns.length || anyBusy}>生成欢迎语</button></div>{active.turns.length > 0 && <small>已有对话时不能生成欢迎语；请新建对话。</small>}</div><div className="compression-settings"><div className="compression-heading"><div><strong>上下文压缩</strong><span>各模型独立保存 memory 与 summary</span></div><button type="button" className="compress-button" onClick={manualCompress} disabled={activeCompressionBusy} title="手动压缩所有已保存对话中的模型对话"><Sparkles size={14} /> {activeCompressionBusy ? '正在压缩…' : '压缩全部对话'}</button></div><div className="compression-layout"><div className="compression-options"><div className="compression-controls"><label>压缩读取最近<input type="number" min="1" max="100" step="1" value={active.compressionLimit ?? 10} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= 100) updateChat(active.id, (c) => ({ ...c, compressionLimit: value })) }} /> 轮对话<span className="compression-help">本次压缩最多读取这些已完成对话</span></label></div><label className="compression-interval">自动压缩间隔 <input type="number" min="0" max="100" step="1" value={active.compressionInterval ?? 0} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value <= 100) updateChat(active.id, (c) => ({ ...c, compressionInterval: value, lastAutoCompressionTurn: Object.fromEntries(c.slots.map((_, index) => [index, c.turns.length])) })) }} /> 轮 <span>0 关闭；不足设定轮数时不生成</span></label><label className="compression-prompt-label">压缩 Prompt<textarea rows={3} value={active.compressionPrompt ?? DEFAULT_COMPRESSION_PROMPT} onChange={(e) => updateChat(active.id, (c) => ({ ...c, compressionPrompt: e.target.value }))} /></label></div><div className="compression-results">{active.slots.map((slot, index) => { const model = store.models.find((item) => item.id === slot.modelId); return model && <div className="compression-panel-result" key={index}><strong>0{index + 1} · {model.name}</strong><div className="compression-result"><label>memory<textarea rows={2} readOnly value={active.memory?.[index] || ''} placeholder="压缩后显示" /></label><label>summary<textarea rows={2} readOnly value={active.summary?.[index] || ''} placeholder="压缩后显示" /></label></div></div> })}</div></div></div></div>}<div className="composer"><textarea rows={2} placeholder="输入一个问题，看看不同模型会如何回答..." value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={keyDown} /><div className="composer-bottom"><button className={`composer-prompt ${promptOpen ? 'selected' : ''}`} onClick={() => setPromptOpen(!promptOpen)} title="编辑本轮系统 Prompt"><Pencil size={15} /> 本轮 Prompt {active.promptDraft && <i />}</button><span><kbd>↵</kbd> 发送 <kbd>⇧ ↵</kbd> 换行</span><button disabled={!draft.trim() || anyBusy} onClick={send}>发送消息 <Send size={16} /></button></div></div></div></div> : <div className="settings-page"><div className="eyebrow"><i /> YOUR WORKSPACE</div><div className="settings-heading"><div><h1>模型与设置 <span>✳</span></h1><p>配置你的模型，建立自己的对话实验室。</p></div><button onClick={() => setPage('chat')}><ArrowLeft size={16} /> 返回工作台</button></div><div className="settings-section"><div className="section-top"><div><h2>已配置的模型 <span>{store.models.length}</span></h2><p>添加模型后，即可在对话面板顶部自由切换。</p></div><button className="add-button" onClick={() => showForm()}><Plus size={17} /> 添加模型</button></div>{store.models.length ? <div className="model-list">{store.models.map((model) => <div className="model-row" key={model.id}><span className="row-icon">{model.name.slice(0, 1).toUpperCase()}</span><div className="row-main"><strong>{model.name}</strong><span>{model.modelId}</span></div><span className="protocol-pill">{providerLabel[model.provider]}</span><span className="stream-pill">{model.stream ? '流式' : '非流式'}</span><span className="price-pill">输入 {model.inputPerMillion === undefined ? '—' : `$${model.inputPerMillion}`} / 输出 {model.outputPerMillion === undefined ? '—' : `$${model.outputPerMillion}`} · 每百万</span><button className="model-test-button" title="测试连接" disabled={!!connectionBusy[model.id]} onClick={() => void testConnection(model.id, model)}>{connectionBusy[model.id] ? "测试中…" : "测试连接"}</button><button title="编辑" onClick={() => showForm(model)}><Pencil size={16} /></button><button title="删除" onClick={() => removeModel(model.id)}><Trash2 size={16} /></button></div>)}</div> : <div className="settings-empty"><div><KeyRound size={27} /></div><h3>还没有添加模型</h3><p>填入 API Key 和接口地址，即可开始并排调试。</p><button onClick={() => showForm()}>添加第一个模型 <ArrowRight size={16} /></button></div>}<div className="connection-results">{store.models.map((model) => { const result = connectionResults[model.id]; return result && result.signature === connectionSignature(model) && <div className={`connection-result ${result.ok ? "success" : "error"}`} key={model.id} role="status"><strong>{model.name} · {result.ok ? `连接成功 · ${(result.durationMs! / 1000).toFixed(2)} 秒` : "连接失败"}</strong><span>{result.message}</span></div> })}</div><div className="settings-note"><ShieldCheck size={17} /> 模型配置和 API Key 仅保存在当前浏览器；清除浏览器数据会删除这些内容。</div></div></div>}</main>{modal && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(false) }}><div className="modal"><div className="modal-head"><div><span>MODEL CONFIGURATION</span><h2>{editing ? '编辑模型' : '添加模型'}</h2><p>连接你的 AI 服务，开始并排对话。</p></div><button onClick={() => setModal(false)} aria-label="关闭"><X size={20} /></button></div><form onSubmit={saveModels}><label>接入方式<select value={form.provider} onChange={(e) => { const provider = e.target.value as Provider; setForm({ ...form, provider, baseUrl: providerDefault[provider] }) }}><option value="openai">OpenAI 兼容协议</option><option value="anthropic">Anthropic 兼容协议</option><option value="gemini">Gemini 原生协议</option><option value="custom">自定义（直接请求）</option></select></label><label>API Key<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="输入你的 API Key" autoComplete="off" /><small>密钥只保存在当前浏览器。</small></label><label>{form.provider === 'custom' ? '完整接口 URL' : 'Base URL'}<input type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={form.provider === 'custom' ? 'https://example.com/v1/chat/completions' : providerDefault[form.provider]} /><small>{form.provider === 'custom' ? '直接 POST 到此地址，不追加路径；使用 OpenAI 兼容请求格式。' : form.provider === 'gemini' ? '填写 Gemini API 根地址，默认 /v1beta；系统自动拼接模型和生成接口。' : `填到 /v1 即可，系统自动拼接 /${form.provider === 'anthropic' ? 'messages' : 'chat/completions'}。`}</small></label>{editing && <label>显示名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：Claude Sonnet" /></label>}<label>{editing ? '模型 ID' : '模型列表 · 每行一个'}<textarea rows={editing ? 2 : 4} value={form.modelIds} onChange={(e) => setForm({ ...form, modelIds: e.target.value })} placeholder={form.provider === 'gemini' ? 'gemini-2.5-flash\ngemini-2.5-pro' : 'gpt-4o\ngpt-4o-mini'} /><small>模型 ID 应与接口接受的 model 参数一致。</small></label><div className="price-fields"><label>输入价格 · 美元 / 百万 token<input type="number" min="0" step="any" value={form.inputPerMillion} onChange={(e) => setForm({ ...form, inputPerMillion: e.target.value })} placeholder="例如 0.15" /></label><label>输出价格 · 美元 / 百万 token<input type="number" min="0" step="any" value={form.outputPerMillion} onChange={(e) => setForm({ ...form, outputPerMillion: e.target.value })} placeholder="例如 0.60" /></label></div><label className="switch-row"><span><strong>流式响应</strong><small>默认开启；接口不支持时可关闭。</small></span><input type="checkbox" checked={form.stream} onChange={(e) => setForm({ ...form, stream: e.target.checked })} /></label><div className="modal-buttons"><button type="button" className="form-test-button" onClick={testFormConnection} disabled={!!connectionBusy.form}>{connectionBusy.form ? "测试中…" : "测试连接"}</button><button type="button" onClick={() => setModal(false)}>取消</button><button type="submit"><Check size={16} /> 保存模型</button></div>{connectionResults.form && connectionResults.form.signature === connectionSignature({ provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), modelId: form.modelIds.split(/[\n,，]/).map((value) => value.trim()).find(Boolean) || "", stream: form.stream }) && <div className={`connection-result form-connection-result ${connectionResults.form.ok ? "success" : "error"}`} role="status"><strong>{connectionResults.form.ok ? `连接成功 · ${(connectionResults.form.durationMs! / 1000).toFixed(2)} 秒` : "连接失败"}</strong><span>{connectionResults.form.message}</span></div>}</form></div></div>}{previewVariable && previewAnchor && createPortal(<div className={`variable-preview ${previewAnchor.top >= 270 ? 'preview-above' : 'preview-below'}`} role="status" style={{ left: Math.min(previewAnchor.left, window.innerWidth - Math.min(620, window.innerWidth - 24) - 12), top: previewAnchor.top >= 270 ? previewAnchor.top - 8 : previewAnchor.top + 26 }}><div className="variable-preview-title">{'${' + previewVariable + '}'} · 当前值</div><div className="variable-preview-grid">{variablePreviews.map(({ index, modelName, configured, values }) => <div className="variable-preview-card" key={index}><strong>0{index + 1} · {modelName}</strong><div>{!configured ? '选择模型后预览' : values[previewVariable] || (previewVariable === 'userInputlatest' ? '输入本轮消息后预览' : '当前为空')}</div></div>)}</div></div>, document.body)}{autoCompressionKeys.length > 0 && <div className="auto-compression-toast" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" /><span>正在自动压缩：{autoCompressionKeys.length} 个模型对话</span></div>}{notice && <div className="toast"><Check size={16} /> {notice}</div>}</div>
}
createRoot(document.getElementById('root')!).render(<App />)
