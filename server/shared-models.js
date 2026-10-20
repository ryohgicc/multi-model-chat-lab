import fs from 'node:fs'
import path from 'node:path'

const file = path.resolve(process.cwd(), 'data/shared-models.json')
const providers = new Set(['openai', 'anthropic', 'gemini', 'custom', 'jev'])

export function readSharedWorkspace() {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(saved) ? { models: saved, settings: null } : saved
  } catch (error) { if (error.code === 'ENOENT') return { models: [], settings: null }; throw error }
}

export function publicModels(models) {
  return models.map((model) => {
    const copy = { ...model }
    delete copy.apiKey
    return copy
  })
}

export function saveSharedWorkspace(models, settings) {
  if (!Array.isArray(models) || models.length > 100 || models.some((model) =>
    !model || typeof model.id !== 'string' || !model.id || typeof model.name !== 'string' || !model.name ||
    !providers.has(model.provider) || typeof model.baseUrl !== 'string' ||
    typeof model.apiKey !== 'string' || !model.apiKey || typeof model.modelId !== 'string' || !model.modelId ||
    typeof model.stream !== 'boolean' ||
    [model.inputPerMillion, model.outputPerMillion].some((price) => price !== undefined && (!Number.isFinite(price) || price < 0))
  ) || new Set(models.map((model) => model.id)).size !== models.length) throw new Error('模型配置无效。')
  const validModelIds = (ids) => Array.isArray(ids) && ids.length === 5 && ids.every((id) => typeof id === 'string' && (!id || models.some((model) => model.id === id)))
  const validTemplate = (template) => template && typeof template.sourceId === 'string' && !!template.sourceId &&
    typeof template.title === 'string' && template.title.length <= 200 &&
    typeof template.promptDraft === 'string' && template.promptDraft.length <= 100000 &&
    typeof template.welcomeInstruction === 'string' && template.welcomeInstruction.length <= 100000 &&
    Number.isInteger(template.historyLimitDraft) && template.historyLimitDraft >= 0 && template.historyLimitDraft <= 100 &&
    typeof template.compressionPrompt === 'string' && template.compressionPrompt.length <= 100000 &&
    Number.isInteger(template.compressionLimit) && template.compressionLimit >= 1 && template.compressionLimit <= 100 &&
    Number.isInteger(template.compressionInterval) && template.compressionInterval >= 0 && template.compressionInterval <= 100 &&
    validModelIds(template.modelIds)
  if (!settings || !Number.isInteger(settings.panelCount) || settings.panelCount < 1 || settings.panelCount > 5 ||
    typeof settings.immersiveMode !== 'boolean' || typeof settings.promptDraft !== 'string' || settings.promptDraft.length > 100000 ||
    typeof settings.welcomeInstruction !== 'string' || settings.welcomeInstruction.length > 100000 ||
    !Number.isInteger(settings.historyLimitDraft) || settings.historyLimitDraft < 0 || settings.historyLimitDraft > 100 ||
    typeof settings.compressionPrompt !== 'string' || settings.compressionPrompt.length > 100000 ||
    !Number.isInteger(settings.compressionLimit) || settings.compressionLimit < 1 || settings.compressionLimit > 100 ||
    !Number.isInteger(settings.compressionInterval) || settings.compressionInterval < 0 || settings.compressionInterval > 100 ||
    !validModelIds(settings.modelIds) ||
    (settings.reviewModelId !== undefined && (typeof settings.reviewModelId !== 'string' || (settings.reviewModelId && !models.some((model) => model.id === settings.reviewModelId)))) ||
    (settings.reviewPrompt !== undefined && (typeof settings.reviewPrompt !== 'string' || settings.reviewPrompt.length > 100000)) ||
    (settings.chatTemplates !== undefined && (!Array.isArray(settings.chatTemplates) || settings.chatTemplates.length > 200 || settings.chatTemplates.some((template) => !validTemplate(template)) || new Set(settings.chatTemplates.map((template) => template.sourceId)).size !== settings.chatTemplates.length)) ||
    (settings.activeSourceId !== undefined && (typeof settings.activeSourceId !== 'string' || !settings.chatTemplates?.some((template) => template.sourceId === settings.activeSourceId)))) throw new Error('工作台设置无效。')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ models, settings }), { mode: 0o600 })
  fs.renameSync(temp, file)
}
