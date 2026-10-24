// One-shot model call through the host LLM service, with transient-failure
// retries.
//
// The harness exposes `ctx.llm.stream(options)` for auxiliary one-shot callers,
// and a direct caller is entitled to exactly ONE provider attempt — the agent
// loop's own retry policy does not cover it. A test-design generation takes
// 30–120 s, so a single rate limit or network blip would otherwise throw away a
// whole tool call. This module adds a bounded exponential backoff around the
// attempt and classifies failures into retryable and terminal ones.
//
// StreamChunks are folded here instead of importing BlockAssembler, which keeps
// this plugin free of any @deepseek-ai/* import.

/** Failure codes that must never be retried: retrying cannot change the answer. */
const TERMINAL_CODES = new Set([
  'ABORTED',
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_REQUEST',
  'INVALID_MODEL_INFO',
  'INVALID_PREPARED_CALL',
  'REGISTRATION_DISPOSED',
  'AUTH_ERROR',
  'AUTHENTICATION_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'EMPTY_REQUEST',
])

/** Failure codes that are worth another attempt. */
const RETRYABLE_CODES = new Set([
  'TIMEOUT',
  'RATE_LIMIT',
  'RATE_LIMITED',
  'OVERLOADED',
  'UNAVAILABLE',
  'SERVER_ERROR',
  'INTERNAL_ERROR',
  'HTTP_ERROR',
  'NETWORK_ERROR',
  'CONNECTION_ERROR',
  'EMPTY_RESPONSE',
  'STREAM_ERROR',
])

const MAX_BACKOFF_MS = 15000

/** A normalized model-call failure carrying a provider-neutral code. */
export class LlmCallError extends Error {
  constructor(message, { code = 'UNKNOWN', status, retryable } = {}) {
    super(message)
    this.name = 'LlmCallError'
    this.code = code
    if (typeof status === 'number') this.status = status
    this.retryable = typeof retryable === 'boolean' ? retryable : classify({ code, status })
  }
}

/**
 * Decide whether one failure is worth retrying.
 * Provider status wins over the code; an unknown failure with no status is
 * treated as transient (network-ish), which is the common case for stream
 * failures that never reached an HTTP status.
 * @param {{ code?: string, status?: number }} failure
 * @returns {boolean}
 */
export function classify(failure) {
  const status = typeof failure?.status === 'number' ? failure.status : undefined
  if (status !== undefined) {
    if (status === 408 || status === 425 || status === 429) return true
    if (status >= 500) return true
    if (status >= 400) return false
  }
  const code = String(failure?.code || '').toUpperCase()
  if (TERMINAL_CODES.has(code)) return false
  if (RETRYABLE_CODES.has(code)) return true
  if (code.startsWith('INVALID_')) return false
  if (code.startsWith('AUTH')) return false
  return true
}

/** Exponential backoff with jitter; attempt starts at 1 for the first retry. */
function backoffMs(attempt, baseMs) {
  const exponential = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** (attempt - 1))
  return exponential + Math.floor(Math.random() * Math.min(250, exponential * 0.3))
}

/** Sleep that settles early (and rejects) when the caller aborts. */
function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError() {
  const error = new Error('模型调用已取消')
  error.name = 'AbortError'
  error.code = 'ABORTED'
  error.retryable = false
  return error
}

/** Fold one provider attempt's StreamChunks into text. */
async function attemptStream(llm, request) {
  const stream = llm.stream(request)

  let text = ''
  let fallbackText = ''
  let usage = null
  let finish = null

  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    switch (chunk.type) {
      case 'text-delta':
        if (typeof chunk.text === 'string') text += chunk.text
        break
      case 'block-end':
        // Authoritative assembled block; used only as a fallback when the
        // adapter emitted no deltas for this block at all.
        if (chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
          fallbackText = chunk.block.text
        }
        break
      case 'usage':
        usage = chunk.usage ?? null
        break
      case 'finish':
        finish = chunk.reason ?? null
        break
      default:
        break
    }
  }

  if (finish && finish.kind === 'aborted') throw abortError()
  if (finish && finish.kind === 'error') {
    const failure = finish.failure ?? {}
    const code = failure.code ? String(failure.code) : 'UNKNOWN'
    const label = failure.code ? ` [${failure.code}]` : ''
    throw new LlmCallError(`模型调用失败${label}: ${failure.message || '未知错误'}`, {
      code,
      status: typeof failure.status === 'number' ? failure.status : undefined,
    })
  }

  const assembled = text.trim() ? text.trim() : fallbackText.trim()
  if (!assembled) {
    throw new LlmCallError('模型返回了空结果', { code: 'EMPTY_RESPONSE' })
  }

  return { text: assembled, usage, finish }
}

/** Turn any thrown value into an LlmCallError with a classification. */
function normalizeFailure(error) {
  if (error instanceof LlmCallError) return error
  if (error && error.name === 'AbortError') return abortError()
  const status =
    typeof error?.status === 'number'
      ? error.status
      : typeof error?.failure?.status === 'number'
        ? error.failure.status
        : undefined
  const code = String(error?.code || error?.failure?.code || 'UNKNOWN')
  return new LlmCallError(error?.message ? `模型调用失败: ${error.message}` : '模型调用失败', {
    code,
    status,
  })
}

/**
 * Run one model call and return its assembled text.
 * @param {{ stream: (options: object) => AsyncIterable<object> }} llm host LLM service
 * @param {{
 *   provider: string,
 *   model: string,
 *   system?: string,
 *   user: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   signal?: AbortSignal,
 *   maxRetries?: number,
 *   retryBaseMs?: number,
 *   onRetry?: (info: { attempt: number, maxRetries: number, error: Error }) => void,
 * }} options
 * @returns {Promise<{ text: string, usage: object|null, finish: object|null, attempts: number }>}
 */
export async function streamText(llm, options) {
  const {
    provider,
    model,
    system,
    user,
    temperature,
    maxTokens,
    signal,
    maxRetries = 0,
    retryBaseMs = 800,
    onRetry,
  } = options

  const request = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  }
  if (typeof system === 'string' && system.trim()) request.system = system
  if (typeof temperature === 'number') request.temperature = temperature
  if (typeof maxTokens === 'number' && maxTokens > 0) request.maxTokens = maxTokens
  if (signal) request.signal = signal

  const retries = Number.isFinite(maxRetries) ? Math.max(0, Math.floor(maxRetries)) : 0
  const base = Number.isFinite(retryBaseMs) ? Math.max(0, retryBaseMs) : 800

  for (let attempt = 1; ; attempt += 1) {
    if (signal && signal.aborted) throw abortError()
    try {
      const result = await attemptStream(llm, request)
      return { ...result, attempts: attempt }
    } catch (raw) {
      const error = normalizeFailure(raw)
      if (error.code === 'ABORTED' || (signal && signal.aborted)) throw abortError()
      if (attempt > retries || !error.retryable) throw error
      if (typeof onRetry === 'function') {
        try {
          onRetry({ attempt, maxRetries: retries, error })
        } catch {
          /* an observer must not break the retry path */
        }
      }
      await sleep(backoffMs(attempt, base), signal)
    }
  }
}

/**
 * Format token usage for a short human-facing diagnostic line.
 *
 * DeepSeek folds cache hits into `prompt_tokens`; the adapter subtracts them, so
 * `inputTokens` is uncached input only and a large cached prefix shows up as a
 * small number. Cache reads are therefore reported explicitly instead of making
 * the line look wrong.
 * @param {object|null} usage
 * @returns {string}
 */
export function formatUsage(usage) {
  if (!usage) return ''
  const input = Number(usage.inputTokens ?? 0)
  const output = Number(usage.outputTokens ?? 0)
  const cacheRead = Number(usage.cacheReadTokens ?? 0)
  if (!input && !output && !cacheRead) return ''
  const inputText = cacheRead ? `输入 ${input}（缓存命中 ${cacheRead}）` : `输入 ${input}`
  return `${inputText} / 输出 ${output}`
}
