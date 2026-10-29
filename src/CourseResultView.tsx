import type { CourseResult } from './course'

const textField = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const taskField = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []

export function CourseResultView({ result }: { result: CourseResult }) {
  const output = result.output
  if (!output) return <span className="course-empty-result">—</span>

  const aiName = textField(output.ai_role_name)
  const aiSetting = textField(output.ai_role_setting)
  const userName = textField(output.user_role_name)
  const userSetting = textField(output.user_role_setting)
  const topic = textField(output.topic) || textField(output.dialogue_topic)
  const difficulty = typeof output.difficulty === 'number' || typeof output.difficulty === 'string' ? String(output.difficulty) : ''
  const mainTasks = taskField(output.main_tasks)
  const optionalTasks = taskField(output.optional_tasks)
  const known = new Set(['ai_role_name', 'ai_role_setting', 'user_role_name', 'user_role_setting', 'topic', 'dialogue_topic', 'difficulty', 'main_tasks', 'optional_tasks'])
  const otherFields = Object.entries(output).filter(([key]) => !known.has(key))

  return <div className="course-result-view">
    <div className="course-result-heading"><strong>{topic ? '对话场景' : '课程内容'}</strong>{difficulty && <span>难度 {difficulty}</span>}</div>
    {topic && <p className="course-result-topic">{topic}</p>}
    {(aiName || aiSetting || userName || userSetting) && <div className="course-role-grid">
      {(aiName || aiSetting) && <div className="course-role"><small>AI 角色</small><strong>{aiName || '未命名'}</strong>{aiSetting && <p>{aiSetting}</p>}</div>}
      {(userName || userSetting) && <div className="course-role"><small>用户角色</small><strong>{userName || '未命名'}</strong>{userSetting && <p>{userSetting}</p>}</div>}
    </div>}
    {mainTasks.length > 0 && <div className="course-task-group"><strong>主要任务</strong><ol>{mainTasks.map((task, index) => <li key={index}>{task}</li>)}</ol></div>}
    {optionalTasks.length > 0 && <div className="course-task-group course-optional-tasks"><strong>可选任务</strong><ul>{optionalTasks.map((task, index) => <li key={index}>{task}</li>)}</ul></div>}
    {otherFields.length > 0 && <dl className="course-extra-fields">{otherFields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl>}
    <details className="course-raw-json"><summary>查看原始 JSON</summary><pre>{JSON.stringify(output, null, 2)}</pre></details>
  </div>
}
