import { requestModel as request } from './modelRequest'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, ChevronUp, Copy, Play, Square } from 'lucide-react'
import { exportResultsByType, filterResultsByType, modelPassSummary, parseTestCaseLists, recoverEvaluationResult, runPanelCases, settledTaskStatus } from './automation'
import type { TestCase, TestResult } from './automation'
import './automation.css'

type Model = { id: string; name: string; provider: string; baseUrl: string; apiKey: string; modelId: string; stream: boolean; inputPerMillion?: number; outputPerMillion?: number }
type ModelRef = { id: string; name: string }
type Chat = { id: string; title: string; promptDraft: string; welcomeInstruction?: string; turns: { id: string; user: string; prompt: string; replies: Record<number, { modelId: string; content: string; error?: string }>; panelIndex?: number }[]; slots: { modelId: string; startedAt: number }[]; welcomeReplies?: Record<number, { modelId: string; content: string; error?: string }>; historyLimitDraft?: number; memory?: Record<number, string>; summary?: Record<number, string> }
type Config = { chatId: string; conversationSource: 'new' | 'existing'; coachModelIds: string[]; replyModelId: string; replyPrompt: string; evaluationModelId: string; evaluationPrompt: string; contentList: string; purposeList: string }
type TestTask = { id: string; title: string; startedAt: string; status: 'running' | 'completed' | 'interrupted' | 'stopped'; total: number; config: Config; results: TestResult[] }
type Saved = { config: Config; tasks: TestTask[] }
const key = 'model-studio-automation-v1'
const draftKey = 'model-studio-automation-draft-v1'
const heartbeatPrefix = 'model-studio-automation-heartbeat-'
const heartbeatMaxAge = 120000
const taskControllers = new Map<string, AbortController>()
const taskHeartbeats = new Map<string, ReturnType<typeof setInterval>>()
const taskIsAlive = (taskId: string) => {
  const heartbeat = Number(localStorage.getItem(`${heartbeatPrefix}${taskId}`))
  return heartbeat > 0 && Date.now() - heartbeat < heartbeatMaxAge
}
window.addEventListener('storage', (event) => {
  if (event.key !== key || !event.newValue) return
  try {
    const tasks = (JSON.parse(event.newValue) as Saved).tasks
    for (const [taskId, controller] of taskControllers) {
      if (tasks.find((task) => task.id === taskId)?.status === 'stopped') controller.abort()
    }
  } catch { /* ignore invalid external storage */ }
})
const taskStatus = (status: TestTask['status']) => status === 'running' ? '运行中' : status === 'interrupted' ? '已中断' : status === 'stopped' ? '已终止' : '已完成'
function load(chats: Chat[]): Saved {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null') as Saved
    const draft = JSON.parse(localStorage.getItem(draftKey) || 'null') as Config | null
    const config = draft || value?.config
    if (config) {
      const chat = chats.find((item) => item.id === config.chatId)
      const legacy = config as Config & { panelIndexes?: number[]; cases?: TestCase[] }
      const coachModelIds = Array.isArray(config.coachModelIds)
        ? config.coachModelIds
        : (legacy.panelIndexes || []).map((index) => chat?.slots[index]?.modelId).filter((id): id is string => !!id)
      const migratedConfig = { ...config, conversationSource: config.conversationSource === 'existing' ? 'existing' as const : 'new' as const, coachModelIds, contentList: typeof config.contentList === 'string' ? config.contentList : (legacy.cases || []).map((item) => item.content).join('\n'), purposeList: typeof config.purposeList === 'string' ? config.purposeList : (legacy.cases || []).map((item) => item.purpose).join('\n') }
      const old = value as Saved & { results?: TestResult[]; startedAt?: string }
      const tasks: TestTask[] = Array.isArray(value?.tasks) ? value.tasks.map((task) => task.status === 'running' && !taskIsAlive(task.id) ? { ...task, status: 'interrupted' as const } : task) : old?.startedAt ? [{ id: old.startedAt, title: chat?.title || '历史测试', startedAt: old.startedAt, status: 'completed', total: old.results?.length || 0, config: migratedConfig, results: old.results || [] }] : []
      return { config: migratedConfig, tasks: tasks.map((task) => ({ ...task, status: task.status === 'completed' ? settledTaskStatus(task.status, task.results.length, task.total) : task.status, results: task.results.map(recoverEvaluationResult) })) }
    }
  } catch { /* use defaults */ }
  return { config: { chatId: chats[0]?.id || '', conversationSource: 'new', coachModelIds: [], replyModelId: '', replyPrompt: '', evaluationModelId: '', evaluationPrompt: '', contentList: '', purposeList: '' }, tasks: [] }
}

export function AutomationPanel({ chats, models, onCreateTestChats, onTestGreeting, onTestExchange }: { chats: Chat[]; models: Model[]; onCreateTestChats: (source: Chat, models: ModelRef[], taskId: string, coachPrompt: string) => Record<string, string>; onTestGreeting: (chatId: string, modelId: string, content: string) => void; onTestExchange: (chatId: string, modelId: string, prompt: string, user: string, reply: string) => void }) {
  const [saved, setSaved] = useState(() => load(chats))
  const savedRef = useRef(saved)
  const persistenceFailed = useRef(false)
  const [busy, setBusy] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({})
  const [resultTypeFilters, setResultTypeFilters] = useState<Record<string, string>>({})
  const [copyStatus, setCopyStatus] = useState<Record<string, string>>({})
  const [saveError, setSaveError] = useState(false)
  const config = saved.config
  const selectedTask = saved.tasks.find((task) => task.id === selectedTaskId)
  const chat = chats.find((item) => item.id === config.chatId) || chats[0]
  const parsedCases = parseTestCaseLists(config.contentList, config.purposeList)
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify(saved.config)); setSaveError(false) }
    catch { setSaveError(true) }
  }, [saved.config])
  useEffect(() => {
    const syncTasks = (event: StorageEvent) => {
      if (event.key !== key) return
      if (persistenceFailed.current) return
      const next = load(chats)
      savedRef.current = next
      setSaved(next)
    }
    window.addEventListener('storage', syncTasks)
    return () => window.removeEventListener('storage', syncTasks)
  }, [chats])
  const save = (next: Saved) => {
    savedRef.current = next
    setSaved(next)
    try { localStorage.setItem(key, JSON.stringify(next)); persistenceFailed.current = false }
    catch { persistenceFailed.current = true; setSaveError(true) }
  }
  const currentSaved = () => persistenceFailed.current ? savedRef.current : load(chats)
  const stopTask = (taskId: string) => {
    taskControllers.get(taskId)?.abort()
    const current = currentSaved()
    save({ ...current, tasks: current.tasks.map((item) => item.id === taskId && item.status === 'running' ? { ...item, status: 'stopped' } : item) })
  }
  const copyResults = async (taskId: string, modelId: string, type: '不通过' | '无法判断') => {
    const task = savedRef.current.tasks.find((item) => item.id === taskId)
    const content = exportResultsByType(task?.results.filter((result) => result.modelId === modelId) || [], type)
    if (!content) return
    const statusKey = `${taskId}:${modelId}:${type}`
    try {
      await navigator.clipboard.writeText(content)
      setCopyStatus((current) => ({ ...current, [statusKey]: '已复制' }))
    } catch {
      setCopyStatus((current) => ({ ...current, [statusKey]: '复制失败，请检查浏览器剪贴板权限' }))
    }
  }
  const update = (change: Partial<Config>) => {
    const nextConfig = { ...config, ...change }
    save({ ...savedRef.current, config: nextConfig })
    try { localStorage.setItem(draftKey, JSON.stringify(nextConfig)); setSaveError(false) }
    catch { setSaveError(true) }
  }
  const ready = !!chat && !!config.replyPrompt.trim() && !!config.evaluationPrompt.trim() && !!models.find((model) => model.id === config.replyModelId) && !!models.find((model) => model.id === config.evaluationModelId) && config.coachModelIds.some((id) => models.some((model) => model.id === id)) && parsedCases.cases.length > 0 && !parsedCases.error
  async function start() {
    if (!ready || busy || !chat) return
    const source = structuredClone(chat)
    const snapshot = structuredClone(config)
    const cases = parseTestCaseLists(snapshot.contentList, snapshot.purposeList).cases
    const replyModel = models.find((model) => model.id === snapshot.replyModelId)!
    const evaluationModel = models.find((model) => model.id === snapshot.evaluationModelId)!
    const selected = snapshot.coachModelIds.map((id) => ({ model: models.find((model) => model.id === id), index: source.slots.findIndex((slot) => slot.modelId === id) })).filter((item): item is { index: number; model: Model } => !!item.model)
    const startedAt = new Date().toISOString()
    const task: TestTask = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title: chat.title, startedAt, status: 'running', total: selected.length * cases.length, config: snapshot, results: [] }
    const coachPrompt = source.turns.at(-1)?.prompt ?? source.promptDraft ?? ''
    const testChatIds = snapshot.conversationSource === 'new' ? onCreateTestChats(source, selected.map(({ model }) => model), task.id, coachPrompt) : {}
    const controller = new AbortController()
    taskControllers.set(task.id, controller)
    const heartbeatKey = `${heartbeatPrefix}${task.id}`
    localStorage.setItem(heartbeatKey, String(Date.now()))
    taskHeartbeats.set(task.id, setInterval(() => localStorage.setItem(heartbeatKey, String(Date.now())), 2000))
    save({ ...savedRef.current, tasks: [task, ...savedRef.current.tasks] }); setBusy(true)
    const onResult = (result: TestResult) => {
      if (controller.signal.aborted) return
      const current = currentSaved()
      save({ ...current, tasks: current.tasks.map((item) => item.id === task.id && item.status === 'running' ? { ...item, results: [...item.results, result] } : item) })
    }
    try {
      const outcomes = await Promise.allSettled(selected.map(({ index, model }) => {
        const isNew = snapshot.conversationSource === 'new'
        const testChat = isNew ? {
          ...source,
          turns: [],
          slots: [{ modelId: model.id, startedAt: 0 }],
          welcomeReplies: {},
          memory: {},
          summary: {},
        } : source
        const testChatId = testChatIds[model.id]
        return runPanelCases({ chat: testChat, panelIndex: isNew ? 0 : index, model, cases, coachPrompt, greetingInstruction: isNew ? source.welcomeInstruction : undefined, replyPrompt: snapshot.replyPrompt, evaluationPrompt: snapshot.evaluationPrompt, replyModel, evaluationModel, request, onGreeting: testChatId ? (content) => onTestGreeting(testChatId, model.id, content) : undefined, onExchange: testChatId ? (user, reply) => onTestExchange(testChatId, model.id, coachPrompt, user, reply) : undefined, onResult, signal: controller.signal })
      }))
      for (const outcome of outcomes) if (outcome.status === 'rejected') console.error('[回复效果测试] 模型任务中断', outcome.reason)
    }
    finally {
      const current = currentSaved()
      save({ ...current, tasks: current.tasks.map((item) => item.id === task.id && item.status === 'running' ? { ...item, status: settledTaskStatus(item.status, item.results.length, item.total) } : item) })
      taskControllers.delete(task.id)
      clearInterval(taskHeartbeats.get(task.id))
      taskHeartbeats.delete(task.id)
      localStorage.removeItem(heartbeatKey)
      setBusy(false)
    }
  }
  if (selectedTask) return <section className="settings-section automation-section"><div className="automation-heading"><div><button className="automation-back" type="button" onClick={() => setSelectedTaskId(null)}><ArrowLeft size={15} /> 返回任务列表</button><h2>{selectedTask.title} · 测试结果</h2></div><span>{new Date(selectedTask.startedAt).toLocaleString()} · {selectedTask.results.length} / {selectedTask.total} · {taskStatus(selectedTask.status)}</span>{selectedTask.status === 'running' && <button className="automation-stop" type="button" onClick={() => stopTask(selectedTask.id)}><Square size={14} /> 终止任务</button>}</div><div className="automation-model-groups">{selectedTask.config.coachModelIds.map((modelId) => { const summary = modelPassSummary(selectedTask.results, modelId, parseTestCaseLists(selectedTask.config.contentList, selectedTask.config.purposeList).cases.length, models.find((item) => item.id === modelId)); const modelName = summary.results[0]?.modelName || models.find((item) => item.id === modelId)?.name || modelId; const filterKey = `${selectedTask.id}:${modelId}`; const typeFilter = resultTypeFilters[filterKey] || "all"; const visibleResults = filterResultsByType(summary.results, typeFilter); return <section className="automation-model-group" key={modelId}><div className="automation-model-summary"><div><h3>{modelName}</h3><span>已完成 {summary.results.length} / {summary.total} 组</span></div><div className="automation-model-summary-actions"><div className="automation-model-rates"><strong>通过 {summary.passed} / {summary.judged} · {summary.percent}%</strong><span>不通过 {summary.failed} / {summary.judged} · {summary.failedPercent}%</span><span>无法判断 {summary.undecided} / {summary.total} · {summary.undecidedPercent}%</span><span>通过用例平均分 {summary.averageScore === null ? "—" : `${summary.averageScore} / 100`} {summary.scored > 0 && `· 已评分 ${summary.scored} 组`}</span><span>陪练再次回复平均耗时 {summary.averageCoachReplyDurationMs === null ? "—" : `${(summary.averageCoachReplyDurationMs / 1000).toFixed(2)} 秒`}</span><span>陪练总消耗 {summary.usage.total ? `${summary.usage.total.toLocaleString()} tokens` : "—"}{summary.cost !== null && ` · $${summary.cost.toFixed(4)}`}</span></div><div className="automation-copy-actions"><button type="button" disabled={!summary.failed} onClick={() => void copyResults(selectedTask.id, modelId, "不通过")}><Copy size={13} /> 复制不通过完整行</button><button type="button" disabled={!summary.undecided} onClick={() => void copyResults(selectedTask.id, modelId, "无法判断")}><Copy size={13} /> 复制无法判断完整行</button>{["不通过", "无法判断"].map((type) => copyStatus[`${selectedTask.id}:${modelId}:${type}`] && <span role="status" key={type}>{type}：{copyStatus[`${selectedTask.id}:${modelId}:${type}`]}</span>)}</div><button type="button" aria-expanded={!!expandedModels[`${selectedTask.id}:${modelId}`]} aria-controls={`automation-results-${selectedTask.id}-${modelId}`} onClick={() => setExpandedModels((current) => ({ ...current, [`${selectedTask.id}:${modelId}`]: !current[`${selectedTask.id}:${modelId}`] }))}>{expandedModels[`${selectedTask.id}:${modelId}`] ? <><ChevronUp size={15} /> 收起</> : <><ChevronDown size={15} /> 展开</>}</button></div></div>{expandedModels[`${selectedTask.id}:${modelId}`] && <div className="automation-table-wrap" id={`automation-results-${selectedTask.id}-${modelId}`}><div className="automation-table-filter"><label>按 type 筛选<select value={typeFilter} onChange={(event) => setResultTypeFilters((current) => ({ ...current, [filterKey]: event.target.value }))}><option value="all">全部</option>{[...new Set(summary.results.map((result) => result.type).filter(Boolean))].map((type) => <option key={type} value={type}>{type}</option>)}{summary.results.some((result) => !result.type) && <option value="missing">无 type / 请求失败</option>}</select></label><span>显示 {visibleResults.length} / {summary.results.length} 组</span></div><table><thead><tr><th>陪练模型</th><th>用例 / 测试目的</th><th>陪练 AI 初始回复 · ${'${aiinputContent}'}</th><th>回复 AI 输入</th><th>陪练 AI 再次回复</th><th>测评 AI 原文</th><th>type</th><th>分数</th><th>analysis</th><th>状态</th></tr></thead><tbody>{visibleResults.map((result, index) => <tr key={`${result.modelId}-${result.caseId}-${index}`}><td>{result.modelName}</td><td><strong>{result.caseContent}</strong><br />{result.purpose}</td><td>{result.initialCoachReply}</td><td>{result.replyInput}</td><td>{result.coachReply}</td><td>{result.evaluation}</td><td>{result.type}</td><td>{typeof result.score === "number" ? result.score : "—"}</td><td>{result.analysis}</td><td>{result.error ? <><strong>{result.error}</strong>{result.evaluation && <details><summary>查看原始输出</summary><pre>{result.evaluation}</pre></details>}</> : '完成'}</td></tr>)}</tbody></table>{!visibleResults.length && <p>{summary.results.length ? "没有符合筛选条件的结果" : "暂无测试结果"}</p>}</div>}</section> })}</div></section>
  return <section className="settings-section automation-section"><div className="automation-heading"><h2>回复效果测试</h2><span className={saveError ? "automation-save-error" : "automation-save-status"} role="status">{saveError ? "自动保存失败：浏览器存储空间不足或被禁用" : "已自动保存在当前浏览器"}</span></div><p>从已配置模型中选择任意数量的陪练模型。每个模型都会创建独立的空白测试对话，不承接所选窗口或其他模型的历史；先用当前对话 Prompt 生成该模型的打招呼，再把打招呼作为首组测试的陪练 AI 输入。每个模型按用例顺序测试，测试消息不会写入原对话。请求超时或临时失败时自动重试最多 2 次；仍失败则记录该用例错误。<div className="automation-case-error" role="note"><strong>注意事项：</strong>回复 Prompt 负责生成回复，测评 Prompt 负责判断结果。两份 Prompt 的变量必须拼写完整；测评结果建议返回包含 <code>type</code>、<code>analysis</code>、<code>score</code> 的 JSON，其中 <code>type</code> 只能是“通过”“不通过”或“无法判断”，评分需符合对应规则。测试内容和测试目的必须逐行对应，不能缺行。</div></p><div className="automation-fields"><label>对话 Prompt 来源<select disabled={busy} value={config.chatId} onChange={(event) => update({ chatId: event.target.value })}>{chats.filter((item) => !item.title.includes(' · 测试 · ')).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>测试对话<select disabled={busy} value={config.conversationSource} onChange={(event) => update({ conversationSource: event.target.value as Config['conversationSource'] })}><option value="new">每个模型新建独立对话</option><option value="existing">复用选中对话上下文</option></select></label><label>回复模型<select disabled={busy} value={config.replyModelId} onChange={(event) => update({ replyModelId: event.target.value })}><option value="">选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label><label>测评模型<select disabled={busy} value={config.evaluationModelId} onChange={(event) => update({ evaluationModelId: event.target.value })}><option value="">选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div><fieldset className="automation-models" disabled={busy}><legend>陪练模型（已选 {config.coachModelIds.length} 个）</legend>{models.map((model) => { const index = chat?.slots.findIndex((slot) => slot.modelId === model.id) ?? -1; return <label key={model.id}><input type="checkbox" checked={config.coachModelIds.includes(model.id)} onChange={(event) => update({ coachModelIds: event.target.checked ? [...config.coachModelIds, model.id] : config.coachModelIds.filter((id) => id !== model.id) })} /> {model.name}{index >= 0 ? ` · 承接面板 ${index + 1}` : ' · 空历史'}</label> })}</fieldset><div className="automation-prompts"><label>回复 Prompt<textarea disabled={busy} rows={5} value={config.replyPrompt} onChange={(event) => update({ replyPrompt: event.target.value })} /></label><label>测评 Prompt<textarea disabled={busy} rows={5} value={config.evaluationPrompt} onChange={(event) => update({ evaluationPrompt: event.target.value })} /></label></div><p className="automation-variable-help">Prompt 变量：<code>${'${testContent}'}</code> 当前行测试内容 · <code>${'${testPurpose}'}</code> 当前行测试目的 · <code>${'${aiinputContent}'}</code> 本组开始时陪练 AI 的上一条回复 · <code>${'${aioutputContent}'}</code> 回复 AI 针对它生成的内容 · <code>${'${aiinputContent2}'}</code> 陪练 AI 再次生成的回复。回复 Prompt 和测评 Prompt 均可使用；回复 AI 运行前，后两个变量为空。</p><div className="automation-cases-head"><h3>测评集</h3><span>两列按行对应，一行一组</span></div><div className="automation-case-lists"><label>测试内容<textarea disabled={busy} rows={10} value={config.contentList} onChange={(event) => update({ contentList: event.target.value })} placeholder="每行一条测试内容" /></label><label>测试目的<textarea disabled={busy} rows={10} value={config.purposeList} onChange={(event) => update({ purposeList: event.target.value })} placeholder="每行一条测试目的，与左侧逐行对应" /></label></div>{parsedCases.error && <p className="automation-case-error" role="status">{parsedCases.error}</p>}<div className="automation-actions"><button className="add-button" disabled={!ready || busy} onClick={() => void start()}><Play size={15} /> {busy ? '测试中…' : '开始测试'}</button></div><div className="automation-results"><h3>测试任务</h3><div className="automation-task-list">{saved.tasks.map((task) => <div className="automation-task-row" key={task.id}><button className="automation-task" type="button" onClick={() => setSelectedTaskId(task.id)}><strong>{task.title}</strong><span>{new Date(task.startedAt).toLocaleString()}</span><span>{task.results.length} / {task.total} · {taskStatus(task.status)}</span></button>{task.status === 'running' && <button className="automation-stop" type="button" onClick={() => stopTask(task.id)}><Square size={14} /> 终止</button>}</div>)}{!saved.tasks.length && <p>还没有测试任务。点击“开始测试”创建第一条任务。</p>}</div></div></section>
}
