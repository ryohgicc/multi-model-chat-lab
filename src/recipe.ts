import { requestWithRetry } from './automation.ts'
import type { Model, ModelRequest } from './automation.ts'

export type RecipeConfig = { planModelIds: string[]; evaluationModelId: string; planPrompt: string; evaluationPrompt: string; contentList: string }
export type RecipeResult = { modelId: string; modelName: string; caseId: string; content: string; planOutput: string; evaluation: string; score?: number; conclusion?: string; error?: string }
export function recipeCases(contentList: string) {
  const lines = contentList.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  return { cases: lines.map((content, index) => ({ id: String(index + 1), content })) }
}
export function renderRecipePrompt(template: string, values: Record<string, string>) { return template.replace(/\$?\$\{(testContent|planOutput)\}/g, (_, key) => values[key] || '') }
export function parseRecipeAssessment(raw: string) {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const first = source.indexOf('{'); const last = source.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('测评结果必须是 JSON 对象，包含 score 和 conclusion')
  const value = JSON.parse(source.slice(first, last + 1)) as { score?: unknown; conclusion?: unknown }
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || typeof value.conclusion !== 'string' || !value.conclusion.trim()) throw new Error('测评结果必须包含数字 score 和非空字符串 conclusion')
  return { score: value.score, conclusion: value.conclusion.trim() }
}
export async function runRecipeTest(args: { config: RecipeConfig; planModels: Model[]; evaluationModel: Model; request: ModelRequest; signal?: AbortSignal; onResult: (result: RecipeResult) => void }) {
  const { config, planModels, evaluationModel, request, signal, onResult } = args
  const parsed = recipeCases(config.contentList)
  for (const testCase of parsed.cases) {
    await Promise.all(planModels.map(async (model) => {
      const base: RecipeResult = { modelId: model.id, modelName: model.name, caseId: testCase.id, content: testCase.content, planOutput: '', evaluation: '' }
      try {
        const values = { testContent: testCase.content, planOutput: '' }
        base.planOutput = (await requestWithRetry(request, model, renderRecipePrompt(config.planPrompt, values), JSON.stringify(values), undefined, signal)).trim()
        const evaluationPrompt = renderRecipePrompt(config.evaluationPrompt, { ...values, planOutput: base.planOutput })
        base.evaluation = (await requestWithRetry(request, evaluationModel, evaluationPrompt, JSON.stringify({ ...values, planOutput: base.planOutput }), undefined, signal)).trim()
        Object.assign(base, parseRecipeAssessment(base.evaluation))
      } catch (error) { if (signal?.aborted) return; base.error = error instanceof Error ? error.message : '请求失败' }
      if (!signal?.aborted) onResult(base)
    }))
  }
}
