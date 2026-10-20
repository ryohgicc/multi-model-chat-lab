import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Play, Square } from 'lucide-react'
import { parseTestCaseLists } from './automation'
import type { Model } from './automation'
import { expressionCoachSource, expressionPerformance, runExpressionTest } from './expression'
import type { ExpressionConfig, ExpressionResult } from './expression'
import { requestModel } from './modelRequest'
import { createExpressionStorage, storageError } from './expressionStorage'
import './automation.css'

type Chat = { id: string; title: string; promptDraft: string; welcomeInstruction?: string; turns: Array<{ prompt: string }> }
type Task = { id: string; title: string; startedAt: string; status: 'running' | 'completed' | 'interrupted' | 'stopped'; total: number; config: ExpressionConfig; results: ExpressionResult[]; error?: string }
type Saved = { config: ExpressionConfig; tasks: Task[] }
const storageKey = 'model-studio-expression-v1'
const draftKey = 'model-studio-expression-draft-v1'
const changeEvent = 'model-studio-expression-change'
const heartbeatPrefix = 'model-studio-expression-heartbeat-'
const controllers = new Map<string, AbortController>()
let memory: Saved | undefined
let saveFailed = false
let draftSaveFailed = false
let draftSavedAt: string | null = null
let saveError = ''
let pendingSaves = 0
let storageReady = false
const expressionStorage = createExpressionStorage()
const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('model-studio-expression')
async function syncStorage() {
  if (pendingSaves || saveFailed || draftSaveFailed) return
  try {
    await expressionStorage.load([storageKey, draftKey])
    if (!pendingSaves) {
      const saved = read()
      for (const [id, controller] of controllers) {
        if (!saved.tasks.some((task) => task.id === id && task.status === 'running')) controller.abort()
      }
    }
  }
  catch (error) { saveError = storageError(error) }
  storageReady = true
  window.dispatchEvent(new Event(changeEvent))
}
channel?.addEventListener('message', () => { void syncStorage() })
void syncStorage()
const defaults: ExpressionConfig = { chatId: '', coachModelId: '', replyModelId: '', evaluationModelIds: [], assessmentModelId: '', rounds: 0, contentList: '', purposeList: '', coachPrompt: '', greetingInstruction: '', replyPrompt: '', evaluationPrompt: '', assessmentPrompt: '' }
const statusText = (status: Task['status']) => ({ running: '运行中', completed: '已完成', interrupted: '已中断', stopped: '已终止' })[status]

function read(): Saved {
  if (!memory || (!saveFailed && !draftSaveFailed)) {
    try {
      const stored = JSON.parse(expressionStorage.getItem(storageKey) || 'null') as Saved | null
      const config = { ...defaults, ...stored?.config }
      config.rounds = parseTestCaseLists(config.contentList, config.purposeList).cases.length
      memory = { config, tasks: (stored?.tasks || []).map((task) => ({ ...task, results: task.results.map((result) => ({ ...result, caseId: result.caseId || '1', testContent: result.testContent || '', testPurpose: result.testPurpose || '', analysisContent: result.analysisContent ?? result.output ?? '' })) })) }
    } catch { memory ??= { config: { ...defaults }, tasks: [] } }
  }
  if (!draftSaveFailed) {
    try {
      const draft = JSON.parse(expressionStorage.getItem(draftKey) || 'null') as ExpressionConfig | null
      if (draft && typeof draft === 'object' && !Array.isArray(draft)) {
        const config = { ...defaults, ...draft }
        config.rounds = parseTestCaseLists(config.contentList, config.purposeList).cases.length
        memory = { ...memory, config }
      }
    } catch { /* keep the previous config if the draft cannot be read */ }
  }
  let changed = false
  const tasks = memory.tasks.map((task) => {
    if (task.status !== 'running' || controllers.has(task.id)) return task
    let alive = false
    try { alive = Date.now() - Number(localStorage.getItem(heartbeatPrefix + task.id)) < 120000 } catch { /* no live owner */ }
    if (alive) return task
    changed = true
    return { ...task, status: 'interrupted' as const }
  })
  if (changed) memory = { ...memory, tasks }
  return memory
}
function write(next: Saved, saveDraft = false) {
  memory = next
  const persist = (key: string, value: unknown, draft: boolean) => {
    pendingSaves += 1
    void expressionStorage.setItem(key, JSON.stringify(value)).then(() => {
      if (draft) { draftSaveFailed = false; draftSavedAt = new Date().toLocaleTimeString() }
      else saveFailed = false
      channel?.postMessage('saved')
    }).catch((error) => {
      if (draft) draftSaveFailed = true
      else saveFailed = true
      saveError = storageError(error)
    }).finally(() => {
      pendingSaves -= 1
      window.dispatchEvent(new Event(changeEvent))
    })
  }
  if (saveDraft) persist(draftKey, next.config, true)
  persist(storageKey, next, false)
  window.dispatchEvent(new Event(changeEvent))
}
function changeTask(id: string, update: (task: Task) => Task) {
  const saved = read()
  write({ ...saved, tasks: saved.tasks.map((task) => task.id === id ? update(task) : task) })
}
function stop(id: string) {
  controllers.get(id)?.abort()
  changeTask(id, (task) => task.status === 'running' ? { ...task, status: 'stopped' } : task)
}
window.addEventListener('storage', (event) => {
  if (event.key !== storageKey && event.key !== draftKey && event.key !== null) return
  if (!saveFailed && !draftSaveFailed) memory = undefined
  const saved = read()
  if (event.key !== draftKey) {
    for (const [id, controller] of controllers) {
      if (!saved.tasks.some((task) => task.id === id && task.status === 'running')) controller.abort()
    }
  }
  window.dispatchEvent(new Event(changeEvent))
})

export function ExpressionPanel({ chats, models }: { chats: Chat[]; models: Model[] }) {
  const [saved, setSaved] = useState(read)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [modelFilters, setModelFilters] = useState<Record<string, string>>({})
  const [copyStatus, setCopyStatus] = useState('')
  const [modelCopyStatuses, setModelCopyStatuses] = useState<Record<string, string>>({})
  useEffect(() => {
    const sync = () => setSaved({ ...read() })
    const refresh = () => { void syncStorage(); sync() }
    window.addEventListener(changeEvent, sync)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    sync()
    const timer = setInterval(refresh, 10000)
    return () => {
      window.removeEventListener(changeEvent, sync)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      clearInterval(timer)
    }
  }, [])
  const config = saved.config
  const source = expressionCoachSource(chats, config.chatId)
  const busy = saved.tasks.some((task) => task.status === 'running')
  const selected = saved.tasks.find((task) => task.id === selectedId)
  const hasModel = (id: string) => models.some((model) => model.id === id)
  const parsedCases = parseTestCaseLists(config.contentList, config.purposeList)
  const ready = [config.coachModelId, config.replyModelId, config.assessmentModelId].every(hasModel)
    && config.evaluationModelIds.length > 0 && config.evaluationModelIds.every(hasModel)
    && !!source && [config.replyPrompt, config.evaluationPrompt, config.assessmentPrompt].every((prompt) => prompt.trim()) && !parsedCases.error && parsedCases.cases.length > 0
  const update = (change: Partial<ExpressionConfig>) => {
    const next = { ...read().config, ...change }
    next.rounds = parseTestCaseLists(next.contentList, next.purposeList).cases.length
    write({ ...read(), config: next }, true)
  }
  async function start() {
    if (!ready || busy || !source) return
    const snapshot = { ...structuredClone(config), ...source, rounds: parsedCases.cases.length }
    const caseCount = parseTestCaseLists(snapshot.contentList, snapshot.purposeList).cases.length
    const getModel = (id: string) => structuredClone(models.find((model) => model.id === id)!)
    const coachModel = getModel(snapshot.coachModelId)
    const replyModel = getModel(snapshot.replyModelId)
    const assessmentModel = getModel(snapshot.assessmentModelId)
    const evaluationModels = snapshot.evaluationModelIds.map(getModel)
    const task: Task = { id: crypto.randomUUID(), title: `${coachModel.name} · ${caseCount} 条用例 · ${snapshot.rounds} 轮 · ${evaluationModels.length} 个评估模型`, startedAt: new Date().toISOString(), status: 'running', total: caseCount * evaluationModels.length, config: snapshot, results: [] }
    const controller = new AbortController()
    controllers.set(task.id, controller)
    const heartbeat = () => { try { localStorage.setItem(heartbeatPrefix + task.id, String(Date.now())) } catch { /* in-memory task remains available */ } }
    heartbeat()
    const timer = setInterval(heartbeat, 10000)
    write({ ...read(), tasks: [task, ...read().tasks] })
    setSelectedId(task.id)
    try {
      await runExpressionTest({ config: snapshot, coachModel, replyModel, evaluationModels, assessmentModel, request: requestModel, signal: controller.signal, onResult: (result) => changeTask(task.id, (current) => current.status === 'running' ? { ...current, results: [...current.results, result] } : current) })
    } catch (error) {
      if (!controller.signal.aborted) changeTask(task.id, (current) => ({ ...current, error: error instanceof Error ? error.message : '测试失败' }))
    } finally {
      changeTask(task.id, (current) => current.status !== 'running' ? current : { ...current, status: current.results.length === current.total && !current.error ? 'completed' : 'interrupted' })
      clearInterval(timer)
      controllers.delete(task.id)
      try { localStorage.removeItem(heartbeatPrefix + task.id) } catch { /* storage may be disabled */ }
    }
  }
  async function copyResults(task: Task, modelId?: string) {
    const results = sortedResults(task).filter((result) => !modelId || result.evaluationModelId === modelId)
    const config = modelId ? { ...task.config, evaluationModelIds: [modelId] } : task.config
    const text = JSON.stringify({ config, results }, null, 2)
    const report = (message: string) => {
      if (modelId) setModelCopyStatuses((current) => ({ ...current, [`${task.id}:${modelId}`]: message }))
      else setCopyStatus(message)
    }
    try { await navigator.clipboard.writeText(text); report(modelId ? `已复制 ${results.length} 条结果 JSON` : '已复制完整结果 JSON') }
    catch { report('复制失败，请检查浏览器剪贴板权限') }
  }
  function sortedResults(task: Task) {
    return [...task.results].sort((a, b) => Number(a.caseId) - Number(b.caseId) || a.round - b.round || task.config.evaluationModelIds.indexOf(a.evaluationModelId) - task.config.evaluationModelIds.indexOf(b.evaluationModelId))
  }
  function modelSelect(label: string, field: 'coachModelId' | 'replyModelId' | 'assessmentModelId') {
    return <label>{label}<select disabled={busy} value={config[field]} onChange={(event) => update({ [field]: event.target.value })}><option value="">选择模型</option>{config[field] && !hasModel(config[field]) && <option value={config[field]}>模型已删除，请重新选择</option>}{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
  }
  if (!storageReady) return <section className="automation-section" role="status">正在读取表达评估草稿与历史任务…</section>
  const saveStatus = <span className={saveFailed || draftSaveFailed ? 'automation-save-error' : 'automation-save-status'} role="status">{pendingSaves ? '正在保存，请勿刷新…' : draftSaveFailed ? `表单自动保存失败，请保留当前窗口并备份填写内容（${saveError}）` : saveFailed ? `测试结果保存失败，请备份（${saveError}）` : draftSavedAt ? `表单已自动保存 · ${draftSavedAt}` : '已载入当前浏览器保存的内容'}</span>
  if (selected) {
    const results = sortedResults(selected)
    const modelFilter = modelFilters[selected.id] || ''
    const visibleResults = modelFilter ? results.filter((result) => result.evaluationModelId === modelFilter) : results
    const evaluationModelIds = [...new Set([...selected.config.evaluationModelIds, ...results.map((result) => result.evaluationModelId)])]
    return <section className="automation-section">
      <button className="automation-back" onClick={() => { setSelectedId(null); setCopyStatus('') }}><ArrowLeft size={14} /> 返回表达评估测试</button>
      <div className="automation-heading"><h2>{selected.title}</h2><span>{selected.results.length} / {selected.total} · {statusText(selected.status)}</span>{saveStatus}{selected.status === 'running' && <button className="automation-stop" onClick={() => stop(selected.id)}><Square size={14} /> 终止</button>}</div>
      <p>陪练：{models.find((model) => model.id === selected.config.coachModelId)?.name || selected.config.coachModelId} · 回复：{models.find((model) => model.id === selected.config.replyModelId)?.name || selected.config.replyModelId} · 测评：{models.find((model) => model.id === selected.config.assessmentModelId)?.name || selected.config.assessmentModelId} · {new Date(selected.startedAt).toLocaleString()}</p>
      {selected.error && <p className="automation-case-error" role="alert">{selected.error}</p>}
      <div className="expression-summaries">{evaluationModelIds.map((id) => {
        const rows = results.filter((result) => result.evaluationModelId === id)
        const scored = rows.filter((result) => !result.error && result.score !== undefined)
        const average = scored.length ? (scored.reduce((sum, result) => sum + result.score!, 0) / scored.length).toFixed(1) : '—'
        const modelName = rows[0]?.evaluationModelName || models.find((model) => model.id === id)?.name || id
        const metrics = expressionPerformance(rows)
        const duration = metrics.averageDurationMs === null ? '—' : `${(metrics.averageDurationMs / 1000).toFixed(2)} 秒`
        const cost = metrics.averageCost === null ? '—' : `$${metrics.averageCost.toFixed(6)}`
        return <div key={id}><strong>{modelName}</strong><span>平均分 {average} · 平均点评响应 {duration}/条 · 平均费用 {cost}/条</span><span title={`响应时间仅统计评估模型的点评 Prompt，不包含测评模型的结论 Prompt；包含点评重试等待。耗时样本 ${metrics.timedCount} 条，费用样本 ${metrics.pricedCount} 条，缺少用量或单价时不估算费用`}>已评分 {scored.length}/{selected.total / selected.config.evaluationModelIds.length} · 错误 {rows.filter((result) => result.error).length}</span><div className="automation-copy-actions"><button type="button" className="add-button" aria-label={`复制 ${modelName} 的结果`} disabled={!rows.length} onClick={() => void copyResults(selected, id)}><Copy size={14} /> 复制该模型结果</button><span role="status">{modelCopyStatuses[`${selected.id}:${id}`] || ''}</span></div></div>
      })}</div>
      <details className="expression-config"><summary>查看本次 Prompt 配置</summary>{(['coachPrompt', 'greetingInstruction', 'replyPrompt', 'evaluationPrompt', 'assessmentPrompt', 'contentList', 'purposeList'] as const).map((field, index) => <div key={field}><strong>{['陪练 Prompt', '欢迎语指令', '回复 Prompt', '评估 Prompt', '测评 Prompt', '测试内容列表', '测试目的列表'][index]}</strong><pre>{selected.config[field] || '（默认）'}</pre></div>)}</details>
      <div className="automation-actions"><button className="add-button" disabled={!results.length} onClick={() => void copyResults(selected)}><Copy size={14} /> 复制完整结果</button><span role="status">{copyStatus}</span></div>
      <div className="automation-table-filter"><label>评估模型筛选<select value={modelFilter} onChange={(event) => setModelFilters((current) => ({ ...current, [selected.id]: event.target.value }))}><option value="">全部评估模型</option>{evaluationModelIds.map((id) => <option key={id} value={id}>{results.find((result) => result.evaluationModelId === id)?.evaluationModelName || models.find((model) => model.id === id)?.name || id}</option>)}</select></label><span>显示 {visibleResults.length} / {results.length} 条结果</span></div>
      <div className="automation-table-wrap"><table><thead><tr>{['用例 / 轮次', '测试内容 · testContent', '测试目的 · testPurpose', '评估模型', '陪练上一条回复 · aiinputContent', '回复 AI 内容 · aioutputContent', '评估点评 · analysisContent', '评分 · score', '结论 · conclusion', '状态'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{visibleResults.map((result) => <tr key={`${result.caseId}:${result.round}:${result.evaluationModelId}`}><td>用例 {result.caseId} · 第 {result.round} 轮</td><td>{result.testContent || '—'}</td><td>{result.testPurpose || '—'}</td><td>{result.evaluationModelName}</td><td>{result.aiinputContent}</td><td>{result.aioutputContent}</td><td>{result.analysisContent}</td><td>{result.score ?? '—'}</td><td>{result.conclusion || '—'}</td><td>{result.error ? <><strong>{result.error}</strong>{result.assessment && <details><summary>查看测评原文</summary><pre>{result.assessment}</pre></details>}</> : '完成'}</td></tr>)}</tbody></table>{!visibleResults.length && <p>{modelFilter ? (selected.status === 'running' ? '该评估模型暂无结果，请等待评估完成…' : '该评估模型暂无结果') : selected.status === 'running' ? '正在生成首轮对话与评估…' : '暂无结果'}</p>}</div>
    </section>
  }
  return <section className="automation-section">
    <div className="automation-heading"><h2>表达评估测试</h2>{saveStatus}</div>
    <div className="automation-actions"><button type="button" className="add-button" onClick={() => write({ ...read(), config }, true)}>立即保存表单 / 重试</button><button type="button" className="add-button" onClick={() => { const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `表达评估表单-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }}>下载表单备份</button></div>
    <p>固定一个陪练模型、一个回复模型和一个测评模型，勾选多个评估模型。每轮先生成一份共同的对话内容，各评估模型分别评估，随后由测评模型分别输出评分与结论。每轮按顺序使用一条测评用例，陪练承接上一轮回复生成下一轮输入；总轮数自动等于用例数量。</p>
    <div className="automation-fields">
      <label>对话 Prompt 来源<select disabled={busy || !source} value={source?.chatId || ''} onChange={(event) => update({ chatId: event.target.value })}>{!source && <option value="">暂无可用对话，请先新建对话</option>}{chats.filter((chat) => !chat.title.includes(' · 测试 · ')).map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
      {modelSelect('陪练模型', 'coachModelId')}{modelSelect('回复模型', 'replyModelId')}{modelSelect('测评模型', 'assessmentModelId')}
      <div className="expression-round-count" role="status">回复轮次：{parsedCases.cases.length} 轮（与有效用例数量一致）</div>
    </div>

    <fieldset className="automation-models" disabled={busy}><legend>评估模型（已选 {config.evaluationModelIds.length} 个）</legend>{models.map((model) => <label key={model.id}><input type="checkbox" checked={config.evaluationModelIds.includes(model.id)} onChange={(event) => update({ evaluationModelIds: event.target.checked ? [...config.evaluationModelIds, model.id] : config.evaluationModelIds.filter((id) => id !== model.id) })} /> {model.name}</label>)}{config.evaluationModelIds.filter((id) => !hasModel(id)).map((id) => <label key={id}><input type="checkbox" checked onChange={() => update({ evaluationModelIds: config.evaluationModelIds.filter((selected) => selected !== id) })} /> 已删除模型（请取消选择）：{id}</label>)}{!models.length && <span>请先在“模型与设置”中添加模型。</span>}</fieldset>
    <div className="automation-prompts">
      <label>陪练 Prompt（来自所选对话）<textarea readOnly rows={5} value={source?.coachPrompt || ''} placeholder="从所选对话自动读取，请在对话窗口中修改" /></label>
      <label>陪练欢迎语指令（来自所选对话）<textarea readOnly rows={2} value={source?.greetingInstruction || ''} placeholder="所选对话未设置时，默认让陪练按 Prompt 打招呼" /></label>
      {(['replyPrompt', 'evaluationPrompt', 'assessmentPrompt'] as const).map((field, index) => <label key={field}>{['回复 Prompt', '评估 Prompt（所有评估模型共用）', '测评 Prompt'][index]}<textarea disabled={busy} rows={5} value={config[field]} onChange={(event) => update({ [field]: event.target.value })} /></label>)}
    </div>
    <p className="automation-variable-help">回复、评估和测评 Prompt 支持 <code>{'${aiinputContent}'}</code> 陪练上一条回复、<code>{'${aioutputContent}'}</code> 本轮回复、<code>{'${analysisContent}'}</code> 评估 AI 针对回复内容的点评、<code>{'${testContent}'}</code> 当前行测试内容、<code>{'${testPurpose}'}</code> 当前行测试目的、<code>{'${round}'}</code> 当前轮次；也兼容 $${'{变量名}'} 写法。尚未生成的值为空。旧变量 output、evaluationResult 仍可引用同一点评。测评必须返回数字 score 与字符串 conclusion 的 JSON 对象，评分标准由测评 Prompt 指定。</p><div className="automation-case-error" role="note"><strong>注意事项：</strong>必须选择陪练、回复、测评模型，并至少勾选一个评估模型。测试内容和测试目的按行一一对应。测评 Prompt 必须要求返回 JSON，并包含数字 <code>score</code> 和非空字符串 <code>conclusion</code>；评估 Prompt 生成点评，测评 Prompt 再评价点评质量。</div>
    <p>每次测试新建独立对话上下文，各轮连续承接历史，测试内容和测试目的会传给回复 AI 与测评 AI。评估模型共享相同输入与回复；评估和测评结果保留在测试列表中。临时请求失败最多重试 2 次，单个评估或测评失败会记录错误并继续。</p>
    <div className="automation-cases-head"><h3>测评集</h3><span>两列按行对应，一行一轮，共 {parsedCases.cases.length} 轮</span></div>
    <div className="automation-case-lists"><label>测试内容<textarea disabled={busy} rows={8} value={config.contentList} onChange={(event) => update({ contentList: event.target.value })} placeholder="每行一条测试内容" /></label><label>测试目的<textarea disabled={busy} rows={8} value={config.purposeList} onChange={(event) => update({ purposeList: event.target.value })} placeholder="每行一条测试目的，与左侧逐行对应" /></label></div>
    {parsedCases.error && <p className="automation-case-error" role="status">{parsedCases.error}</p>}
    <div className="automation-actions"><button className="add-button" disabled={!ready || busy} onClick={() => void start()}><Play size={15} /> {busy ? '测试中…' : '开始测试'}</button></div>
    <div className="automation-results"><h3>测试任务</h3><div className="automation-task-list">{saved.tasks.map((task) => <div className="automation-task-row" key={task.id}><button className="automation-task" onClick={() => { setSelectedId(task.id); setCopyStatus('') }}><strong>{task.title}</strong><span>{new Date(task.startedAt).toLocaleString()}</span><span>{task.results.length} / {task.total} · {statusText(task.status)}</span></button>{task.status === 'running' && <button className="automation-stop" onClick={() => stop(task.id)}><Square size={14} /> 终止</button>}</div>)}{!saved.tasks.length && <p>还没有表达评估任务。填写四个角色的模型和 Prompt 后开始测试。</p>}</div></div>
  </section>
}
