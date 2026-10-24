// Background-job tests: long generations can run as a job (returning a job id
// immediately) and degrade to synchronous execution when the job registry is
// missing or refuses the start.

import test from 'node:test'
import assert from 'node:assert/strict'

import { registerTools } from '../lib/tools.js'
import { resolveOptions } from '../lib/options.js'
import { clearGenerations } from '../lib/session.js'

function makeCtx(script = '模型输出正文') {
  const tools = new Map()
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      const text = typeof script === 'function' ? script(options) : script
      return (async function* run() {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  // `get` mirrors Cordis' optional-service lookup; `jobs` is assigned by tests.
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    llm,
    toolsMap: tools,
    calls,
    get(name) {
      return name === 'jobs' ? ctx.jobs : undefined
    },
  }
  return ctx
}

/** Fake registry that records the spec, runs it eagerly, and exposes its hooks. */
function makeJobs() {
  const jobs = {
    specs: [],
    records: [],
    start(spec) {
      const id = `aitestcase-${jobs.specs.length + 1}`
      jobs.specs.push(spec)
      const progress = []
      const job = { id, append() {}, updateProgress: (line) => progress.push(line) }
      const hooks = spec.run(job)
      jobs.records.push({ id, spec, hooks, progress })
      return id
    },
  }
  return jobs
}

function makeExec() {
  const session = { id: 'session-test' }
  return { agent: { session }, signal: new AbortController().signal }
}

function mount(ctx, config = {}) {
  registerTools(ctx, () => resolveOptions(config))
}

test('background=true starts a job and returns a job id immediately', async () => {
  clearGenerations()
  const ctx = makeCtx('后台测试点')
  ctx.jobs = makeJobs()
  mount(ctx, { saveArtifacts: false })

  const result = await ctx.toolsMap.get('aitestcase_testpoints').execute(
    { requirement: '需求', background: true },
    makeExec(),
  )

  assert.match(result.text, /已启动后台任务 aitestcase-1/)
  assert.equal(result.jobId, 'aitestcase-1')
  assert.equal(ctx.jobs.specs.length, 1)

  const record = ctx.jobs.records[0]
  assert.equal(record.spec.kind, 'aitestcase')
  assert.equal(record.spec.owner, 'session-test', 'the job is fenced to the calling session')
  assert.match(record.spec.label, /生成/)

  const outcome = await record.hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /【测试点】/)
  assert.match(outcome.result, /后台测试点/)
  assert.equal(ctx.calls.length, 1)
  assert.ok(record.progress.some((line) => line.includes('调用模型')), 'progress is reported live')
})

test('background evaluate also runs as a job', async () => {
  clearGenerations()
  const ctx = makeCtx('{"score": 80}')
  ctx.jobs = makeJobs()
  mount(ctx, { saveArtifacts: false })

  const result = await ctx.toolsMap.get('aitestcase_evaluate').execute(
    { testcases: 'TC1', background: true },
    makeExec(),
  )
  assert.match(result.text, /已启动后台任务/)
  const outcome = await ctx.jobs.records[0].hooks.done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /"score": 80/)
})

test('without a job registry the call degrades to synchronous execution', async () => {
  clearGenerations()
  const ctx = makeCtx('同步结果')
  mount(ctx, { saveArtifacts: false })

  const result = await ctx.toolsMap.get('aitestcase_testpoints').execute(
    { requirement: '需求', background: true },
    makeExec(),
  )
  assert.equal(result.jobId, undefined)
  assert.match(result.text, /【测试点】/)
  assert.match(result.text, /同步结果/)
  assert.equal(ctx.calls.length, 1)
})

test('a refused job start degrades to synchronous execution', async () => {
  clearGenerations()
  const ctx = makeCtx('同步结果')
  ctx.jobs = {
    start() {
      throw new Error('no controller serves this owner')
    },
  }
  mount(ctx, { saveArtifacts: false })

  const result = await ctx.toolsMap.get('aitestcase_testpoints').execute(
    { requirement: '需求', background: true },
    makeExec(),
  )
  assert.equal(result.jobId, undefined)
  assert.match(result.text, /同步结果/)
})

test('a failing background generation settles as failed with its message', async () => {
  clearGenerations()
  const ctx = makeCtx()
  ctx.llm.stream = () =>
    (async function* failing() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', message: '参数不合法' } } }
    })()
  ctx.jobs = makeJobs()
  mount(ctx, { saveArtifacts: false, maxRetries: 0 })

  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求', background: true }, makeExec())
  const outcome = await ctx.jobs.records[0].hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /参数不合法/)
})

test('cancelling a background job settles it as killed', async () => {
  clearGenerations()
  const ctx = makeCtx()
  // A stream that only settles when the job's signal aborts, so the cancel
  // arrives while the work is genuinely still running.
  ctx.llm.stream = (options) => {
    ctx.calls.push(options)
    return (async function* hanging() {
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
      yield { type: 'text-delta', index: 0, text: '不会被采用' }
    })()
  }
  ctx.jobs = makeJobs()
  mount(ctx, { saveArtifacts: false })

  await ctx.toolsMap.get('aitestcase_testpoints').execute({ requirement: '需求', background: true }, makeExec())
  const record = ctx.jobs.records[0]
  record.hooks.cancel('用户取消')
  const outcome = await record.hooks.done
  assert.equal(outcome.status, 'killed')
})

test('status reports background-job availability', async () => {
  clearGenerations()
  const withJobs = makeCtx()
  withJobs.jobs = makeJobs()
  mount(withJobs, {})
  const ready = await withJobs.toolsMap.get('aitestcase_status').execute({}, makeExec())
  assert.match(ready.text, /后台任务: 注册表可用/)

  const withoutJobs = makeCtx()
  mount(withoutJobs, {})
  const degraded = await withoutJobs.toolsMap.get('aitestcase_status').execute({}, makeExec())
  assert.match(degraded.text, /后台任务: 不可用/)
})

test('a property-only registry (no ctx.get) is still found', async () => {
  clearGenerations()
  const ctx = makeCtx()
  delete ctx.get
  ctx.jobs = makeJobs()
  mount(ctx, { saveArtifacts: false })
  const result = await ctx.toolsMap.get('aitestcase_testpoints').execute(
    { requirement: '需求', background: true },
    makeExec(),
  )
  assert.match(result.jobId || '', /^aitestcase-/)
})

test('a throwing ctx.get degrades instead of breaking the call', async () => {
  clearGenerations()
  const ctx = makeCtx()
  ctx.get = () => {
    throw new Error('service not available')
  }
  mount(ctx, { saveArtifacts: false })
  const result = await ctx.toolsMap.get('aitestcase_testpoints').execute(
    { requirement: '需求', background: true },
    makeExec(),
  )
  assert.equal(result.jobId, undefined)
  assert.match(result.text, /【测试点】/)
})
