// Retry tests: one tool call gets bounded retries for transient provider
// failures, and terminal failures must not be retried.

import test from 'node:test'
import assert from 'node:assert/strict'

import { classify, streamText } from '../lib/llm.js'

/** Build a fake LLM whose i-th call follows the i-th script entry. */
function scripted(scripts) {
  const llm = {
    calls: 0,
    stream() {
      const script = scripts[Math.min(llm.calls, scripts.length - 1)]
      llm.calls += 1
      return (async function* run() {
        if (script.throw) throw script.throw
        if (script.error) {
          yield { type: 'finish', reason: { kind: 'error', failure: script.error } }
          return
        }
        if (script.empty) {
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: script.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: script.text } }
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return llm
}

const base = { provider: 'p', model: 'm', user: 'u', retryBaseMs: 1, maxRetries: 2 }

test('a transient failure is retried and the call succeeds', async () => {
  const llm = scripted([{ error: { code: 'TIMEOUT', message: '超时' } }, { text: '结果' }])
  const result = await streamText(llm, base)
  assert.equal(result.text, '结果')
  assert.equal(result.attempts, 2)
  assert.equal(llm.calls, 2)
})

test('a terminal failure is not retried', async () => {
  const llm = scripted([{ error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: '超长' } }])
  await assert.rejects(() => streamText(llm, base), /CONTEXT_WINDOW_EXCEEDED|超长/)
  assert.equal(llm.calls, 1)
})

test('retries stop after the configured budget', async () => {
  const llm = scripted([{ error: { code: 'TIMEOUT', message: '超时' } }])
  await assert.rejects(() => streamText(llm, { ...base, maxRetries: 2 }), /模型调用失败 \[TIMEOUT\]/)
  assert.equal(llm.calls, 3, 'one initial attempt plus two retries')
})

test('maxRetries=0 performs exactly one attempt', async () => {
  const llm = scripted([{ error: { code: 'RATE_LIMIT', message: '限流' } }])
  await assert.rejects(() => streamText(llm, { ...base, maxRetries: 0 }))
  assert.equal(llm.calls, 1)
})

test('a rate-limit failure carrying a status is retryable', async () => {
  const llm = scripted([{ error: { code: 'HTTP_ERROR', status: 429, message: '限流' } }, { text: 'ok' }])
  const result = await streamText(llm, base)
  assert.equal(result.attempts, 2)
})

test('an empty response is retried', async () => {
  const llm = scripted([{ empty: true }, { text: '第二次有内容' }])
  const result = await streamText(llm, base)
  assert.equal(result.text, '第二次有内容')
  assert.equal(result.attempts, 2)
})

test('a thrown transport error with a 5xx status is retried', async () => {
  const failure = Object.assign(new Error('bad gateway'), { status: 502 })
  const llm = scripted([{ throw: failure }, { text: 'ok' }])
  const result = await streamText(llm, base)
  assert.equal(result.attempts, 2)
})

test('a thrown transport error with a 401 status is terminal', async () => {
  const failure = Object.assign(new Error('unauthorized'), { status: 401 })
  const llm = scripted([{ throw: failure }])
  await assert.rejects(() => streamText(llm, base), /unauthorized|模型调用失败/)
  assert.equal(llm.calls, 1)
})

test('an abort during the backoff wait stops retrying immediately', async () => {
  const controller = new AbortController()
  const llm = scripted([{ error: { code: 'TIMEOUT', message: '超时' } }, { text: '不会到达' }])
  await assert.rejects(
    () =>
      streamText(llm, {
        ...base,
        retryBaseMs: 50,
        signal: controller.signal,
        onRetry: () => controller.abort(),
      }),
    (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
  assert.equal(llm.calls, 1)
})

test('classify() separates terminal from transient failures', () => {
  assert.equal(classify({ status: 429 }), true)
  assert.equal(classify({ status: 503 }), true)
  assert.equal(classify({ status: 400 }), false)
  assert.equal(classify({ status: 401 }), false)
  assert.equal(classify({ code: 'CONTEXT_WINDOW_EXCEEDED' }), false)
  assert.equal(classify({ code: 'INVALID_MODEL_INFO' }), false)
  assert.equal(classify({ code: 'AUTH_ERROR' }), false)
  assert.equal(classify({ code: 'TIMEOUT' }), true)
  assert.equal(classify({ code: 'EMPTY_RESPONSE' }), true)
  // Unknown failure without an HTTP status is treated as transient.
  assert.equal(classify({ code: 'SOMETHING_NEW' }), true)
})
