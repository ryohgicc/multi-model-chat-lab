import type { Model, ModelRequest } from './automation.ts'

export type CourseConfig = { modelId: string; prompt: string; category: string; theme: string; sceneNames: string }
export type CourseResult = { sceneName: string; raw: string; prompt?: string; requestContent?: string; response?: unknown; output?: Record<string, unknown>; error?: string; attempts?: number }

export const courseScenes = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
export const courseSceneName = (config: CourseConfig, scene: string) => config.category?.trim() && config.theme?.trim() ? `${config.category.trim()}-${config.theme.trim()}-${scene}` : scene

export function renderCoursePrompt(prompt: string, sceneName: string, themeSceneList: string[]) {
  return prompt.replace(/\$\{(scene_name|theme_scene_list)\}/g, (_, key: string) => key === 'scene_name' ? sceneName : JSON.stringify(themeSceneList))
}

export function parseCourseOutput(raw: string): Record<string, unknown> {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed: unknown = JSON.parse(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('课程结果必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

const isEmptyResponse = (error: unknown) => error instanceof Error && (error.message.includes('接口没有返回可显示的文本') || error.message === '模型没有返回内容')

function waitForRetry(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('请求已取消', 'AbortError')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, 500)
    const onAbort = () => { clearTimeout(timer); reject(new DOMException('请求已取消', 'AbortError')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function runCourseGeneration(args: { config: CourseConfig; model: Model; request: ModelRequest; signal?: AbortSignal; onResult: (result: CourseResult) => void }) {
  const { config, model, request, signal, onResult } = args
  const scenes = courseScenes(config.sceneNames)
  for (const scene of scenes) {
    if (signal?.aborted) break
    const sceneName = courseSceneName(config, scene)
    const prompt = renderCoursePrompt(config.prompt, sceneName, scenes)
    const requestContent = JSON.stringify({ scene_name: sceneName, theme_scene_list: scenes })
    const result: CourseResult = { sceneName, raw: '', prompt, requestContent }
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        result.attempts = attempt
        try {
          result.raw = await request(model, prompt, requestContent, undefined, signal)
          if (!result.raw.trim()) throw new Error('模型没有返回内容')
          break
        } catch (error) {
          if (error && typeof error === 'object' && 'debugResponse' in error) result.response = error.debugResponse
          if (!isEmptyResponse(error) || attempt === 3 || signal?.aborted) throw error
          await waitForRetry(signal)
        }
      }
      result.response = result.raw
      result.output = parseCourseOutput(result.raw)
    } catch (error) {
      if (signal?.aborted) break
      if (error && typeof error === 'object' && 'debugResponse' in error) result.response = error.debugResponse
      result.error = error instanceof Error ? error.message : '请求失败'
    }
    onResult(result)
  }
}
