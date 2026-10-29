import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Copy, KeyRound, LayoutGrid, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Send, Settings2, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react'
import { buildContext, promptVariableValues, renderSystemPrompt } from './context'
import type { PromptVariable } from './context'
import { buildCompressionInput, buildCompressionRequestContent, modelCompressionTurns, DEFAULT_COMPRESSION_PROMPT, LEGACY_DEFAULT_COMPRESSION_PROMPT, parseCompressionResult, shouldAutoCompress } from './compression'
import { conversationCost, formatUsd, replyCosts } from './pricing'
import { parseConnectionResponse } from './connection'
import { parseImmersiveReply } from './immersive'
import { panelConversationMarkdown } from './export'
import { AutomationPanel } from './AutomationPanel'
import { ExpressionPanel } from './ExpressionPanel'
import { RecipePanel } from './RecipePanel'
import { CoursePanel } from './CoursePanel'
import { persistBrowserValue } from './storage'
import './style.css'

type Provider = 'openai' | 'anthropic' | 'gemini' | 'custom' | 'jev'
type Connection = { provider: Provider; baseUrl: string; apiKey: string; stream: boolean }
type Model = { id: string; name: string; provider: Provider; baseUrl: string; apiKey: string; modelId: string; stream: boolean; inputPerMillion?: number; outputPerMillion?: number }
type Reply = { modelId: string; content: string; error?: string; firstTokenMs?: number; durationMs?: number; usage?: { input?: number; output?: number; total?: number }; pricing?: { inputPerMillion?: number; outputPerMillion?: number }; attempted?: boolean }
type Turn = { id: string; prompt: string; user: string; replies: Record<number, Reply>; panelIndex?: number; historyLimit?: number; memorySnapshot?: Record<number, string>; summarySnapshot?: Record<number, string> }
type Slot = { modelId: string; startedAt: number }
type ReviewResult = { modelId: string; content: string; error?: string; analyzedAt: string }
type Chat = { id: string; title: string; turns: Turn[]; slots: Slot[]; promptDraft: string; welcomeInstruction?: string; welcomeReplies?: Record<number, Reply>; historyLimitDraft?: number; compressionPrompt?: string; compressionLimit?: number; compressionInterval?: number; lastAutoCompressionTurn?: Record<number, number>; memory?: Record<number, string>; summary?: Record<number, string>; reviewResults?: Record<number, ReviewResult>; sharedSourceId?: string }
type Store = { mode?: 'newapi' | 'free'; models: Model[]; connection: Connection; chats: Chat[]; activeId: string; panelCount: number; immersiveMode?: boolean; reviewModelId?: string; reviewPrompt?: string }
type SharedChatTemplate = { sourceId: string; title: string; promptDraft: string; welcomeInstruction: string; historyLimitDraft: number; compressionPrompt: string; compressionLimit: number; compressionInterval: number; modelIds: string[] }
type SharedSettings = { mode?: 'newapi' | 'free'; panelCount: number; immersiveMode: boolean; promptDraft: string; welcomeInstruction: string; historyLimitDraft: number; compressionPrompt: string; compressionLimit: number; compressionInterval: number; modelIds: string[]; reviewModelId?: string; reviewPrompt?: string; chatTemplates?: SharedChatTemplate[]; activeSourceId?: string }
type ConnectionResult = { ok: boolean; message: string; signature: string; durationMs?: number }
const uid = () => Math.random().toString(36).slice(2, 10)
const providerDefault: Record<Provider, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta', custom: '', jev: '' }
const freshChat = (models: Model[] = []): Chat => ({ id: uid(), title: '新对话', turns: [], slots: Array.from({ length: 5 }, (_, i) => ({ modelId: models[i]?.id || '', startedAt: 0 })), promptDraft: '', historyLimitDraft: 10, compressionPrompt: DEFAULT_COMPRESSION_PROMPT, compressionLimit: 10, compressionInterval: 10, lastAutoCompressionTurn: {} })
const initial = (): Store => { const chat = freshChat(); return { mode: 'free', models: [], connection: { provider: 'openai', baseUrl: providerDefault.openai, apiKey: '', stream: true }, chats: [chat], activeId: chat.id, panelCount: 3 } }
function load(): Store {
  try {
    const saved = JSON.parse(localStorage.getItem('model-studio-v1') || 'null') as Store
    if (saved?.chats?.length) {
      const legacy = saved.models?.[0]
      const connection = saved.connection || (legacy ? { provider: legacy.provider, baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, stream: legacy.stream } : { provider: 'openai' as Provider, baseUrl: providerDefault.openai, apiKey: '', stream: true })
      return { ...saved, models: saved.models, connection, panelCount: Math.min(5, Math.max(1, saved.panelCount || 3)), chats: saved.chats.map((chat) => ({ ...chat, compressionPrompt: chat.compressionPrompt === LEGACY_DEFAULT_COMPRESSION_PROMPT ? DEFAULT_COMPRESSION_PROMPT : chat.compressionPrompt, memory: typeof chat.memory === 'string' ? {} : chat.memory, summary: typeof chat.summary === 'string' ? {} : chat.summary, lastAutoCompressionTurn: typeof chat.lastAutoCompressionTurn === 'number' ? {} : chat.lastAutoCompressionTurn, slots: Array.from({ length: 5 }, (_, i) => chat.slots?.[i] || { modelId: '', startedAt: chat.turns.length }) })) }
    }
  } catch { /* new store */ }
  return initial()
}
const providerLabel: Record<Provider, string> = { openai: 'OpenAI 兼容协议', anthropic: 'Anthropic 兼容协议', gemini: 'Gemini 原生协议', custom: '自定义 · 直接请求', jev: 'JEV 兼容协议' }
const chatTemplate = (chat: Chat): SharedChatTemplate => ({ sourceId: chat.id, title: chat.title, promptDraft: chat.promptDraft, welcomeInstruction: chat.welcomeInstruction || '', historyLimitDraft: chat.historyLimitDraft ?? 10, compressionPrompt: chat.compressionPrompt ?? DEFAULT_COMPRESSION_PROMPT, compressionLimit: chat.compressionLimit ?? 10, compressionInterval: chat.compressionInterval ?? 10, modelIds: chat.slots.map((slot) => slot.modelId) })
const applyTemplate = (chat: Chat, template: SharedChatTemplate): Chat => {
  const changed = chat.slots.map((slot, index) => slot.modelId !== (template.modelIds[index] || ''))
  const clearChanged = (values?: Record<number, string>) => Object.fromEntries(Object.entries(values || {}).filter(([index]) => !changed[Number(index)]))
  return { ...chat, sharedSourceId: template.sourceId, title: template.title, promptDraft: template.promptDraft, welcomeInstruction: template.welcomeInstruction, historyLimitDraft: template.historyLimitDraft, compressionPrompt: template.compressionPrompt, compressionLimit: template.compressionLimit, compressionInterval: template.compressionInterval, slots: chat.slots.map((slot, index) => ({ modelId: template.modelIds[index] || '', startedAt: changed[index] ? chat.turns.length : slot.startedAt })), welcomeReplies: Object.fromEntries(Object.entries(chat.welcomeReplies || {}).filter(([index]) => !changed[Number(index)])) as Record<number, Reply>, memory: clearChanged(chat.memory), summary: clearChanged(chat.summary), lastAutoCompressionTurn: Object.fromEntries(chat.slots.map((slot, index) => [index, changed[index] ? chat.turns.length : chat.lastAutoCompressionTurn?.[index] ?? slot.startedAt])) }
}

function ReplyContent({ content, immersive }: { content: string; immersive: boolean }) {
  const items = immersive ? parseImmersiveReply(content) : null
  if (!items) return <div className="msg-content">{content}</div>
  return <div className="immersive-items">{items.map((item, index) => <div className={`immersive-bubble immersive-${item.type}`} key={index}><span className="immersive-kind">{item.type === 'correction' ? '纠错建议' : item.type === 'topic_change' ? '话题转换' : '回复'}</span><div>{item.content}</div></div>)}</div>
}

function App() {
  const [store, setStore] = useState<Store>(load)
  const [lanMode, setLanMode] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [isHostPage] = useState(() => ['localhost', '127.0.0.1'].includes(location.hostname))
  const [page, setPage] = useState<'chat' | 'settings' | 'review' | 'automation' | 'expression' | 'recipe' | 'course'>('chat')
  const [reviewChatId, setReviewChatId] = useState(store.activeId)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [modal, setModal] = useState(false)
  const [modalMode, setModalMode] = useState<'model' | 'connection' | 'all'>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState({ provider: 'openai' as Provider, name: '', apiKey: '', baseUrl: providerDefault.openai, modelIds: '', stream: true, inputPerMillion: '', outputPerMillion: '' })
  const [connectionBusy, setConnectionBusy] = useState<Record<string, boolean>>({})
  const [connectionResults, setConnectionResults] = useState<Record<string, ConnectionResult>>({})
  const [draft, setDraft] = useState('')
  const [panelDrafts, setPanelDrafts] = useState<Record<number, string>>({})
  const [expandedPanel, setExpandedPanel] = useState<number | null>(null)
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
  const [workspaceSaveFailed, setWorkspaceSaveFailed] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('model-studio-sidebar-collapsed') === 'true')
  const active = store.chats.find((c) => c.id === store.activeId) || store.chats[0]
  const connection = store.connection || (store.models[0] ? { provider: store.models[0].provider, baseUrl: store.models[0].baseUrl, apiKey: store.models[0].apiKey, stream: store.models[0].stream } : { provider: 'openai' as Provider, baseUrl: providerDefault.openai, apiKey: '', stream: true })
  const isLanClient = lanMode && !isHostPage
  const canAddModels = !isLanClient || !!connection.apiKey.trim()
  const withConnection = (model: Model): Model => store.mode === 'newapi' ? ({ ...model, baseUrl: connection.baseUrl, apiKey: connection.apiKey, stream: connection.stream }) : model
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
  useEffect(() => {
    fetch('/api/models').then((response) => response.json()).then((data: { shared: boolean; models: Model[]; settings: SharedSettings | null }) => {
      setLanMode(data.shared)
      if (data.shared && !isHostPage && !connection.apiKey.trim()) {
        setPage('settings')
        setEditing(null)
        setModalMode('connection')
        setForm({ provider: connection.provider, name: '', apiKey: '', baseUrl: connection.baseUrl, modelIds: '', stream: connection.stream, inputPerMillion: '', outputPerMillion: '' })
        setModal(true)
      }
      if (data.shared && !isHostPage) setStore((current) => {
        const models = data.models.map((model) => ({ ...model, apiKey: current.connection?.apiKey || '' }))
        const settings = data.settings
        if (!settings) return { ...current, models }
        const reviewModelId = settings.reviewModelId || (models.some((model) => model.id === current.reviewModelId) ? current.reviewModelId : '')
        const templates = settings.chatTemplates || []
        let chats = current.chats.map((chat) => {
          const template = templates.find((item) => item.sourceId === chat.sharedSourceId)
          if (template) return applyTemplate(chat, template)
          return { ...chat, compressionLimit: settings.compressionLimit, compressionInterval: settings.compressionInterval, ...(chat.turns.length ? {} : { promptDraft: settings.promptDraft, welcomeInstruction: settings.welcomeInstruction, historyLimitDraft: settings.historyLimitDraft, compressionPrompt: settings.compressionPrompt, slots: chat.slots.map((slot, index) => ({ ...slot, modelId: settings.modelIds[index] || '' })) }) }
        })
        let activeId = current.activeId
        if (templates.length) {
          const pristine = current.chats.length === 1 && !current.chats[0].turns.length && !current.chats[0].sharedSourceId && current.chats[0].title === '新对话' && !current.chats[0].promptDraft && !current.chats[0].welcomeInstruction && current.chats[0].slots.every((slot) => !slot.modelId)
          if (pristine) chats = []
          for (const template of templates) {
            if (!chats.some((chat) => chat.sharedSourceId === template.sourceId)) {
              const chat = applyTemplate(freshChat(models), template)
              chats.push(chat)
              if (pristine && template.sourceId === settings.activeSourceId) activeId = chat.id
            }
          }
          if (pristine && !chats.some((chat) => chat.id === activeId)) activeId = chats[0].id
        }
        return { ...current, mode: 'newapi', models, panelCount: settings.panelCount, immersiveMode: settings.immersiveMode, reviewModelId, reviewPrompt: settings.reviewPrompt || current.reviewPrompt || '', chats, activeId }
      })
    }).catch(() => {})
  }, [isHostPage])
  useEffect(() => {
    if (lanMode && !isHostPage && !connection.apiKey.trim() && !modal) {
      setPage('settings')
      showConnectionForm()
    }
  }, [lanMode, isHostPage, connection.apiKey, modal])
  useEffect(() => {
    try {
      let saved = persistBrowserValue(localStorage, 'model-studio-v1', store)
      if (!saved) {
        // Keep the active workspace usable when an old history has filled the
        // browser quota. Older chats are only a convenience and can be
        // trimmed before showing a save warning.
        const compact: Store = {
          ...store,
          chats: store.chats.map((chat) => chat.id === store.activeId ? chat : {
            ...chat,
            turns: chat.turns.slice(-3),
            welcomeReplies: undefined,
            memory: undefined,
            summary: undefined,
            reviewResults: undefined,
          }),
        }
        saved = persistBrowserValue(localStorage, 'model-studio-v1', compact)
      }
      setWorkspaceSaveFailed(!saved)
    }
    catch { setWorkspaceSaveFailed(true) }
  }, [store])
  useEffect(() => {
    try { persistBrowserValue(localStorage, 'model-studio-sidebar-collapsed', String(sidebarCollapsed)) }
    catch { return }
  }, [sidebarCollapsed])
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(''), 3200); return () => clearTimeout(t) } }, [notice])
  useEffect(() => { setPanelDrafts({}); setExpandedPanel(null) }, [active.id])
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
    chat.historyLimitDraft = previous.historyLimitDraft
    chat.compressionPrompt = previous.compressionPrompt
    chat.slots = previous.slots.map((slot) => ({ modelId: slot.modelId, startedAt: 0 }))
    setStore((s) => ({ ...s, chats: [chat, ...s.chats], activeId: chat.id }))
    setDraft(''); setPage('chat'); setPromptOpen(false)
    if (chat.welcomeInstruction?.trim()) generateWelcome(chat)
  }
  function deleteChat(id: string) { setStore((s) => { const chats = s.chats.filter((c) => c.id !== id); if (!chats.length) chats.push(freshChat(s.models)); return { ...s, chats, activeId: s.activeId === id ? chats[0].id : s.activeId } }) }
  function createAutomationChats(source: Chat, models: Array<{ id: string; name: string }>, _taskId: string, prompt: string) {
    const created = models.map((model) => {
      const configured = store.models.find((item) => item.id === model.id)
      if (!configured) throw new Error(`找不到模型：${model.id}`)
      const chat = freshChat([configured])
      chat.title = `${source.title} · 测试 · ${model.name}`
      chat.promptDraft = prompt
      chat.welcomeInstruction = source.welcomeInstruction
      chat.historyLimitDraft = source.historyLimitDraft
      chat.compressionPrompt = source.compressionPrompt
      chat.sharedSourceId = undefined
      return chat
    })
    setStore((s) => ({ ...s, chats: [...created, ...s.chats] }))
    return Object.fromEntries(created.map((chat, index) => [models[index].id, chat.id]))
  }
  function recordAutomationGreeting(chatId: string, modelId: string, content: string) {
    updateChat(chatId, (chat) => ({ ...chat, welcomeReplies: { 0: { modelId, content } } }))
  }
  function recordAutomationExchange(chatId: string, modelId: string, prompt: string, user: string, reply: string) {
    updateChat(chatId, (chat) => ({ ...chat, turns: [...chat.turns, { id: uid(), prompt, user, replies: { 0: { modelId, content: reply } } }] }))
  }
  function selectModel(index: number, modelId: string) { if (anyBusy) return; updateChat(active.id, (c) => { if (c.slots[index].modelId === modelId) return c; const slots = [...c.slots]; slots[index] = { modelId, startedAt: c.turns.length }; return { ...c, slots, welcomeReplies: { ...c.welcomeReplies, [index]: undefined } as Record<number, Reply>, memory: { ...c.memory, [index]: '' }, summary: { ...c.summary, [index]: '' }, lastAutoCompressionTurn: { ...c.lastAutoCompressionTurn, [index]: c.turns.length } } }); setPicker(null) }
  async function publishModels() {
    if (publishing) return
    setPublishing(true)
    try {
      const settings: SharedSettings = { mode: store.mode || 'free', panelCount: store.panelCount, immersiveMode: !!store.immersiveMode, promptDraft: active.promptDraft, welcomeInstruction: active.welcomeInstruction || '', historyLimitDraft: active.historyLimitDraft ?? 10, compressionPrompt: active.compressionPrompt ?? DEFAULT_COMPRESSION_PROMPT, compressionLimit: active.compressionLimit ?? 10, compressionInterval: active.compressionInterval ?? 10, modelIds: active.slots.map((slot) => slot.modelId), reviewModelId: store.reviewModelId || '', reviewPrompt: store.reviewPrompt || '', chatTemplates: store.chats.map(chatTemplate), activeSourceId: active.id }
      const response = await fetch('/api/models', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: store.models.map((model) => store.mode === 'newapi' ? ({ ...model, baseUrl: connection.baseUrl, apiKey: connection.apiKey, stream: connection.stream, modelId: model.name }) : ({ ...model, modelId: model.name })), settings }) })
      if (!response.ok) throw new Error((await response.json()).error || '发布失败')
      setNotice(`已发布 ${settings.chatTemplates!.length} 个对话的 Prompt 和工作空间设置`)
    } catch (error) { setNotice(error instanceof Error ? error.message : '发布失败') }
    finally { setPublishing(false) }
  }
  function showConnectionForm() { setEditing(null); setModalMode('connection'); setForm({ provider: connection.provider, name: '', apiKey: '', baseUrl: connection.baseUrl, modelIds: '', stream: connection.stream, inputPerMillion: '', outputPerMillion: '' }); setModal(true) }
  function showForm(model?: Model) {
    setEditing(model?.id || null)
    setModalMode(store.mode === 'newapi' ? 'model' : 'all')
    const current = model || connection
    setForm(model ? { provider: current.provider, name: model.name, apiKey: current.apiKey, baseUrl: current.baseUrl, modelIds: model.name, stream: current.stream, inputPerMillion: model.inputPerMillion?.toString() ?? '', outputPerMillion: model.outputPerMillion?.toString() ?? '' } : { provider: current.provider, name: '', apiKey: current.apiKey, baseUrl: current.baseUrl || providerDefault[current.provider], modelIds: '', stream: current.stream, inputPerMillion: '', outputPerMillion: '' })
    setConnectionResults((current) => { const { form: _form, ...rest } = current; void _form; return rest })
    setModal(true)
  }
  function connectionSignature(model: Pick<Model, 'provider' | 'baseUrl' | 'apiKey' | 'modelId' | 'stream'>) { return JSON.stringify([model.provider, model.baseUrl, model.apiKey, model.modelId, model.stream]) }
  async function testConnection(key: string, model: Model) {
    if (connectionBusy[key]) return
    const signature = connectionSignature(model)
    const startedAt = performance.now()
    setConnectionResults((current) => { const next = { ...current }; delete next[key]; return next })
    setConnectionBusy((current) => ({ ...current, [key]: true }))
    try {
      const url = new URL(model.baseUrl)
      if (!['https:', 'http:'].includes(url.protocol) || !model.apiKey || !model.modelId) throw new Error('请填完 API Key、接口地址和模型名称。')
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: withConnection(model), messages: [{ role: 'user', content: '请判断这条消息是否需要尽快处理。' }], systemPrompt: model.provider === 'jev' ? JSON.stringify({ is_urgent: { type: 'noul', instructions: '判断这条消息是否表达了需要尽快处理的紧迫性' } }) : '' }), signal: AbortSignal.timeout(30000) })
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
    const modelId = form.name.trim()
    void testConnection('form', { id: editing || '', name: form.name || modelId, provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), modelId, stream: form.stream })
  }
  function saveModels(e: FormEvent) {
    e.preventDefault()
    if (modalMode === 'connection') {
      if (!form.apiKey.trim() || !form.baseUrl.trim()) { setNotice('请填完 API Key 和接口地址'); return }
      try { const url = new URL(form.baseUrl); if (!['https:', 'http:'].includes(url.protocol)) throw new Error() } catch { setNotice('接口地址不是有效 URL'); return }
      setStore((s) => ({ ...s, connection: { provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), stream: form.stream }, models: s.mode === 'newapi' ? s.models.map((m) => ({ ...m, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() })) : s.models }))
      setModal(false); setNotice('Key 和 Base URL 已更新'); return
    }
    const name = form.name.trim()
    if (!name) { setNotice('请填写模型名称'); return }
    if (modalMode === 'all') {
      if (!form.apiKey.trim() || !form.baseUrl.trim()) { setNotice('请填完 API Key 和接口地址'); return }
      try { const url = new URL(form.baseUrl); if (!['https:', 'http:'].includes(url.protocol)) throw new Error() } catch { setNotice('接口地址不是有效 URL'); return }
    }
    const inputPrice = form.inputPerMillion.trim() === '' ? undefined : Number(form.inputPerMillion)
    const outputPrice = form.outputPerMillion.trim() === '' ? undefined : Number(form.outputPerMillion)
    if ([inputPrice, outputPrice].some((price) => price !== undefined && (!Number.isFinite(price) || price < 0))) { setNotice('价格需为不小于 0 的数字'); return }
    const id = editing || uid()
    const nextConnection = modalMode === 'model' ? connection : { provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), stream: form.stream }
    const model = { id, name, provider: form.provider, baseUrl: store.mode === 'newapi' ? connection.baseUrl : form.baseUrl.trim(), apiKey: store.mode === 'newapi' ? connection.apiKey : form.apiKey.trim(), modelId: name, stream: store.mode === 'newapi' ? connection.stream : form.stream, inputPerMillion: inputPrice, outputPerMillion: outputPrice }
    setStore((s) => { const changedModels = editing ? s.models.map((m) => m.id === editing ? model : m) : [...s.models, model]; const models = store.mode === 'newapi' ? changedModels.map((m) => ({ ...m, baseUrl: nextConnection.baseUrl, apiKey: nextConnection.apiKey, stream: nextConnection.stream })) : changedModels; return { ...s, connection: nextConnection, models, chats: editing ? s.chats : s.chats.map((chat) => ({ ...chat, slots: chat.slots.map((slot, i) => slot.modelId ? slot : { ...slot, modelId: i === 0 ? id : slot.modelId }) })) } })
    setModal(false); setNotice(editing ? '模型已更新' : '模型已添加')
  }
  function removeModel(id: string) { setStore((s) => ({ ...s, models: s.models.filter((m) => m.id !== id), chats: s.chats.map((c) => ({ ...c, slots: c.slots.map((slot) => slot.modelId === id ? { modelId: '', startedAt: c.turns.length } : slot), welcomeReplies: Object.fromEntries(Object.entries(c.welcomeReplies || {}).filter(([, reply]) => reply?.modelId !== id)) })) })) }
  function visibleTurns(chat: Chat, index: number) { return chat.turns.map((turn, turnIndex) => ({ turn, turnIndex })).filter(({ turn, turnIndex }) => (turn.panelIndex === undefined || turn.panelIndex === index) && turnIndex >= chat.slots[index].startedAt) }
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
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: withConnection(model), messages: context, systemPrompt: prompt }) })
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
    const contexts = targets.map(({ slot, index, model }) => { const welcome = active.welcomeReplies?.[index]; const sharedTurns = active.turns.filter((item) => item.panelIndex === undefined || item.panelIndex === index); return { index, model: model!, context: buildContext([...sharedTurns, turn], index, model!.id, slot.startedAt, sharedTurns.length, historyLimit, welcome?.modelId === model!.id && !welcome.error ? welcome.content : '') } })
    updateChat(chatId, (chat) => ({ ...chat, title: chat.title === '新对话' ? user.slice(0, 24) : chat.title, turns: [...chat.turns, turn] }))
    setDraft(''); setPromptOpen(false)
    contexts.forEach(({ index, model, context }) => void requestModel(chatId, turnId, index, model, context, renderSystemPrompt(prompt, context, user, active.memory?.[index] || '', active.summary?.[index] || '')))
  }
  function sendPanel(index: number) {
    const user = (panelDrafts[index] || '').trim()
    if (!user || isBusy(index)) return
    const slot = active.slots[index]
    const model = store.models.find((item) => item.id === slot.modelId)
    if (!model) { setNotice('请先为此面板选择模型'); return }
    const chatId = active.id
    const prompt = active.promptDraft
    const historyLimit = active.historyLimitDraft ?? 10
    const turn: Turn = { id: uid(), user, prompt, panelIndex: index, historyLimit, memorySnapshot: { ...active.memory }, summarySnapshot: { ...active.summary }, replies: { [index]: { modelId: model.id, content: '', attempted: true, pricing: { inputPerMillion: model.inputPerMillion, outputPerMillion: model.outputPerMillion } } } }
    const welcome = active.welcomeReplies?.[index]
    const sharedTurns = active.turns.filter((item) => item.panelIndex === undefined || item.panelIndex === index)
    const context = buildContext([...sharedTurns, turn], index, model.id, slot.startedAt, sharedTurns.length, historyLimit, welcome?.modelId === model.id && !welcome.error ? welcome.content : '')
    updateChat(chatId, (chat) => ({ ...chat, title: chat.title === '新对话' ? user.slice(0, 24) : chat.title, turns: [...chat.turns, turn] }))
    setPanelDrafts((current) => ({ ...current, [index]: '' }))
    setExpandedPanel(null)
    void requestModel(chatId, turn.id, index, model, context, renderSystemPrompt(prompt, context, user, active.memory?.[index] || '', active.summary?.[index] || ''))
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
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...withConnection(model), stream: false }, messages: [{ role: 'user', content: buildCompressionRequestContent(input, chat.memory?.[index] || '') }], systemPrompt: chat.compressionPrompt ?? DEFAULT_COMPRESSION_PROMPT }) })
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
  async function copyPanel(index: number, model?: Model) {
    const markdown = panelConversationMarkdown(active.title, model?.name || '未选择模型', model?.id || '', index, visibleTurns(active, index), active.welcomeReplies?.[index])
    try {
      await navigator.clipboard.writeText(markdown)
      setNotice('已复制此面板的 Markdown 对话记录')
    } catch {
      setNotice('复制失败，请检查剪贴板权限')
    }
  }
  async function analyzeConversation() {
    const chat = store.chats.find((item) => item.id === reviewChatId)
    const reviewer = store.models.find((item) => item.id === store.reviewModelId)
    if (!chat || !reviewer || !store.reviewPrompt?.trim() || reviewBusy) return
    const targets = chat.slots.slice(0, store.panelCount).map((slot, index) => {
      const model = store.models.find((item) => item.id === slot.modelId)
      const turns = visibleTurns(chat, index)
      const welcome = chat.welcomeReplies?.[index]
      if (!model || (!turns.length && !(welcome?.modelId === model.id && (welcome.content || welcome.error)))) return null
      return { index, model, markdown: panelConversationMarkdown(chat.title, model.name, model.id, index, turns, welcome) }
    }).filter((target): target is { index: number; model: Model; markdown: string } => !!target)
    if (!targets.length) { setNotice('所选对话没有可点评的模型记录'); return }
    setReviewBusy(true)
    updateChat(chat.id, (current) => ({ ...current, reviewResults: Object.fromEntries(Object.entries(current.reviewResults || {}).filter(([index]) => !targets.some((target) => target.index === Number(index)))) }))
    await Promise.all(targets.map(async ({ index, model, markdown }) => {
      let result: ReviewResult
      try {
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: { ...withConnection(reviewer), stream: false }, messages: [{ role: 'user', content: markdown }], systemPrompt: store.reviewPrompt }) })
        if (!response.ok) { const body = await response.json(); throw new Error(body.error || `点评失败 (${response.status})`) }
        const raw = await response.text()
        let content = ''
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as { delta?: string; error?: string }
          if (event.error) throw new Error(event.error)
          content += event.delta || ''
        }
        if (!content.trim()) throw new Error('测评模型没有返回内容')
        result = { modelId: model.id, content, analyzedAt: new Date().toISOString() }
      } catch (error) {
        result = { modelId: model.id, content: '', error: error instanceof Error ? error.message : '点评失败', analyzedAt: new Date().toISOString() }
      }
      updateChat(chat.id, (current) => ({ ...current, reviewResults: { ...current.reviewResults, [index]: result } }))
    }))
    setReviewBusy(false)
  }
  return <div className="app"><aside className={`sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}><div className="brand"><div className="brand-icon"><MessageSquare size={20} /></div><div><strong>Model Studio</strong><span>对话调试工作台</span></div><button className="sidebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'} title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}>{sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></div><button className="new-chat" onClick={newChat} title="新建对话"><Plus size={17} /> 新建对话 <kbd>⌘ K</kbd></button><div className="side-label">工作空间</div><button className={`side-link ${page === 'chat' ? 'active' : ''}`} onClick={() => setPage('chat')} title="对比工作台"><LayoutGrid size={18} /> 对比工作台</button><button className={`side-link ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')} title="模型与设置"><Settings2 size={18} /> 模型与设置 <span className="count">{store.models.length}</span></button><button className={`side-link ${page === 'review' ? 'active' : ''}`} onClick={() => { setReviewChatId(active.id); setPage('review') }} title="模型点评"><Sparkles size={18} /> 模型点评</button><button className={`side-link ${page === 'automation' ? 'active' : ''}`} onClick={() => setPage('automation')} title="回复效果测试"><RotateCcw size={18} /> 回复效果测试</button><button className={`side-link ${page === 'expression' ? 'active' : ''}`} onClick={() => setPage('expression')} title="表达评估测试"><Sparkles size={18} /> 表达评估测试</button><button className={`side-link ${page === 'recipe' ? 'active' : ''}`} onClick={() => setPage('recipe')} title="食谱生成效果测试"><Sparkles size={18} /> 食谱生成测试</button><button className={`side-link ${page === 'course' ? 'active' : ''}`} onClick={() => setPage('course')} title="课程生成调试器"><Sparkles size={18} /> 课程生成调试器</button><div className="side-label layout-label">显示模式</div><button className={`side-link immersive-toggle ${store.immersiveMode ? "active" : ""}`} onClick={() => setStore((current) => ({ ...current, immersiveMode: !current.immersiveMode }))} aria-pressed={!!store.immersiveMode} title="沉浸模式：将结构化回复拆成对话气泡"><MessageSquare size={18} /> 沉浸模式</button><div className="side-label layout-label">对话布局</div><div className="side-layout" aria-label="对话面板数量">{[1, 2, 3, 4, 5].map((count) => <button key={count} className={store.panelCount === count ? 'active' : ''} onClick={() => setStore((current) => ({ ...current, panelCount: count }))} aria-label={`${count} 个对话面板`} title={`${count} 个对话面板`}>{count}</button>)}</div><div className="side-divider" /><div className="side-label history-label">最近对话</div><div className="history">{store.chats.map((chat) => <div className={`history-row ${active.id === chat.id && page === 'chat' ? 'selected' : ''}`} key={chat.id}><button onClick={() => { setStore((s) => ({ ...s, activeId: chat.id })); setPage('chat') }}><MessageSquare size={15} /><span>{chat.title}</span></button><button className="delete-chat" title="删除对话" onClick={() => deleteChat(chat.id)}><Trash2 size={14} /></button></div>)}</div><div className="sidebar-footer"><div className="profile"><span className="profile-icon">M</span><span><strong>本地工作台</strong><small>仅保存在当前浏览器</small></span></div></div></aside><main className="main">{page !== 'chat' && <header className="topbar"><div className="breadcrumbs"><span>工作空间</span><span>/</span><strong>{page === 'review' ? '模型点评' : page === 'automation' ? '回复效果测试' : page === 'expression' ? '表达评估测试' : page === 'recipe' ? '食谱生成测试' : page === 'course' ? '课程生成调试器' : '模型与设置'}</strong></div></header>}{page === 'chat' ? <div className="workspace"><div className="panels" style={{ gridTemplateColumns: `repeat(${store.panelCount}, minmax(220px, 1fr))` }}>{Array.from({ length: store.panelCount }, (_, index) => { const slot = active.slots[index]; const model = store.models.find((m) => m.id === slot.modelId); const turns = visibleTurns(active, index); const welcome: Reply = active.welcomeReplies?.[index] || { modelId: '', content: '' }; const showWelcome = welcome?.modelId === model?.id && (welcome.content || welcome.error || isBusy(index)); const costSummary = conversationCost([...(welcome.modelId === model?.id ? [welcome] : []), ...active.turns.map((turn) => turn.replies[index]).filter(Boolean)].map((reply) => ({ ...reply, attempted: reply.attempted ?? Boolean(reply.content || reply.error || reply.durationMs) }))); return <section className="panel" key={`${active.id}-${index}`}><div className="panel-top"><span className="panel-index">0{index + 1}</span><div className="picker-wrap"><button className="picker-button" onClick={() => setPicker(picker === index ? null : index)}><span className={`model-icon ${model ? '' : 'no-model'}`}>{model ? model.name.slice(0, 1).toUpperCase() : <Plus size={16} />}</span><span>{model?.name || '选择模型'}</span><ChevronDown size={15} /></button>{picker === index && <div className="picker-menu"><div className="picker-label">选择模型</div>{store.models.map((item) => <button key={item.id} onClick={() => selectModel(index, item.id)}><span className="model-icon">{item.name.slice(0, 1).toUpperCase()}</span><span className="picker-name"><strong>{item.name}</strong><small>{providerLabel[item.provider]}</small></span>{item.id === model?.id && <Check size={16} />}</button>)}{!store.models.length && <div className="picker-empty">还没有配置模型</div>}{canAddModels && <button className="picker-add" onClick={() => { setPicker(null); setPage('settings'); showForm() }}><Plus size={16} /> 添加模型</button>}</div>}</div><button type="button" className="panel-copy" onClick={() => void copyPanel(index, model)} aria-label={`复制第 ${index + 1} 个面板的 Markdown 对话记录`} title="复制 Markdown 对话记录"><Copy size={14} /><span>复制</span></button></div><div className="panel-scroll">{turns.length || showWelcome ? <div className="messages">{showWelcome && <div className="turn welcome-turn"><div className={`message ai-message ${welcome.error ? 'has-error' : ''}`}><div className="msg-head"><span className="model-icon">{model?.name.slice(0, 1).toUpperCase() || 'AI'}</span><strong>{model?.name || '模型'}</strong><span className="prompt-mark">欢迎语</span></div><div className="msg-content">{welcome.error ? <><span className="error-title">请求失败</span><span>{welcome.error}</span></> : welcome.content ? <ReplyContent content={welcome.content} immersive={!!store.immersiveMode} /> : <span className="reply-loading"><span className="loading-spinner" />等待模型响应…</span>}</div><div className="msg-actions">{welcome.error && !active.turns.length ? <button onClick={() => retryWelcome(index)}><RotateCcw size={13} /> 重试</button> : welcome.content && <button onClick={() => { navigator.clipboard.writeText(welcome.content); setNotice('已复制回复') }}><Copy size={13} /> 复制</button>}</div></div></div>}{turns.map(({ turn, turnIndex }) => { const reply = turn.replies[index]; const pending = isBusy(index) && turnIndex === active.turns.length - 1; const shouldShow = reply?.modelId && (reply.content || reply.error || pending); const costs = replyCosts(reply?.usage, reply?.pricing); return <div className="turn" key={turn.id}><div className="message user-message"><div className="msg-head"><span className="user-icon">你</span><strong>你</strong><span>第 {turnIndex + 1} 轮</span></div><div className="msg-content">{turn.user}</div></div>{shouldShow && <div className={`message ai-message ${reply.error ? 'has-error' : ''}`}><div className="msg-head"><span className="model-icon">{model?.name.slice(0, 1).toUpperCase() || 'AI'}</span><strong>{model?.name || '模型'}</strong>{turn.prompt && <span className="prompt-mark" title={`本轮 Prompt：${turn.prompt}`}>Prompt</span>}</div><div className="msg-content">{reply.error ? <><span className="error-title">请求失败</span><span>{reply.error}</span></> : reply.content ? <ReplyContent content={reply.content} immersive={!!store.immersiveMode} /> : pending ? <span className="reply-loading" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" />等待模型响应…</span> : <span className="reply-loading">未收到回复</span>}</div><div className="reply-metrics">{isBusy(index) && turnIndex === active.turns.length - 1 ? <span>{reply.content ? '正在生成…' : '等待响应…'}</span> : <><span>耗时 {reply.durationMs === undefined ? '—' : `${(reply.durationMs / 1000).toFixed(2)}s`}</span><span>首字 {reply.firstTokenMs === undefined ? '—' : `${(reply.firstTokenMs / 1000).toFixed(2)}s`}</span><span title="由模型接口返回的实际用量；未提供时显示 —">Token 输入 {reply.usage?.input ?? '—'} / 输出 {reply.usage?.output ?? '—'} / 总计 {reply.usage?.total ?? (reply.usage?.input !== undefined && reply.usage?.output !== undefined ? reply.usage.input + reply.usage.output : '—')}</span><span title="本次回复的输出 token 成本；缺少用量或价格时显示 —">输出成本 {costs.output === null ? '—' : formatUsd(costs.output)}</span></>}</div><div className="msg-actions">{reply.error ? <button onClick={() => retry(index, turnIndex)}><RotateCcw size={13} /> 重试</button> : reply.content && <button onClick={() => { navigator.clipboard.writeText(reply.content); setNotice('已复制回复') }}><Copy size={13} /> 复制</button>}</div></div>}</div> })}<div ref={(el) => { bottomRefs.current[index] = el }} /></div> : <div className="empty-state"><div className="empty-graphic"><Sparkles size={27} /></div><h3>{model ? '等待你的第一个问题' : '选择一个模型开始'}</h3><p>{model ? '在下方输入问题，一次发送给所有模型。' : '点击上方菜单，选择已配置的模型。'}</p>{!model && <button onClick={() => { setPage('settings'); showForm() }}>配置模型 <ArrowRight size={14} /></button>}</div>}</div><div className="panel-bottom"><span><i className={isBusy(index) ? 'pulse' : ''} />{isBusy(index) ? ((turns.at(-1)?.turn.replies[index]?.content || welcome?.content) ? '正在生成' : '等待响应') : model ? '准备就绪' : '尚未配置'}</span><span className="panel-cost" title="本面板整个对话的输入加输出成本；统计不完整时标记部分未知">本次总成本 {formatUsd(costSummary.total)}{costSummary.incomplete ? ' · 部分未知' : ''}</span></div><div className={`panel-direct ${expandedPanel === index ? 'open' : ''}`}><button type="button" className="panel-direct-toggle" onClick={() => setExpandedPanel(expandedPanel === index ? null : index)} aria-expanded={expandedPanel === index} aria-label={expandedPanel === index ? '收起单独对话' : '展开单独对话'} title={expandedPanel === index ? '收起单独对话' : '单独与此模型对话'}>{expandedPanel === index ? <ChevronDown size={18} /> : <ChevronUp size={18} />}</button>{expandedPanel === index && <div className="panel-direct-form"><textarea rows={2} value={panelDrafts[index] || ''} onChange={(event) => setPanelDrafts((current) => ({ ...current, [index]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendPanel(index) } }} placeholder="发送单独的消息…" aria-label={`向${model?.name || '此模型'}发送单独消息`} /><button type="button" onClick={() => sendPanel(index)} disabled={!panelDrafts[index]?.trim() || isBusy(index)}><Send size={14} /> 发送</button></div>}</div></section> })}</div><div className="composer-area">{promptOpen && <div className="prompt-editor"><div><strong>本轮系统 Prompt</strong><span>下一轮默认沿用 · 支持变量</span></div><div className="prompt-variables" onMouseLeave={() => setPreviewVariable(null)}>{promptVariables.map((name) => <button type="button" key={name} className={previewVariable === name ? 'active' : ''} onMouseEnter={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPreviewTime(new Date().toISOString()); setPreviewVariable(name); setPreviewAnchor({ left: rect.left, top: rect.top }) }} onFocus={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPreviewTime(new Date().toISOString()); setPreviewVariable(name); setPreviewAnchor({ left: rect.left, top: rect.top }) }} onBlur={() => setPreviewVariable(null)} aria-label={`预览变量 ${name}`}>{'${' + name + '}'}</button>)}</div><textarea rows={3} value={active.promptDraft} onChange={(e) => updateChat(active.id, (c) => ({ ...c, promptDraft: e.target.value }))} placeholder="给所有模型的系统指令，例如：请简洁、准确地回答问题。" /><label className="context-limit">携带最近 <input type="number" min="0" max="100" step="1" value={active.historyLimitDraft ?? 10} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value <= 100) updateChat(active.id, (c) => ({ ...c, historyLimitDraft: value })) }} /> 轮上下文 <span>0 表示只发送本轮消息；最多 100 轮</span></label><div className="welcome-settings"><div className="welcome-heading"><strong>欢迎语</strong><span>仅新对话生成一次；指令不会进入聊天记录或压缩</span></div><div className="welcome-input-row"><textarea rows={2} value={active.welcomeInstruction || ''} onChange={(e) => updateChat(active.id, (c) => ({ ...c, welcomeInstruction: e.target.value }))} placeholder="输入生成欢迎语的指令；与本轮系统 Prompt 一起发送给 AI" /><button type="button" onClick={() => generateWelcome(active)} disabled={!active.welcomeInstruction?.trim() || !!active.turns.length || anyBusy}>生成欢迎语</button></div>{active.turns.length > 0 && <small>已有对话时不能生成欢迎语；请新建对话。</small>}</div><div className="compression-settings"><div className="compression-heading"><div><strong>上下文压缩</strong><span>各模型独立保存 memory 与 summary</span></div><button type="button" className="compress-button" onClick={manualCompress} disabled={activeCompressionBusy} title="手动压缩所有已保存对话中的模型对话"><Sparkles size={14} /> {activeCompressionBusy ? '正在压缩…' : '压缩全部对话'}</button></div><div className="compression-layout"><div className="compression-options"><div className="compression-controls"><label>压缩读取最近<input type="number" min="1" max="100" step="1" value={active.compressionLimit ?? 10} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= 100) updateChat(active.id, (c) => ({ ...c, compressionLimit: value })) }} /> 轮对话<span className="compression-help">本次压缩最多读取这些已完成对话</span></label></div><label className="compression-interval">自动压缩间隔 <input type="number" min="0" max="100" step="1" value={active.compressionInterval ?? 10} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value <= 100) updateChat(active.id, (c) => ({ ...c, compressionInterval: value, lastAutoCompressionTurn: Object.fromEntries(c.slots.map((_, index) => [index, c.turns.length])) })) }} /> 轮 <span>0 关闭；不足设定轮数时不生成</span></label><label className="compression-prompt-label">压缩 Prompt<textarea rows={3} value={active.compressionPrompt ?? DEFAULT_COMPRESSION_PROMPT} onChange={(e) => updateChat(active.id, (c) => ({ ...c, compressionPrompt: e.target.value }))} /></label></div><div className="compression-results">{active.slots.map((slot, index) => { const model = store.models.find((item) => item.id === slot.modelId); return model && <div className="compression-panel-result" key={index}><strong>0{index + 1} · {model.name}</strong><div className="compression-result"><label>memory<textarea rows={2} readOnly value={active.memory?.[index] || ''} placeholder="压缩后显示" /></label><label>summary<textarea rows={2} readOnly value={active.summary?.[index] || ''} placeholder="压缩后显示" /></label></div></div> })}</div></div></div></div>}<div className="composer"><textarea rows={2} placeholder="输入一个问题，看看不同模型会如何回答..." value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={keyDown} /><div className="composer-bottom"><button className={`composer-prompt ${promptOpen ? 'selected' : ''}`} onClick={() => setPromptOpen(!promptOpen)} title="编辑本轮系统 Prompt"><Pencil size={15} /> 本轮 Prompt {active.promptDraft && <i />}</button><span><kbd>↵</kbd> 发送 <kbd>⇧ ↵</kbd> 换行</span><button disabled={!draft.trim() || anyBusy} onClick={send}>发送消息 <Send size={16} /></button></div></div></div></div>  : page === 'review' ? <div className="review-page"><div className="eyebrow"><i /> YOUR WORKSPACE</div><div className="settings-heading"><div><h1>模型点评 <span>✳</span></h1><p>选择一个对话窗口，分别点评当前各模型面板的完整记录。</p></div><button onClick={() => setPage('chat')}><ArrowLeft size={16} /> 返回工作台</button></div><section className="settings-section review-settings"><h2>点评设置</h2><p>测评模型和 Prompt 在工作空间共用。对话记录作为用户消息发送给测评模型。</p><div className="review-fields"><label>测评模型<select value={store.reviewModelId || ''} onChange={(event) => setStore((current) => ({ ...current, reviewModelId: event.target.value }))}><option value="">选择已配置模型</option>{store.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>测评 Prompt<textarea rows={7} value={store.reviewPrompt || ''} onChange={(event) => setStore((current) => ({ ...current, reviewPrompt: event.target.value }))} placeholder="输入评价标准和输出要求…" /></label></div>{lanMode && <p>{isHostPage ? '修改后到“模型与设置”重新发布，局域网设备才能收到最新点评设置。' : '可选择主机已发布的模型并填写测评 Prompt；主机未发布点评设置时，你的选择会保存在当前浏览器，刷新后继续使用。主机发布的点评设置会在刷新时同步。'}</p>}</section><section className="settings-section review-conversation"><div className="review-run"><label>对话窗口<select value={store.chats.some((chat) => chat.id === reviewChatId) ? reviewChatId : store.chats[0]?.id || ''} onChange={(event) => setReviewChatId(event.target.value)}>{store.chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label><button className="add-button" type="button" onClick={() => void analyzeConversation()} disabled={reviewBusy || !store.reviewModelId || !store.reviewPrompt?.trim()}><Sparkles size={15} /> {reviewBusy ? '正在分析…' : '执行分析'}</button></div><p>使用与各面板“复制”按钮一致的 Markdown 记录；当前无记录的面板会跳过。再次分析会覆盖对应面板的旧结果。</p><div className="review-results" style={{ gridTemplateColumns: `repeat(${store.panelCount}, minmax(220px, 1fr))` }}>{(() => { const chat = store.chats.find((item) => item.id === reviewChatId) || store.chats[0]; return chat?.slots.slice(0, store.panelCount).map((slot, index) => { const model = store.models.find((item) => item.id === slot.modelId); const result = chat.reviewResults?.[index]; return <article className="review-card" key={index}><header><strong>0{index + 1} · {model?.name || '未选择模型'}</strong>{result && result.modelId === model?.id && <time>{new Date(result.analyzedAt).toLocaleString()}</time>}</header>{result && result.modelId === model?.id ? <div className={result.error ? 'review-error' : 'review-content'}>{result.error || result.content}</div> : <p>{reviewBusy ? '等待点评结果…' : '暂无点评结果'}</p>}</article> }) })()}</div></section></div> : page === 'expression' ? <div className="review-page expression-page"><div className="eyebrow"><i /> YOUR WORKSPACE</div><div className="settings-heading"><div><h1>表达评估测试 <span>✳</span></h1><p>固定对话与测评模型，比较多个评估模型的表达评估效果。</p></div><button onClick={() => setPage('chat')}><ArrowLeft size={16} /> 返回工作台</button></div><ExpressionPanel chats={store.chats} models={store.models} /></div> : page === 'recipe' ? <div className="review-page"><div className="eyebrow"><i /> YOUR WORKSPACE</div><div className="settings-heading"><div><h1>食谱生成测试 <span>✳</span></h1><p>选择多个计划 AI，使用一个测评 AI 评估生成结果。</p></div><button onClick={() => setPage('chat')}><ArrowLeft size={16} /> 返回工作台</button></div><RecipePanel models={store.models} /></div> : page === 'course' ? <div className="review-page"><div className="eyebrow"><i /> YOUR WORKSPACE</div><div className="settings-heading"><div><h1>课程生成调试器 <span>✳</span></h1><p>批量生成课程场景并汇总结果。</p></div><button onClick={() => setPage('chat')}><ArrowLeft size={16} /> 返回工作台</button></div><CoursePanel models={store.models.map(withConnection)} /></div>  : page === 'automation' ? <div className="review-page"><div className="eyebrow"><i /> YOUR WORKSPACE</div><div className="settings-heading"><div><h1>回复效果测试 <span>✳</span></h1><p>选择陪练模型，按测评集连续模拟对话并查看结果。</p></div><button onClick={() => setPage('chat')}><ArrowLeft size={16} /> 返回工作台</button></div><AutomationPanel chats={store.chats} models={store.models} onCreateTestChats={createAutomationChats} onTestGreeting={recordAutomationGreeting} onTestExchange={recordAutomationExchange} /></div> : <div className="settings-page"><div className="eyebrow"><i /> YOUR WORKSPACE</div><div className="settings-heading"><div><h1>模型与设置 <span>✳</span></h1><p>配置你的模型，建立自己的对话实验室。</p></div><button onClick={() => setPage('chat')}><ArrowLeft size={16} /> 返回工作台</button></div><div className="settings-mode-switch">{!isLanClient && <button className={store.mode !== 'newapi' ? 'active' : ''} onClick={() => setStore((current) => ({ ...current, mode: 'free' }))}>自由模式</button>}<button className={store.mode === 'newapi' ? 'active' : ''} onClick={() => setStore((current) => ({ ...current, mode: 'newapi' }))}>NewAPI 模式</button></div><div className="mode-actions">{lanMode && !isHostPage && <button className="add-button" onClick={showConnectionForm}><KeyRound size={17} /> 本机 API Key</button>}{!isLanClient && store.mode === 'newapi' && <button className="add-button" onClick={showConnectionForm}><KeyRound size={17} /> 管理 Key</button>}{canAddModels && <button className="add-button" onClick={() => showForm()}><Plus size={17} /> 新增模型</button>}{isHostPage && <button className="add-button" disabled={publishing} onClick={() => void publishModels()}>{publishing ? '正在发布…' : '一键发布所有 Prompt 和本地设置'}</button>}</div><div className="settings-section"><div className="section-top"><div><h2>已配置的模型 <span>{store.models.length}</span></h2><p>{store.mode === 'newapi' ? 'Key 和 Base URL 共用；每个模型单独设置名称、接入方式和价格。' : '每个模型独立设置完整接入信息。'}</p></div></div>{store.models.length ? <div className="model-list">{store.models.map((model) => <div className="model-row" key={model.id}><span className="row-icon">{model.name.slice(0, 1).toUpperCase()}</span><div className="row-main"><strong>{model.name}</strong><span>{model.modelId}</span></div><span className="protocol-pill">{providerLabel[model.provider]}</span><span className="stream-pill">{model.stream ? '流式' : '非流式'}</span><span className="price-pill">输入 {model.inputPerMillion === undefined ? '—' : `$${model.inputPerMillion}`} / 输出 {model.outputPerMillion === undefined ? '—' : `$${model.outputPerMillion}`} · 每百万</span><button className="model-test-button" title="测试连接" disabled={!!connectionBusy[model.id]} onClick={() => void testConnection(model.id, model)}>{connectionBusy[model.id] ? "测试中…" : "测试连接"}</button>{(!lanMode || isHostPage) && <><button title="编辑" onClick={() => showForm(model)}><Pencil size={16} /></button><button title="删除" onClick={() => removeModel(model.id)}><Trash2 size={16} /></button></>}</div>)}</div> : <div className="settings-empty"><div><KeyRound size={27} /></div><h3>还没有添加模型</h3><p>{store.mode === 'newapi' ? '先管理 Key 和 Base URL，再新增模型。' : '填写模型的完整接入信息后即可开始。'}</p>{canAddModels && <button onClick={() => showForm()}>添加第一个模型 <ArrowRight size={16} /></button>}</div>}<div className="connection-results">{store.models.map((model) => { const result = connectionResults[model.id]; return result && result.signature === connectionSignature(model) && <div className={`connection-result ${result.ok ? "success" : "error"}`} key={model.id} role="status"><strong>{model.name} · {result.ok ? `连接成功 · ${(result.durationMs! / 1000).toFixed(2)} 秒` : "连接失败"}</strong><span>{result.message}</span></div> })}</div><div className="settings-note"><ShieldCheck size={17} /> {lanMode ? '局域网设备共用主机发布的模型配置；每台设备使用自己的 API Key，聊天记录仍保存在各自浏览器。' : '模型配置和 API Key 仅保存在当前浏览器；清除浏览器数据会删除这些内容。'}</div></div></div>}</main>{modal && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(false) }}><div className="modal"><div className="modal-head"><div><span>MODEL CONFIGURATION</span><h2>{modalMode === 'connection' ? '管理 Key' : editing ? '编辑模型' : '新增模型'}</h2><p>{modalMode === 'connection' ? '设置 NewAPI 模式共用的 API Key 和 Base URL。' : modalMode === 'model' ? '填写模型名称、接入方式和价格。' : '填写该模型的完整接入信息。'}</p></div><button onClick={() => setModal(false)} aria-label="关闭"><X size={20} /></button></div><form className={`model-form form-${modalMode}`} onSubmit={saveModels}>
{modalMode !== 'connection' && <label>接入方式<select value={form.provider} onChange={(e) => { const provider = e.target.value as Provider; setForm((current) => ({ ...current, provider, ...(modalMode === 'all' ? { baseUrl: providerDefault[provider] } : {}) })) }}><option value="openai">OpenAI 兼容协议</option><option value="anthropic">Anthropic 兼容协议</option><option value="gemini">Gemini 原生协议</option><option value="custom">自定义（直接请求）</option><option value="jev">JEV 兼容协议</option></select></label>}
{modalMode !== 'model' && <><label>API Key<input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="输入你的 API Key" autoComplete="off" /><small>密钥只保存在当前浏览器。</small></label><label>{modalMode === 'all' && form.provider === 'custom' ? '完整接口 URL' : 'Base URL'}<input type="url" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://example.com/v1" />{modalMode === 'all' && <small>{form.provider === 'jev' ? 'JEV 自动追加 /typesafe/v1/systemone。' : form.provider === 'custom' ? '直接请求填写的完整 URL。' : '填写接口根地址，系统自动追加相应路径。'}</small>}</label></>}
{modalMode !== 'connection' && <><label>模型名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如：gpt-4o" /><small>名称会作为接口请求中的 model 参数。</small></label><div className="price-fields"><label>输入价格 · 美元 / 百万 token<input type="number" min="0" step="any" value={form.inputPerMillion} onChange={(e) => setForm({ ...form, inputPerMillion: e.target.value })} placeholder="例如 0.15" /></label><label>输出价格 · 美元 / 百万 token<input type="number" min="0" step="any" value={form.outputPerMillion} onChange={(e) => setForm({ ...form, outputPerMillion: e.target.value })} placeholder="例如 0.60" /></label></div></>}
{modalMode === 'all' && <label className="switch-row"><span><strong>流式响应</strong><small>接口不支持时可关闭。</small></span><input type="checkbox" checked={form.stream} onChange={(e) => setForm({ ...form, stream: e.target.checked })} /></label>}
<div className="modal-buttons">{modalMode === 'all' && <button type="button" className="form-test-button" onClick={testFormConnection} disabled={!!connectionBusy.form}>{connectionBusy.form ? '测试中…' : '测试连接'}</button>}<button type="button" onClick={() => setModal(false)}>取消</button><button type="submit"><Check size={16} /> {modalMode === 'connection' ? '保存 Key' : '保存模型'}</button></div>
{modalMode === 'all' && connectionResults.form && connectionResults.form.signature === connectionSignature({ provider: form.provider, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), modelId: form.name.trim(), stream: form.stream }) && <div className={`connection-result form-connection-result ${connectionResults.form.ok ? 'success' : 'error'}`} role="status"><strong>{connectionResults.form.ok ? `连接成功 · ${(connectionResults.form.durationMs! / 1000).toFixed(2)} 秒` : '连接失败'}</strong><span>{connectionResults.form.message}</span></div>}
</form></div></div>}{previewVariable && previewAnchor && createPortal(<div className={`variable-preview ${previewAnchor.top >= 270 ? 'preview-above' : 'preview-below'}`} role="status" style={{ left: Math.min(previewAnchor.left, window.innerWidth - Math.min(620, window.innerWidth - 24) - 12), top: previewAnchor.top >= 270 ? previewAnchor.top - 8 : previewAnchor.top + 26 }}><div className="variable-preview-title">{'${' + previewVariable + '}'} · 当前值</div><div className="variable-preview-grid">{variablePreviews.map(({ index, modelName, configured, values }) => <div className="variable-preview-card" key={index}><strong>0{index + 1} · {modelName}</strong><div>{!configured ? '选择模型后预览' : values[previewVariable] || (previewVariable === 'userInputlatest' ? '输入本轮消息后预览' : '当前为空')}</div></div>)}</div></div>, document.body)}{autoCompressionKeys.length > 0 && <div className="auto-compression-toast" role="status" aria-live="polite"><span className="loading-spinner" aria-hidden="true" /><span>正在自动压缩：{autoCompressionKeys.length} 个模型对话</span></div>}{workspaceSaveFailed && <div className="workspace-save-warning" role="alert">工作空间自动保存失败：当前内容仅保留在本窗口，请勿刷新或关闭，也不要清理浏览器数据；请先复制重要内容备份。</div>}{notice && <div className="toast"><Check size={16} /> {notice}</div>}</div>
}
createRoot(document.getElementById('root')!).render(<App />)
