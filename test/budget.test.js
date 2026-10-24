// Context-budget tests: `maxInputChars` must bound the WHOLE request
// (template + continuity history + current input), with history giving way
// before the task input.

import test from 'node:test'
import assert from 'node:assert/strict'

import { fitPrompt, describeBudget, DEFAULT_HISTORY_SHARE } from '../lib/budget.js'
import { buildHistoryBlock } from '../lib/prompts.js'

function entries(specs) {
  return specs.map((text, index) => ({
    type: index === 0 ? '测试点' : '测试用例·表格',
    at: `2026-10-24T00:00:0${index}.000Z`,
    text,
  }))
}

test('a request that fits is returned untouched', () => {
  const fitted = fitPrompt({
    template: 'T'.repeat(100),
    input: 'I'.repeat(200),
    entries: [],
    rounds: 4,
    budget: 1000,
  })
  assert.equal(fitted.system, 'T'.repeat(100))
  assert.equal(fitted.user, 'I'.repeat(200))
  assert.equal(fitted.stats.historyChars, 0)
  assert.equal(fitted.stats.inputTruncated, false)
  assert.equal(fitted.stats.overBudget, false)
  assert.equal(fitted.stats.totalChars, 300)
})

test('history is fitted into its share of the remaining budget', () => {
  const big = 'X'.repeat(2000)
  const history = entries([big, big, big])
  const budget = 6000
  const template = 'T'.repeat(500)
  const fitted = fitPrompt({ template, input: 'short', entries: history, rounds: 4, budget })

  const available = budget - template.length
  const allowance = Math.floor(available * DEFAULT_HISTORY_SHARE)
  assert.ok(fitted.stats.historyChars <= allowance, 'history must respect its share')
  assert.ok(fitted.stats.droppedEntries > 0, 'older entries must be dropped when they do not fit')
  assert.ok(fitted.stats.totalChars <= budget, 'the whole request must fit the budget')
  assert.equal(fitted.stats.inputTruncated, false, 'short input survives untouched')
})

test('a single oversized newest entry is truncated, not dropped', () => {
  const fitted = fitPrompt({
    template: 'T'.repeat(100),
    input: 'input',
    entries: entries(['Y'.repeat(50000)]),
    rounds: 4,
    budget: 4000,
    historyShare: 0.5,
  })
  const allowance = Math.floor((4000 - 100) * 0.5)
  assert.ok(fitted.stats.historyChars > 0, 'the newest entry still contributes context')
  assert.ok(fitted.stats.historyChars <= allowance)
  assert.ok(fitted.system.includes('历史内容已截断'), 'truncation is marked in the block')
  assert.equal(fitted.stats.droppedEntries, 0, 'the entry was truncated, not dropped')
})

test('historyRounds=0 disables continuity entirely', () => {
  const fitted = fitPrompt({
    template: 'T'.repeat(100),
    input: 'I'.repeat(100),
    entries: entries(['Z'.repeat(1000)]),
    rounds: 0,
    budget: 5000,
  })
  assert.equal(fitted.stats.historyChars, 0)
  assert.doesNotMatch(fitted.system, /本会话历史输出/)
  assert.equal(fitted.stats.droppedEntries, 1)
})

test('the input is truncated only with the budget left after history', () => {
  const budget = 5000
  const fitted = fitPrompt({
    template: 'T'.repeat(1000),
    input: 'I'.repeat(20000),
    entries: entries(['H'.repeat(2000)]),
    rounds: 4,
    budget,
  })
  assert.equal(fitted.stats.inputTruncated, true)
  assert.ok(fitted.stats.totalChars <= budget)
  assert.ok(fitted.user.includes('输入超出上下文预算'))
  assert.ok(fitted.user.length < 20000)
})

test('a template larger than the budget is reported instead of silently dropped', () => {
  const fitted = fitPrompt({
    template: 'T'.repeat(5000),
    input: 'I'.repeat(100),
    entries: [],
    rounds: 4,
    budget: 2000,
  })
  assert.equal(fitted.stats.overBudget, true)
  assert.ok(fitted.user.length > 0, 'the request keeps a usable input floor')
  assert.match(describeBudget(fitted.stats), /模板已超预算/)
})

test('describeBudget reports every dimension that was cut', () => {
  const fitted = fitPrompt({
    template: 'T'.repeat(1000),
    input: 'I'.repeat(9000),
    entries: entries(['H'.repeat(3000)]),
    rounds: 4,
    budget: 4000,
  })
  const line = describeBudget(fitted.stats)
  assert.match(line, /模板 \d+/)
  assert.match(line, /历史 \d+/)
  assert.match(line, /输入 \d+/)
  assert.match(line, /\/4000 字符/)
  assert.match(line, /输入已截断/)
})

test('buildHistoryBlock keeps its plain form when no budget is given', () => {
  const block = buildHistoryBlock(entries(['first', 'second']), 4)
  assert.match(block, /本会话历史输出/)
  assert.match(block, /第 1 轮/)
  assert.match(block, /第 2 轮/)
  assert.match(block, /second/)
})

test('buildHistoryBlock honours a character cap', () => {
  const block = buildHistoryBlock(entries(['A'.repeat(5000)]), 4, 1200)
  assert.ok(block.length <= 1200, `block was ${block.length} chars`)
  assert.match(block, /历史内容已截断/)
})
