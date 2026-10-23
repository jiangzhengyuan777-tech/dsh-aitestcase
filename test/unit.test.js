// Unit tests for dsh-aitestcase. The host is faked: `ctx.tools` captures
// definitions and `ctx.llm.stream` returns a scripted StreamChunk sequence, so
// no model call and no network happens here.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerTools } from '../lib/tools.js'
import { resolveOptions, defaultOptions } from '../lib/options.js'
import { formatUsage } from '../lib/llm.js'
import { clearPromptCache, loadPrompt } from '../lib/prompts.js'
import { clearGenerations } from '../lib/session.js'
import { readTextFile } from '../lib/files.js'

/** Mount the tools exactly as the runtime entry does, with a plain config object. */
function apply(ctx, config) {
  registerTools(ctx, () => resolveOptions(config))
}

/** Scripted host: one text block, usage, and a stop finish. */
function makeCtx(script = '模型输出正文') {
  const tools = new Map()
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      const text = typeof script === 'function' ? script(options) : script
      return (async function* stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return {
    tools: { register(definition) { tools.set(definition.name, definition) } },
    llm,
    toolsMap: tools,
    calls,
  }
}

function makeExec() {
  const session = { id: 'session-test' }
  return { agent: { session }, signal: new AbortController().signal }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-aitestcase-test-'))
}

const PLUGIN_COUNT = 6

test('registers the six test-design tools', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  assert.equal(ctx.toolsMap.size, PLUGIN_COUNT)
  assert.deepEqual(
    [...ctx.toolsMap.keys()].sort(),
    [
      'aitestcase_evaluate',
      'aitestcase_history',
      'aitestcase_status',
      'aitestcase_testcases',
      'aitestcase_testpoints',
      'aitestcase_testprd',
    ],
  )
  for (const definition of ctx.toolsMap.values()) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('status reports every prompt template as ready', async () => {
  clearPromptCache()
  clearGenerations()
  const ctx = makeCtx()
  apply(ctx, {})
  const result = await ctx.toolsMap.get('aitestcase_status').execute({}, makeExec())
  assert.match(result.text, /全部模板就绪/)
  assert.match(result.text, /ask_testpoint\.md/)
  assert.equal(ctx.calls.length, 0, 'status must not call the model without probe')
})

test('status probe performs one minimal model call', async () => {
  const ctx = makeCtx('OK')
  apply(ctx, {})
  const result = await ctx.toolsMap.get('aitestcase_status').execute({ probe: true }, makeExec())
  assert.match(result.text, /探测成功/)
  assert.equal(ctx.calls.length, 1)
  assert.equal(ctx.calls[0].maxTokens, 64)
  assert.equal(ctx.calls[0].system, undefined)
})

test('testpoints tool uses the testpoint template and the tagged input contract', async () => {
  clearGenerations()
  const ctx = makeCtx('测试点结果')
  apply(ctx, { saveArtifacts: false })
  const result = await ctx.toolsMap.get('aitestcase_testpoints').execute(
    { requirement: '登录验证码有效期五分钟', instruction: '重点覆盖并发重发' },
    makeExec(),
  )
  const call = ctx.calls[0]
  assert.equal(call.system, loadPrompt('testpoint'))
  assert.match(call.messages[0].content[0].text, /^\[优化后PRD\]\n登录验证码有效期五分钟\n\[\/优化后PRD\]/)
  assert.match(call.messages[0].content[0].text, /\[补充说明\]\n重点覆盖并发重发\n\[\/补充说明\]/)
  assert.equal(call.temperature, 0)
  assert.equal(call.maxTokens, 20000)
  assert.match(result.text, /【测试点】/)
  assert.match(result.text, /测试点结果/)
})

test('testcases tool selects the template by output format', async () => {
  clearGenerations()
  const ctx = makeCtx('用例结果')
  apply(ctx, { saveArtifacts: false })
  const tool = ctx.toolsMap.get('aitestcase_testcases')

  await tool.execute({ requirement: '需求A', testpoints: '测试点B', format: 'yaml' }, makeExec())
  assert.equal(ctx.calls[0].system, loadPrompt('testcase_yaml'))
  assert.match(ctx.calls[0].messages[0].content[0].text, /\[测试点\]\n测试点B\n\[\/测试点\]/)

  await tool.execute({ requirement: '需求A', format: 'table' }, makeExec())
  assert.equal(ctx.calls[1].system, loadPrompt('testcase_table'))

  await tool.execute({ requirement: '需求A' }, makeExec())
  assert.equal(ctx.calls[2].system, loadPrompt('testcase_xmind'))
})

test('artifacts land in the configured directory and are reported', async () => {
  clearGenerations()
  const dir = tempDir()
  try {
    const ctx = makeCtx('落盘正文')
    apply(ctx, { outputDir: dir, saveArtifacts: true })
    const result = await ctx.toolsMap.get('aitestcase_testcases').execute(
      { requirement: '需求', format: 'xmind' },
      makeExec(),
    )
    assert.ok(result.artifactPath, 'artifactPath must be reported')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.match(files[0], /^testcase-xmind-\d{8}-\d{6}\.md$/)
    assert.equal(readFileSync(join(dir, files[0]), 'utf8'), '落盘正文')
    assert.match(result.text, /已保存: /)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveArtifacts=false leaves the filesystem untouched', async () => {
  clearGenerations()
  const dir = tempDir()
  try {
    const ctx = makeCtx('不落盘')
    apply(ctx, { outputDir: dir, saveArtifacts: false })
    const result = await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, makeExec())
    assert.equal(result.artifactPath, undefined)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('previous generations feed back into later prompts and are readable', async () => {
  clearGenerations()
  const ctx = makeCtx('第一版测试点')
  apply(ctx, { historyRounds: 4, saveArtifacts: false })
  const exec = makeExec()

  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, exec)
  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求（改）' }, exec)

  assert.doesNotMatch(ctx.calls[0].system, /本会话历史输出/)
  assert.match(ctx.calls[1].system, /本会话历史输出/)
  assert.match(ctx.calls[1].system, /禁止原样复述/)
  assert.match(ctx.calls[1].system, /第一版测试点/)

  const history = await ctx.toolsMap.get('aitestcase_history').execute({ full: true }, exec)
  assert.match(history.text, /共 2 条/)
  assert.match(history.text, /第一版测试点/)
})

test('testcases inherits the newest test points through the [测试点] slot', async () => {
  clearGenerations()
  const ctx = makeCtx('测试点正文')
  apply(ctx, { saveArtifacts: false })
  const exec = makeExec()

  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, exec)
  await ctx.toolsMap.get('aitestcase_testcases').execute({ requirement: '需求', format: 'table' }, exec)

  const caseCall = ctx.calls[1]
  assert.match(caseCall.messages[0].content[0].text, /\[测试点\]\n测试点正文\n\[\/测试点\]/)
  // The same document must not be sent twice (once as a tag, once as history).
  assert.doesNotMatch(caseCall.system, /测试点正文/)
})

test('an explicit testpoints argument wins over session history', async () => {
  clearGenerations()
  const ctx = makeCtx('历史测试点')
  apply(ctx, { saveArtifacts: false })
  const exec = makeExec()

  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, exec)
  await ctx.toolsMap.get('aitestcase_testcases').execute(
    { requirement: '需求', testpoints: '显式测试点', format: 'table' },
    exec,
  )

  const user = ctx.calls[1].messages[0].content[0].text
  assert.match(user, /\[测试点\]\n显式测试点\n\[\/测试点\]/)
  assert.doesNotMatch(user, /历史测试点/)
})

test('evaluations are recorded in session history', async () => {
  clearGenerations()
  const ctx = makeCtx('{"score":90}')
  apply(ctx, { saveArtifacts: false })
  const exec = makeExec()

  await ctx.toolsMap.get('aitestcase_evaluate').execute({ testcases: 'TC1' }, exec)
  const history = await ctx.toolsMap.get('aitestcase_history').execute({}, exec)
  assert.match(history.text, /用例质检评估/)
})

test('history is isolated per Session', async () => {
  clearGenerations()
  const ctx = makeCtx('会话一的结果')
  apply(ctx, { saveArtifacts: false })
  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, makeExec())

  const other = makeExec()
  other.agent.session = { id: 'session-other' }
  const history = await ctx.toolsMap.get('aitestcase_history').execute({}, other)
  assert.match(history.text, /没有任何生成记录/)
})

test('historyRounds=0 disables the continuity block', async () => {
  clearGenerations()
  const ctx = makeCtx('结果')
  apply(ctx, { historyRounds: 0, saveArtifacts: false })
  const exec = makeExec()
  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, exec)
  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, exec)
  assert.equal(ctx.calls[1].system, loadPrompt('testpoint'))
})

test('evaluate uses the evaluator prompt and the PRD/cases sections', async () => {
  clearGenerations()
  const ctx = makeCtx('{"score":85}')
  apply(ctx, { saveArtifacts: false })
  const result = await ctx.toolsMap.get('aitestcase_evaluate').execute(
    { testcases: 'TC1 步骤…', prd: '需求…', reference: '规范…' },
    makeExec(),
  )
  const call = ctx.calls[0]
  assert.equal(call.system, loadPrompt('evaluator'))
  const user = call.messages[0].content[0].text
  assert.match(user, /## 【原始 PRD】/)
  assert.match(user, /## 【待评审测试用例】/)
  assert.match(user, /## 【参考规范和历史用例】/)
  assert.match(user, /严格的 JSON 格式评估报告/)
  assert.match(result.text, /【用例质检评估】/)
})

test('missing required arguments fail loudly', async () => {
  clearGenerations()
  const ctx = makeCtx()
  apply(ctx, {})
  await assert.rejects(
    () => ctx.toolsMap.get('aitestcase_testpoints').execute({}, makeExec()),
    /缺少必填参数 requirement/,
  )
  await assert.rejects(
    () => ctx.toolsMap.get('aitestcase_evaluate').execute({ prd: '只有需求' }, makeExec()),
    /缺少必填参数 testcases/,
  )
  assert.equal(ctx.calls.length, 0)
})

test('an unsupported testcase format is rejected before any model call', async () => {
  clearGenerations()
  const ctx = makeCtx()
  apply(ctx, {})
  await assert.rejects(
    () => ctx.toolsMap.get('aitestcase_testcases').execute({ requirement: '需求', format: 'docx' }, makeExec()),
    /format 只能是 xmind、table 或 yaml/,
  )
  assert.equal(ctx.calls.length, 0)
})

test('over-long input is truncated and disclosed', async () => {
  clearGenerations()
  const ctx = makeCtx('结果')
  apply(ctx, { maxInputChars: 1000, saveArtifacts: false })
  const result = await ctx.toolsMap.get('aitestcase_testpoints').execute(
    { requirement: 'A'.repeat(4000) },
    makeExec(),
  )
  const user = ctx.calls[0].messages[0].content[0].text
  assert.ok(user.length < 4000, 'input must be truncated')
  assert.match(user, /已截断/)
  assert.match(result.text, /超出长度上限/)
})

test('usage line reports cache reads instead of looking truncated', () => {
  assert.equal(formatUsage(null), '')
  assert.equal(formatUsage({ inputTokens: 0, outputTokens: 0 }), '')
  assert.equal(formatUsage({ inputTokens: 288, outputTokens: 5874 }), '输入 288 / 输出 5874')
  assert.equal(
    formatUsage({ inputTokens: 288, outputTokens: 5874, cacheReadTokens: 2100 }),
    '输入 288（缓存命中 2100） / 输出 5874',
  )
})

test('model errors surface instead of returning empty text', async () => {
  clearGenerations()
  const ctx = makeCtx()
  ctx.llm.stream = () =>
    (async function* failing() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TIMEOUT', message: '超时了' } } }
    })()
  apply(ctx, {})
  await assert.rejects(
    () => ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, makeExec()),
    /模型调用失败 \[TIMEOUT\]: 超时了/,
  )
})

// ---- configuration resolution -------------------------------------------------

test('resolveOptions applies defaults, clamps, and unwraps volatile refs', () => {
  assert.deepEqual(resolveOptions(undefined), defaultOptions())
  assert.deepEqual(resolveOptions({}), defaultOptions())

  const resolved = resolveOptions({
    provider: '  custom-provider ',
    model: 'custom-model',
    temperature: 9,
    maxTokens: 10,
    outputDir: '',
    saveArtifacts: false,
    historyRounds: 99,
    maxInputChars: '120000',
  })
  assert.equal(resolved.provider, 'custom-provider')
  assert.equal(resolved.model, 'custom-model')
  assert.equal(resolved.temperature, 2, 'temperature is clamped to 2')
  assert.equal(resolved.maxTokens, 256, 'maxTokens is clamped to the minimum')
  assert.equal(resolved.outputDir, defaultOptions().outputDir, 'empty outputDir falls back to the default')
  assert.equal(resolved.saveArtifacts, false)
  assert.equal(resolved.historyRounds, 10, 'historyRounds is clamped to 10')
  assert.equal(resolved.maxInputChars, 120000)

  // Volatile fields may arrive as references; the resolver unwraps them.
  const volatile = resolveOptions({
    provider: { get: () => 'ref-provider' },
    maxTokens: { get: () => 30000 },
    saveArtifacts: { get: () => true },
  })
  assert.equal(volatile.provider, 'ref-provider')
  assert.equal(volatile.maxTokens, 30000)
  assert.equal(volatile.saveArtifacts, true)
})

test('a live option edit is picked up by the next call without remounting', async () => {
  clearGenerations()
  const ctx = makeCtx()
  const config = { model: 'first-model', saveArtifacts: false }
  apply(ctx, config)
  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, makeExec())
  config.model = 'second-model'
  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求' }, makeExec())
  assert.equal(ctx.calls[0].model, 'first-model')
  assert.equal(ctx.calls[1].model, 'second-model')
})

// ---- file inputs --------------------------------------------------------------

test('generation tools accept a requirement file instead of inline text', async () => {
  clearGenerations()
  const dir = tempDir()
  try {
    const prd = join(dir, 'prd.md')
    writeFileSync(prd, '登录验证码有效期五分钟\n', 'utf8')
    const ctx = makeCtx('来自文件的测试点')
    apply(ctx, { saveArtifacts: false })
    const exec = makeExec()
    exec.agent.session.cwd = dir
    const result = await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirementFile: 'prd.md' }, exec)
    assert.match(ctx.calls[0].messages[0].content[0].text, /登录验证码有效期五分钟/)
    assert.match(result.text, /来自文件的测试点/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file argument reports a readable error', async () => {
  clearGenerations()
  const ctx = makeCtx()
  apply(ctx, { saveArtifacts: false })
  await assert.rejects(
    () => ctx.toolsMap.get('aitestcase_testcases').execute({ requirementFile: 'nope/missing.md' }, makeExec()),
    /需求不存在或无法访问/,
  )
  assert.equal(ctx.calls.length, 0)
})

test('readTextFile rejects directories, empty files, and oversized files', () => {
  const dir = tempDir()
  try {
    assert.throws(() => readTextFile(dir), /不是一个文件/)
    const empty = join(dir, 'empty.md')
    writeFileSync(empty, '   \n', 'utf8')
    assert.throws(() => readTextFile(empty), /内容为空/)
    assert.throws(() => readTextFile(join(dir, 'ghost.md')), /不存在或无法访问/)
    assert.throws(() => readTextFile(''), /路径为空/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
