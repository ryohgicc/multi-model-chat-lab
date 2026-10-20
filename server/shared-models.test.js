import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('publishes all conversation settings, rejects invalid templates, and reads legacy settings', async () => {
  const previous = process.cwd()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-studio-publish-'))
  process.chdir(directory)
  try {
    const { saveSharedWorkspace, readSharedWorkspace, publicModels } = await import('./shared-models.js')
    const models = [{ id: 'model', name: 'Model', provider: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'test-key', modelId: 'model', stream: true }]
    const defaults = { promptDraft: 'system', welcomeInstruction: 'welcome', historyLimitDraft: 10, compressionPrompt: 'compress', compressionLimit: 10, compressionInterval: 10, modelIds: ['model', '', '', '', ''] }
    const settings = { ...defaults, panelCount: 3, immersiveMode: true, reviewModelId: 'model', reviewPrompt: 'review', activeSourceId: 'b', chatTemplates: [{ ...defaults, sourceId: 'a', title: 'A' }, { ...defaults, sourceId: 'b', title: 'B', promptDraft: 'another system', compressionInterval: 5 }] }
    saveSharedWorkspace(models, settings)
    assert.deepEqual(readSharedWorkspace(), { models, settings })
    assert.equal(publicModels(models)[0].apiKey, undefined)
    assert.throws(() => saveSharedWorkspace(models, { ...settings, chatTemplates: [{ ...settings.chatTemplates[0], modelIds: ['missing', '', '', '', ''] }] }), /工作台设置无效/)
    assert.throws(() => saveSharedWorkspace(models, { ...settings, chatTemplates: [settings.chatTemplates[0], settings.chatTemplates[0]] }), /工作台设置无效/)
    assert.deepEqual(readSharedWorkspace().settings, settings)
    const { chatTemplates: _templates, activeSourceId: _active, ...legacy } = settings
    void _templates; void _active
    saveSharedWorkspace(models, legacy)
    assert.deepEqual(readSharedWorkspace().settings, legacy)
  } finally {
    process.chdir(previous)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
