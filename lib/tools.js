// dsh-aitestcase — the six test-design tools.
//
// Every tool runs inside the host process and calls the harness LLM service
// (`ctx.llm`) directly. There is no Python backend, no extra port and no second
// API key — installing the bundle is the whole setup.
//
// The generation prompts and the tagged-input assembly are ported from
// AITestCase (MIT, https://github.com/LiuYuan0115/AITestCase) so results stay
// comparable with the original service.
//
// This module imports nothing from @deepseek-ai/* on purpose: the runtime entry
// (./index.js) owns the schemastery Config, and the pure logic here stays
// runnable under plain `node --test`.

import {
  buildEvaluatorInput,
  buildTaggedInput,
  latestOfType,
  loadPrompt,
  promptDir,
  templateFiles,
  testcaseTemplateKey,
} from './prompts.js'
import { describeBudget, fitPrompt } from './budget.js'
import { buildRepairRequest, normalizeEvaluation, renderEvaluation } from './json.js'
import { formatUsage, streamText } from './llm.js'
import { readGenerations, recordGeneration } from './session.js'
import { reportHeader, resolveOutputDir, saveArtifact, sessionCwd } from './artifacts.js'
import { readTextFile } from './files.js'
import { PLUGIN_VERSION } from './version.js'

export const PLUGIN_NAME = 'dsh-aitestcase'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '面向模型的最终结果（含报告头）' },
    type: { type: 'string', description: '结果类型' },
    model: { type: 'string', description: '使用的模型路由' },
    chars: { type: 'number', description: '生成正文的字符数' },
    artifactPath: { type: 'string', description: '落盘文件的绝对路径（未落盘时缺省）' },
    jobId: { type: 'string', description: '后台任务 id（background=true 时返回）' },
  },
  required: ['text'],
  additionalProperties: false,
}

const TYPE_LABELS = {
  testprd: '测试 PRD',
  testpoint: '测试点',
  testcase: '测试用例',
}

const FORMAT_LABELS = {
  xmind: 'xmind 层级',
  table: '表格',
  yaml: 'YAML',
}

/** Canonical output contract shared by every tool. */
function textOutput() {
  return {
    schema: OUTPUT_SCHEMA,
    render(_args, value) {
      return [{ type: 'text', text: String(value && value.text ? value.text : '') }]
    },
  }
}

function readString(args, key, { required = false } = {}) {
  const value = args ? args[key] : undefined
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`缺少必填参数 ${key}`)
    return ''
  }
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new Error(`参数 ${key} 不能为空`)
  return trimmed
}

function readNumber(args, key) {
  const value = args ? args[key] : undefined
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  if (!Number.isFinite(num)) throw new Error(`参数 ${key} 必须是数字`)
  return num
}

function readBoolean(args, key) {
  const value = args ? args[key] : undefined
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'boolean') throw new Error(`参数 ${key} 必须是布尔值`)
  return value
}

/**
 * Resolve a text argument that may instead be given as a file path.
 * The inline value wins; the file is read relative to the Session working
 * directory so `requirementFile: "docs/prd.md"` behaves the way a test engineer
 * expects.
 */
function readTextOrFile(args, textKey, fileKey, exec, label) {
  const inline = readString(args, textKey)
  if (inline) return inline
  const file = readString(args, fileKey)
  if (file) return readTextFile(file, { cwd: sessionCwd(exec), label }).text
  throw new Error(`缺少必填参数 ${textKey}（也可以改用 ${fileKey} 指定一个文件路径）`)
}

/** Optional variant of {@link readTextOrFile}: returns '' when neither is given. */
function readOptionalTextOrFile(args, textKey, fileKey, exec, label) {
  const inline = readString(args, textKey)
  if (inline) return inline
  const file = readString(args, fileKey)
  if (file) return readTextFile(file, { cwd: sessionCwd(exec), label }).text
  return ''
}

/** Truncate over-long input instead of failing, and say so in the result. */
function clampInput(text, limit) {
  const value = String(text ?? '').trim()
  if (value.length <= limit) return { text: value, truncated: false }
  const tail = '\n\n... (输入过长，已截断) ...'
  return { text: value.slice(0, Math.max(0, limit - tail.length)) + tail, truncated: true }
}

/** Build the shared report text for one generation-family result. */
function composeReport({
  label,
  opts,
  at,
  usage,
  artifactPath,
  rounds,
  body,
  budgetStats,
  formatLabel,
  attempts,
}) {
  const heading = formatLabel ? `${label}（${formatLabel}）` : label
  const header = reportHeader({
    label: heading,
    model: `${opts.provider}/${opts.model}`,
    entry: { at },
    usageLine: formatUsage(usage),
    artifactPath,
    rounds,
  })
  const notes = []
  if (attempts && attempts > 1) notes.push(`> 模型调用重试后成功（第 ${attempts} 次尝试）。`)
  if (budgetStats) {
    if (budgetStats.overBudget) {
      notes.push('> ⚠ 系统模板本身已超出上下文预算，建议提高 maxInputChars。')
    }
    if (budgetStats.inputTruncated) {
      notes.push('> 输入超出剩余上下文预算，已截断后生成。')
    }
    if (budgetStats.droppedEntries > 0) {
      notes.push(`> 历史上下文裁剪了 ${budgetStats.droppedEntries} 条以适应预算。`)
    } else if (budgetStats.historyTruncated) {
      notes.push('> 历史上下文已截断以适应预算。')
    }
    if (budgetStats.overBudget || budgetStats.inputTruncated || budgetStats.historyTruncated || budgetStats.droppedEntries > 0) {
      notes.push(`> 上下文用量：${describeBudget(budgetStats)}`)
    }
  }
  const noteBlock = notes.length ? `\n\n${notes.join('\n')}` : ''
  return `${header}${noteBlock}\n\n---\n\n${body}`
}

/** Persist the generation body and return its path (or null). */
function persist(exec, opts, type, format, body) {
  if (!opts.saveArtifacts) return null
  const slug = format ? `${type}-${format}` : type
  return saveArtifact(exec, { outputDir: opts.outputDir, type: slug, content: body })
}

/** Session id of the tool call, when the host exposes one. */
function sessionIdOf(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  if (!session) return undefined
  const id = session.id
  return typeof id === 'string' && id ? id : undefined
}

/**
 * The job registry is an optional capability: it is accessed defensively so a
 * profile without `dsh-jobs-local` (or without a job controller attached) still
 * loads the plugin and simply runs generation synchronously.
 */
function jobsOf(ctx) {
  if (!ctx) return null
  // `ctx.get(name)` is Cordis' optional-service lookup: it returns undefined for
  // a service this plugin did not inject, where plain property access throws.
  let jobs
  try {
    if (typeof ctx.get === 'function') jobs = ctx.get('jobs')
  } catch {
    jobs = undefined
  }
  if (!jobs) {
    try {
      jobs = ctx.jobs
    } catch {
      jobs = undefined
    }
  }
  return jobs && typeof jobs.start === 'function' ? jobs : null
}

/**
 * Start one background generation job.
 * @returns {string|null} the job id, or null when background execution is unavailable
 */
function startBackgroundJob(ctx, exec, { label, work }) {
  const jobs = jobsOf(ctx)
  if (!jobs) return null
  const owner = sessionIdOf(exec)
  if (!owner) return null
  try {
    return jobs.start({
      kind: 'aitestcase',
      label,
      owner,
      run(job) {
        const controller = new AbortController()
        try {
          job.updateProgress('生成中…')
        } catch {
          /* the progress line is best-effort */
        }
        const done = (async () => {
          try {
            const value = await work(controller.signal, job)
            return { status: 'completed', result: String(value && value.text ? value.text : value) }
          } catch (error) {
            if (controller.signal.aborted) return { status: 'killed', detail: '已取消' }
            return { status: 'failed', detail: String((error && error.message) || error) }
          }
        })()
        return {
          cancel() {
            controller.abort()
          },
          done,
        }
      },
    })
  } catch {
    // No controller serves this owner, admission refused, etc. The caller falls
    // back to a synchronous run rather than failing the tool call.
    return null
  }
}

/** Result returned immediately when a background job was started. */
function backgroundResult(jobId, type, opts, label) {
  return {
    text:
      `已启动后台任务 ${jobId}（${label}，预计 30–120 秒）。\n` +
      `模型: ${opts.provider}/${opts.model}\n\n` +
      `用 job_output 读取结果（job_id = "${jobId}"）；用 job_kill 取消。` +
      '完成后的结果会随首次读取一并返回。',
    type,
    model: `${opts.provider}/${opts.model}`,
    chars: 0,
    jobId: String(jobId),
  }
}

/**
 * Run one generation request to completion.
 * @param {object} ctx plugin context
 * @param {object} opts resolved options
 * @param {object} exec tool run context (session history, artifacts, cwd owner)
 * @param {{ type: string, requirement: string, testpoints?: string, instruction?: string, format?: string }} input
 * @param {AbortSignal|undefined} signal cancellation for THIS run (tool call or job)
 * @param {object} [job] background job handle for progress reporting
 */
async function generateOnce(ctx, opts, exec, input, signal, job) {
  const { type } = input
  const format = type === 'testcase' ? input.format || 'xmind' : ''
  const label = TYPE_LABELS[type] || type
  const formatLabel = format ? FORMAT_LABELS[format] || format : ''

  const now = new Date()
  const at = now.toISOString()
  const history = readGenerations(exec)

  // A test-case request without an explicit `testpoints` argument inherits the
  // newest test-point document of this session — through the template's own
  // `[测试点]` protocol slot, not as loose history prose. That entry is then
  // removed from the continuity block so the same text is not sent twice.
  let testpoints = input.testpoints
  let continuity = history
  if (type === 'testcase' && !testpoints) {
    const found = latestOfType(history, '测试点')
    if (found) {
      testpoints = found.entry.text
      continuity = history.filter((_entry, index) => index !== found.index)
    }
  }

  // The template is the task contract: it is never truncated. History is fitted
  // first, the current input takes what is left — all against the single
  // `maxInputChars` budget for the whole request.
  const templateKey = type === 'testcase' ? testcaseTemplateKey(format) : type
  const template = loadPrompt(templateKey)
  const userInput = buildTaggedInput({
    type,
    requirement: input.requirement,
    testpoints: testpoints || '',
    instruction: input.instruction,
  })
  const fitted = fitPrompt({
    template,
    input: userInput,
    entries: continuity,
    rounds: opts.historyRounds,
    budget: opts.maxInputChars,
    historyShare: opts.historyShare,
  })

  if (job) {
    try {
      job.updateProgress('调用模型…')
    } catch {
      /* best-effort */
    }
  }

  const { text: body, usage, attempts } = await streamText(ctx.llm, {
    provider: opts.provider,
    model: opts.model,
    system: fitted.system,
    user: fitted.user,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    maxRetries: opts.maxRetries,
    retryBaseMs: opts.retryBaseMs,
    signal,
  })

  const artifactPath = persist(exec, opts, type, format, body)
  // Report the entries actually folded into the prompt (the test-point document
  // consumed through the `[测试点]` slot is not part of the continuity block).
  const text = composeReport({
    label,
    opts,
    at,
    usage,
    artifactPath,
    rounds: fitted.stats.historyEntries,
    body,
    budgetStats: fitted.stats,
    formatLabel,
    attempts,
  })

  recordGeneration(exec, { type: format ? `${label}·${formatLabel}` : label, format, text: body, at })

  return {
    text,
    type: format ? `${type}-${format}` : type,
    model: `${opts.provider}/${opts.model}`,
    chars: body.length,
    ...(artifactPath ? { artifactPath } : {}),
  }
}

/**
 * Entry point used by the generation tools: foreground by default, background
 * when the caller asked for it and a job registry is available.
 */
async function generate(ctx, getOptions, exec, input) {
  const opts = getOptions()
  const format = input.type === 'testcase' ? input.format || 'xmind' : ''
  const label = TYPE_LABELS[input.type] || input.type
  const formatLabel = format ? FORMAT_LABELS[format] || format : ''

  if (input.background) {
    const jobId = startBackgroundJob(ctx, exec, {
      label: `aitestcase 生成${formatLabel ? `（${formatLabel}）` : ''}`,
      work: (jobSignal, job) => generateOnce(ctx, opts, exec, input, jobSignal, job),
    })
    if (jobId) {
      return backgroundResult(jobId, format ? `${input.type}-${format}` : input.type, opts, label)
    }
    // Fall through: background was requested but is unavailable here.
  }

  return generateOnce(ctx, opts, exec, input, exec ? exec.signal : undefined)
}

/**
 * Run one evaluation request to completion.
 * @param {object} ctx plugin context
 * @param {object} opts resolved options
 * @param {object} exec tool run context
 * @param {{ testcases: string, prd?: string, reference?: string }} input
 * @param {AbortSignal|undefined} signal cancellation for THIS run
 * @param {object} [job] background job handle for progress reporting
 */
async function evaluateOnce(ctx, opts, exec, input, signal, job) {
  const now = new Date()
  const at = now.toISOString()
  const userInput = buildEvaluatorInput({
    prd: input.prd,
    testcases: input.testcases,
    reference: input.reference,
  })

  // No continuity block here: an evaluation is about the supplied cases only.
  const fitted = fitPrompt({
    template: loadPrompt('evaluator'),
    input: userInput,
    entries: [],
    rounds: 0,
    budget: opts.maxInputChars,
    historyShare: 0,
  })

  if (job) {
    try {
      job.updateProgress('调用模型…')
    } catch {
      /* best-effort */
    }
  }

  const first = await streamText(ctx.llm, {
    provider: opts.provider,
    model: opts.model,
    system: fitted.system,
    user: fitted.user,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    maxRetries: opts.maxRetries,
    retryBaseMs: opts.retryBaseMs,
    signal,
  })

  // Normalize the JSON contract. A programmatic consumer needs a parseable value;
  // when the first answer does not parse, spend exactly one small repair call
  // instead of failing the whole evaluation.
  let normalized = normalizeEvaluation(first.text)
  let attempts = first.attempts
  let usage = first.usage
  let repaired = false
  if (!normalized.valid && opts.jsonRepair) {
    const repair = buildRepairRequest(first.text)
    try {
      const second = await streamText(ctx.llm, {
        provider: opts.provider,
        model: opts.model,
        system: repair.system,
        user: repair.user,
        temperature: 0,
        maxTokens: Math.min(opts.maxTokens, 8000),
        maxRetries: opts.maxRetries,
        retryBaseMs: opts.retryBaseMs,
        signal,
      })
      attempts += second.attempts
      const candidate = normalizeEvaluation(second.text)
      if (candidate.valid) {
        normalized = candidate
        repaired = true
      }
    } catch {
      // A failed repair keeps the raw answer with its warning; it must not turn
      // a successful evaluation into a failed tool call.
    }
  }

  const body = renderEvaluation(normalized, { repaired })
  const artifactPath = persist(exec, opts, 'evaluate', '', body)
  const text = composeReport({
    label: 'AI 辅助评审',
    opts,
    at,
    usage,
    artifactPath,
    rounds: 0,
    body,
    budgetStats: fitted.stats,
    formatLabel: '',
    attempts,
  })

  recordGeneration(exec, { type: 'AI 辅助评审', format: '', text: body, at })

  return {
    text,
    type: 'evaluate',
    model: `${opts.provider}/${opts.model}`,
    chars: body.length,
    ...(artifactPath ? { artifactPath } : {}),
  }
}

/**
 * Entry point used by the evaluate tool: foreground by default, background when
 * the caller asked for it and a job registry is available.
 */
async function evaluate(ctx, getOptions, exec, input) {
  const opts = getOptions()
  if (input.background) {
    const jobId = startBackgroundJob(ctx, exec, {
      label: 'aitestcase AI 辅助评审',
      work: (jobSignal, job) => evaluateOnce(ctx, opts, exec, input, jobSignal, job),
    })
    if (jobId) return backgroundResult(jobId, 'evaluate', opts, 'AI 辅助评审')
    // Fall through: background was requested but is unavailable here.
  }
  return evaluateOnce(ctx, opts, exec, input, exec ? exec.signal : undefined)
}

/** Parameter schema shared by the three generation tools. */
function generationParameters({ testpoints = false } = {}) {
  const properties = {
    requirement: {
      type: 'string',
      description: '需求 / PRD / 测试点原文。与 requirementFile 二选一必填；超过长度上限会被截断。',
    },
    requirementFile: {
      type: 'string',
      description:
        '需求文件路径（.md/.txt），相对路径按会话工作目录解析。与 requirement 二选一必填，requirement 优先。',
    },
    instruction: {
      type: 'string',
      description: '补充说明或修改指令，例如"重点覆盖并发场景""只保留 P0/P1"。可选。',
    },
    background: {
      type: 'boolean',
      description:
        'true = 以后台任务运行（生成通常 30–120 秒），立即返回 job id，之后用 job_output 读取结果、job_kill 取消；默认同步等待。可选。',
    },
  }
  if (testpoints) {
    properties.testpoints = {
      type: 'string',
      description: '已确认的测试点文本，作为用例生成依据。可选。',
    }
    properties.testpointsFile = {
      type: 'string',
      description: '测试点文件路径。与 testpoints 二选一，testpoints 优先。可选。',
    }
  }
  return {
    type: 'object',
    properties,
    additionalProperties: false,
  }
}

/**
 * Register the six test-design tools on a Cordis context.
 * @param {object} ctx Cordis context providing `tools` (and `llm` at call time)
 * @param {() => object} options resolves the effective options for one call, so
 *   a live Config-form edit applies to the next call without a remount
 */
export function registerTools(ctx, options) {
  ctx.tools.register({
    name: 'aitestcase_testprd',
    description:
      '把需求原文整理成"测试 PRD"：补全未定义规则、列出待确认问题、给出可测的验收标准。' +
      '测试设计链条的第一环，后续测试点和用例都以它的产出为依据。' +
      '纯本地运行，不需要任何外部服务。',
    parameters: generationParameters(),
    output: textOutput(),
    async execute(rawArgs, exec) {
      const args = rawArgs || {}
      return generate(ctx, options, exec, {
        type: 'testprd',
        requirement: readTextOrFile(args, 'requirement', 'requirementFile', exec, '需求'),
        instruction: readString(args, 'instruction'),
        background: readBoolean(args, 'background') ?? false,
      })
    },
  })

  ctx.tools.register({
    name: 'aitestcase_testpoints',
    description:
      '从测试 PRD 或需求原文中提取测试点（验证要点），不含具体步骤和数据。' +
      '输入应尽量使用上一步 aitestcase_testprd 的产出。纯本地运行。',
    parameters: generationParameters(),
    output: textOutput(),
    async execute(rawArgs, exec) {
      const args = rawArgs || {}
      return generate(ctx, options, exec, {
        type: 'testpoint',
        requirement: readTextOrFile(args, 'requirement', 'requirementFile', exec, '需求'),
        instruction: readString(args, 'instruction'),
        background: readBoolean(args, 'background') ?? false,
      })
    },
  })

  const testcaseParameters = generationParameters({ testpoints: true })
  testcaseParameters.properties.format = {
    type: 'string',
    enum: ['xmind', 'table', 'yaml'],
    description:
      '输出格式：xmind = H1-H6 层级结构（可直接导入 XMind，默认）；table = Markdown 表格；yaml = 结构化 YAML（便于程序消费）。',
  }

  ctx.tools.register({
    name: 'aitestcase_testcases',
    description:
      '生成测试用例。把测试点（可选）与 PRD/需求一起传入，按 xmind / table / yaml 三种格式之一输出。' +
      '推荐链条：aitestcase_testprd → aitestcase_testpoints → aitestcase_testcases → aitestcase_evaluate。纯本地运行。',
    parameters: testcaseParameters,
    output: textOutput(),
    async execute(rawArgs, exec) {
      const args = rawArgs || {}
      const format = readString(args, 'format') || 'xmind'
      if (!['xmind', 'table', 'yaml'].includes(format)) {
        throw new Error('参数 format 只能是 xmind、table 或 yaml')
      }
      return generate(ctx, options, exec, {
        type: 'testcase',
        requirement: readTextOrFile(args, 'requirement', 'requirementFile', exec, '需求'),
        testpoints: readOptionalTextOrFile(args, 'testpoints', 'testpointsFile', exec, '测试点'),
        instruction: readString(args, 'instruction'),
        format,
        background: readBoolean(args, 'background') ?? false,
      })
    },
  })

  ctx.tools.register({
    name: 'aitestcase_evaluate',
    description:
      '对测试用例做 AI 辅助评审：覆盖率、边界值、异常路径、步骤清晰度打分（0–100），' +
      '并给出覆盖缺口、逻辑问题、重复用例、风险点和建议补充的用例（JSON 报告，结论需人工复核）。纯本地运行。',
    parameters: {
      type: 'object',
      properties: {
        testcases: { type: 'string', description: '待评估的测试用例全文。与 testcasesFile 二选一必填。' },
        testcasesFile: {
          type: 'string',
          description: '测试用例文件路径（.md/.yaml/.xmind 导出文本），相对路径按会话工作目录解析。与 testcases 二选一必填。',
        },
        prd: { type: 'string', description: '对应的 PRD / 需求原文，用于判断覆盖度。可选但强烈建议提供。' },
        prdFile: { type: 'string', description: 'PRD 文件路径。与 prd 二选一，prd 优先。可选。' },
        reference: { type: 'string', description: '参考规范或历史用例，用于一致性检查。可选。' },
        background: {
          type: 'boolean',
          description:
            'true = 以后台任务运行，立即返回 job id，之后用 job_output 读取结果、job_kill 取消；默认同步等待。可选。',
        },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      const args = rawArgs || {}
      return evaluate(ctx, options, exec, {
        testcases: readTextOrFile(args, 'testcases', 'testcasesFile', exec, '测试用例'),
        prd: readOptionalTextOrFile(args, 'prd', 'prdFile', exec, 'PRD'),
        reference: readString(args, 'reference'),
        background: readBoolean(args, 'background') ?? false,
      })
    },
  })

  ctx.tools.register({
    name: 'aitestcase_history',
    description:
      '读取本会话此前的生成结果（测试 PRD / 测试点 / 用例 / 评估），用于"基于上一版修改"。' +
      '不跨会话、不跨进程重启。纯本地运行。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多返回几条，默认 3，最大 10。' },
        type: { type: 'string', description: '只返回类型里包含该子串的记录，例如"测试用例"或"测试点"。可选。' },
        full: { type: 'boolean', description: 'true = 返回完整正文；默认只返回摘要。' },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      const args = rawArgs || {}
      const opts = options()
      const limitRaw = readNumber(args, 'limit')
      const limit = Math.min(Math.max(Math.floor(limitRaw ?? 3), 1), 10)
      const typeFilter = readString(args, 'type')
      const full = readBoolean(args, 'full') ?? false

      const all = readGenerations(exec)
      const filtered = typeFilter ? all.filter((entry) => entry.type.includes(typeFilter)) : all
      const selected = filtered.slice(-limit)

      if (selected.length === 0) {
        return {
          text: all.length === 0
            ? '本会话还没有任何生成记录。先调用 aitestcase_testprd / aitestcase_testpoints / aitestcase_testcases 生成一次。'
            : `本会话共有 ${all.length} 条记录，但没有匹配"${typeFilter}"的条目。`,
          type: 'history',
          model: `${opts.provider}/${opts.model}`,
          chars: 0,
        }
      }

      const blocks = selected.map((entry, index) => {
        const body = full ? entry.text : entry.text.slice(0, 300) + (entry.text.length > 300 ? ' …' : '')
        return `### ${index + 1}. ${entry.type} · ${entry.at}\n\n${body}`
      })
      return {
        text: `【本会话生成记录】\n\n模型: ${opts.provider}/${opts.model}\n共 ${filtered.length} 条，返回最近 ${selected.length} 条\n\n---\n\n${blocks.join('\n\n')}`,
        type: 'history',
        model: `${opts.provider}/${opts.model}`,
        chars: blocks.join('\n\n').length,
      }
    },
  })

  ctx.tools.register({
    name: 'aitestcase_status',
    description:
      '自检：确认插件已加载、模型路由可用、prompt 模板齐全、产物目录可解析。' +
      'probe=true 时真的向模型发一次极小的请求来验证连通性（会消耗少量 token）。',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'boolean', description: '是否做一次真实的最小模型调用，默认 false。' },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(rawArgs, exec) {
      const args = rawArgs || {}
      const opts = options()
      const probe = readBoolean(args, 'probe') ?? false
      const lines = ['【dsh-aitestcase 自检】', '']
      lines.push(`插件: ${PLUGIN_NAME} v${PLUGIN_VERSION}（已加载）`)
      lines.push(`模型路由: ${opts.provider}/${opts.model}  temperature=${opts.temperature}  maxTokens=${opts.maxTokens}`)

      const llmReady = Boolean(ctx.llm) && typeof ctx.llm.stream === 'function'
      lines.push(`LLM 服务: ${llmReady ? '可用（ctx.llm.stream）' : '不可用'}`)

      lines.push('', 'Prompt 模板:')
      const files = templateFiles()
      let missing = 0
      for (const [key, file] of Object.entries(files)) {
        try {
          const text = loadPrompt(key)
          lines.push(`  ✓ ${key} (${file}, ${text.length} 字符)`)
        } catch (error) {
          missing += 1
          lines.push(`  ✗ ${key} (${file}) — ${error.message}`)
        }
      }
      lines.push(`模板目录: ${promptDir()}`)

      const outputDir = resolveOutputDir(exec, opts.outputDir)
      lines.push('', `产物目录（解析后）: ${outputDir}`)
      lines.push(`落盘开关: ${opts.saveArtifacts ? '开' : '关'}`)
      lines.push(
        `上下文预算: ${opts.maxInputChars} 字符（历史占比 ${Math.round(opts.historyShare * 100)}%，保留 ${opts.historyRounds} 轮）`,
      )
      lines.push(`重试策略: 最多 ${opts.maxRetries} 次，退避基数 ${opts.retryBaseMs} ms`)
      lines.push(`评审 JSON 修复: ${opts.jsonRepair ? '开' : '关'}`)

      const jobsReady = Boolean(jobsOf(ctx))
      lines.push(
        `后台任务: ${
          jobsReady ? '注册表可用（ctx.jobs；无控制器时自动降级为同步）' : '不可用（将同步执行）'
        }`,
      )

      const historyCount = readGenerations(exec).length
      lines.push(`本会话历史记录: ${historyCount} 条`)

      if (probe) {
        lines.push('', '正在做连通性探测…')
        if (!llmReady) {
          lines.push('探测失败: LLM 服务不可用')
        } else {
          try {
            const { text } = await streamText(ctx.llm, {
              provider: opts.provider,
              model: opts.model,
              user: '只回复两个字符：OK',
              temperature: 0,
              maxTokens: 64,
              signal: exec ? exec.signal : undefined,
            })
            lines.push(`探测成功，模型回复: ${text.slice(0, 80)}`)
          } catch (error) {
            lines.push(`探测失败: ${error.message}`)
          }
        }
      } else {
        lines.push('', '未做连通性探测（传 probe=true 可实测一次模型调用）。')
      }

      lines.push('', missing === 0 ? '结论: 全部模板就绪，插件可直接使用。' : `结论: 有 ${missing} 个模板缺失，请检查安装。`)

      return {
        text: lines.join('\n'),
        type: 'status',
        model: `${opts.provider}/${opts.model}`,
        chars: 0,
      }
    },
  })
}
