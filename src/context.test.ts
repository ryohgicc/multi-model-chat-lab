import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { buildContext, promptVariableValues, renderSystemPrompt } from './context.ts'

const turns = [
  { user: 'one', replies: { 0: { modelId: 'a', content: 'A1' }, 1: { modelId: 'b', content: 'B1' } } },
  { user: 'two', replies: { 0: { modelId: 'a', content: 'A2' } } },
  { user: 'three', replies: {} },
]

test('history limit counts previous turns and keeps only own model replies', () => {
  assert.deepEqual(buildContext(turns, 0, 'a', 0, 2, 1), [
    { role: 'user', content: 'two' }, { role: 'assistant', content: 'A2' }, { role: 'user', content: 'three' },
  ])
})
test('zero history sends only current user message', () => {
  assert.deepEqual(buildContext(turns, 0, 'a', 0, 2, 0), [{ role: 'user', content: 'three' }])
})
test('model switch boundary excludes earlier context', () => {
  assert.deepEqual(buildContext(turns, 0, 'a', 2, 2, 10), [{ role: 'user', content: 'three' }])
})
test('welcome reply enters context without its hidden instruction', () => {
  const context = buildContext(turns, 0, 'a', 0, 1, 10, 'Welcome!')
  assert.deepEqual(context.slice(0, 2), [{ role: 'assistant', content: 'Welcome!' }, { role: 'user', content: 'one' }])
  assert.equal(JSON.stringify(context).includes('hidden instruction'), false)
  assert.deepEqual(buildContext(turns, 0, 'a', 0, 1, 0, 'Welcome!'), [{ role: 'user', content: 'two' }])
})

test('renders prompt variables from the current model context', () => {
  assert.equal(renderSystemPrompt('prev=${userInputPrevious}; ai=${aiOutputPrevious}; latest=${userInputlatest}', [
    { role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'latest question' },
  ], 'latest question'), 'prev=old question; ai=old answer; latest=latest question')
})

test('renders memory and summary values without changing the template', () => {
  const template = '${memory} | ${summary} | ${userInputlatest}'
  assert.equal(renderSystemPrompt(template, [{ role: 'user', content: 'hi' }], 'hi', 'facts', 'recap'), 'facts | recap | hi')
  assert.equal(template, '${memory} | ${summary} | ${userInputlatest}')
})
test('variable preview values match prompt replacement for each model', () => {
  const current = { user: 'new', replies: {} }
  const turns = [
    { user: 'old', replies: { 0: { modelId: 'a', content: 'answer A' }, 1: { modelId: 'b', content: 'answer B' } } },
    current,
  ]
  const first = buildContext(turns, 0, 'a', 0, 1, 1)
  const second = buildContext(turns, 1, 'b', 0, 1, 1)
  assert.equal(promptVariableValues(first, 'new').aiOutputPrevious, 'answer A')
  assert.equal(promptVariableValues(second, 'new').aiOutputPrevious, 'answer B')
  assert.equal(renderSystemPrompt('${aiOutputPrevious}', first, 'new'), promptVariableValues(first, 'new').aiOutputPrevious)
})
test('one user message is latest and has no previous user message', () => {
  const context = [{ role: 'user' as const, content: 'only message' }]
  const values = promptVariableValues(context, 'only message')
  assert.equal(values.userInputlatest, 'only message')
  assert.equal(values.userInputPrevious, '')
  assert.equal(values.aiOutputPrevious, '')
})
test('currentTime uses the provided UTC ISO timestamp', () => {
  const utc = '2026-10-10T08:30:00.000Z'
  assert.equal(promptVariableValues([], '', '', '', utc).currentTime, utc)
  assert.equal(renderSystemPrompt('Now: ${currentTime}', [], '', '', '', utc), `Now: ${utc}`)
})
