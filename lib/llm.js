// One-shot model call through the host LLM service.
//
// The harness exposes `ctx.llm.stream(options)` for auxiliary one-shot callers;
// `GenerateOptions.system` is the supported slot for those callers, and
// `messages` only needs identity-free user input. StreamChunks are folded here
// instead of importing BlockAssembler, which keeps this plugin free of any
// @deepseek-ai/* import (and therefore of peer-resolution risk).

/**
 * Run one model call and return its assembled text.
 * @param {{ stream: (options: object) => AsyncIterable<object> }} llm host LLM service
 * @param {{
 *   provider: string,
 *   model: string,
 *   system: string,
 *   user: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ text: string, usage: object|null, finish: object|null }>}
 */
export async function streamText(llm, options) {
  const { provider, model, system, user, temperature, maxTokens, signal } = options

  const request = {
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  }
  if (typeof system === 'string' && system.trim()) request.system = system
  if (typeof temperature === 'number') request.temperature = temperature
  if (typeof maxTokens === 'number' && maxTokens > 0) request.maxTokens = maxTokens
  if (signal) request.signal = signal

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

  if (finish && finish.kind === 'error') {
    const failure = finish.failure ?? {}
    const code = failure.code ? ` [${failure.code}]` : ''
    throw new Error(`模型调用失败${code}: ${failure.message || '未知错误'}`)
  }
  if (finish && finish.kind === 'aborted') {
    const error = new Error('模型调用已取消')
    error.name = 'AbortError'
    throw error
  }

  const assembled = text.trim() ? text.trim() : fallbackText.trim()
  if (!assembled) throw new Error('模型返回了空结果')

  return { text: assembled, usage, finish }
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
