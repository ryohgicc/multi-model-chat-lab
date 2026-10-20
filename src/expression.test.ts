import test from 'node:test'
import assert from 'node:assert/strict'
import { expressionCoachSource, expressionPerformance, parseAssessment, renderExpressionPrompt, runExpressionTest } from './expression.ts'
import type { ExpressionConfig, ExpressionResult } from './expression.ts'
import type { Model, ModelRequest } from './automation.ts'

const model = (id: string): Model => ({ id, name: id, provider: 'openai', baseUrl: '', apiKey: '', modelId: id, stream: false })
test('evaluation timing and price measure evaluators only and retain latest usage totals', async () => {
  const results: ExpressionResult[] = []
  await runExpressionTest({ config: { ...config, contentList: '语法', purposeList: '纠错' }, coachModel: model('coach'), replyModel: model('reply'), assessmentModel: model('judge'), evaluationModels: [{ ...model('eval-a'), inputPerMillion: 2, outputPerMillion: 4 }, model('eval-b')],
    request: async (target, _prompt, _content, _messages, _signal, onUsage) => {
      onUsage?.({ input: 10, output: 20 })
      onUsage?.({ input: 100, output: 200 })
      return target.id === 'judge' ? '{"score":90,"conclusion":"准确"}' : '内容'
    }, onResult: (result) => results.push(result) })
  const a = results.find((result) => result.evaluationModelId === 'eval-a')!
  const b = results.find((result) => result.evaluationModelId === 'eval-b')!
  assert.ok(a.evaluationDurationMs! >= 0)
  assert.equal(a.evaluationCost, 0.001)
  assert.equal(b.evaluationCost, undefined)
  const metrics = expressionPerformance([a, b, { ...a, evaluationDurationMs: undefined, evaluationCost: undefined }])
  assert.equal(metrics.pricedCount, 1)
  assert.equal(metrics.timedCount, 2)
  assert.equal(metrics.averageCost, 0.001)
})

test('performance averages ignore legacy missing metrics and preserve valid zeros', () => {
  const row = { evaluationDurationMs: 0, evaluationCost: 0 } as ExpressionResult
  assert.deepEqual(expressionPerformance([row, { ...row, evaluationDurationMs: 2000, evaluationCost: 0.002 }, {} as ExpressionResult]), { averageDurationMs: 1000, averageCost: 0.001, timedCount: 2, pricedCount: 2 })
  assert.deepEqual(expressionPerformance([{} as ExpressionResult]), { averageDurationMs: null, averageCost: null, timedCount: 0, pricedCount: 0 })
})
test('coach settings default to an ordinary chat and follow the same prompt precedence as reply tests', () => {
  const chats = [
    { id: 'test', title: '来源 · 测试 · 模型', promptDraft: '不应默认选择', turns: [] },
    { id: 'first', title: '第一对话', promptDraft: '草稿', welcomeInstruction: '欢迎语', turns: [{ prompt: '最近使用的 Prompt' }] },
    { id: 'second', title: '第二对话', promptDraft: '第二草稿', turns: [] },
  ]
  assert.deepEqual(expressionCoachSource(chats, ''), { chatId: 'first', coachPrompt: '最近使用的 Prompt', greetingInstruction: '欢迎语' })
  assert.deepEqual(expressionCoachSource(chats, 'second'), { chatId: 'second', coachPrompt: '第二草稿', greetingInstruction: '' })
  assert.equal(expressionCoachSource(chats, 'deleted')?.chatId, 'first')
  assert.equal(expressionCoachSource([chats[0]], ''), null)
  chats[1].welcomeInstruction = '更新后的欢迎语'
  assert.equal(expressionCoachSource(chats, 'first')?.greetingInstruction, '更新后的欢迎语')
})
const config: ExpressionConfig = { chatId: '', coachModelId: 'coach', replyModelId: 'reply', evaluationModelIds: ['eval-a', 'eval-b'], assessmentModelId: 'judge', rounds: 2, contentList: '测试内容1\n测试内容2', purposeList: '测试目的1\n测试目的2', coachPrompt: '陪练 ${userInputlatest}', greetingInstruction: '欢迎', replyPrompt: '回复 $${aiinputContent} ${aioutputContent}', evaluationPrompt: '评估 ${aiinputContent} ${aioutputContent}', assessmentPrompt: '测评 ${output} $${evaluationResult}' }
function setup(request: ModelRequest, overrides: Partial<ExpressionConfig> = {}, signal?: AbortSignal) {
  const results: ExpressionResult[] = []
  return { results, run: () => runExpressionTest({ config: { ...config, ...overrides }, coachModel: model('coach'), replyModel: model('reply'), evaluationModels: [model('eval-a'), model('eval-b')], assessmentModel: model('judge'), request, signal, onResult: (result) => results.push(result) }) }
}

test('expression prompts support both variable spellings without expanding variables inside data', () => {
  assert.equal(renderExpressionPrompt('${aiinputContent}|$${aioutputContent}|${output}|${evaluationResult}|${round}', { aiinputContent: '${output}', aioutputContent: '$&', output: '原文', evaluationResult: '原文', round: '2' }), '${output}|$&|原文|原文|2')
  assert.equal(renderExpressionPrompt('${output} $${output}', {}), ' ')
})

test('assessment requires numeric score and nonempty conclusion, retains zero and decimal scores', () => {
  assert.deepEqual(parseAssessment('说明\n```json\n{"score":0,"conclusion":"不准确"}\n```'), { score: 0, conclusion: '不准确' })
  assert.equal(parseAssessment('结果：{"score":8.5,"conclusion":"合理"}').score, 8.5)
  for (const raw of ['{"score":"80","conclusion":"好"}', '{"score":null,"conclusion":"好"}', '{"score":1,"conclusion":" "}', '{"type":"通过","analysis":"好"}', '{"score":1,"conclusion":', '{"score":1e999,"conclusion":"好"}']) assert.throws(() => parseAssessment(raw), /score/)
})

test('all evaluators share each pair, judge receives each evaluation, and coach carries history forward', async () => {
  const calls: Array<{ id: string; prompt: string; content: string; messages?: Array<{ role: 'user' | 'assistant'; content: string }> }> = []
  let coachCalls = 0
  const run = setup(async (target, prompt, content, messages) => {
    calls.push({ id: target.id, prompt, content, messages: messages ? structuredClone(messages) : undefined })
    if (target.id === 'coach') return ++coachCalls === 1 ? '你好' : '继续聊'
    const values = JSON.parse(content)
    if (target.id === 'reply') return `回应${values.round}`
    if (target.id.startsWith('eval-')) return `${target.id}评估${values.round}`
    return JSON.stringify({ score: values.output.startsWith('eval-a') ? 80 : 90, conclusion: values.output })
  })
  await run.run()
  assert.equal(run.results.length, 4)
  assert.equal(calls.filter((call) => call.id === 'reply').length, 2)
  assert.equal(coachCalls, 2)
  for (const round of [1, 2]) {
    const rows = run.results.filter((row) => row.round === round)
    assert.deepEqual(rows.map((row) => [row.aiinputContent, row.aioutputContent]), [[round === 1 ? '你好' : '继续聊', `回应${round}`], [round === 1 ? '你好' : '继续聊', `回应${round}`]])
    assert.deepEqual(rows.map((row) => row.score), [80, 90])
    const evalCalls = calls.filter((call) => call.id.startsWith('eval-') && JSON.parse(call.content).round === round)
    assert.equal(evalCalls[0].content, evalCalls[1].content)
    for (const row of rows) {
      const judgeCall = calls.find((call) => call.id === 'judge' && JSON.parse(call.content).output === row.output)!
      assert.equal(JSON.parse(judgeCall.content).aioutputContent, row.aioutputContent)
      assert.ok(judgeCall.prompt.includes(row.output))
      assert.equal(row.conclusion, row.output)
    }
  }
  assert.deepEqual(calls.filter((call) => call.id === 'coach')[1].messages, [{ role: 'assistant', content: '你好' }, { role: 'user', content: '回应1' }])
  assert.equal(calls.filter((call) => call.id === 'coach')[1].prompt, '陪练 回应1')
})

test('evaluation failure is isolated from other models and later rounds', async () => {
  const run = setup(async (target) => {
    if (target.id === 'eval-a') throw Object.assign(new Error('配置错误'), { status: 400 })
    return target.id === 'judge' ? '{"score":70,"conclusion":"可用"}' : '有效内容'
  })
  await run.run()
  assert.equal(run.results.filter((row) => row.error).length, 2)
  assert.equal(run.results.filter((row) => row.score === 70).length, 2)
  assert.ok(run.results.find((row) => row.error)?.error?.includes('评估失败'))
})

test('malformed assessment keeps evaluation and raw assessment without inventing scores', async () => {
  const run = setup(async (target) => target.id === 'judge' ? '这里没有评分' : '有效内容', { contentList: '测试内容', purposeList: '测试目的' })
  await run.run()
  assert.equal(run.results.length, 2)
  for (const result of run.results) {
    assert.equal(result.output, '有效内容')
    assert.equal(result.assessment, '这里没有评分')
    assert.equal(result.score, undefined)
    assert.match(result.error!, /测评失败/)
  }
})

test('abort during evaluation prevents judge calls and partial rows', async () => {
  const controller = new AbortController()
  let judgeCalls = 0
  const run = setup(async (target) => {
    if (target.id.startsWith('eval-')) controller.abort()
    if (target.id === 'judge') judgeCalls++
    return '内容'
  }, {}, controller.signal)
  await run.run()
  assert.equal(judgeCalls, 0)
  assert.equal(run.results.length, 0)
})

test('failed coach continuation preserves finished rows and reports the blocked round', async () => {
  let coachCalls = 0
  const run = setup(async (target) => {
    if (target.id === 'coach' && ++coachCalls > 1) throw Object.assign(new Error('无权限'), { status: 401 })
    return target.id === 'judge' ? '{"score":100,"conclusion":"准确"}' : '内容'
  }, { rounds: 3 })
  await run.run()
  assert.equal(run.results.length, 4)
  assert.equal(run.results.filter((result) => result.score === 100).length, 2)
  assert.ok(run.results.filter((result) => result.round === 2).every((result) => result.error?.includes('陪练生成下一轮失败')))
})

test('saved manual round counts do not override the dataset length', async () => {
  for (const rounds of [0, 1, 99, NaN]) {
    const run = setup(async (target) => target.id === 'judge' ? '{"score":80,"conclusion":"有效"}' : '内容', { rounds })
    await run.run()
    assert.equal(run.results.length, 4)
    assert.deepEqual([...new Set(run.results.map((row) => row.round))], [1, 2])
  }
})

test('long runs respect the API limit of 100 context messages', async () => {
  let longest = 0
  const run = setup(async (target, _prompt, _content, messages) => {
    if (messages) { assert.ok(messages.length <= 100); longest = Math.max(longest, messages.length) }
    return target.id === 'judge' ? '{"score":1,"conclusion":"已测评"}' : '内容'
  }, { contentList: Array.from({ length: 55 }, (_, i) => `内容${i}`).join('\n'), purposeList: Array.from({ length: 55 }, (_, i) => `目的${i}`).join('\n') })
  await run.run()
  assert.equal(run.results.length, 110)
  assert.equal(longest, 100)
})

test('analysisContent and test case variables support both spellings without expanding data', () => {
  const values = { analysisContent: '点评 ${testContent}', testContent: '测试 $${analysisContent}', testPurpose: '目的 $&' }
  assert.equal(renderExpressionPrompt('${analysisContent}|$${analysisContent}|${testContent}|$${testContent}|${testPurpose}|$${testPurpose}', values), '点评 ${testContent}|点评 ${testContent}|测试 $${analysisContent}|测试 $${analysisContent}|目的 $&|目的 $&')
  assert.equal(renderExpressionPrompt('${analysisContent} $${analysisContent}', {}), ' ')
})

test('each dialogue round uses the next case and sends matching content, purpose and evaluator analysis', async () => {
  const calls: Array<{ id: string; prompt: string; data: Record<string, string>; messages?: Array<{ role: 'user' | 'assistant'; content: string }> }> = []
  let greetings = 0
  const run = setup(async (target, prompt, content, messages) => {
    const data = target.id === 'coach' ? {} : JSON.parse(content)
    calls.push({ id: target.id, prompt, data, messages: messages ? structuredClone(messages) : undefined })
    if (target.id === 'coach') return messages ? '后续陪练' : `招呼${++greetings}`
    if (target.id === 'reply') return `${data.testContent}回复${data.round}`
    if (target.id.startsWith('eval-')) return `${target.id}对${data.testContent}的点评`
    assert.equal(data.analysisContent, data.output)
    assert.ok(prompt.includes(data.analysisContent))
    assert.ok(prompt.includes(data.testContent))
    assert.ok(prompt.includes(data.testPurpose))
    return JSON.stringify({ score: 88, conclusion: data.analysisContent })
  }, { contentList: '道歉\n拒绝', purposeList: '表达诚意\n态度明确', replyPrompt: '内容 $${testContent} 目的 ${testPurpose} 点评 ${analysisContent}', assessmentPrompt: '点评 $${analysisContent} 内容 ${testContent} 目的 $${testPurpose}' })
  await run.run()
  assert.equal(run.results.length, 4)
  assert.equal(greetings, 1)
  for (const [caseId, testContent, testPurpose, greeting] of [['1', '道歉', '表达诚意', '招呼1'], ['2', '拒绝', '态度明确', '后续陪练']]) {
    const rows = run.results.filter((row) => row.caseId === caseId)
    assert.equal(rows.length, 2)
    assert.ok(rows.every((row) => row.testContent === testContent && row.testPurpose === testPurpose && row.analysisContent === row.output && row.analysisContent === row.conclusion))
    assert.ok(rows.every((row) => row.round === Number(caseId) && row.aiinputContent === greeting))
    const replies = calls.filter((call) => call.id === 'reply' && call.data.caseId === caseId)
    assert.equal(replies.length, 1)
    assert.ok(replies.every((call) => call.data.testContent === testContent && call.data.testPurpose === testPurpose && call.prompt === `内容 ${testContent} 目的 ${testPurpose} 点评 `))
    const assessments = calls.filter((call) => call.id === 'judge' && call.data.caseId === caseId)
    assert.equal(assessments.length, 2)
    assert.ok(assessments.every((call) => call.data.testContent === testContent && call.data.testPurpose === testPurpose))
  }
  const continuations = calls.filter((call) => call.id === 'coach' && call.messages)
  assert.deepEqual(continuations.map((call) => call.messages), [[{ role: 'assistant', content: '招呼1' }, { role: 'user', content: '道歉回复1' }]])
})

test('empty, mismatched and incomplete expression test sets fail before requests', async () => {
  for (const [contentList, purposeList] of [['', ''], ['一\n二', '目的'], ['一\n\n三', '目的1\n目的2\n目的3']]) {
    const run = setup(async () => { assert.fail('must not request') }, { contentList, purposeList })
    await assert.rejects(run.run(), /测评集|行数一致|缺少/)
  }
})

test('dialogue failure stops the shared conversation without generating later cases', async () => {
  const run = setup(async (target, _prompt, content) => {
    if (target.id === 'coach') return '招呼'
    const data = JSON.parse(content)
    if (target.id === 'reply' && data.caseId === '1') throw Object.assign(new Error('回复失败'), { status: 400 })
    return target.id === 'judge' ? '{"score":75,"conclusion":"有效点评"}' : '回复或点评'
  }, { contentList: '第一条\n第二条', purposeList: '第一目的\n第二目的' })
  await run.run()
  const failed = run.results.filter((row) => row.caseId === '1')
  assert.equal(failed.length, 2)
  assert.ok(failed.every((row) => row.testContent === '第一条' && row.testPurpose === '第一目的' && row.error?.includes('回复失败')))
  const next = run.results.filter((row) => row.caseId === '2')
  assert.equal(next.length, 0)
})
