import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Play, Square } from 'lucide-react'
import type { Model } from './automation'
import { courseSceneName, courseScenes, runCourseGeneration } from './course'
import type { CourseConfig, CourseResult } from './course'
import { requestModelDebug } from './modelRequest'
import { CourseResultView } from './CourseResultView'
import './automation.css'

type Task = { id: string; startedAt: string; status: 'running' | 'completed' | 'stopped' | 'interrupted'; config: CourseConfig; results: CourseResult[] }
const defaults: CourseConfig = { modelId: '', prompt: '', category: '', theme: '', sceneNames: '' }
const key = 'model-studio-course-v1'
function load(): { config: CourseConfig; tasks: Task[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    return { config: { ...defaults, ...saved?.config }, tasks: (saved?.tasks || []).map((task: Task) => ({ ...task, status: task.status === 'running' ? 'interrupted' : task.status })) }
  } catch { return { config: defaults, tasks: [] } }
}

export function CoursePanel({ models }: { models: Model[] }) {
  const [saved, setSaved] = useState(load)
  const [selected, setSelected] = useState<string | null>(null)
  const [controller, setController] = useState<AbortController | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const config = saved.config
  const task = saved.tasks.find((item) => item.id === selected)
  const busy = !!controller
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(saved)) } catch { setError('浏览器存储空间不足，结果可能无法在刷新后恢复') } }, [saved])
  const update = (change: Partial<CourseConfig>) => setSaved((current) => ({ ...current, config: { ...current.config, ...change } }))
  const ready = !!models.find((model) => model.id === config.modelId) && !!config.prompt.trim() && !!config.category.trim() && !!config.theme.trim() && courseScenes(config.sceneNames).length > 0

  async function start() {
    if (!ready || busy) return
    setError('')
    const snapshot = structuredClone(config)
    const model = models.find((item) => item.id === snapshot.modelId)!
    const next: Task = { id: crypto.randomUUID(), startedAt: new Date().toISOString(), status: 'running', config: snapshot, results: [] }
    const abort = new AbortController()
    setController(abort)
    setSelected(next.id)
    setSaved((current) => ({ ...current, tasks: [next, ...current.tasks] }))
    try {
      await runCourseGeneration({ config: snapshot, model, request: requestModelDebug, signal: abort.signal, onResult: (result) => setSaved((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === next.id ? { ...item, results: [...item.results, result] } : item) })) })
    } finally {
      setSaved((current) => ({ ...current, tasks: current.tasks.map((item) => item.id === next.id ? { ...item, status: abort.signal.aborted ? 'stopped' : 'completed' } : item) }))
      setController(null)
    }
  }

  async function copyResults() {
    if (!task) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(task.results.map((result) => ({ scene_name: result.sceneName, result: result.output ?? null, error: result.error ?? null, attempts: result.attempts ?? 1, request: { systemPrompt: result.prompt, userMessage: result.requestContent }, response: result.response ?? result.raw })), null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { setError('复制失败，请检查浏览器剪贴板权限') }
  }

  if (task) return <section className="automation-section"><button className="automation-back" onClick={() => setSelected(null)}><ArrowLeft size={14} /> 返回课程生成调试器</button><div className="automation-heading"><h2>课程生成结果</h2><span>{task.results.length} / {courseScenes(task.config.sceneNames).length} · {task.status === 'completed' ? '已完成' : task.status === 'running' ? '运行中' : task.status === 'stopped' ? '已终止' : '已中断'}</span></div><div className="automation-actions"><button className="add-button" onClick={() => void copyResults()}><Copy size={14} /> {copied ? '已复制' : '复制结果 JSON'}</button>{busy && <button className="automation-stop" onClick={() => controller.abort()}><Square size={14} /> 终止</button>}</div>{error && <p className="automation-case-error" role="alert">{error}</p>}<div className="automation-table-wrap"><table className="course-results-table"><thead><tr><th>scene_name</th><th>状态</th><th>课程结果</th><th>请求与返回</th></tr></thead><tbody>{courseScenes(task.config.sceneNames).map((scene, index) => { const result = task.results[index]; return <tr key={index}><td>{result?.sceneName || courseSceneName(task.config, scene)}</td><td>{result ? <>{result.error ? <span className="course-error">{result.error}</span> : '完成'}{(result.attempts ?? 1) > 1 && <small className="course-attempts">请求 {result.attempts} 次</small>}</> : '等待中'}</td><td>{result ? <CourseResultView result={result} /> : '—'}</td><td>{result ? <details><summary>查看请求与返回</summary><pre>{JSON.stringify({ request: { systemPrompt: result.prompt, userMessage: result.requestContent }, response: result.response ?? result.raw }, null, 2)}</pre></details> : '—'}</td></tr> })}</tbody></table></div></section>

  return <section className="automation-section"><div className="automation-heading"><h2>课程生成调试器</h2><span>表单与结果保存在当前浏览器</span></div><div className="automation-fields"><label>生成模型<select value={config.modelId} onChange={(event) => update({ modelId: event.target.value })}><option value="">选择模型</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label></div><div className="course-fields"><label>课程生成 Prompt<textarea rows={10} value={config.prompt} onChange={(event) => update({ prompt: event.target.value })} placeholder="输入课程生成指令，可使用 ${scene_name} 和 ${theme_scene_list}" /></label><div className="course-scene-fields"><label>分类<input value={config.category} onChange={(event) => update({ category: event.target.value })} placeholder="例如：职场" /></label><label>主题<input value={config.theme} onChange={(event) => update({ theme: event.target.value })} placeholder="例如：求职面试" /></label><label>场景（一行一个）<textarea rows={6} value={config.sceneNames} onChange={(event) => update({ sceneNames: event.target.value })} placeholder={'面试自我介绍\n追问岗位职责'} /></label></div></div><p className="automation-variable-help">Prompt 变量：<code>${'{scene_name}'}</code> 分类-主题-场景 · <code>${'{theme_scene_list}'}</code> 所有场景组成的列表。每个场景单独请求，模型回复按 JSON 对象解析。</p>{error && <p className="automation-case-error" role="alert">{error}</p>}<div className="automation-actions"><button className="add-button" disabled={!ready || busy} onClick={() => void start()}><Play size={15} /> {busy ? '生成中…' : '开始生成'}</button>{busy && <button className="automation-stop" onClick={() => controller?.abort()}><Square size={14} /> 终止</button>}</div><div className="automation-results"><h3>生成任务</h3><div className="automation-task-list">{saved.tasks.map((item) => <button className="automation-task" key={item.id} onClick={() => setSelected(item.id)}><strong>{new Date(item.startedAt).toLocaleString()}</strong><span>{item.results.length} / {courseScenes(item.config.sceneNames).length}</span><span>{item.status === 'completed' ? '已完成' : item.status === 'running' ? '运行中' : item.status === 'stopped' ? '已终止' : '已中断'}</span></button>)}</div></div></section>
}
