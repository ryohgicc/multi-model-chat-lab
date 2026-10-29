import test from 'node:test'
import assert from 'node:assert/strict'
import { courseSceneName, courseScenes, parseCourseOutput, runCourseGeneration } from './course.ts'
import type { Model } from './automation.ts'

const model: Model = { id: 'm', name: 'Model', provider: 'openai', baseUrl: '', apiKey: '', modelId: 'm', stream: false }

test('course generation sends one request per scene with shared themes and preserves order', async () => {
  const calls: Array<{ prompt: string; content: string }> = []
  const results: string[] = []
  await runCourseGeneration({ config: { modelId: 'm', prompt: 'Generate ${scene_name} from ${theme_scene_list}', category: 'Work', theme: 'Communication', sceneNames: 'Interview\n\nMeeting', }, model,
    request: async (_model, prompt, content) => { calls.push({ prompt, content }); return '```json\n{"difficulty":3}\n```' },
    onResult: (result) => { assert.equal(result.output?.difficulty, 3); results.push(result.sceneName) },
  })
  assert.deepEqual(results, ['Work-Communication-Interview', 'Work-Communication-Meeting'])
  assert.equal(calls.length, 2)
  assert.deepEqual(JSON.parse(calls[1].content), { scene_name: 'Work-Communication-Meeting', theme_scene_list: ['Interview', 'Meeting'] })
  assert.equal(calls[0].prompt, 'Generate Work-Communication-Interview from ["Interview","Meeting"]')
})

test('course input and output reject wrong JSON shapes', () => {
  assert.deepEqual(courseScenes(' A \r\n \n B '), ['A', 'B'])
  assert.equal(courseSceneName({ modelId: 'm', prompt: '', category: '', theme: '', sceneNames: '' }, 'Legacy'), 'Legacy')
  assert.throws(() => parseCourseOutput('[]'), /JSON 对象/)
})

test('theme_scene_list safely encodes quotes in scene text', async () => {
  const contents: string[] = []
  await runCourseGeneration({ config: { modelId: 'm', prompt: '${theme_scene_list}', category: 'Work', theme: 'Communication', sceneNames: 'Ask "why"\nFollow up' }, model,
    request: async (_model, prompt, content) => { contents.push(content); assert.equal(JSON.parse(prompt)[0], 'Ask "why"'); return '{}' },
    onResult: () => {},
  })
  assert.equal(contents.length, 2)
  assert.deepEqual(JSON.parse(contents[0]).theme_scene_list, ['Ask "why"', 'Follow up'])
})

test('course result keeps request and upstream response when no text is returned', async () => {
  const results: Array<{ prompt?: string; requestContent?: string; response?: unknown; error?: string; attempts?: number }> = []
  const upstream = { choices: [{ message: { content: null, reasoning_content: 'internal' } }] }
  await runCourseGeneration({ config: { modelId: 'm', prompt: 'Generate ${scene_name}', category: 'Work', theme: 'Meeting', sceneNames: 'Opening' }, model,
    request: async () => { throw Object.assign(new Error('接口没有返回可显示的文本。'), { debugResponse: upstream }) },
    onResult: (result) => results.push(result),
  })
  assert.equal(results[0].prompt, 'Generate Work-Meeting-Opening')
  assert.deepEqual(JSON.parse(results[0].requestContent || ''), { scene_name: 'Work-Meeting-Opening', theme_scene_list: ['Opening'] })
  assert.deepEqual(results[0].response, upstream)
  assert.match(results[0].error || '', /没有返回可显示的文本/)
  assert.equal(results[0].attempts, 3)
})

test('course generation retries empty text and preserves the successful response', async () => {
  let attempts = 0
  const results: Array<{ output?: Record<string, unknown>; attempts?: number }> = []
  await runCourseGeneration({ config: { modelId: 'm', prompt: 'Generate', category: 'Work', theme: 'Meeting', sceneNames: 'Opening' }, model,
    request: async () => { attempts++; if (attempts < 3) throw new Error('接口没有返回可显示的文本。'); return '{"difficulty":2}' },
    onResult: (result) => results.push(result),
  })
  assert.equal(attempts, 3)
  assert.equal(results[0].attempts, 3)
  assert.equal(results[0].output?.difficulty, 2)
})

test('course generation does not retry other errors', async () => {
  let attempts = 0
  await runCourseGeneration({ config: { modelId: 'm', prompt: 'Generate', category: 'Work', theme: 'Meeting', sceneNames: 'Opening' }, model,
    request: async () => { attempts++; throw new Error('请求参数无效') },
    onResult: () => {},
  })
  assert.equal(attempts, 1)
})

test('stopping a course task cancels pending empty-response retries', async () => {
  const controller = new AbortController()
  let attempts = 0
  const results: unknown[] = []
  await runCourseGeneration({ config: { modelId: 'm', prompt: 'Generate', category: 'Work', theme: 'Meeting', sceneNames: 'Opening\nClosing' }, model,
    request: async () => { attempts++; controller.abort(); throw new Error('接口没有返回可显示的文本。') },
    signal: controller.signal,
    onResult: (result) => results.push(result),
  })
  assert.equal(attempts, 1)
  assert.equal(results.length, 0)
})
