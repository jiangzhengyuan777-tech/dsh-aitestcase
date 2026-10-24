// Evaluation JSON handling tests: extraction tolerates the ways a model wraps
// JSON, and normalization never throws on garbage.

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRepairRequest, extractJson, normalizeEvaluation, renderEvaluation } from '../lib/json.js'

test('extractJson parses a bare object', () => {
  assert.deepEqual(extractJson('{"score":85,"summary":"ok"}'), { score: 85, summary: 'ok' })
})

test('extractJson parses a fenced json block', () => {
  const text = '```json\n{"score": 72, "coverage_gap": ["边界值"]}\n```'
  assert.deepEqual(extractJson(text), { score: 72, coverage_gap: ['边界值'] })
})

test('extractJson tolerates prose before and after the object', () => {
  const text = '好的，评估如下：\n{"score": 90}\n以上仅为建议。'
  assert.deepEqual(extractJson(text), { score: 90 })
})

test('extractJson rejects non-object and malformed answers', () => {
  assert.equal(extractJson(''), null)
  assert.equal(extractJson('只有一个分数 85 分'), null)
  assert.equal(extractJson('[1,2,3]'), null)
  assert.equal(extractJson('{"score": }'), null)
})

test('normalizeEvaluation renders a clean fenced block for valid JSON', () => {
  const normalized = normalizeEvaluation('```json\n{"score":88,"logic_issues":[]}\n```')
  assert.equal(normalized.valid, true)
  assert.equal(normalized.parsed.score, 88)
  assert.match(normalized.body, /^```json\n\{/)
  assert.match(normalized.body, /"score": 88/)
  assert.doesNotMatch(renderEvaluation(normalized), /未返回合法 JSON/)
})

test('normalizeEvaluation keeps raw text and flags invalid JSON', () => {
  const normalized = normalizeEvaluation('评分 80 分，覆盖有缺口。')
  assert.equal(normalized.valid, false)
  assert.equal(normalized.parsed, null)
  const rendered = renderEvaluation(normalized)
  assert.match(rendered, /未返回合法 JSON/)
  assert.match(rendered, /评分 80 分/)
})

test('renderEvaluation marks a repaired result without pretending it was first-try', () => {
  const normalized = normalizeEvaluation('{"score": 60}')
  const rendered = renderEvaluation(normalized, { repaired: true })
  assert.match(rendered, /一次修复调用/)
  assert.match(rendered, /"score": 60/)
})

test('the repair request asks for JSON only and keeps the source bounded', () => {
  const request = buildRepairRequest('x'.repeat(50000))
  assert.match(request.system, /只输出 JSON/)
  assert.ok(request.user.length < 21000, 'repair source must be bounded')
})
